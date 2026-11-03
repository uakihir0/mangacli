// Effect generators (spec 8.2-8.12).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { Rng, fbm1p, noise1 } from "../core/random.js";
import { type Range, parseAngle, toMm, toRange } from "../core/units.js";
import { polyPath } from "../geom/path.js";
import { type Rect, type Vec } from "../geom/vec.js";
import { type HandSpec, type PenSpec } from "../ink/presets.js";
import { inkLine } from "../ink/shape.js";
import type { InkPoly } from "../ink/stroke.js";
import { isObj } from "../load/normalize.js";
import { resolvePoint } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint, resolveHand, resolvePen } from "../model/values.js";
import type { Node } from "../render/ir.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { inksToNodes } from "./inkir.js";
import { type ResolvedRegion, resolveRegion } from "./region.js";

type Obj = Record<string, unknown>;

interface FxCtx {
  el: RElement;
  p: Obj;
  ctx: ElemCtx;
  region: ResolvedRegion;
  rng: Rng;
  hand: HandSpec;
  pen: PenSpec;
  color: { r: number; g: number; b: number; a: number };
  k: number;
}

const L = (f: FxCtx, v: unknown, base?: number) => toMm(v as string, { ...f.ctx.u, base });
const R = (f: FxCtx, v: unknown, fb: Range, base?: number): Range => toRange(v as never, (x) => L(f, x, base), fb);

function sampleR(f: FxCtx, r: Range): number {
  return f.rng.sample(r.min, r.max, r.dist);
}

/** distance from p along dir to the bbox boundary (exit) */
function rayExit(p: Vec, d: Vec, b: Rect): number {
  let t = Infinity;
  if (d.x > 1e-9) t = Math.min(t, (b.x + b.w - p.x) / d.x);
  if (d.x < -1e-9) t = Math.min(t, (b.x - p.x) / d.x);
  if (d.y > 1e-9) t = Math.min(t, (b.y + b.h - p.y) / d.y);
  if (d.y < -1e-9) t = Math.min(t, (b.y - p.y) / d.y);
  return Math.max(0, t);
}

/** clustered stratified angles in [0, 2pi) */
function clusteredAngles(rng: Rng, n: number, jitter: number, cluster: number): number[] {
  const bins = 720;
  const seed = rng.nextU32();
  const dens: number[] = [];
  let tot = 0;
  for (let i = 0; i < bins; i++) {
    const v = Math.max(0.05, 1 + cluster * 1.6 * fbm1p(seed, (i / bins) * 9, 9, 2));
    dens.push(v);
    tot += v;
  }
  const cdf: number[] = [];
  let acc = 0;
  for (const d of dens) {
    acc += d / tot;
    cdf.push(acc);
  }
  const phase = rng.next();
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    let uu = (i + phase + (rng.next() - 0.5) * jitter) / n;
    uu = ((uu % 1) + 1) % 1;
    j = 0;
    let lo = 0;
    let hi = bins - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cdf[m] < uu) lo = m + 1;
      else hi = m;
    }
    j = lo;
    const prev = j > 0 ? cdf[j - 1] : 0;
    const frac = (uu - prev) / (cdf[j] - prev || 1);
    out.push(((j + frac) / bins) * Math.PI * 2);
  }
  return out;
}

function ellipseR(rx: number, ry: number, a: number): number {
  const c = Math.cos(a) / rx;
  const s = Math.sin(a) / ry;
  return 1 / Math.sqrt(c * c + s * s);
}

function wrap(f: FxCtx, inner: Node[], pre: Node[] = []): Node[] {
  const p = f.p;
  const g: Node = {
    kind: "group",
    clip: f.region.path,
    opacity: typeof p.opacity === "number" && p.opacity < 1 ? p.opacity : undefined,
    children: [...pre, ...inner],
    tag: tag(f.el, "ink"),
  };
  return [g];
}

function backgroundNode(f: FxCtx): Node[] {
  const bg = parsePaint(f.p.background, { u: f.ctx.u, box: f.region.bbox, seed: f.el.seed, bag: f.ctx.bag, path: [...f.el.path, "background"] });
  return bg ? [{ kind: "path", path: f.region.path, fillRule: f.region.fillRule, paint: bg, tag: tag(f.el, "fill") }] : [];
}

function lineStyle(f: FxCtx, width: number) {
  return { width, pen: f.pen, style: "solid" as const };
}

// ---- focus lines -------------------------------------------------------------

function focusLines(f: FxCtx, over: Obj = {}): InkPoly[] {
  const p = { ...f.p, ...over };
  const b = f.region.bbox;
  const pc = { ...placeCtx(f.ctx, f.el), coordsBox: f.ctx.coordsBox };
  const c = resolvePoint(p.center ?? "center", pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const inner = (p.inner as unknown[]) ?? ["32%", "26%"];
  const rx = L(f, inner[0], b.w);
  const ry = L(f, inner[1], b.h);
  const rot0 = p.innerRotate !== undefined ? parseAngle(p.innerRotate as string) : 0;
  const far = Math.max(...[
    [b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
  ].map(([x, y]) => Math.hypot(x - c.x, y - c.y))) + 5 * f.k;
  const per = 2 * (b.w + b.h);
  const count = p.count === "auto" || p.count === undefined ? Math.round(Math.min(400, Math.max(80, per / (2.2 * f.k))) * ((p.density as number) ?? 1)) : Math.round(Number(p.count) * ((p.density as number) ?? 1));
  const jit = (p.angleJitter as number) ?? 0.8;
  const cl = (p.cluster as number) ?? 0.35;
  const ij = (p.innerJitter as number) ?? 0.35;
  const spikes = (isObj(p.spikes) ? p.spikes : { ratio: 0.06, depth: 0.45 }) as Obj;
  const th = R(f, p.thickness, { min: 0.12 * f.k, max: 0.5 * f.k, dist: "low" });
  const taper = (p.taper as string) ?? "in";
  const curve = (p.curve as number) ?? 0;
  const angles = clusteredAngles(f.rng, count, jit, cl);
  const out: InkPoly[] = [];
  const clear = p.clear;
  const clearReg = clear ? resolveRegion(clear, f.ctx, "panel", [...f.el.path, "clear"]) : null;
  for (const a of angles) {
    const d = { x: Math.cos(a), y: Math.sin(a) };
    let rin = ellipseR(rx, ry, a - rot0) * (1 + ij * Math.pow(f.rng.next(), 1.5));
    if (f.rng.chance((spikes.ratio as number) ?? 0.06)) rin *= 1 - ((spikes.depth as number) ?? 0.45) * f.rng.next();
    if (clearReg) {
      // shorten until outside clear region
      let r = rin;
      while (r < far && clearReg.contains({ x: c.x + d.x * r, y: c.y + d.y * r })) r += 0.5 * f.k;
      rin = r;
    }
    const outerP = { x: c.x + d.x * far, y: c.y + d.y * far };
    const innerP = { x: c.x + d.x * rin, y: c.y + d.y * rin };
    const w = sampleR(f, th);
    const vis = Math.max(1, rayExit(innerP, d, b));
    let pts: Vec[] = [outerP, innerP];
    if (curve) {
      pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const r = far + (rin - far) * t;
        const aa = a + curve * 0.35 * (1 - r / far);
        pts.push({ x: c.x + Math.cos(aa) * r, y: c.y + Math.sin(aa) * r });
      }
    }
    const taperLen = Math.min(vis * 0.75, 40 * f.k);
    out.push(
      ...inkLine(pts, lineStyle(f, w), f.hand, f.rng.fork("fl"), {
        ruler: p.ruler !== false && !curve,
        taperIn: taper === "out" || taper === "both",
        taperOut: taper === "in" || taper === "both",
        taperOutLen: taperLen,
        taperInLen: taperLen,
        resolution: curve ? undefined : Math.max(0.3, w),
        inkPool: false,
      }),
    );
    if (f.rng.chance(0.03)) {
      const off = f.rng.range(0.1, 0.3) * f.k;
      const n = { x: -d.y * off, y: d.x * off };
      out.push(...inkLine(pts.map((q) => ({ x: q.x + n.x, y: q.y + n.y })), lineStyle(f, w * 0.7), f.hand, f.rng.fork("fl2"), { ruler: true, taperOut: true, taperIn: false, taperOutLen: taperLen, resolution: Math.max(0.3, w), inkPool: false }));
    }
  }
  return out;
}

// ---- beta flash --------------------------------------------------------------

function betaFlash(f: FxCtx): Node[] {
  const p = f.p;
  const b = f.region.bbox;
  const pc = placeCtx(f.ctx, f.el);
  const c = resolvePoint(p.center ?? "center", pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const inner = (p.inner as unknown[]) ?? ["24%", "20%"];
  const outer = (p.outer as unknown[]) ?? ["44%", "38%"];
  const rx = L(f, inner[0], b.w);
  const ry = L(f, inner[1], b.h);
  const ox = L(f, outer[0], b.w);
  const oy = L(f, outer[1], b.h);
  const oj = (p.outerJitter as number) ?? 0.15;
  const seed = f.rng.nextU32();
  const outerR = (a: number) => ellipseR(ox, oy, a) * (1 + oj * 0.6 * fbm1p(seed, (a / (Math.PI * 2)) * 14, 14, 2));
  const n = 240;
  const outerPoly: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = outerR(a);
    outerPoly.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  const per = Math.PI * (ox + oy);
  const count = p.count === "auto" || p.count === undefined ? Math.round((per / (0.9 * f.k)) * ((p.density as number) ?? 1)) : Number(p.count);
  const th = R(f, p.thickness, { min: 0.25 * f.k, max: 1.0 * f.k, dist: "low" });
  const ij = (p.innerJitter as number) ?? 0.5;
  const spikes = (isObj(p.spikes) ? p.spikes : { ratio: 0.1, depth: 0.6 }) as Obj;
  const angles = clusteredAngles(f.rng, count, 0.9, 0.25);
  const inks: InkPoly[] = [];
  for (const a of angles) {
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const ro = outerR(a) + 0.8 * f.k;
    let ri = ellipseR(rx, ry, a) * (1 + ij * Math.pow(f.rng.next(), 1.3) * ((ro / ellipseR(rx, ry, a)) - 1) * 0.6);
    if (f.rng.chance((spikes.ratio as number) ?? 0.1)) ri *= 1 - ((spikes.depth as number) ?? 0.6) * f.rng.next() * 0.6;
    ri = Math.min(ri, ro - 1 * f.k);
    const w = sampleR(f, th);
    inks.push(...inkLine([{ x: c.x + d.x * ro, y: c.y + d.y * ro }, { x: c.x + d.x * ri, y: c.y + d.y * ri }], lineStyle(f, w), f.hand, f.rng.fork("bf"), { ruler: true, taperIn: false, taperOut: true, taperOutLen: (ro - ri) * 0.85, resolution: Math.max(0.3, w), inkPool: false }));
  }
  const core = parsePaint(p.core ?? "paper", { u: f.ctx.u, box: b, seed: f.el.seed });
  const pre: Node[] = [];
  if (core) pre.push({ kind: "path", path: f.region.path, fillRule: f.region.fillRule, paint: core, tag: tag(f.el, "fill") });
  // black outside the outer boundary
  const ring = [...polyPath(f.region.polys[0] ?? [], true), ...polyPath(outerPoly.slice().reverse(), true)];
  pre.push({ kind: "path", path: ring, fillRule: "evenodd", paint: { type: "solid", color: f.color }, tag: tag(f.el, "ink") });
  return wrap(f, inksToNodes(inks, f.color, tag(f.el, "ink")), pre);
}

// ---- uni flash ---------------------------------------------------------------

function uniFlash(f: FxCtx): Node[] {
  const p = f.p;
  const b = f.region.bbox;
  const pc = placeCtx(f.ctx, f.el);
  const c = resolvePoint(p.center ?? "center", pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const inner = (p.inner as unknown[]) ?? ["18%", "15%"];
  const outer = (p.outer as unknown[]) ?? ["36%", "30%"];
  const rx = L(f, inner[0], b.w);
  const ry = L(f, inner[1], b.h);
  const ox = L(f, outer[0], b.w);
  const oy = L(f, outer[1], b.h);
  const ij = (p.innerJitter as number) ?? 0.25;
  const oj = (p.outerJitter as number) ?? 0.35;
  const per = Math.PI * (ox + oy);
  const rings = Math.max(1, Number(p.rings ?? 1));
  const th = R(f, p.thickness, { min: 0.08 * f.k, max: 0.3 * f.k, dist: "low" });
  const peak = (p.peak as number) ?? 0.6;
  const inks: InkPoly[] = [];
  for (let ringI = 0; ringI < rings; ringI++) {
    const sc = 1 + ringI * 0.25;
    const count = p.count === "auto" || p.count === undefined ? Math.round((per * sc / (0.7 * f.k)) * ((p.density as number) ?? 1)) : Number(p.count);
    const angles = clusteredAngles(f.rng, count, 0.9, 0.2);
    for (const a of angles) {
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const ri = ellipseR(rx * sc, ry * sc, a) * (1 + ij * (f.rng.next() - 0.3));
      const ro = ellipseR(ox * sc, oy * sc, a) * (1 + oj * (f.rng.next() - 0.5));
      if (ro <= ri + 0.5 * f.k) continue;
      const w = sampleR(f, th);
      const len = ro - ri;
      inks.push(...inkLine([{ x: c.x + d.x * ro, y: c.y + d.y * ro }, { x: c.x + d.x * ri, y: c.y + d.y * ri }], lineStyle(f, w), f.hand, f.rng.fork("uf"), { ruler: true, taperIn: true, taperOut: true, taperInLen: len * (1 - peak), taperOutLen: len * peak, resolution: Math.max(0.2, w), inkPool: false }));
    }
  }
  const pre: Node[] = [];
  const core = parsePaint(p.core ?? "paper", { u: f.ctx.u, box: b, seed: f.el.seed });
  if (core) {
    const poly: Vec[] = [];
    const seed = f.rng.nextU32();
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2;
      const r = ellipseR(ox, oy, a) * (0.92 + 0.08 * fbm1p(seed, (i / 180) * 10, 10));
      poly.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    }
    pre.push({ kind: "path", path: polyPath(poly, true), fillRule: "nonzero", paint: core, tag: tag(f.el, "fill") });
  }
  return wrap(f, inksToNodes(inks, f.color, tag(f.el, "ink")), pre);
}

// ---- speed lines -------------------------------------------------------------

function speedLines(f: FxCtx): InkPoly[] {
  const p = f.p;
  const b = f.region.bbox;
  const ang = parseAngle((p.angle as string) ?? 0);
  const d = { x: Math.cos(ang), y: Math.sin(ang) };
  const n = { x: -d.y, y: d.x };
  const corners = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }];
  const projN = corners.map((q) => q.x * n.x + q.y * n.y);
  const projD = corners.map((q) => q.x * d.x + q.y * d.y);
  const n0 = Math.min(...projN);
  const n1 = Math.max(...projN);
  const d0 = Math.min(...projD);
  const d1 = Math.max(...projD);
  const extent = d1 - d0;
  const sp = R(f, p.spacing, { min: 0.5 * f.k, max: 2.2 * f.k, dist: "uniform" });
  const lenR = toRange(p.length as never, (x) => toMm(x as string, { ...f.ctx.u, base: extent }), { min: extent * 0.3, max: extent * 0.9, dist: "uniform" });
  const th = R(f, p.thickness, { min: 0.1 * f.k, max: 0.4 * f.k, dist: "low" });
  const taper = (p.taper as string) ?? "both";
  const align = (p.align as string) ?? "random";
  const cl = (p.cluster as number) ?? 0.4;
  const seed = f.rng.nextU32();
  const dens = (p.density as number) ?? 1;
  const clearReg = p.clear ? resolveRegion(p.clear, f.ctx, "panel", [...f.el.path, "clear"]) : null;
  const out: InkPoly[] = [];
  let pos = n0 - sp.max;
  while (pos < n1 + sp.max) {
    const mod = 1 + cl * 1.5 * noise1(seed, pos / (6 * f.k));
    pos += Math.max(sp.min * 0.5, sampleR(f, sp) / Math.max(0.3, mod) / dens);
    const len = sampleR(f, lenR);
    let start: number;
    if (align === "start") start = d0 + f.rng.range(0, extent * 0.08);
    else if (align === "end") start = d1 - len - f.rng.range(0, extent * 0.08);
    else if (align === "center") start = (d0 + d1) / 2 - len / 2 + f.rng.range(-0.05, 0.05) * extent;
    else start = d0 - len * 0.2 + f.rng.range(0, Math.max(0, extent - len * 0.6));
    const w = sampleR(f, th);
    const P = (t: number) => ({ x: n.x * pos + d.x * t, y: n.y * pos + d.y * t });
    let segs: [number, number][] = [[start, start + len]];
    if (clearReg) {
      const ns: [number, number][] = [];
      for (const [a0, a1] of segs) {
        let cur: number | null = null;
        const step = 0.5 * f.k;
        for (let t = a0; t <= a1; t += step) {
          const inside = clearReg.contains(P(t));
          if (!inside && cur === null) cur = t;
          if (inside && cur !== null) {
            if (t - cur > 2 * f.k) ns.push([cur, t]);
            cur = null;
          }
        }
        if (cur !== null && a1 - cur > 2 * f.k) ns.push([cur, a1]);
      }
      segs = ns;
    }
    for (const [a0, a1] of segs) {
      const segLen = a1 - a0;
      out.push(...inkLine([P(a0), P(a1)], lineStyle(f, w), f.hand, f.rng.fork("sl"), { ruler: p.ruler !== false, taperIn: taper === "both" || taper === "start", taperOut: taper === "both" || taper === "end", taperInLen: segLen * 0.35, taperOutLen: segLen * 0.45, resolution: Math.max(0.3, w), inkPool: false }));
    }
  }
  return out;
}

// ---- gloom lines -------------------------------------------------------------

function gloomLines(f: FxCtx): InkPoly[] {
  const p = f.p;
  const b = f.region.bbox;
  const sp = R(f, p.spacing, { min: 0.7 * f.k, max: 1.5 * f.k, dist: "uniform" });
  const lenR = toRange(p.length as never, (x) => toMm(x as string, { ...f.ctx.u, base: b.h }), { min: b.h * 0.45, max: b.h, dist: "uniform" });
  const th = R(f, p.thickness, { min: 0.15 * f.k, max: 0.35 * f.k, dist: "uniform" });
  const out: InkPoly[] = [];
  let x = b.x + f.rng.range(0, sp.max);
  while (x < b.x + b.w) {
    const len = sampleR(f, lenR);
    const w = sampleR(f, th);
    const y0 = b.y - 1 * f.k;
    out.push(...inkLine([{ x, y: y0 }, { x: x + f.rng.range(-0.15, 0.15) * f.k, y: y0 + len }], lineStyle(f, w), f.hand, f.rng.fork("gl"), { ruler: true, taperIn: false, taperOut: true, taperOutLen: len * 0.6, resolution: Math.max(0.3, w), inkPool: false }));
    x += sampleR(f, sp);
  }
  return out;
}

// ---- rain --------------------------------------------------------------------

function rain(f: FxCtx): InkPoly[] {
  const p = f.p;
  const b = f.region.bbox;
  const ang = parseAngle((p.angle as string) ?? "100deg");
  const d = { x: Math.cos(ang), y: Math.sin(ang) };
  const rate = ((p.rate as number) ?? 0.6) * ((p.density as number) ?? 1);
  const n = Math.round(((b.w * b.h) / 100) * rate);
  const lenR = R(f, p.length, { min: 3 * f.k, max: 12 * f.k, dist: "uniform" });
  const th = R(f, p.thickness, { min: 0.08 * f.k, max: 0.2 * f.k, dist: "low" });
  const out: InkPoly[] = [];
  for (let i = 0; i < n; i++) {
    const c = { x: b.x + f.rng.next() * b.w, y: b.y + f.rng.next() * b.h };
    const l = sampleR(f, lenR);
    out.push(...inkLine([{ x: c.x - (d.x * l) / 2, y: c.y - (d.y * l) / 2 }, { x: c.x + (d.x * l) / 2, y: c.y + (d.y * l) / 2 }], lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("r"), { ruler: true, taperIn: true, taperOut: true, taperInLen: l * 0.4, taperOutLen: l * 0.5, inkPool: false, resolution: 0.25 }));
  }
  return out;
}

// ---- swirl -------------------------------------------------------------------

function swirl(f: FxCtx): InkPoly[] {
  const p = f.p;
  const b = f.region.bbox;
  const pc = placeCtx(f.ctx, f.el);
  const c = resolvePoint(p.center ?? "center", pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const base = Math.max(b.w, b.h);
  const rr = toRange(p.radius as never, (x) => toMm(x as string, { ...f.ctx.u, base }), { min: base * 0.15, max: base * 0.6, dist: "uniform" });
  const arc = toRange(p.arc as never, (x) => parseAngle(x as string), { min: (25 * Math.PI) / 180, max: (90 * Math.PI) / 180, dist: "uniform" });
  const th = R(f, p.thickness, { min: 0.1 * f.k, max: 0.4 * f.k, dist: "low" });
  const cw = (p.direction as string) !== "ccw";
  const count = p.count === "auto" || p.count === undefined ? 60 : Number(p.count);
  const spiral = (p.spiral as number) ?? 0;
  const out: InkPoly[] = [];
  for (let i = 0; i < count; i++) {
    const r = sampleR(f, rr);
    const a0 = f.rng.range(0, Math.PI * 2);
    const span = sampleR(f, arc);
    const pts: Vec[] = [];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      const a = a0 + (cw ? 1 : -1) * span * t;
      const rad = r * (1 + spiral * t);
      pts.push({ x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad });
    }
    const len = r * span;
    out.push(...inkLine(pts, lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("sw"), { taperIn: true, taperOut: true, taperInLen: len * 0.2, taperOutLen: len * 0.55, inkPool: false }));
  }
  return out;
}

// ---- hatching / kakeami -------------------------------------------------------

function hatching(f: FxCtx): InkPoly[] {
  const p = f.p;
  const b = f.region.bbox;
  const pattern = (p.pattern as string) ?? "hatch";
  const ang0 = parseAngle((p.angle as string) ?? "45deg");
  const spacing = L(f, p.spacing ?? `${0.6 * f.k}mm`);
  const th = R(f, p.thickness, { min: 0.08 * f.k, max: 0.16 * f.k, dist: "uniform" });
  const layers = Number(p.layers ?? (pattern === "hatch" ? 1 : 2));
  const out: InkPoly[] = [];
  const soft = (p.edge as string) !== "clean";
  if (pattern === "kakeami") {
    const bs = R(f, p.blockSize, { min: 2 * f.k, max: 3.5 * f.k, dist: "uniform" });
    const lpb = Number(p.linesPerBlock ?? 4);
    for (let layer = 0; layer < layers; layer++) {
      const step = (bs.min + bs.max) / 2;
      const off = layer * step * 0.37;
      let row = 0;
      for (let y = b.y - step + off; y < b.y + b.h + step; y += step * 0.95) {
        row++;
        for (let x = b.x - step + off + (row % 2) * step * 0.5; x < b.x + b.w + step; x += step * 0.95) {
          const size = sampleR(f, bs);
          const cx = x + f.rng.range(-0.15, 0.15) * size;
          const cy = y + f.rng.range(-0.15, 0.15) * size;
          if (soft && !f.region.contains({ x: cx, y: cy })) continue;
          const parity = ((Math.round(x / step) + Math.round(y / step) + layer) % 2) * (Math.PI / 2);
          const a = ang0 + parity + f.rng.range(-0.26, 0.26);
          const d = { x: Math.cos(a), y: Math.sin(a) };
          const n = { x: -d.y, y: d.x };
          for (let i = 0; i < lpb; i++) {
            const o = (i - (lpb - 1) / 2) * (size / lpb);
            const l = size * f.rng.range(0.8, 1.05);
            const c0 = { x: cx + n.x * o, y: cy + n.y * o };
            out.push(...inkLine([{ x: c0.x - (d.x * l) / 2, y: c0.y - (d.y * l) / 2 }, { x: c0.x + (d.x * l) / 2, y: c0.y + (d.y * l) / 2 }], lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("ka"), { taperIn: true, taperOut: true, taperInLen: l * 0.3, taperOutLen: l * 0.4, inkPool: false, wobble: false, resolution: 0.15 }));
          }
        }
      }
    }
    return out;
  }
  const dirs = pattern === "cross" ? [ang0, ang0 + Math.PI / 2] : [ang0];
  for (let li = 0; li < Math.max(layers, dirs.length); li++) {
    const a = dirs[li % dirs.length] + (li >= dirs.length ? 0.2 : 0);
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const n = { x: -d.y, y: d.x };
    const corners = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }];
    const pn = corners.map((q) => q.x * n.x + q.y * n.y);
    const pd = corners.map((q) => q.x * d.x + q.y * d.y);
    for (let s = Math.min(...pn); s < Math.max(...pn); s += spacing * f.rng.range(0.85, 1.15)) {
      // find extent inside region by sampling
      let t0: number | null = null;
      const tA = Math.min(...pd);
      const tB = Math.max(...pd);
      const step = 0.5 * f.k;
      for (let t = tA; t <= tB + step; t += step) {
        const q = { x: n.x * s + d.x * t, y: n.y * s + d.y * t };
        const ins = t <= tB && f.region.contains(q);
        if (ins && t0 === null) t0 = t + (soft ? f.rng.range(0, 2) * f.k : 0);
        if ((!ins || t > tB) && t0 !== null) {
          const t1 = t - (soft ? f.rng.range(0, 2) * f.k : 0);
          if (t1 - t0 > 1 * f.k) {
            const l = t1 - t0;
            out.push(...inkLine([{ x: n.x * s + d.x * t0, y: n.y * s + d.y * t0 }, { x: n.x * s + d.x * t1, y: n.y * s + d.y * t1 }], lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("h"), { taperIn: true, taperOut: true, taperInLen: Math.min(l * 0.3, 2 * f.k), taperOutLen: Math.min(l * 0.4, 3 * f.k), inkPool: false, resolution: 0.3 }));
          }
          t0 = null;
        }
      }
    }
  }
  return out;
}

// ---- impact ------------------------------------------------------------------

function impact(f: FxCtx): Node[] {
  const p = f.p;
  const pc = placeCtx(f.ctx, f.el);
  const c = resolvePoint(p.center ?? "center", pc) ?? { x: 0, y: 0 };
  const b = f.region.bbox;
  const radius = L(f, p.radius ?? "18%", Math.min(b.w, b.h));
  const spikes = Number(p.spikes ?? 14);
  const irr = (p.irregularity as number) ?? 0.5;
  const star = (r: number, seedShift: number): Vec[] => {
    const pts: Vec[] = [];
    const rr = new Rng(f.el.seed + seedShift);
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 + rr.range(-0.1, 0.1);
      const rad = i % 2 === 0 ? r * (1 + irr * rr.range(0, 0.8)) : r * (0.55 + rr.range(-0.08, 0.08));
      pts.push({ x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad });
    }
    return pts;
  };
  const outer = star(radius, 1);
  const nodes: Node[] = [];
  const fill = parsePaint(p.fill ?? "paper", { u: f.ctx.u, box: b, seed: f.el.seed });
  if (fill) nodes.push({ kind: "path", path: polyPath(outer, true), fillRule: "nonzero", paint: fill, tag: tag(f.el, "fill") });
  const w = toMm((((p.stroke as Obj)?.width as string) ?? `${0.3 * f.k}mm`), f.ctx.u);
  const inks: InkPoly[] = [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const bb = outer[(i + 1) % outer.length];
    inks.push(...inkLine([a, bb], lineStyle(f, w), f.hand, f.rng.fork("im"), { taperIn: i % 2 === 1, taperOut: i % 2 === 0, inkPool: false }));
  }
  if (p.double !== false) {
    const inner = star(radius * 0.6, 2);
    for (let i = 0; i < inner.length; i++) inks.push(...inkLine([inner[i], inner[(i + 1) % inner.length]], lineStyle(f, w * 0.7), f.hand, f.rng.fork("im2"), { inkPool: false }));
  }
  const rays = (isObj(p.rays) ? p.rays : { count: 24 }) as Obj;
  const rc = Number(rays.count ?? 24);
  const rl = R(f, rays.length, { min: 2 * f.k, max: 8 * f.k, dist: "uniform" });
  const rt = R(f, rays.thickness, { min: 0.15 * f.k, max: 0.4 * f.k, dist: "low" });
  for (let i = 0; i < rc; i++) {
    const a = (i / rc) * Math.PI * 2 + f.rng.range(-0.1, 0.1);
    const r0 = radius * (1.5 + f.rng.range(0, 0.3));
    const l = sampleR(f, rl);
    const d = { x: Math.cos(a), y: Math.sin(a) };
    inks.push(...inkLine([{ x: c.x + d.x * r0, y: c.y + d.y * r0 }, { x: c.x + d.x * (r0 + l), y: c.y + d.y * (r0 + l) }], lineStyle(f, sampleR(f, rt)), f.hand, f.rng.fork("ray"), { ruler: true, taperIn: true, taperOut: true, inkPool: false }));
  }
  nodes.push(...inksToNodes(inks, f.color, tag(f.el, "ink")));
  return wrap(f, nodes);
}

// ---- vignette ----------------------------------------------------------------

function vignette(f: FxCtx): Node[] {
  const p = f.p;
  const b = f.region.bbox;
  const color = parseColor((p.color as string) ?? "paper") ?? WHITE;
  const width = L(f, p.width ?? `${8 * f.k}mm`);
  const soft = (p.softness as number) ?? 0.7;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const r = Math.hypot(b.w, b.h) / 2;
  const innerR = Math.max(0, r - width * 2.2);
  const t0 = innerR / r;
  const tr = { ...color, a: 0 };
  const stops = [{ offset: Math.max(0, t0 - soft * 0.2), color: tr }, { offset: Math.min(1, t0 + (1 - t0) * (1 - soft * 0.5)), color }, { offset: 1, color }];
  const node: Node = { kind: "group", transform: [b.w / Math.max(b.w, b.h) * 1.1, 0, 0, b.h / Math.max(b.w, b.h) * 1.1, cx * (1 - (b.w / Math.max(b.w, b.h)) * 1.1), cy * (1 - (b.h / Math.max(b.w, b.h)) * 1.1)], children: [{ kind: "path", path: polyPath([{ x: cx - r * 2, y: cy - r * 2 }, { x: cx + r * 2, y: cy - r * 2 }, { x: cx + r * 2, y: cy + r * 2 }, { x: cx - r * 2, y: cy + r * 2 }], true), fillRule: "nonzero", paint: { type: "radial-gradient", cx, cy, r, stops }, tag: tag(f.el, "fill") }], tag: tag(f.el, "fill") };
  return wrap(f, [node]);
}

export function renderEffect(el: RElement, ctx: ElemCtx): Node[] {
  const p = el.props;
  const kind = String(p.kind);
  const hand = resolveHand(p.hand, ctx.u, ctx.draft);
  const pen = resolvePen(p.pen, ctx.u, hand.pen);
  const color = parseColor((p.color as string) ?? "black") ?? BLACK;
  const region = resolveRegion(p.region, ctx, ctx.panel ? "panel" : "page", [...el.path, "region"]);
  const f: FxCtx = { el, p, ctx, region, rng: new Rng(el.seed), hand, pen, color, k: ctx.u.k };
  const ink = (inks: InkPoly[]) => wrap(f, inksToNodes(inks, color, tag(el, "ink")), backgroundNode(f));
  switch (kind) {
    case "focus-lines": {
      const passes = Array.isArray(p.passes) ? (p.passes as Obj[]) : null;
      const inks = passes ? passes.flatMap((ov) => focusLines(f, ov)) : focusLines(f);
      return ink(inks);
    }
    case "beta-flash":
      return betaFlash(f);
    case "uni-flash":
      return uniFlash(f);
    case "speed-lines":
      return ink(speedLines(f));
    case "gloom-lines": {
      const out = ink(gloomLines(f));
      if (p.tone && p.tone !== "none") {
        const tp = parsePaint(p.tone, { u: ctx.u, box: region.bbox, seed: el.seed, bag: ctx.bag, path: [...el.path, "tone"] });
        if (tp) (out[0] as { children: Node[] }).children.unshift({ kind: "path", path: region.path, fillRule: region.fillRule, paint: tp, tag: tag(el, "tone") });
      }
      return out;
    }
    case "rain":
      return ink(rain(f));
    case "swirl-lines":
      return ink(swirl(f));
    case "hatching":
      return ink(hatching(f));
    case "impact":
      return impact(f);
    case "vignette":
      return vignette(f);
    default:
      ctx.bag.error("SCHEMA_ENUM", `unknown effect kind "${kind}"`, { path: [...el.path, "kind"] });
      return [];
  }
}
