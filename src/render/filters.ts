// Image filters (spec 5.6), applied to the pixels after resampling to the output resolution.
import sharp from "sharp";
import { parseColor } from "../core/color.js";
import { parseAngle, toMm } from "../core/units.js";
import type { ImageFilter } from "./ir.js";
import { makeToneSampler } from "./screen.js";

type Obj = Record<string, unknown>;

/** "levels(0.05, 0.95)" | "grayscale" | { halftone: { lpi: 60 } } -> ImageFilter */
export function parseFilter(f: unknown): ImageFilter | null {
  if (typeof f === "string") {
    const m = f.trim().match(/^([a-z-]+)(?:\((.*)\))?$/);
    if (!m) return null;
    const args = m[2] ? m[2].split(",").map((a) => a.trim()).filter(Boolean).map((a) => (/^-?[\d.]+$/.test(a) ? Number(a) : a)) : [];
    return { name: m[1], args };
  }
  if (f && typeof f === "object") {
    const [name, v] = Object.entries(f as Obj)[0] ?? [];
    if (!name) return null;
    if (v && typeof v === "object" && !Array.isArray(v)) return { name, args: [], opts: v as Obj };
    return { name, args: Array.isArray(v) ? (v as (number | string)[]) : v === undefined || v === null || v === true ? [] : [v as number | string] };
  }
  return null;
}

export const FILTER_NAMES = new Set(["grayscale", "threshold", "levels", "brightness", "contrast", "saturate", "hue", "tint", "sepia", "invert", "blur", "motion-blur", "sharpen", "posterize", "halftone", "dither", "white-to-alpha"]);

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export async function applyFilters(px: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }, filters: ImageFilter[], mmPerPx: number): Promise<{ data: Uint8Array; width: number; height: number }> {
  let data = new Uint8Array(px.data);
  const { width: w, height: h } = px;
  const len = (v: unknown, fb: number) => (v === undefined ? fb : typeof v === "number" ? v : toMm(String(v), { units: "mm", dpi: 96, k: 1 })) / mmPerPx;
  for (const f of filters) {
    const o = (f.opts ?? {}) as Obj;
    const a = (i: number, key: string, fb: number) => {
      const v = o[key] ?? f.args[i];
      return v === undefined ? fb : Number(v);
    };
    switch (f.name) {
      case "grayscale":
        for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = lum(data[i], data[i + 1], data[i + 2]);
        break;
      case "threshold": {
        const t = a(0, "level", 0.5) * 255;
        for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = lum(data[i], data[i + 1], data[i + 2]) < t ? 0 : 255;
        break;
      }
      case "levels": {
        const b0 = a(0, "black", 0) * 255;
        const w0 = a(1, "white", 1) * 255;
        const gm = a(2, "gamma", 1);
        for (let i = 0; i < data.length; i += 4)
          for (let c = 0; c < 3; c++) data[i + c] = clamp(255 * Math.pow(Math.max(0, Math.min(1, (data[i + c] - b0) / Math.max(1, w0 - b0))), 1 / gm));
        break;
      }
      case "brightness": {
        const k = a(0, "amount", 1);
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp(data[i + c] * k);
        break;
      }
      case "contrast": {
        const k = a(0, "amount", 1);
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] - 128) * k + 128);
        break;
      }
      case "saturate": {
        const k = a(0, "amount", 1);
        for (let i = 0; i < data.length; i += 4) {
          const y = lum(data[i], data[i + 1], data[i + 2]);
          for (let c = 0; c < 3; c++) data[i + c] = clamp(y + (data[i + c] - y) * k);
        }
        break;
      }
      case "hue": {
        const ang = parseAngle((o.angle ?? f.args[0] ?? 0) as string);
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        // rotation about the grey axis
        const m = [
          0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
          0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283,
          0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
        ];
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          data[i] = clamp(m[0] * r + m[1] * g + m[2] * b);
          data[i + 1] = clamp(m[3] * r + m[4] * g + m[5] * b);
          data[i + 2] = clamp(m[6] * r + m[7] * g + m[8] * b);
        }
        break;
      }
      case "tint":
      case "sepia": {
        const col = f.name === "sepia" ? { r: 0.44, g: 0.26, b: 0.08 } : (parseColor(String(o.color ?? f.args[0] ?? "#704214")) ?? { r: 0.44, g: 0.26, b: 0.08 });
        const amt = f.name === "sepia" ? a(0, "amount", 1) : a(1, "amount", 1);
        for (let i = 0; i < data.length; i += 4) {
          const y = lum(data[i], data[i + 1], data[i + 2]) / 255;
          // duotone: dark tones take the tint colour, light tones stay paper
          const tr = 255 * cc(col.r, y);
          const tg = 255 * cc(col.g, y);
          const tb = 255 * cc(col.b, y);
          data[i] = clamp(data[i] + (tr - data[i]) * amt);
          data[i + 1] = clamp(data[i + 1] + (tg - data[i + 1]) * amt);
          data[i + 2] = clamp(data[i + 2] + (tb - data[i + 2]) * amt);
        }
        break;
      }
      case "invert":
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = 255 - data[i + c];
        break;
      case "blur":
      case "sharpen":
      case "motion-blur": {
        let img = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: w, height: h, channels: 4 } });
        if (f.name === "blur") img = img.blur(Math.max(0.3, len(o.radius ?? f.args[0], 1) / 2));
        else if (f.name === "sharpen") img = img.sharpen({ sigma: Math.max(0.5, a(0, "amount", 1)) });
        else {
          const L = Math.max(3, Math.round(len(o.length ?? f.args[1], 3)) | 1);
          const ang = parseAngle((o.angle ?? f.args[0] ?? 0) as string);
          const k = new Array(L * L).fill(0);
          const c = (L - 1) / 2;
          for (let t = -c; t <= c; t++) {
            const x = Math.round(c + Math.cos(ang) * t);
            const y = Math.round(c + Math.sin(ang) * t);
            k[y * L + x] = 1;
          }
          img = img.convolve({ width: L, height: L, kernel: k, scale: k.reduce((p, q) => p + q, 0) });
        }
        const out = await img.raw().toBuffer();
        data = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        break;
      }
      case "posterize": {
        const n = Math.max(2, Math.round(a(0, "levels", 4)));
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.round(Math.round((data[i + c] / 255) * (n - 1)) * (255 / (n - 1)));
        break;
      }
      case "halftone": {
        const lpi = a(0, "lpi", 60);
        const angle = parseAngle((o.angle ?? f.args[1] ?? "45deg") as string);
        const dens = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) dens[i] = 1 - lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / 255;
        const target = { mmPerPx, toMm: (x: number, y: number): [number, number] => [(x + 0.5) * mmPerPx, (y + 0.5) * mmPerPx] };
        const sampler = makeToneSampler({ density: 0, lpi, angle, dot: ((o.dot as string) ?? "round") as never, grain: 0.08, invert: false, offset: [0, 0], seed: 5 }, target, (x, y) => dens[Math.min(h - 1, Math.floor(y / mmPerPx)) * w + Math.min(w - 1, Math.floor(x / mmPerPx))]);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = sampler(x, y) > 0.5 ? 0 : 255;
          }
        break;
      }
      case "dither": {
        const method = String(o.method ?? f.args[0] ?? "floyd-steinberg");
        const g = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) g[i] = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            let v: number;
            if (method === "ordered") v = g[i] > ((BAYER[(y % 4) * 4 + (x % 4)] + 0.5) / 16) * 255 ? 255 : 0;
            else {
              v = g[i] < 128 ? 0 : 255;
              const e = g[i] - v;
              if (x + 1 < w) g[i + 1] += (e * 7) / 16;
              if (y + 1 < h) {
                if (x > 0) g[i + w - 1] += (e * 3) / 16;
                g[i + w] += (e * 5) / 16;
                if (x + 1 < w) g[i + w + 1] += e / 16;
              }
            }
            data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
          }
        break;
      }
      case "white-to-alpha": {
        const t = a(0, "threshold", 0.92) * 255;
        for (let i = 0; i < data.length; i += 4) {
          const y = lum(data[i], data[i + 1], data[i + 2]);
          if (y >= t) data[i + 3] = 0;
          else data[i + 3] = Math.min(data[i + 3], clamp(((t - y) / Math.max(1, t)) * 255 * 4));
        }
        break;
      }
    }
  }
  return { data, width: w, height: h };
}

function cc(c: number, y: number): number {
  // black -> tint colour (mid grey) -> paper
  return y < 0.5 ? c * (y / 0.5) : c + (1 - c) * ((y - 0.5) / 0.5);
}
