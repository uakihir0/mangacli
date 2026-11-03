// Asset registry: metadata at prepare time, decoded pixels at render time (spec 3.14, 2.8).
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { isObj, looksLikePath } from "../load/normalize.js";

type Obj = Record<string, unknown>;

export interface AssetInfo {
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
  ) {}

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
        this.bag.error("SECURITY_NETWORK_DENIED", `network assets are disabled: ${src}`, { path });
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
