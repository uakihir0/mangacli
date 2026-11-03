// Asset registry: metadata at prepare time, decoded pixels at render time (spec 3.14, 2.8).
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { relative, resolve } from "node:path";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { isObj, looksLikePath } from "../load/normalize.js";

type Obj = Record<string, unknown>;

export interface AssetInfo {
  filters?: unknown[];
  key: string;
  name: string;
  src: string;
  kind: "art" | "lineart" | "background" | "photo" | "texture";
  width: number;
  height: number;
  ppi: number;
  character?: string;
  anchors: Record<string, [number, number]>;
  regions: Record<string, [number, number, number, number]>;
  crop?: [number, number, number, number];
  whiteToAlpha: number | false;
  blend?: string;
  data?: Uint8Array;
  missing?: boolean;
}

export class AssetRegistry {
  private infos = new Map<string, AssetInfo>();
  private pixelCache = new Map<string, { data: Buffer; width: number; height: number }>();

  constructor(
    private defs: Record<string, Obj>,
    private inline: Record<string, Uint8Array>,
    private bag: DiagnosticBag,
    private defaultPpi: number,
    private missingMode: "error" | "placeholder",
    private access: { root?: string; allowOutsideRoot?: boolean; network?: false | { hosts?: string[]; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean } } = {},
  ) {}

  /** fetch a URL asset under the network policy (spec 2.13): hosts, private addresses, size, timeout, redirects */
  private async fetchUrl(url: string, path?: (string | number)[]): Promise<Uint8Array | null> {
    const net = this.access.network;
    if (!net) {
      this.bag.error("SECURITY_NETWORK_DENIED", `network assets are disabled: ${url}`, { path, hint: "enable allowNetwork in the config or pass --allow-network" });
      return null;
    }
    const { lookup } = await import("node:dns/promises");
    const isPrivate = (ip: string) => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80)/i.test(ip);
    let cur = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(cur);
      if (u.protocol !== "https:" && u.protocol !== "http:") break;
      if (net.hosts && !net.hosts.includes(u.hostname)) {
        this.bag.error("SECURITY_NETWORK_DENIED", `host ${u.hostname} is not allowed: ${url}`, { path });
        return null;
      }
      if (!net.allowPrivate) {
        const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
        if (addrs.some((a) => isPrivate(a.address))) {
          this.bag.error("SECURITY_NETWORK_DENIED", `private address refused: ${u.hostname}`, { path });
          return null;
        }
      }
      try {
        const res = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(net.timeoutMs ?? 15000) });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          cur = new URL(res.headers.get("location")!, cur).href;
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > (net.maxBytes ?? 50e6)) {
          this.bag.error("ASSET_TOO_LARGE", `asset ${url} is larger than ${net.maxBytes ?? 50e6} bytes`, { path });
          return null;
        }
        return buf;
      } catch (e) {
        this.bag.error("ASSET_NOT_FOUND", `cannot fetch ${url}: ${(e as Error).message}`, { path });
        return null;
      }
    }
    this.bag.error("SECURITY_NETWORK_DENIED", `too many redirects: ${url}`, { path });
    return null;
  }

  /** `soft`: a placeholder is drawn on purpose, so a missing file is only informational */
  async info(ref: string, path?: (string | number)[], soft = false): Promise<AssetInfo | null> {
    const hit = this.infos.get(ref);
    if (hit) return hit;
    const def = this.defs[ref];
    let src: string;
    let o: Obj = {};
    if (def) {
      o = def;
      src = String(def.src);
    } else if (this.inline[ref]) src = `inline:${ref}`;
    else if (looksLikePath(ref)) src = ref;
    else {
      this.report(`unknown asset "${ref}"`, path, soft);
      return this.missing(ref);
    }
    let data: Uint8Array | undefined = this.inline[ref] ?? (def && this.inline[String(def.src)]);
    if (!data) {
      if (src.startsWith("data:")) {
        const m = src.match(/^data:[^;]+;base64,(.*)$/);
        if (m) data = Buffer.from(m[1], "base64");
      } else if (/^https?:/.test(src)) {
        const got = await this.fetchUrl(src, path);
        if (!got) return this.missing(ref);
        data = got;
      } else if (this.access.root && !this.access.allowOutsideRoot && !src.startsWith("inline:") && relative(this.access.root, resolve(src)).startsWith("..")) {
        this.bag.error("SECURITY_PATH_OUTSIDE_ROOT", `asset outside the project root: ${src}`, { path, hint: "set allowOutsideRoot or move the file under the root" });
        return this.missing(ref);
      } else if (!existsSync(src)) {
        this.report(`asset file not found: ${src}`, path, soft);
        return this.missing(ref);
      } else data = readFileSync(src);
    }
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(data).metadata();
    } catch (e) {
      this.bag.error("ASSET_DECODE_FAILED", `cannot decode asset ${ref}: ${(e as Error).message}`, { path });
      return this.missing(ref);
    }
    const crop = Array.isArray(o.crop) ? (o.crop as [number, number, number, number]) : undefined;
    const info: AssetInfo = {
      key: ref,
      name: ref,
      src,
      kind: (o.kind as AssetInfo["kind"]) ?? "art",
      width: meta.width ?? 1,
      height: meta.height ?? 1,
      ppi: typeof o.ppi === "number" ? o.ppi : meta.density && meta.density > 72 ? meta.density : this.defaultPpi,
      character: o.character as string | undefined,
      anchors: (isObj(o.anchors) ? o.anchors : {}) as AssetInfo["anchors"],
      regions: (isObj(o.regions) ? o.regions : {}) as AssetInfo["regions"],
      crop,
      whiteToAlpha: o.whiteToAlpha === true ? 0.92 : typeof o.whiteToAlpha === "number" ? o.whiteToAlpha : false,
      blend: o.blend as string | undefined,
      filters: Array.isArray(o.filters) ? (o.filters as unknown[]) : undefined,
      data,
    };
    this.infos.set(ref, info);
    return info;
  }

  private report(msg: string, path?: (string | number)[], soft = false) {
    if (soft) this.bag.info("ASSET_NOT_FOUND", `${msg} (placeholder drawn)`, { path });
    else if (this.missingMode === "placeholder") this.bag.warn("ASSET_NOT_FOUND", msg, { path });
    else this.bag.error("ASSET_NOT_FOUND", msg, { path });
  }

  private missing(ref: string): AssetInfo {
    const info: AssetInfo = { key: ref, name: ref, src: "", kind: "art", width: 1000, height: 1400, ppi: this.defaultPpi, anchors: {}, regions: {}, whiteToAlpha: false, missing: true };
    this.infos.set(ref, info);
    return info;
  }

  get(ref: string): AssetInfo | undefined {
    return this.infos.get(ref);
  }

  /** decoded RGBA pixels resized to (w,h) of the source crop */
  async pixels(ref: string, outW: number, outH: number, src: { x: number; y: number; w: number; h: number }): Promise<{ data: Buffer; width: number; height: number } | null> {
    const info = this.infos.get(ref);
    if (!info || !info.data) return null;
    const w = Math.max(1, Math.round(outW));
    const h = Math.max(1, Math.round(outH));
    const key = `${ref}|${w}x${h}|${src.x},${src.y},${src.w},${src.h}`;
    const hit = this.pixelCache.get(key);
    if (hit) return hit;
    let img = sharp(info.data, { limitInputPixels: 300_000_000 }).rotate();
    const ex = { left: Math.max(0, Math.round(src.x)), top: Math.max(0, Math.round(src.y)), width: Math.max(1, Math.round(src.w)), height: Math.max(1, Math.round(src.h)) };
    ex.width = Math.min(ex.width, info.width - ex.left);
    ex.height = Math.min(ex.height, info.height - ex.top);
    if (ex.left !== 0 || ex.top !== 0 || ex.width !== info.width || ex.height !== info.height) img = img.extract(ex);
    img = img.resize(w, h, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().toColourspace("srgb");
    const { data, info: oi } = await img.raw().toBuffer({ resolveWithObject: true });
    if (info.whiteToAlpha !== false) {
      const th = info.whiteToAlpha * 255;
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (lum >= th) data[i + 3] = 0;
        else if (lum > th - 40) data[i + 3] = Math.round(data[i + 3] * ((th - lum) / 40));
      }
    }
    const res = { data, width: oi.width, height: oi.height };
    if (this.pixelCache.size > 64) this.pixelCache.clear();
    this.pixelCache.set(key, res);
    return res;
  }
}
