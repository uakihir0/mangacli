// Catalog font acquisition: lookup, download, verification, cache (spec 7.3.10).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { type CatalogFont, loadCatalog } from "./catalog.js";

export interface FontFetchOptions {
  fontDownload?: "auto" | "never";
  fontDir?: string;
  fontCacheDir?: string;
  fontMirror?: string;
  signal?: AbortSignal;
  onProgress?: (e: { font: string; done: number; total: number }) => void;
  onInfo?: (code: string, message: string) => void;
  /** font errors are reported here instead of thrown (missing files, unknown catalog ids) */
  onError?: (code: string, message: string) => void;
}

export class FontFetchError extends Error {
  constructor(public code: "FONT_DOWNLOAD_FAILED" | "FONT_INTEGRITY_FAILED" | "FONT_DOWNLOAD_DISABLED" | "FONT_CATALOG_UNKNOWN", message: string) {
    super(message);
  }
}

export function defaultFontCacheDir(): string {
  if (process.env.MANGACLI_FONT_CACHE) return process.env.MANGACLI_FONT_CACHE;
  const p = platform();
  if (p === "darwin") return join(homedir(), "Library", "Caches", "mangacli", "fonts");
  if (p === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "mangacli", "Cache", "fonts");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "mangacli", "fonts");
}

function fileName(f: CatalogFont): string {
  return `${f.id}-${f.weight}-r${f.revision}-${f.sha256.slice(0, 12)}.ttf`;
}

function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** find a catalog font locally; returns path or null */
export function findLocalCatalogFont(f: CatalogFont, o: FontFetchOptions = {}): string | null {
  const dirs = [o.fontDir, o.fontCacheDir ?? defaultFontCacheDir()].filter(Boolean) as string[];
  for (const d of dirs) {
    const p = join(d, fileName(f));
    if (existsSync(p)) return p;
    // fontDir may also contain the original file name
    const q = join(d, f.file);
    if (o.fontDir && d === o.fontDir && existsSync(q)) {
      const data = readFileSync(q);
      if (sha256(data) === f.sha256) return q;
    }
  }
  return null;
}

function rewriteUrl(url: string, mirror?: string): string {
  const m = mirror ?? process.env.MANGACLI_FONT_MIRROR;
  if (!m) return url;
  const cat = loadCatalog();
  const base = `https://raw.githubusercontent.com/google/fonts/${cat.source.commit}/`;
  return url.startsWith(base) ? m.replace(/\/?$/, "/") + url.slice(base.length) : url;
}

async function download(url: string, o: FontFetchOptions, label: string, allowedHosts: string[]): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (u.protocol !== "https:") throw new FontFetchError("FONT_DOWNLOAD_FAILED", `refusing non-HTTPS URL: ${current}`);
    const mirrorHost = o.fontMirror ? new URL(o.fontMirror).host : process.env.MANGACLI_FONT_MIRROR ? new URL(process.env.MANGACLI_FONT_MIRROR).host : null;
    if (!allowedHosts.includes(u.host) && u.host !== mirrorHost) throw new FontFetchError("FONT_DOWNLOAD_FAILED", `host not allowed: ${u.host}`);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: o.signal ?? AbortSignal.timeout(120_000) });
    } catch (e) {
      throw new FontFetchError("FONT_DOWNLOAD_FAILED", `failed to download ${label}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new FontFetchError("FONT_DOWNLOAD_FAILED", `failed to download ${label}: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    const chunks: Uint8Array[] = [];
    let done = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      chunks.push(value);
      done += value.length;
      o.onProgress?.({ font: label, done, total });
    }
    const out = new Uint8Array(done);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  throw new FontFetchError("FONT_DOWNLOAD_FAILED", `too many redirects: ${url}`);
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 300_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (Date.now() - start > 600_000) throw new FontFetchError("FONT_DOWNLOAD_FAILED", `timeout waiting for lock ${lockPath}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Ensure a catalog font is available locally; downloads if allowed. */
export async function ensureCatalogFont(f: CatalogFont, o: FontFetchOptions = {}, targetDir?: string): Promise<string> {
  const local = targetDir ? null : findLocalCatalogFont(f, o);
  if (local) return local;
  const dir = targetDir ?? o.fontCacheDir ?? defaultFontCacheDir();
  const dest = join(dir, fileName(f));
  if (existsSync(dest)) return dest;
  const mode = o.fontDownload ?? (process.env.MANGACLI_NO_DOWNLOAD === "1" ? "never" : "auto");
  if (mode === "never")
    throw new FontFetchError("FONT_DOWNLOAD_DISABLED", `font ${f.id}@${f.weight} is not installed and downloading is disabled. Run: mangacli fonts install`);
  mkdirSync(dir, { recursive: true });
  return withLock(dest + ".lock", async () => {
    if (existsSync(dest)) return dest;
    const cat = loadCatalog();
    o.onInfo?.("FONT_DOWNLOADING", `downloading ${f.family} ${f.weight} (${(f.bytes / 1e6).toFixed(1)} MB)`);
    const data = await download(rewriteUrl(f.url, o.fontMirror), o, `${f.id}@${f.weight}`, cat.allowedHosts);
    if (sha256(data) !== f.sha256) throw new FontFetchError("FONT_INTEGRITY_FAILED", `hash mismatch for ${f.id}@${f.weight}`);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, dest);
    const licPath = join(dir, `${f.id}-OFL.txt`);
    if (!existsSync(licPath)) {
      try {
        const lic = await download(rewriteUrl(f.license.url, o.fontMirror), o, `${f.id} license`, cat.allowedHosts);
        writeFileSync(licPath, lic);
      } catch {
        /* license text is best-effort */
      }
    }
    return dest;
  });
}
