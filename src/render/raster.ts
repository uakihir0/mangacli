// Raster backend (Skia via @napi-rs/canvas) with tone screening and mono pipeline (spec 2.6, 10.2, 10.3).
import { type Canvas, type SKRSContext2D, Path2D, createCanvas } from "@napi-rs/canvas";
import { type RGBA, cssColor, luminanceLinear, srgbToLinear, linearToSrgb } from "../core/color.js";
import type { PathData } from "../geom/path.js";
import { type Matrix, type Rect, applyMat, matMul } from "../geom/vec.js";
import type { AssetRegistry } from "./assets.js";
import type { DisplayList, GroupNode, ImageNode, Node, Paint, PathNode, ToneSpec } from "./ir.js";
import { makeBinaryRoundToneSampler, makeToneSampler } from "./screen.js";
import { distanceSquared } from "./edt.js";
import { applyFilters } from "./filters.js";

export type ColorMode = "color" | "gray" | "mono";
export type ToneRendering = "dots" | "flat" | "auto";

export interface RasterOptions {
  dpi: number;
  crop: "trim" | "bleed" | "marks";
  marks?: { margin?: number; length?: number; width?: number };
  maxPixels?: number;
  /** 1-bit: screen ruling for images (overrides the element's) and dither mode */
  imageLpi?: number;
  monoImages?: "screen" | "dither";
  colorMode: ColorMode;
  toneRendering: ToneRendering;
  monoLpi: number;
  toneCurve: "linear" | "perceptual";
  transparent?: boolean;
  /** filter nodes by separation */
  separations?: string[];
  assets: AssetRegistry;
}

export interface RasterResult {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
  dpi: number;
}

interface Dev {
  ctx: SKRSContext2D;
  /** mm (display-list space) -> device px */
  base: Matrix;
  opts: RasterOptions;
  scale: number; // px per mm
  W: number;
  H: number;
  /** Logical device frame; only the destination canvas is offset. */
  offsetX: number;
}

function buildPath(pd: PathData): Path2D {
  const p = new Path2D();
  for (const c of pd) {
    switch (c[0]) {
      case "M":
        p.moveTo(c[1], c[2]);
        break;
      case "L":
        p.lineTo(c[1], c[2]);
        break;
      case "Q":
        p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
        break;
      case "C":
        p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case "Z":
        p.closePath();
        break;
    }
  }
  return p;
}

function pathBounds(pd: PathData, m: Matrix): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of pd) {
    for (let i = 1; i + 1 < c.length; i += 2) {
      const q = applyMat(m, { x: c[i] as number, y: c[i + 1] as number });
      if (q.x < x0) x0 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.x > x1) x1 = q.x;
      if (q.y > y1) y1 = q.y;
    }
  }
  if (!isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

/** device-space bounds of a node */
function nodeBounds(n: Node, m: Matrix): Rect | null {
  if (n.kind === "path") {
    const b = pathBounds(n.path, m);
    if (b && n.stroke) {
      const s = n.stroke.width * Math.hypot(m[0], m[1]);
      return { x: b.x - s, y: b.y - s, w: b.w + 2 * s, h: b.h + 2 * s };
    }
    return b;
  }
  if (n.kind === "image") {
    const mm = matMul(m, n.transform ?? [1, 0, 0, 1, 0, 0]);
    const d = n.dest;
    const ext = n.outline?.length ? n.outline[0].w : 0;
    const b = pathBounds([["M", d.x - ext, d.y - ext], ["L", d.x + d.w + ext, d.y - ext], ["L", d.x + d.w + ext, d.y + d.h + ext], ["L", d.x - ext, d.y + d.h + ext]], mm);
    return b;
  }
  const mm = n.transform ? matMul(m, n.transform) : m;
  if (n.clip) return pathBounds(n.clip, mm);
  let r: Rect | null = null;
  for (const c of n.children) r = union(r, nodeBounds(c, mm));
  return r;
}

function clampRect(r: Rect, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  const x0 = Math.max(0, Math.floor(r.x) - 1);
  const y0 = Math.max(0, Math.floor(r.y) - 1);
  const x1 = Math.min(W, Math.ceil(r.x + r.w) + 1);
  const y1 = Math.min(H, Math.ceil(r.y + r.h) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function setDeviceM(dev: Dev, m: Matrix = [1, 0, 0, 1, 0, 0]) {
  dev.ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - dev.offsetX, m[5]);
}

function blit(dev: Dev, canvas: Canvas, x: number, y: number) {
  const left = Math.max(0, dev.offsetX - x);
  const right = Math.min(canvas.width, dev.offsetX + dev.ctx.canvas.width - x);
  if (right > left) dev.ctx.drawImage(canvas, left, 0, right - left, canvas.height, x + left, y, right - left, canvas.height);
}

function setM(ctx: SKRSContext2D, m: Matrix) {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

function grayize(c: RGBA, mode: ColorMode): RGBA {
  if (mode === "color") return c;
  const y = linearToSrgb(luminanceLinear(c));
  return { r: y, g: y, b: y, a: c.a };
}

function toneFlatColor(spec: ToneSpec, color: RGBA, mode: ColorMode): string {
  const d = spec.gradient ? spec.gradient.stops.reduce((a, s) => a + s[1], 0) / spec.gradient.stops.length : spec.density;
  const dd = spec.invert ? 1 - d : d;
  // linear-light average of tone color over white
  const c = grayize(color, mode);
  const mix = (v: number) => linearToSrgb(dd * srgbToLinear(v) + (1 - dd));
  return cssColor({ r: mix(c.r), g: mix(c.g), b: mix(c.b), a: 1 });
}

/** Japanese-style crop marks (トンボ): double corner marks on the trim and bleed lines, center crosses (spec 10.6) */
function drawCropMarks(ctx: SKRSContext2D, trim: { x: number; y: number; w: number; h: number }, bleedPx: number, s: number, m?: { length?: number; width?: number }) {
  const L = (m?.length ?? 9) * s;
  const lw = Math.max(1, (m?.width ?? 0.1) * s);
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = lw;
  ctx.lineCap = "butt";
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const b = bleedPx;
  const x0 = trim.x;
  const y0 = trim.y;
  const x1 = trim.x + trim.w;
  const y1 = trim.y + trim.h;
  for (const [cx, cy, dx, dy] of [
    [x0, y0, -1, -1],
    [x1, y0, 1, -1],
    [x0, y1, -1, 1],
    [x1, y1, 1, 1],
  ] as const) {
    const ox = cx + dx * b;
    const oy = cy + dy * b;
    // horizontal: on the trim line and on the bleed line, outside the bleed
    line(ox, cy, ox + dx * L, cy);
    line(cx, oy, cx + dx * (b + L), oy);
    // vertical
    line(cx, oy, cx, oy + dy * L);
    line(ox, cy, ox, cy + dy * (b + L));
  }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const c = L * 0.5;
  // center marks
  line(mx, y0 - b, mx, y0 - b - L);
  line(mx - c, y0 - b - L * 0.5, mx + c, y0 - b - L * 0.5);
  line(mx, y1 + b, mx, y1 + b + L);
  line(mx - c, y1 + b + L * 0.5, mx + c, y1 + b + L * 0.5);
  line(x0 - b, my, x0 - b - L, my);
  line(x0 - b - L * 0.5, my - c, x0 - b - L * 0.5, my + c);
  line(x1 + b, my, x1 + b + L, my);
  line(x1 + b + L * 0.5, my - c, x1 + b + L * 0.5, my + c);
  ctx.restore();
}

export class RasterBackend {
  constructor(private opts: RasterOptions) {}

  async render(list: DisplayList, viewport?: { x: number; width: number }): Promise<RasterResult> {
    const o = this.opts;
    const s = o.dpi / 25.4;
    const trimW = list.boxes.trim.w;
    const trimH = list.boxes.trim.h;
    const bleed = -list.boxes.bleed.x;
    const trimPxW = Math.round(trimW * s + 1e-6);
    const trimPxH = Math.round(trimH * s + 1e-6);
    const bleedOnly = o.crop === "bleed" || o.crop === "marks" ? Math.round(bleed * s + 1e-6) : 0;
    const markMm = o.marks?.margin ?? 10;
    const markPx = o.crop === "marks" ? Math.round(markMm * s + 1e-6) : 0;
    const bleedPx = bleedOnly + markPx;
    const W = viewport?.width ?? trimPxW + 2 * bleedPx;
    const H = trimPxH + 2 * bleedPx;
    if (W * H > (o.maxPixels ?? 200_000_000)) throw new Error(`OUTPUT_TOO_LARGE: ${W}x${H} exceeds maxOutputPixels`);
    const sx = trimPxW / trimW;
    const sy = trimPxH / trimH;
    // display list coords are bleed-origin mm: px = (x - bleed) * sx + bleedPx
    const base: Matrix = [sx, 0, 0, sy, bleedPx - bleed * sx, bleedPx - bleed * sy];
    // Keep vector antialiasing independent of the canvas edge at the fold.
    const halo = viewport ? 1 : 0;
    const canvas = createCanvas(W + 2 * halo, H);
    const ctx = canvas.getContext("2d");
    if (!o.transparent) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, H);
    }
    const dev: Dev = { ctx, base, offsetX: (viewport?.x ?? 0) - halo, opts: o, scale: (sx + sy) / 2, W: trimPxW + 2 * bleedPx, H };
    if (markPx) {
      // artwork stops at the bleed line; the margin holds the crop marks
      ctx.save();
      ctx.beginPath();
      ctx.rect(markPx, markPx, W - 2 * markPx, H - 2 * markPx);
      ctx.clip();
      await this.drawNode(dev, list.root, base, canvas);
      ctx.restore();
      drawCropMarks(ctx, { x: bleedPx, y: bleedPx, w: trimPxW, h: trimPxH }, bleedOnly, s, o.marks);
    } else await this.drawNode(dev, list.root, base, canvas);
    const result = this.result(canvas, halo, W);
    canvas.width = canvas.height = 1;
    return result;
  }

  addMarks(raster: { data: Uint8ClampedArray; width: number; height: number }, bleed: number): RasterResult {
    const o = this.opts;
    const s = o.dpi / 25.4;
    const margin = Math.round((o.marks?.margin ?? 10) * s + 1e-6);
    const b = Math.round(bleed * s + 1e-6);
    const W = raster.width + 2 * margin;
    const H = raster.height + 2 * margin;
    if (W * H > (o.maxPixels ?? 200_000_000)) throw new Error(`OUTPUT_TOO_LARGE: ${W}x${H} exceeds maxOutputPixels`);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    if (!o.transparent) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
    }
    if (margin) drawCropMarks(ctx, { x: margin + b, y: margin + b, w: raster.width - 2 * b, h: raster.height - 2 * b }, b, s, o.marks);
    const result = this.result(canvas);
    for (let y = 0; y < raster.height; y++) {
      result.data.set(raster.data.subarray(y * raster.width * 4, (y + 1) * raster.width * 4), ((y + margin) * W + margin) * 4);
    }
    return result;
  }

  private result(canvas: Canvas, x = 0, width = canvas.width): RasterResult {
    const o = this.opts;
    const W = width;
    const H = canvas.height;
    const img = canvas.getContext("2d").getImageData(x, 0, W, H);
    const data = img.data;
    if (o.colorMode === "mono") {
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        const v = lum * a + (o.transparent ? 0 : 1 - a);
        const bw = v < 0.5 ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = bw;
        if (!o.transparent) data[i + 3] = 255;
        else data[i + 3] = a > 0.5 ? 255 : 0;
      }
    } else if (o.colorMode === "gray") {
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        data[i] = data[i + 1] = data[i + 2] = y;
      }
    }
    return { width: W, height: H, data, dpi: o.dpi };
  }

  private visible(n: Node): boolean {
    const seps = this.opts.separations;
    if (!seps || !n.tag) return true;
    if (n.kind === "group" && !n.tag) return true;
    return seps.includes(n.tag.separation);
  }

  private async drawNode(dev: Dev, n: Node, m: Matrix, canvas: Canvas): Promise<void> {
    const ctx = dev.ctx;
    if (n.kind === "group") return this.drawGroup(dev, n, m, canvas);
    if (this.opts.separations && n.tag && !this.opts.separations.includes(n.tag.separation)) return;
    if (n.kind === "path") return this.drawPath(dev, n, m);
    if (n.kind === "image") return this.drawImage(dev, n, m);
    void ctx;
  }

  private async drawGroup(dev: Dev, g: GroupNode, m: Matrix, canvas: Canvas): Promise<void> {
    const ctx = dev.ctx;
    const mm = g.transform ? matMul(m, g.transform) : m;
    if (this.opts.separations && g.tag && g.tag.role === "background" && !this.opts.separations.includes("background")) return;
    const needOff = (g.opacity !== undefined && g.opacity < 0.999) || (g.blend && g.blend !== "normal") || !!g.alphaMaskOf || !!g.softClip || !!g.isolate;
    if (!needOff) {
      if (g.clip) {
        ctx.save();
        setDeviceM(dev, mm);
        ctx.clip(buildPath(g.clip), g.clipRule ?? "nonzero");
        for (const c of g.children) await this.drawNode(dev, c, mm, canvas);
        ctx.restore();
      } else for (const c of g.children) await this.drawNode(dev, c, mm, canvas);
      return;
    }
    const b = nodeBounds(g, m);
    const r = b ? clampRect(b, dev.W, dev.H) : null;
    if (!r) return;
    const off = createCanvas(r.w, r.h);
    const octx = off.getContext("2d");
    const shift: Matrix = [1, 0, 0, 1, -r.x, -r.y];
    const sub: Dev = { ...dev, ctx: octx, W: r.w, H: r.h, offsetX: 0, base: matMul(shift, dev.base) };
    const subM = matMul(shift, mm);
    if (g.clip) {
      octx.save();
      setM(octx, subM);
      octx.clip(buildPath(g.clip), g.clipRule ?? "nonzero");
    }
    for (const c of g.children) await this.drawNode(sub, c, subM, off);
    if (g.clip) octx.restore();
    if (g.alphaMaskOf) await this.applyAlphaMask(sub, g.alphaMaskOf, matMul(shift, m), off);
    let maskData: Uint8ClampedArray | null = null;
    if (g.softClip) {
      const mc = createCanvas(r.w, r.h);
      const mctx = mc.getContext("2d");
      const blurPx = Math.max(0.5, g.softClip.feather * dev.scale);
      mctx.filter = `blur(${blurPx / 2}px)`;
      setM(mctx, matMul(shift, m));
      mctx.fillStyle = "#fff";
      mctx.fill(buildPath(g.softClip.path), g.softClip.fillRule);
      if (dev.opts.colorMode === "mono") maskData = mctx.getImageData(0, 0, r.w, r.h).data;
      else {
        octx.save();
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.globalCompositeOperation = "destination-in";
        octx.drawImage(mc, 0, 0);
        octx.restore();
      }
    }
    let op = g.opacity ?? 1;
    if (dev.opts.colorMode === "mono" && (op < 0.999 || g.softClip)) {
      // screen the (partial) coverage into dots instead of grey edges
      const id = octx.getImageData(0, 0, r.w, r.h);
      const data = id.data;
      const fwd = matMul(shift, dev.base);
      // coverage to screen: the soft mask (× opacity); line art inside stays solid
      const alphaAt = (xmm: number, ymm: number) => {
        const q = applyMat(fwd, { x: xmm, y: ymm });
        const px = Math.min(r.w - 1, Math.max(0, Math.floor(q.x)));
        const py = Math.min(r.h - 1, Math.max(0, Math.floor(q.y)));
        const i = (py * r.w + px) * 4 + 3;
        return (maskData ? maskData[i] / 255 : 1) * op;
      };
      const sampler = makeToneSampler({ density: op, lpi: dev.opts.monoLpi, angle: Math.PI / 4, dot: "round", grain: 0.08, invert: false, offset: [0, 0], seed: 7 }, this.target(dev, r), alphaAt);
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const i = (y * r.w + x) * 4;
          if (data[i + 3] === 0) continue;
          const full = maskData ? maskData[i + 3] >= 250 && op >= 0.999 : false;
          data[i + 3] = data[i + 3] >= 96 && (full || sampler(x, y)) ? 255 : 0;
        }
      octx.putImageData(id, 0, 0);
      op = 1;
    }
    ctx.save();
    setDeviceM(dev);
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = (g.blend && g.blend !== "normal" ? g.blend : "source-over") as never;
    blit(dev, off, r.x, r.y);
    ctx.restore();
  }

  private target(dev: Dev, r: { x: number; y: number }) {
    // device px (within offscreen at offset r) -> page mm (display-list coords minus bleed origin shift handled by base)
    const inv = invert(dev.base);
    return {
      toMm: (px: number, py: number): [number, number] => {
        const q = applyMat(inv, { x: px + r.x + 0.5, y: py + r.y + 0.5 });
        return [q.x, q.y];
      },
      mmPerPx: 1 / dev.scale,
    };
  }

  private async applyAlphaMask(dev: Dev, mask: NonNullable<GroupNode["alphaMaskOf"]>, m: Matrix, off: Canvas) {
    const info = this.opts.assets.get(mask.assetKey);
    if (!info) return;
    const mm = matMul(m, mask.matrix);
    const sc = Math.hypot(mm[0], mm[1]);
    const pix = await this.opts.assets.pixels(mask.assetKey, mask.w * sc, mask.h * Math.hypot(mm[2], mm[3]), { x: 0, y: 0, w: mask.w, h: mask.h });
    if (!pix) return;
    const tmp = createCanvas(pix.width, pix.height);
    const tctx = tmp.getContext("2d");
    const id = tctx.createImageData(pix.width, pix.height);
    id.data.set(pix.data);
    tctx.putImageData(id, 0, 0);
    const octx = off.getContext("2d");
    octx.save();
    // invert: keep everything except the silhouette (effects cleared around a figure)
    octx.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
    const k: Matrix = matMul(mm, [mask.w / pix.width, 0, 0, mask.h / pix.height, 0, 0]);
    setM(octx, k);
    if (mask.dilate && mask.dilate > 0) octx.filter = `blur(${Math.max(0.5, (mask.dilate * dev.scale) / 2)}px)`;
    octx.drawImage(tmp, 0, 0);
    if (mask.dilate && mask.dilate > 0) {
      // a second pass hardens the blurred silhouette into a slightly grown one
      octx.filter = "none";
      octx.drawImage(tmp, 0, 0);
    }
    octx.restore();
  }

  private paintStyle(dev: Dev, p: Paint): unknown {
    const mode = dev.opts.colorMode;
    if (p.type === "solid") return cssColor(grayize(p.color, mode));
    if (p.type === "linear-gradient" || p.type === "radial-gradient") {
      const ctx = dev.ctx;
      const g = p.type === "linear-gradient" ? ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1) : ctx.createRadialGradient(p.cx, p.cy, 0, p.cx, p.cy, p.r);
      for (const st of p.stops) g.addColorStop(Math.min(1, Math.max(0, st.offset)), cssColor(grayize(st.color, mode)));
      return g;
    }
    return null;
  }

  private needsScreen(dev: Dev, p: Paint): boolean {
    if (dev.opts.colorMode !== "mono") return false;
    if (p.type === "solid") {
      const y = linearToSrgb(luminanceLinear(p.color));
      return y > 0.05 && y < 0.95 && p.color.a > 0.01;
    }
    return p.type !== "tone";
  }

  private async drawPath(dev: Dev, n: PathNode, m: Matrix): Promise<void> {
    const ctx = dev.ctx;
    if (n.stroke) {
      ctx.save();
      setDeviceM(dev, m);
      const st = this.paintStyle(dev, n.stroke.paint);
      if (st) ctx.strokeStyle = st as string;
      ctx.lineWidth = n.stroke.width;
      ctx.lineJoin = n.stroke.join;
      ctx.lineCap = "round";
      ctx.stroke(buildPath(n.path));
      ctx.restore();
    }
    const p = n.paint;
    if (!p) return;
    if (p.type === "tone" || this.needsScreen(dev, p)) return this.drawTone(dev, n, m, p);
    if (dev.offsetX && n.path.some((c) => c[0] === "C" || c[0] === "Q")) {
      const b = pathBounds(n.path, m);
      const r = b && clampRect(b, dev.W, dev.H);
      if (!r) return;
      const off = createCanvas(r.w, r.h);
      const octx = off.getContext("2d");
      const path = buildPath(n.path).transform({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
      setM(octx, [m[0], m[1], m[2], m[3], m[4] - r.x, m[5] - r.y]);
      octx.fillStyle = this.paintStyle({ ...dev, ctx: octx }, p) as string;
      octx.setTransform(1, 0, 0, 1, -r.x, -r.y);
      octx.fill(path, n.fillRule);
      ctx.save();
      setDeviceM(dev);
      blit(dev, off, r.x, r.y);
      ctx.restore();
      off.width = off.height = 1;
      return;
    }
    ctx.save();
    setDeviceM(dev, m);
    const st = this.paintStyle(dev, p);
    if (st) ctx.fillStyle = st as string;
    ctx.fill(buildPath(n.path), n.fillRule);
    ctx.restore();
  }

  private async drawTone(dev: Dev, n: PathNode, m: Matrix, p: Paint, tile?: Rect): Promise<void> {
    const ctx = dev.ctx;
    const mode = dev.opts.colorMode;
    const b = pathBounds(n.path, m);
    if (!b) return;
    const r = tile ?? clampRect(b, dev.W, dev.H);
    if (!r) return;
    if (!tile && p.type === "tone" && !p.tone.softEdge && r.w * r.h > 1_000_000) {
      // Pointwise screens need no neighboring pixels; retain logical coordinates.
      const x = Math.max(r.x, dev.offsetX);
      const end = Math.min(r.x + r.w, dev.offsetX + ctx.canvas.width);
      if (end <= x) return;
      for (let y = r.y; y < r.y + r.h; y += 128)
        await this.drawTone(dev, n, m, p, { x, y, w: end - x, h: Math.min(128, r.y + r.h - y) });
      return;
    }
    let spec: ToneSpec;
    let color: RGBA = { r: 0, g: 0, b: 0, a: 1 };
    let densityFn: ((x: number, y: number) => number) | undefined;
    let alphaFn: ((x: number, y: number) => number) | undefined;
    if (p.type === "tone") {
      spec = p.tone;
      color = p.color;
    } else {
      // mono conversion of gray/gradient fills: screen luminance
      // spatter: irregular white-ink specks instead of a regular dot screen
      const spatter = (p.type === "linear-gradient" || p.type === "radial-gradient") && p.screen === "spatter";
      spec = { density: 0, lpi: dev.opts.monoLpi, angle: Math.PI / 4, dot: spatter ? "noise" : "round", grain: spatter ? 0.18 : 0.08, invert: false, offset: [0, 0], seed: 3 };
      const off0 = createCanvas(r.w, r.h);
      const o0 = off0.getContext("2d");
      setM(o0, matMul([1, 0, 0, 1, -r.x, -r.y], m));
      const st = this.paintStyle({ ...dev, ctx: o0, opts: { ...dev.opts, colorMode: "color" } }, p);
      if (st) o0.fillStyle = st as string;
      o0.fill(buildPath(n.path), n.fillRule);
      const lumData = o0.getImageData(0, 0, r.w, r.h).data;
      const inv = invert(dev.base);
      const fwd = dev.base;
      densityFn = (x, y) => {
        const q = applyMat(fwd, { x, y });
        const px = Math.min(r.w - 1, Math.max(0, Math.floor(q.x - r.x)));
        const py = Math.min(r.h - 1, Math.max(0, Math.floor(q.y - r.y)));
        const i = (py * r.w + px) * 4;
        const lin = 0.2126 * srgbToLinear(lumData[i] / 255) + 0.7152 * srgbToLinear(lumData[i + 1] / 255) + 0.0722 * srgbToLinear(lumData[i + 2] / 255);
        const y2 = dev.opts.toneCurve === "perceptual" ? linearToSrgb(lin) : lin;
        return 1 - y2;
      };
      // translucent fills (gradients fading to transparent): coverage is screened separately
      let translucent = false;
      for (let i = 3; i < lumData.length; i += 4 * 7) if (lumData[i] < 250) {
        translucent = true;
        break;
      }
      if (translucent)
        alphaFn = (x, y) => {
          const q = applyMat(fwd, { x, y });
          const px = Math.min(r.w - 1, Math.max(0, Math.floor(q.x - r.x)));
          const py = Math.min(r.h - 1, Math.max(0, Math.floor(q.y - r.y)));
          return lumData[(py * r.w + px) * 4 + 3] / 255;
        };
      void inv;
    }
    const cellPx = (25.4 / Math.max(1, spec.lpi)) * dev.scale;
    const flat = mode !== "mono" && (dev.opts.toneRendering === "flat" || (dev.opts.toneRendering === "auto" && cellPx < 6));
    ctx.save();
    setDeviceM(dev, m);
    ctx.clip(buildPath(n.path), n.fillRule);
    if (flat && p.type === "tone" && !spec.gradient && !spec.softEdge) {
      ctx.fillStyle = toneFlatColor(spec, color, mode);
      setDeviceM(dev);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
      return;
    }
    // soft edge mask
    let soft: Uint8ClampedArray | null = null;
    if (spec.softEdge && spec.softEdge > 0) {
      const mc = createCanvas(r.w, r.h);
      const mctx = mc.getContext("2d");
      const blurPx = Math.max(1, spec.softEdge * dev.scale);
      mctx.filter = `blur(${blurPx / 2}px)`;
      setM(mctx, matMul([1, 0, 0, 1, -r.x, -r.y], m));
      // shrink path by drawing it and eroding via blur: draw solid, then blur
      mctx.fillStyle = "#fff";
      mctx.fill(buildPath(n.path), n.fillRule);
      soft = mctx.getImageData(0, 0, r.w, r.h).data;
    }
    const target = this.target(dev, r);
    const gradDensity = flat && spec.gradient ? true : false;
    const origin = applyMat(dev.base, { x: spec.offset[0], y: spec.offset[1] });
    const binaryRound = mode === "mono" && p.type === "tone" && spec.dot === "round"
      ? makeBinaryRoundToneSampler(spec, cellPx, 0.5 - origin.x, 0.5 - origin.y, (x, y) => target.toMm(x - r.x, y - r.y))
      : undefined;
    const sampler = binaryRound ? (x: number, y: number) => binaryRound(x + r.x, y + r.y) : makeToneSampler(spec, target, densityFn);
    const alphaSampler = alphaFn ? makeToneSampler({ ...spec, angle: 0, seed: 11, grain: 0.15 }, target, alphaFn) : null;
    const ss = mode === "mono" ? 1 : 2;
    const tc = grayize(color, mode);
    const off = createCanvas(r.w, r.h);
    const octx = off.getContext("2d");
    const id = octx.createImageData(r.w, r.h);
    const d = id.data;
    const R8 = Math.round(tc.r * 255);
    const G8 = Math.round(tc.g * 255);
    const B8 = Math.round(tc.b * 255);
    const isScreenFill = p.type !== "tone";
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        let cov = 0;
        if (gradDensity) {
          const [mx, my] = target.toMm(x, y);
          const dd = spec.gradient ? gradientDensityAt(spec, mx, my) : spec.density;
          cov = dd;
        } else if (ss === 1) cov = sampler(x, y);
        else {
          for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) cov += sampler(x + (sx + 0.5) / ss - 0.5, y + (sy + 0.5) / ss - 0.5);
          cov /= ss * ss;
        }
        if (soft) cov *= Math.max(0, Math.min(1, (soft[(y * r.w + x) * 4 + 3] / 255 - 0.5) * 2.2 + 0.5));
        const i = (y * r.w + x) * 4;
        if (isScreenFill) {
          // opaque: ink where covered, paper otherwise (translucent areas keep what is below)
          d[i] = d[i + 1] = d[i + 2] = cov > 0.5 ? 0 : 255;
          d[i + 3] = alphaSampler && alphaSampler(x, y) <= 0.5 ? 0 : 255;
        } else {
          d[i] = R8;
          d[i + 1] = G8;
          d[i + 2] = B8;
          d[i + 3] = Math.round(cov * 255 * tc.a);
        }
      }
    }
    octx.putImageData(id, 0, 0);
    setDeviceM(dev);
    blit(dev, off, r.x, r.y);
    ctx.restore();
    off.width = off.height = 1;
  }

  private async drawImage(dev: Dev, n: ImageNode, m: Matrix): Promise<void> {
    const ctx = dev.ctx;
    const mm = matMul(m, n.transform ?? [1, 0, 0, 1, 0, 0]);
    const scX = Math.hypot(mm[0], mm[1]);
    const scY = Math.hypot(mm[2], mm[3]);
    const outW = n.dest.w * scX;
    const outH = n.dest.h * scY;
    if (outW < 1 || outH < 1) return;
    const pix0 = await dev.opts.assets.pixels(n.assetKey, Math.min(outW, n.sourceRect.w * 4), Math.min(outH, n.sourceRect.h * 4), n.sourceRect);
    if (!pix0) return;
    const pix = n.filters.length ? await applyFilters(pix0, n.filters, n.dest.w / pix0.width) : pix0;
    const tmp = createCanvas(pix.width, pix.height);
    const tctx = tmp.getContext("2d");
    const id = tctx.createImageData(pix.width, pix.height);
    id.data.set(pix.data);
    tctx.putImageData(id, 0, 0);
    const k: Matrix = matMul(mm, [n.dest.w / pix.width, 0, 0, n.dest.h / pix.height, n.dest.x, n.dest.y]);
    const mono = dev.opts.colorMode === "mono";
    const b = nodeBounds({ ...n, outline: undefined }, m);
    const r = b ? clampRect(b, dev.W, dev.H) : null;
    if (!r) return;
    // outlines: exact dilation of the alpha silhouette (distance transform)
    if (n.shadow) {
      // the silhouette in the shadow colour, offset and blurred; screened in 1-bit output
      const sh = n.shadow;
      const pad = Math.ceil((Math.abs(sh.dx) + Math.abs(sh.dy) + sh.blur * 2) * dev.scale) + 4;
      const rr = clampRect({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }, dev.W, dev.H);
      if (rr) {
        const sc = createCanvas(rr.w, rr.h);
        const sctx = sc.getContext("2d");
        if (sh.blur > 0) sctx.filter = `blur(${(sh.blur * dev.scale) / 2}px)`;
        const offPx = applyMat(dev.base, { x: sh.dx, y: sh.dy });
        const o0 = applyMat(dev.base, { x: 0, y: 0 });
        setM(sctx, matMul([1, 0, 0, 1, -rr.x + offPx.x - o0.x, -rr.y + offPx.y - o0.y], k));
        sctx.drawImage(tmp, 0, 0);
        sctx.filter = "none";
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = "source-in";
        const c = grayize(sh.color, dev.opts.colorMode);
        sctx.fillStyle = cssColor({ ...c, a: 1 });
        sctx.fillRect(0, 0, rr.w, rr.h);
        if (mono) {
          const id = sctx.getImageData(0, 0, rr.w, rr.h);
          const dd = id.data;
          const dens = (1 - (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)) * c.a;
          const sampler = makeToneSampler({ density: 0, lpi: dev.opts.monoLpi, angle: Math.PI / 4, dot: "round", grain: 0.08, invert: false, offset: [0, 0], seed: 9 }, this.target(dev, rr), (xm, ym) => {
            const q = applyMat(matMul([1, 0, 0, 1, -rr.x, -rr.y], dev.base), { x: xm, y: ym });
            const i = (Math.min(rr.h - 1, Math.max(0, Math.floor(q.y))) * rr.w + Math.min(rr.w - 1, Math.max(0, Math.floor(q.x)))) * 4 + 3;
            return (dd[i] / 255) * dens;
          });
          for (let y = 0; y < rr.h; y++) for (let x = 0; x < rr.w; x++) {
            const i = (y * rr.w + x) * 4;
            dd[i] = dd[i + 1] = dd[i + 2] = 0;
            dd[i + 3] = dd[i + 3] > 0 && sampler(x, y) ? 255 : 0;
          }
          sctx.putImageData(id, 0, 0);
        }
        ctx.save();
        setDeviceM(dev);
        ctx.globalAlpha = mono ? 1 : c.a;
        blit(dev, sc, rr.x, rr.y);
        ctx.restore();
      }
    }
    if (n.outline?.length) {
      const maxR = Math.max(...n.outline.map((o) => o.w)) * dev.scale;
      const pad = Math.ceil(maxR) + 2;
      const rr = clampRect({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }, dev.W, dev.H)!;
      const mc = createCanvas(rr.w, rr.h);
      const mctx = mc.getContext("2d");
      setM(mctx, matMul([1, 0, 0, 1, -rr.x, -rr.y], k));
      mctx.drawImage(tmp, 0, 0);
      const md = mctx.getImageData(0, 0, rr.w, rr.h).data;
      const mask = new Uint8Array(rr.w * rr.h);
      const thr = Math.round((n.outline[0].threshold ?? 0.5) * 255);
      for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] > thr ? 1 : 0;
      const dist = distanceSquared(mask, rr.w, rr.h);
      // miter: square corners by measuring the Chebyshev distance instead of the Euclidean one
      const cheb = n.outline.some((o) => o.join === "miter") ? chebyshev(mask, rr.w, rr.h) : null;
      for (const o of n.outline) {
        const rad = o.w * dev.scale;
        const oc = createCanvas(rr.w, rr.h);
        const octx2 = oc.getContext("2d");
        const od = octx2.createImageData(rr.w, rr.h);
        const c = grayize(o.color, dev.opts.colorMode);
        const R8 = Math.round(c.r * 255);
        const G8 = Math.round(c.g * 255);
        const B8 = Math.round(c.b * 255);
        for (let i = 0; i < mask.length; i++) {
          const dd = o.join === "miter" && cheb ? cheb[i] : Math.sqrt(dist[i]);
          const a = mono ? (dd <= rad ? 1 : 0) : Math.max(0, Math.min(1, rad + 0.5 - dd));
          if (a <= 0) continue;
          od.data[i * 4] = R8;
          od.data[i * 4 + 1] = G8;
          od.data[i * 4 + 2] = B8;
          od.data[i * 4 + 3] = Math.round(a * 255 * c.a);
        }
        octx2.putImageData(od, 0, 0);
        ctx.save();
        setDeviceM(dev);
        blit(dev, oc, rr.x, rr.y);
        ctx.restore();
      }
    }
    if (!mono && dev.opts.colorMode !== "gray") {
      ctx.save();
      setDeviceM(dev, k);
      ctx.imageSmoothingEnabled = n.smoothing !== "none";
      ctx.imageSmoothingQuality = n.smoothing === "high" ? "high" : "medium";
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
      return;
    }
    // gray/mono: draw into device-aligned offscreen, then convert
    const off = createCanvas(r.w, r.h);
    const octx = off.getContext("2d");
    setM(octx, matMul([1, 0, 0, 1, -r.x, -r.y], k));
    octx.imageSmoothingEnabled = n.smoothing !== "none";
    octx.imageSmoothingQuality = "high";
    octx.drawImage(tmp, 0, 0);
    const od = octx.getImageData(0, 0, r.w, r.h);
    const dd = od.data;
    let curDensity = 0;
    // density map for edge-aware screening
    const dens = new Float32Array(r.w * r.h);
    for (let i = 0; i < r.w * r.h; i++) {
      const lin0 = 0.2126 * srgbToLinear(dd[i * 4] / 255) + 0.7152 * srgbToLinear(dd[i * 4 + 1] / 255) + 0.0722 * srgbToLinear(dd[i * 4 + 2] / 255);
      dens[i] = 1 - (dev.opts.toneCurve === "perceptual" ? linearToSrgb(lin0) : lin0);
    }
    // error diffusion instead of a dot screen (output.mono.images: dither)
    const dither = mono && dev.opts.monoImages === "dither" && !n.lineart ? new Float32Array(r.w * r.h) : null;
    if (dither) for (let i = 0; i < r.w * r.h; i++) dither[i] = dens[i];
    const sampler = mono ? makeToneSampler({ density: 0, lpi: dev.opts.imageLpi ?? (n.monoLpi || dev.opts.monoLpi), angle: Math.PI / 4, dot: "round", grain: 0.08, invert: false, offset: [0, 0], seed: 11 }, this.target(dev, r), () => curDensity) : null;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (y * r.w + x) * 4;
        const a = dd[i + 3];
        if (a === 0) continue;
        const lin = 0.2126 * srgbToLinear(dd[i] / 255) + 0.7152 * srgbToLinear(dd[i + 1] / 255) + 0.0722 * srgbToLinear(dd[i + 2] / 255);
        if (!mono) {
          const g = Math.round(linearToSrgb(lin) * 255);
          dd[i] = dd[i + 1] = dd[i + 2] = g;
          continue;
        }
        let ink: boolean;
        if (dither) {
          const i0 = y * r.w + x;
          const v = dither[i0];
          ink = v >= 0.5;
          const e = v - (ink ? 1 : 0);
          if (x + 1 < r.w) dither[i0 + 1] += (e * 7) / 16;
          if (y + 1 < r.h) {
            if (x > 0) dither[i0 + r.w - 1] += (e * 3) / 16;
            dither[i0 + r.w] += (e * 5) / 16;
            if (x + 1 < r.w) dither[i0 + r.w + 1] += e / 16;
          }
        } else if (n.lineart) ink = linearToSrgb(lin) < 0.5;
        else {
          const de = dens[y * r.w + x];
          let lo = de;
          let hi = de;
          for (let oy = -2; oy <= 2; oy += 2)
            for (let ox = -2; ox <= 2; ox += 2) {
              const xx = Math.min(r.w - 1, Math.max(0, x + ox));
              const yy = Math.min(r.h - 1, Math.max(0, y + oy));
              const v = dens[yy * r.w + xx];
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          curDensity = de;
          if (hi - lo > 0.55) ink = linearToSrgb(lin) < 0.5; // hard edge: threshold, no dot fringe
          else ink = de > 0.88 ? true : de < 0.08 ? false : sampler!(x, y) === 1;
        }
        dd[i] = dd[i + 1] = dd[i + 2] = ink ? 0 : 255;
        dd[i + 3] = a > 127 ? 255 : 0;
      }
    }
    octx.putImageData(od, 0, 0);
    ctx.save();
    setDeviceM(dev);
    if (n.lineart) ctx.globalCompositeOperation = "multiply";
    blit(dev, off, r.x, r.y);
    ctx.restore();
  }
}

function gradientDensityAt(spec: ToneSpec, x: number, y: number): number {
  return spec.gradient ? gradientDensityImport(spec.gradient, x, y) : spec.density;
}

import { gradientDensity as gradientDensityImport } from "./screen.js";

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}


/** chessboard distance to the nearest set pixel (two-pass), for square outline corners */
function chebyshev(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 1);
        if (x + 1 < w) v = Math.min(v, d[i - w + 1] + 1);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x + 1 < w) v = Math.min(v, d[i + 1] + 1);
      if (y + 1 < h) {
        v = Math.min(v, d[i + w] + 1);
        if (x + 1 < w) v = Math.min(v, d[i + w + 1] + 1);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 1);
      }
      d[i] = v;
    }
  return d;
}
