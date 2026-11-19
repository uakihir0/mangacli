// Config file discovery and loading (spec 12.5).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { MangaError } from "./core/diagnostics.js";
import type { MangaPlugin } from "./plugin.js";

type Obj = Record<string, unknown>;

export interface MangaConfig {
  root?: string;
  plugins?: unknown[];
  pageSizes?: MangaPlugin["pageSizes"];
  fonts?: Record<string, unknown>;
  fontFallback?: string[];
  fontSet?: string;
  fontDownload?: "auto" | "never";
  fontDir?: string;
  fontCacheDir?: string;
  fontMirror?: string;
  assetPaths?: string[];
  missingAssets?: "error" | "placeholder";
  allowNetwork?: boolean | Obj;
  allowOutsideRoot?: boolean;
  defaults?: Obj;
  styles?: Record<string, Obj>;
  hand?: Obj;
  output?: { dir?: string; profile?: string; profiles?: Record<string, Obj>; name?: string };
  diagnostics?: Record<string, "error" | "warning" | "info" | "off">;
  concurrency?: number;
  cache?: { dir?: string; enabled?: boolean };
  limits?: Obj;
  locale?: "ja" | "en";
}

export function defineConfig(c: MangaConfig): MangaConfig {
  return c;
}

const NAMES = ["mangacli.config.ts", "mangacli.config.mts", "mangacli.config.js", "mangacli.config.mjs", "mangacli.config.json", "mangacli.config.yaml"];

/** search from `startDir` upward; stops at a directory containing package.json or the filesystem root */
export function findConfig(startDir: string): string | null {
  let d = resolve(startDir);
  for (;;) {
    for (const n of NAMES) {
      const p = join(d, n);
      if (existsSync(p)) return p;
    }
    if (existsSync(join(d, "package.json"))) return null;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export async function loadConfig(path: string): Promise<MangaConfig & { __file: string }> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new MangaError("CONFIG_NOT_FOUND", `config file not found: ${abs}`);
  let cfg: unknown;
  try {
    if (abs.endsWith(".json")) cfg = JSON.parse(readFileSync(abs, "utf8"));
    else if (abs.endsWith(".yaml") || abs.endsWith(".yml")) cfg = parseYaml(readFileSync(abs, "utf8"));
    else {
      let mod: { default?: unknown };
      try {
        mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
      } catch (e) {
        // `npx mangacli` without a local install: the config's `import ... from "mangacli"`
        // cannot resolve, so load a copy that points at this running copy of mangacli
        if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND" || !/['"]mangacli['"]/.test((e as Error).message)) throw e;
        const self = new URL(import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js", import.meta.url).href;
        const src = readFileSync(abs, "utf8").replace(/(from\s*|import\s*\(\s*)(["'])mangacli\2/g, (_m, a: string, q: string) => `${a}${q}${self}${q}`);
        const tmp = join(dirname(abs), `.${basename(abs).replace(/\.(\w+)$/, `.${process.pid}.$1`)}`);
        writeFileSync(tmp, src);
        try {
          mod = (await import(pathToFileURL(tmp).href)) as { default?: unknown };
        } finally {
          rmSync(tmp, { force: true });
        }
      }
      cfg = mod.default ?? mod;
    }
  } catch (e) {
    throw new MangaError("CONFIG_INVALID", `failed to load config ${abs}: ${(e as Error).message}`);
  }
  if (typeof cfg !== "object" || cfg === null) throw new MangaError("CONFIG_INVALID", `config ${abs} must export an object`);
  const c = cfg as MangaConfig;
  // paths in the config are relative to the config file
  const base = dirname(abs);
  const rel = (p?: string) => (p === undefined ? undefined : resolve(base, p));
  const out: MangaConfig & { __file: string } = { ...c, __file: abs };
  if (c.root) out.root = rel(c.root);
  if (c.fontDir) out.fontDir = rel(c.fontDir);
  if (c.fontCacheDir) out.fontCacheDir = rel(c.fontCacheDir);
  if (c.output?.dir) out.output = { ...c.output, dir: rel(c.output.dir) };
  if (c.assetPaths) out.assetPaths = c.assetPaths.map((p) => resolve(base, p));
  if (c.fonts) {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.fonts)) {
      if (typeof v === "string" && !v.startsWith("catalog:") && /[./\\]/.test(v)) f[k] = { src: resolve(base, v) };
      else if (typeof v === "string" && v.startsWith("catalog:")) f[k] = { catalog: v.slice(8).split("@")[0], weight: v.includes("@") ? Number(v.split("@")[1]) : undefined };
      else if (v && typeof v === "object" && typeof (v as Obj).src === "string") f[k] = { ...(v as Obj), src: resolve(base, (v as Obj).src as string) };
      else f[k] = v;
    }
    out.fonts = f;
  }
  if (Array.isArray(c.plugins)) {
    // module specifiers are resolved relative to the config file
    const plugins: unknown[] = [];
    for (const pl of c.plugins) {
      if (typeof pl !== "string") {
        plugins.push(pl);
        continue;
      }
      const spec = pl.startsWith(".") || pl.startsWith("/") ? pathToFileURL(resolve(base, pl)).href : pl;
      try {
        const mod = (await import(spec)) as { default?: unknown };
        plugins.push(mod.default ?? mod);
      } catch (e) {
        throw new MangaError("PLUGIN_LOAD_FAILED", `cannot load plugin "${pl}": ${(e as Error).message}`);
      }
    }
    out.plugins = plugins;
  }
  if (c.fontFallback) out.fontFallback = c.fontFallback.map((p) => (/[./\\]/.test(p) && !p.startsWith("catalog:") ? resolve(base, p) : p));
  return out;
}
