// Image filters (spec 5.6), applied to the pixels after resampling to the output resolution.
import sharp from "sharp";
import { parseColor } from "../core/color.js";
import { parseAngle, toMm } from "../core/units.js";
import { hash2, noise2 } from "../core/random.js";
import type { ImageFilter } from "./ir.js";
import { makeToneSampler } from "./screen.js";
import { distanceSquared } from "./edt.js";

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

export const FILTER_NAMES = new Set(["grayscale", "threshold", "levels", "brightness", "contrast", "saturate", "hue", "tint", "sepia", "invert", "blur", "motion-blur", "sharpen", "posterize", "halftone", "manga", "dither", "white-to-alpha"]);

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export interface MangaFilterContext {
  /** crop in source-asset pixels corresponding to the buffer passed to the filter */
  sourceRect?: { x: number; y: number; w: number; h: number };
  /** named regions in source-asset pixels */
  regions?: Record<string, [number, number, number, number]>;
}

/** resolution multiplier needed for a clean 60-ish lpi AM screen (six device px per cell) */
export function mangaResolutionBoost(filters: ImageFilter[], mmPerPx: number): number {
  let boost = 1;
  for (const f of filters) {
    if (f.name !== "manga") continue;
    const raw = f.opts?.lpi ?? f.args[0];
    const n = typeof raw === "string" ? parseFloat(raw) : Number(raw);
    const lpi = Number.isFinite(n) && n > 0 ? n : 60;
    const clean = (25.4 / Math.max(1, lpi)) / 6;
    boost = Math.max(boost, mmPerPx / clean);
  }
  return boost;
}

/** lower the effective screen ruling when the final output cannot resolve a 60-ish lpi dot cell */
export function mangaOutputFilters(filters: ImageFilter[], mmPerPx: number): ImageFilter[] {
  let changed = false;
  const out = filters.map((f) => {
    if (f.name !== "manga") return f;
    const raw = f.opts?.lpi ?? f.args[0];
    const n = typeof raw === "string" ? parseFloat(raw) : Number(raw);
    const lpi = Number.isFinite(n) && n > 0 ? n : 60;
    const cellPx = (25.4 / lpi) / mmPerPx;
    if (cellPx >= 3) return f;
    const adjusted = 25.4 / (mmPerPx * 4);
    if (adjusted >= lpi) return f;
    changed = true;
    return { ...f, opts: { ...(f.opts ?? {}), lpi: adjusted } };
  });
  return changed ? out : filters;
}

export async function applyFilters(px: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }, filters: ImageFilter[], mmPerPx: number, image?: MangaFilterContext): Promise<{ data: Uint8Array; width: number; height: number }> {
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
      case "manga":
        mangaFilter(data, w, h, mmPerPx, f, len, image);
        break;
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

type LenFn = (v: unknown, fallback: number) => number;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** circular morphological opening (erosion, then dilation) of a binary mask, using exact Euclidean distances */
function openMask(src: Uint8Array, w: number, h: number, size: number): Uint8Array {
  if (size <= 1) return Uint8Array.from(src);
  const n = w * h;
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = src[i] ? 0 : 1;
  const radius = size / 2;
  const rr = radius * radius;
  const clearance = distanceSquared(outside, w, h);
  const seed = new Uint8Array(n);
  for (let i = 0; i < n; i++) seed[i] = src[i] && clearance[i] >= rr ? 1 : 0;
  const grown = distanceSquared(seed, w, h);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i] && grown[i] <= rr ? 1 : 0;
  return out;
}

/** classify connected dark shapes as beta, so each accepted shape is toned as a whole */
function largeBetaMask(core: Uint8Array, lines: Uint8Array, w: number, h: number, size: number, mode: "background" | "all" | "none"): Uint8Array {
  const n = w * h;
  // cut pixel-wide connections before component labelling, without erasing the shape itself
  const cutSize = Math.max(3, Math.round(size * 0.08));
  const base = openMask(lines, w, h, cutSize);
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const areas: number[] = [];
  const solid: number[] = [];
  const touchesEdge: boolean[] = [];
  const outsideCore = new Uint8Array(n);
  for (let i = 0; i < n; i++) outsideCore[i] = core[i] ? 0 : 1;
  const clearance = distanceSquared(outsideCore, w, h);
  const radius = size / 2;
  const rr = radius * radius;
  for (let start = 0; start < n; start++) {
    if (!base[start] || comp[start] >= 0) continue;
    const label = areas.length;
    areas.push(0);
    solid.push(0);
    touchesEdge.push(false);
    let top = 0;
    comp[start] = label;
    stack[top++] = start;
    while (top) {
      const cur = stack[--top];
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesEdge[label] = true;
      areas[label]++;
      if (core[cur] && clearance[cur] >= rr) solid[label]++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const ni = y * w + x;
        if (!base[ni] || comp[ni] >= 0) continue;
        comp[ni] = label;
        stack[top++] = ni;
      }
    }
  }
  const minArea = Math.PI * rr * 0.5;
  const accepted = areas.map((area, i) => mode !== "none" && area >= minArea && solid[i] / area >= 0.05 && (mode === "all" || touchesEdge[i]));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (base[i] && accepted[comp[i]]) out[i] = 1;
  return out;
}

/** edge-preserving local mean of midtone density, suppressing raster/texture noise before quantization */
function smoothDensity(lum01: Float32Array, data: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  const radius = 2;
  const tolerance = 0.1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!data[i * 4 + 3]) continue;
    const center = lum01[i];
    let sum = 0;
    let count = 0;
    const ya = Math.max(0, y - radius);
    const yb = Math.min(h - 1, y + radius);
    const xa = Math.max(0, x - radius);
    const xb = Math.min(w - 1, x + radius);
    for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) {
      const j = yy * w + xx;
      if (!data[j * 4 + 3]) continue;
      const ly = lum01[j];
      if (Math.abs(ly - center) > tolerance) continue;
      sum += 1 - ly;
      count++;
    }
    out[i] = count ? sum / count : 1 - center;
  }
  return out;
}

/** replace tiny same-density midtone islands by the dominant neighbouring density */
function removeToneIslands(density: Float32Array, midtone: Uint8Array, w: number, h: number, mmPerPx: number) {
  const n = w * h;
  const minPixels = Math.max(4, Math.ceil(1 / (mmPerPx * mmPerPx)));
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const areas: number[] = [];
  const values: number[] = [];
  const votes: Map<number, number>[] = [];
  for (let start = 0; start < n; start++) {
    if (!midtone[start] || comp[start] >= 0) continue;
    const label = areas.length;
    const dv = density[start];
    areas.push(0);
    values.push(dv);
    votes.push(new Map());
    let top = 0;
    comp[start] = label;
    stack[top++] = start;
    while (top) {
      const cur = stack[--top];
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      areas[label]++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) {
          const vote = votes[label];
          vote.set(0, (vote.get(0) ?? 0) + 1);
          continue;
        }
        const ni = y * w + x;
        if (midtone[ni] && density[ni] === dv) {
          if (comp[ni] < 0) {
            comp[ni] = label;
            stack[top++] = ni;
          }
        } else {
          const nv = density[ni];
          const vote = votes[label];
          vote.set(nv, (vote.get(nv) ?? 0) + 1);
        }
      }
    }
  }
  const replace = new Float32Array(areas.length).fill(-1);
  for (let label = 0; label < areas.length; label++) {
    if (!values[label] || areas[label] >= minPixels) continue;
    let best = 0;
    let bestCount = -1;
    for (const [value, count] of votes[label]) {
      if (count > bestCount || (count === bestCount && value < best)) {
        best = value;
        bestCount = count;
      }
    }
    replace[label] = best;
  }
  for (let i = 0; i < n; i++) {
    const c = comp[i];
    if (c >= 0 && replace[c] >= 0) density[i] = replace[c];
  }
}

/** per-component vertical gradient density (0.8 at the top to 0.4 at the bottom) */
function betaGradient(mask: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const out = new Float32Array(n);
  const stack = new Int32Array(n);
  const boxes: { minY: number; maxY: number }[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || comp[start] >= 0) continue;
    const label = boxes.length;
    let top = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    comp[start] = label;
    stack[top++] = start;
    while (top) {
      const cur = stack[--top];
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const ni = y * w + x;
        if (!mask[ni] || comp[ni] >= 0) continue;
        comp[ni] = label;
        stack[top++] = ni;
      }
    }
    boxes.push({ minY, maxY });
  }
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const b = boxes[comp[i]];
    const y = Math.floor(i / w);
    const t = b.maxY <= b.minY ? 0.5 : (y - b.minY) / (b.maxY - b.minY);
    out[i] = 0.8 + (0.4 - 0.8) * t;
  }
  return out;
}

function mangaFilter(data: Uint8Array, w: number, h: number, mmPerPx: number, f: ImageFilter, len: LenFn, image?: MangaFilterContext) {
  const o = (f.opts ?? {}) as Obj;
  const numberOpt = (key: string, index: number, fallback: number) => {
    const v = o[key] ?? f.args[index];
    if (v === undefined) return fallback;
    const n = typeof v === "string" ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const defaults = [0.2, 0.3, 0.5];
  const rawTones = Array.isArray(o.tones) ? o.tones : defaults;
  const tones = [...new Set(rawTones.map((v) => clamp01(Number(v))).filter((v) => Number.isFinite(v)).sort((a, b) => a - b))];
  if (!tones.length) tones.push(...defaults);
  const lpi = Math.max(0.1, numberOpt("lpi", 0, 60));
  const angle = parseAngle((o.angle ?? f.args[1] ?? "45deg") as string | number);
  const line = clamp01(numberOpt("line", 2, 0.3));
  const beta = clamp01(numberOpt("beta", 3, 0.15));
  const betaSize = Math.max(1, Math.round(len(o.betaMinSize ?? f.args[4], 3)));
  const rawBetaTone = o.betaTone ?? f.args[5] ?? 0.7;
  const betaTone = rawBetaTone === "gradient" ? "gradient" : Math.max(0.6, Math.min(0.8, numberOpt("betaTone", 5, 0.7)));
  const paper = clamp01(numberOpt("paper", 9, 0.15));
  const rawBetaReplace = String(o.betaReplace ?? f.args[10] ?? "background");
  const betaReplace = rawBetaReplace === "all" || rawBetaReplace === "none" ? rawBetaReplace : "background";
  const cut = clamp01(numberOpt("cut", 6, 0));
  const grain = clamp01(numberOpt("grain", 7, 0));
  const seed = Math.floor(numberOpt("seed", 8, 1)) >>> 0;

  const n = w * h;
  const lum01 = new Float32Array(n);
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const y = lum(data[j], data[j + 1], data[j + 2]) / 255;
    lum01[i] = y;
    dark[i] = data[j + 3] && y < beta ? 1 : 0;
  }
  const lines = new Uint8Array(n);
  for (let i = 0; i < n; i++) lines[i] = data[i * 4 + 3] && lum01[i] < line ? 1 : 0;
  const large = largeBetaMask(dark, lines, w, h, betaSize, betaReplace);
  const grad = betaTone === "gradient" ? betaGradient(large, w, h) : null;
  const toneOutside = new Uint8Array(n);
  for (let i = 0; i < n; i++) toneOutside[i] = large[i] ? 0 : 1;
  const toneEdge = distanceSquared(toneOutside, w, h);
  const rimPx = Math.max(1, Math.round(0.25 / mmPerPx));
  const rimSq = rimPx * rimPx;

  const sr = image?.sourceRect;
  const sx = sr ? w / Math.max(1e-9, sr.w) : 1;
  const sy = sr ? h / Math.max(1e-9, sr.h) : 1;
  const ox = sr?.x ?? 0;
  const oy = sr?.y ?? 0;
  const rawKeep = o.keepBeta;
  const keepInput = rawKeep === undefined ? [] : Array.isArray(rawKeep) ? rawKeep : [rawKeep];
  const keepRects: [number, number, number, number][] = [];
  for (const entry of keepInput) {
    const rr = typeof entry === "string" ? image?.regions?.[entry] : entry;
    if (!Array.isArray(rr) || rr.length < 4) continue;
    const [rx, ry, rw, rh] = rr.slice(0, 4).map(Number);
    if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) continue;
    const x0 = (rx - ox) * sx;
    const y0 = (ry - oy) * sy;
    const x1 = x0 + rw * sx;
    const y1 = y0 + rh * sy;
    const xa = Math.max(0, Math.ceil(x0 - 0.5));
    const ya = Math.max(0, Math.ceil(y0 - 0.5));
    const xb = Math.min(w, Math.ceil(x1 - 0.5));
    const yb = Math.min(h, Math.ceil(y1 - 0.5));
    if (xa < xb && ya < yb) keepRects.push([xa, ya, xb, yb]);
  }
  const inKeep = (x: number, y: number) => {
    for (const [xa, ya, xb, yb] of keepRects) if (x >= xa && x < xb && y >= ya && y < yb) return true;
    return false;
  };

  const toneSteps = [...new Set([0, ...tones])].sort((a, b) => a - b);
  const boundaries: number[] = [];
  for (let i = 0; i + 1 < toneSteps.length; i++) boundaries.push((toneSteps[i] + toneSteps[i + 1]) / 2);
  const quantize = (d: number) => {
    let best = 0;
    let bd = Math.abs(d);
    for (const t of tones) {
      const dd = Math.abs(d - t);
      if (dd < bd) {
        best = t;
        bd = dd;
      }
    }
    return best;
  };

  const smooth = smoothDensity(lum01, data, w, h);
  const midtone = new Uint8Array(n);
  const density = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const alpha = data[i * 4 + 3];
    if (!alpha) continue;
    const yv = lum01[i];
    if (dark[i]) {
      if (large[i] && !inKeep(x, y)) density[i] = toneEdge[i] <= rimSq ? 1 : grad ? grad[i] : (betaTone as number);
      else density[i] = 1;
      continue;
    }
    if (yv < line) {
      density[i] = 1;
      continue;
    }
    let d = smooth[i];
    if (cut > 0 && boundaries.length) {
      let nearest = Infinity;
      for (const b of boundaries) nearest = Math.min(nearest, Math.abs(d - b));
      const width = 0.06;
      if (nearest < width) {
        const xmm = (x + 0.5) * mmPerPx;
        const ymm = (y + 0.5) * mmPerPx;
        const rough = noise2((seed + 17) >>> 0, xmm / 2.8, ymm / 2.8) / 1.414;
        d += rough * cut * 0.05 * (1 - nearest / width);
      }
    }
    density[i] = d < paper ? 0 : quantize(d);
    midtone[i] = 1;
  }
  removeToneIslands(density, midtone, w, h, mmPerPx);

  const target = { mmPerPx, toMm: (x: number, y: number): [number, number] => [(x + 0.5) * mmPerPx, (y + 0.5) * mmPerPx] };
  const sampler = makeToneSampler({ density: 0, lpi, angle, dot: "round", grain: 0.08, invert: false, offset: [0, 0], seed }, target, (xm, ym) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(xm / mmPerPx)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(ym / mmPerPx)));
    return density[y * w + x];
  });
  const ink = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = sampler(x, y) > 0.5 ? 1 : 0;

  if (grain > 0) {
    const before = Uint8Array.from(ink);
    const threshold = 1 - grain * 0.7;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v0 = before[i];
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (before[yy * w + xx] !== v0) {
          edge = true;
          break;
        }
      }
      if (!edge) continue;
      const xmm = (x + 0.5) * mmPerPx;
      const ymm = (y + 0.5) * mmPerPx;
      const smooth = noise2((seed + 101) >>> 0, xmm / 0.16, ymm / 0.16) / 1.414;
      const speck = (hash2((seed + 211) >>> 0, x, y) / 4294967296) * 2 - 1;
      const v = (smooth * 0.75 + speck * 0.25) / 0.78;
      if (v0 && v > threshold) ink[i] = 0;
      else if (!v0 && v < -threshold) ink[i] = 1;
    }
  }

  for (let i = 0; i < n; i++) {
    const v = ink[i] ? 0 : 255;
    const j = i * 4;
    data[j] = data[j + 1] = data[j + 2] = v;
  }
}
