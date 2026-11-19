// Effect generators (spec 8.2-8.12).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { Rng, fbm1p, noise1 } from "../core/random.js";
import { type Range, parseAngle, toMm, toRange } from "../core/units.js";
import { flattenPath, parseSvgPath, polyPath, smoothPath, transformPath } from "../geom/path.js";
import { type Rect, type Vec } from "../geom/vec.js";
import { type HandSpec, type PenSpec } from "../ink/presets.js";
import { inkLine, inkShape } from "../ink/shape.js";
import type { InkPoly } from "../ink/stroke.js";
import { isObj } from "../load/normalize.js";
import { resolvePoint } from "../layout/place.js";
import { BUILTIN_EFFECT_DEFAULTS } from "../model/defaults.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint, resolveHand, resolvePen, resolveStroke } from "../model/values.js";
import type { Node } from "../render/ir.js";
import { activePlugins } from "../plugin.js";
import { runPluginDrawable } from "./plugindraw.js";
import { renderBeam } from "./beam.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { inksToNodes } from "./inkir.js";
import { renderLight } from "./light.js";
import { type ResolvedRegion, resolveRegion } from "./region.js";
import { type EffectAlphaCache, effectSilhouette, splitClearLine } from "./effect-clear.js";

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
  clears: { region: ResolvedRegion; margin: number; contains: (p: Vec, extra?: number) => boolean }[];
}

function effectLine(f: FxCtx, ...args: Parameters<typeof inkLine>): InkPoly[] {
  if (!f.clears.length) return inkLine(...args);
  const [points, style, hand, rng, opts = {}] = args;
  let nominalLength = 0;
  for (let i = 1; i < points.length; i++) nominalLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const minimum = Math.max(L(f, f.p.minLength ?? "3mm"), nominalLength * 0.05, style.width * 6);
  const runs = splitClearLine(points, (p) => f.clears.some((c) => c.contains(p, style.width * 0.8 + hand.wobbleAmp * 2 + hand.tremorAmp * 2)), 0.15 * f.k, minimum);
  return runs.flatMap((run) => {
    let length = 0;
    for (let i = 1; i < run.length; i++) length += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
    const cutStart = Math.hypot(run[0].x - points[0].x, run[0].y - points[0].y) > 0.01;
    const cutEnd = Math.hypot(run.at(-1)!.x - points.at(-1)!.x, run.at(-1)!.y - points.at(-1)!.y) > 0.01;
    const taperLimit = length * 0.4;
    return inkLine(run, style, { ...hand, rulerAngleError: 0, taper: cutStart || cutEnd ? Math.max(1, hand.taper) : hand.taper }, rng, { ...opts, taperIn: cutStart || opts.taperIn, taperOut: cutEnd || opts.taperOut, taperInLen: Math.min(taperLimit, cutStart ? 4 * f.k : opts.taperInLen ?? f.pen.taperIn * hand.taper), taperOutLen: Math.min(taperLimit, cutEnd ? 4 * f.k : opts.taperOutLen ?? f.pen.taperOut * hand.taper) }).filter((poly) => {
      const xs = poly.pts.map((p) => p.x), ys = poly.pts.map((p) => p.y);
      return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= minimum;
    });
  });
}

async function resolveClears(f: FxCtx): Promise<FxCtx["clears"]> {
  const cache: EffectAlphaCache = new Map();
  const raw = f.p.clear == null ? [] : Array.isArray(f.p.clear) ? [...f.p.clear] : [f.p.clear];
  if (["focus-lines", "uni-flash", "speed-lines", "beta-flash"].includes(String(f.p.kind)) && f.p.clearFigures !== false) {
    for (const t of f.ctx.refs.all()) {
      if (t.type === "image" && t.character && t.imagePx && (!f.ctx.panel || t.panelId === f.ctx.panel.panel.id)) {
        if (!raw.some((s) => isObj(s) && s.element === t.id)) raw.push({ element: t.id, mode: "alpha", automatic: true });
      }
    }
  }
  const clears: FxCtx["clears"] = [];
  for (const [i, spec] of raw.entries()) {
    const region = resolveRegion(spec, f.ctx, "panel", [...f.el.path, "clear", i]);
    const margin = isObj(spec) && spec.margin !== undefined ? L(f, spec.margin) : region.alphaOf ? L(f, isObj(spec) ? spec.feather ?? "1mm" : "1mm") : 0;
    if (region.alphaOf) {
      const image = f.ctx.refs.get(region.alphaOf)?.imagePx;
      const silhouette = image && await effectSilhouette(f.ctx, image, margin, cache);
      if (!silhouette) continue;
      if (silhouette.opaque) {
        if (!(isObj(spec) && spec.automatic)) f.ctx.bag.warn("EFFECT_OPAQUE_CLEAR", `alpha clear ignored: image "${region.alphaOf}" is essentially opaque`, { path: [...f.el.path, "clear", i] });
        continue;
      }
      clears.push({ region, margin, contains: silhouette.contains });
      continue;
    }
    clears.push({ region, margin, contains: (p: Vec, extra = 0) => {
      if (region.contains(p)) return true;
      const radius = margin + extra;
      return region.polys.some((poly) => poly.some((a, j) => {
        const b = poly[(j + 1) % poly.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t) <= radius;
      }));
    } });
  }
  return clears;
}

/** the burst centre: explicit, else the face of the panel's main character, else the region centre */
function autoCenter(f: FxCtx, p: Obj, pc: ReturnType<typeof placeCtx>): Vec | null {
  if (p.center !== undefined && p.center !== "auto") return resolvePoint(p.center, pc);
  const b = f.region.bbox;
  let best: { c: Vec; a: number } | null = null;
  for (const t of f.ctx.refs.all()) {
    const face = t.regions.face?.bbox;
    if (t.type !== "image" || !t.character || !face || (f.ctx.panel && t.panelId !== f.ctx.panel.panel.id)) continue;
    const c = { x: face.x + face.w / 2, y: face.y + face.h / 2 };
    if (c.x < b.x || c.y < b.y || c.x > b.x + b.w || c.y > b.y + b.h) continue;
    if (!best || face.w * face.h > best.a) best = { c, a: face.w * face.h };
  }
  return best ? best.c : resolvePoint("center", pc);
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
    ...(f.region.feather > 0 ? { softClip: { path: f.region.path, fillRule: f.region.fillRule, feather: f.region.feather } } : { clip: f.region.path, clipRule: f.region.fillRule }),
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
  const c = autoCenter(f, p, pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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
  for (const a of angles) {
    const d = { x: Math.cos(a), y: Math.sin(a) };
    let rin = ellipseR(rx, ry, a - rot0) * (1 + ij * Math.pow(f.rng.next(), 1.5));
    if (f.rng.chance((spikes.ratio as number) ?? 0.06)) rin *= 1 - ((spikes.depth as number) ?? 0.45) * f.rng.next();
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
      ...effectLine(f, pts, lineStyle(f, w), f.hand, f.rng.fork("fl"), {
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
      out.push(...effectLine(f, pts.map((q) => ({ x: q.x + n.x, y: q.y + n.y })), lineStyle(f, w * 0.7), f.hand, f.rng.fork("fl2"), { ruler: true, taperOut: true, taperIn: false, taperOutLen: taperLen, resolution: Math.max(0.3, w), inkPool: false }));
    }
  }
  return out;
}

// ---- beta flash --------------------------------------------------------------

function betaFlash(f: FxCtx): Node[] {
  const p = f.p;
  const b = f.region.bbox;
  const pc = placeCtx(f.ctx, f.el);
  const c = autoCenter(f, p, pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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
  const angles = clusteredAngles(f.rng, count, 0.9, 0.25).sort((a, b) => a - b);
  const inks: InkPoly[] = [];
  const spikesAt: { a: number; ri: number }[] = [];
  for (const a of angles) {
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const ro = outerR(a) + 0.8 * f.k;
    let ri = ellipseR(rx, ry, a) * (1 + ij * Math.pow(f.rng.next(), 1.3) * ((ro / ellipseR(rx, ry, a)) - 1) * 0.6);
    if (f.rng.chance((spikes.ratio as number) ?? 0.1)) ri *= 1 - ((spikes.depth as number) ?? 0.6) * f.rng.next() * 0.6;
    ri = Math.min(ri, ro - 1 * f.k);
    spikesAt.push({ a, ri });
    const w = sampleR(f, th);
    inks.push(...effectLine(f, [{ x: c.x + d.x * ro, y: c.y + d.y * ro }, { x: c.x + d.x * ri, y: c.y + d.y * ri }], lineStyle(f, w), f.hand, f.rng.fork("bf"), { ruler: true, taperIn: false, taperOut: true, taperOutLen: (ro - ri) * 0.85, resolution: Math.max(0.3, w), inkPool: false }));
  }
  // the solid black reaches in past the outer boundary as a ring of wedges, so the strokes
  // grow out of solid ink instead of ending at a visible (scalloped) edge
  const solidR = (a: number, ri: number) => {
    const ro = outerR(a);
    return ro - (ro - ri) * 0.22;
  };
  for (let i = 0; i < spikesAt.length; i++) {
    const s0 = spikesAt[i];
    const s1 = spikesAt[(i + 1) % spikesAt.length];
    const a1 = i + 1 < spikesAt.length ? s1.a : s1.a + Math.PI * 2;
    const am = (s0.a + a1) / 2;
    const rb = solidR(am, Math.max(s0.ri, s1.ri));
    const rt = solidR(s0.a, s0.ri) - (solidR(s0.a, s0.ri) - s0.ri) * 0.45;
    if (i === 0) outerPoly.length = 0;
    outerPoly.push({ x: c.x + Math.cos(s0.a) * rt, y: c.y + Math.sin(s0.a) * rt }, { x: c.x + Math.cos(am) * rb, y: c.y + Math.sin(am) * rb });
  }
  const core = parsePaint(p.core ?? "paper", { u: f.ctx.u, box: b, seed: f.el.seed });
  const pre: Node[] = [];
  if (core) pre.push({ kind: "path", path: f.region.path, fillRule: f.region.fillRule, paint: core, tag: tag(f.el, "fill") });
  // black outside the outer boundary
  const ring = [...polyPath(f.region.polys[0] ?? [], true), ...polyPath(outerPoly.slice().reverse(), true)];
  pre.push({ kind: "path", path: ring, fillRule: "evenodd", paint: { type: "solid", color: f.color }, tag: tag(f.el, "fill") });
  return wrap(f, inksToNodes(inks, f.color, tag(f.el, "ink")), pre);
}

// ---- uni flash ---------------------------------------------------------------

function uniFlash(f: FxCtx): Node[] {
  const ufTaper = (f.p.taper as string) ?? "both";
  const p = f.p;
  const b = f.region.bbox;
  const pc = placeCtx(f.ctx, f.el);
  const c = autoCenter(f, p, pc) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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
      inks.push(...effectLine(f, [{ x: c.x + d.x * ro, y: c.y + d.y * ro }, { x: c.x + d.x * ri, y: c.y + d.y * ri }], lineStyle(f, w), f.hand, f.rng.fork("uf"), { ruler: true, taperIn: ufTaper !== "out" && ufTaper !== "none", taperOut: ufTaper !== "in" && ufTaper !== "none", taperInLen: len * (1 - peak), taperOutLen: len * peak, resolution: Math.max(0.2, w), inkPool: false }));
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
  const follow = p.followPath;
  const pc = placeCtx(f.ctx, f.el);
  const points = Array.isArray(follow) ? follow.map((q) => resolvePoint(q, pc)).filter((q): q is Vec => q !== null) : [];
  const path = points.length >= 2 ? smoothPath(points, false) : isObj(follow) && typeof follow.path === "string" ? transformPath(parseSvgPath(follow.path), [1, 0, 0, 1, f.ctx.coordsBox.x, f.ctx.coordsBox.y]) : [];
  const guide = flattenPath(path, 0.1)[0]?.pts ?? [];
  if (follow !== undefined && guide.length < 2) f.ctx.bag.error("EFFECT_PATH_INVALID", "followPath needs at least two points or a nonempty SVG path", { path: [...f.el.path, "followPath"] });
  const arc = [0];
  for (let i = 1; i < guide.length; i++) arc.push(arc[i - 1] + Math.hypot(guide[i].x - guide[i - 1].x, guide[i].y - guide[i - 1].y));
  const total = arc.at(-1) ?? 0;
  const ang = total > 0 ? Math.atan2(guide.at(-1)!.y - guide[0].y, guide.at(-1)!.x - guide[0].x) : parseAngle((p.angle as string) ?? 0);
  const d = { x: Math.cos(ang), y: Math.sin(ang) };
  const n = { x: -d.y, y: d.x };
  const corners = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }];
  const projN = corners.map((q) => q.x * n.x + q.y * n.y);
  const guideN = guide.map((q) => q.x * n.x + q.y * n.y);
  const projD = corners.map((q) => q.x * d.x + q.y * d.y);
  const n0 = Math.min(...projN) - (total ? Math.max(...guideN) : 0);
  const n1 = Math.max(...projN) - (total ? Math.min(...guideN) : 0);
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
  // in a band region the lines thin out toward the band's open edge instead of stopping at a rule
  const band = isObj(p.region) && isObj((p.region as Obj).band) ? String(((p.region as Obj).band as Obj).side ?? "") : "";
  const bandN = band === "top" ? { x: 0, y: -1 } : band === "bottom" ? { x: 0, y: 1 } : band === "left" ? { x: -1, y: 0 } : band === "right" ? { x: 1, y: 0 } : null;
  // +1: the open edge is at n0, -1: at n1 (only when the lines run along the band)
  const openAt = bandN && Math.abs(bandN.x * n.x + bandN.y * n.y) > 0.9 ? (bandN.x * n.x + bandN.y * n.y > 0 ? 1 : -1) : 0;
  const fade = typeof p.fade === "number" ? p.fade : openAt ? 0.45 : 0;
  const out: InkPoly[] = [];
  let pos = n0 - sp.max;
  while (pos < n1 + sp.max) {
    const mod = 1 + cl * 1.5 * noise1(seed, pos / (6 * f.k));
    pos += Math.max(sp.min * 0.5, sampleR(f, sp) / Math.max(0.3, mod) / dens);
    let len = sampleR(f, lenR);
    if (fade > 0 && openAt) {
      // 0 at the open edge -> 1 at the far side; the outer `fade` part of the band thins out
      const tN = Math.max(0, Math.min(1, openAt > 0 ? (pos - n0) / Math.max(1e-6, n1 - n0) : (n1 - pos) / Math.max(1e-6, n1 - n0)));
      const keep = Math.min(1, tN / fade);
      if (f.rng.next() > keep * keep) continue;
      len *= 0.45 + 0.55 * keep;
    }
    let start: number;
    if (align === "start") start = d0 + f.rng.range(0, extent * 0.08);
    else if (align === "end") start = d1 - len - f.rng.range(0, extent * 0.08);
    else if (align === "center") start = (d0 + d1) / 2 - len / 2 + f.rng.range(-0.05, 0.05) * extent;
    else start = d0 - len * 0.2 + f.rng.range(0, Math.max(0, extent - len * 0.6));
    const w = sampleR(f, th);
    const P = (t: number) => {
      if (!total) return { x: n.x * pos + d.x * t, y: n.y * pos + d.y * t };
      const s = Math.max(0, Math.min(total, (t - d0) / extent * total));
      let i = 1;
      while (i < arc.length - 1 && arc[i] < s) i++;
      const a = guide[i - 1], z = guide[i];
      const length = arc[i] - arc[i - 1] || 1;
      const fraction = (s - arc[i - 1]) / length;
      const offset = pos;
      return { x: a.x + (z.x - a.x) * fraction - (z.y - a.y) / length * offset, y: a.y + (z.y - a.y) * fraction + (z.x - a.x) / length * offset };
    };
    const segs: [number, number][] = [[start, start + len]];
    for (const [a0, a1] of segs) {
      const segLen = a1 - a0;
      const steps = total ? Math.max(2, Math.ceil(segLen / (0.5 * f.k))) : 1;
      const line = Array.from({ length: steps + 1 }, (_, i) => P(a0 + segLen * i / steps));
      out.push(...effectLine(f, line, lineStyle(f, w), f.hand, f.rng.fork("sl"), { ruler: !total && p.ruler !== false, taperIn: taper === "both" || taper === "start", taperOut: taper === "both" || taper === "end", taperInLen: segLen * 0.35, taperOutLen: segLen * 0.45, resolution: Math.max(0.3, w), inkPool: false }));
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
    out.push(...effectLine(f, [{ x, y: y0 }, { x: x + f.rng.range(-0.15, 0.15) * f.k, y: y0 + len }], lineStyle(f, w), f.hand, f.rng.fork("gl"), { ruler: true, taperIn: (p.taper as string) === "both", taperOut: true, taperInLen: len * 0.15, taperOutLen: len * 0.6, resolution: Math.max(0.3, w), inkPool: false }));
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
  const rate = ((p.rate as number) ?? 2.5) * ((p.density as number) ?? 1);
  const n = Math.round(((b.w * b.h) / 100) * rate);
  const lenR = R(f, p.length, { min: 3 * f.k, max: 12 * f.k, dist: "uniform" });
  const th = R(f, p.thickness, { min: 0.08 * f.k, max: 0.2 * f.k, dist: "low" });
  const out: InkPoly[] = [];
  for (let i = 0; i < n; i++) {
    const c = { x: b.x + f.rng.next() * b.w, y: b.y + f.rng.next() * b.h };
    const l = sampleR(f, lenR);
    out.push(...effectLine(f, [{ x: c.x - (d.x * l) / 2, y: c.y - (d.y * l) / 2 }, { x: c.x + (d.x * l) / 2, y: c.y + (d.y * l) / 2 }], lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("r"), { ruler: true, taperIn: true, taperOut: true, taperInLen: l * 0.2, taperOutLen: l * 0.35, inkPool: false, resolution: 0.25 }));
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
    out.push(...effectLine(f, pts, lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("sw"), { taperIn: true, taperOut: true, taperInLen: len * 0.2, taperOutLen: len * 0.55, inkPool: false }));
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
  const ruler = p.ruler === true;
  // gradient: darkness 1 -> 0 across the region; lines thin out where it is light
  const gr = isObj(p.gradient) ? (p.gradient as Obj) : null;
  const gAng = gr ? parseAngle((gr.angle as string) ?? "90deg") : 0;
  const gd = { x: Math.cos(gAng), y: Math.sin(gAng) };
  const gc = [b, { ...b, x: b.x + b.w }, { ...b, y: b.y + b.h }, { ...b, x: b.x + b.w, y: b.y + b.h }].map((q) => q.x * gd.x + q.y * gd.y);
  const g0 = Math.min(...gc);
  const g1 = Math.max(...gc);
  const darkAt = (q: Vec) => {
    if (!gr) return 1;
    const t = (q.x * gd.x + q.y * gd.y - g0) / Math.max(1e-6, g1 - g0);
    return Number(gr.from ?? 1) + (Number(gr.to ?? 0) - Number(gr.from ?? 1)) * t;
  };
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
          // darker parts get more layers
          if (gr && f.rng.next() > Math.max(0, Math.min(1, darkAt({ x: cx, y: cy }) * layers - layer))) continue;
          const parity = ((Math.round(x / step) + Math.round(y / step) + layer) % 2) * (Math.PI / 2);
          const a = ang0 + parity + f.rng.range(-0.26, 0.26);
          const d = { x: Math.cos(a), y: Math.sin(a) };
          const n = { x: -d.y, y: d.x };
          for (let i = 0; i < lpb; i++) {
            const o = (i - (lpb - 1) / 2) * (size / lpb);
            const l = size * f.rng.range(0.8, 1.05);
            const c0 = { x: cx + n.x * o, y: cy + n.y * o };
            out.push(...effectLine(f, [{ x: c0.x - (d.x * l) / 2, y: c0.y - (d.y * l) / 2 }, { x: c0.x + (d.x * l) / 2, y: c0.y + (d.y * l) / 2 }], lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("ka"), { taperIn: true, taperOut: true, taperInLen: l * 0.3, taperOutLen: l * 0.4, inkPool: false, wobble: false, resolution: 0.15, ruler }));
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
            // with a gradient, lines are cut into strokes and the light side keeps fewer, shorter ones
            const pieces = gr ? Math.max(1, Math.round((t1 - t0) / (4 * f.k))) : 1;
            const pl = (t1 - t0) / pieces;
            for (let k = 0; k < pieces; k++) {
              let a0 = t0 + k * pl;
              let a1 = a0 + pl * (gr ? 1.08 : 1);
              if (gr) {
                const mid = { x: n.x * s + d.x * (a0 + pl / 2), y: n.y * s + d.y * (a0 + pl / 2) };
                const dk = Math.max(0, Math.min(1, darkAt(mid)));
                if (f.rng.next() > dk + 0.05) continue;
                const shrink = pl * (1 - (0.35 + 0.65 * dk)) * 0.5;
                a0 += shrink;
                a1 -= shrink;
              }
              const l = a1 - a0;
              if (l < 0.6 * f.k) continue;
              out.push(...effectLine(f, [{ x: n.x * s + d.x * a0, y: n.y * s + d.y * a0 }, { x: n.x * s + d.x * a1, y: n.y * s + d.y * a1 }], lineStyle(f, sampleR(f, th)), f.hand, f.rng.fork("h"), { taperIn: true, taperOut: true, taperInLen: Math.min(l * 0.3, 2 * f.k), taperOutLen: Math.min(l * 0.4, 3 * f.k), inkPool: false, resolution: 0.3, ruler }));
            }
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
  const c = resolvePoint(f.p.center ?? "center", placeCtx(f.ctx, f.el)) ?? { x: 0, y: 0 };
  return wrap(f, impactNodes(f, c));
}

function impactNodes(f: FxCtx, c: Vec, beamRadius?: number): Node[] {
  const p = f.p;
  const b = f.region.bbox;
  const radius = beamRadius ?? L(f, p.radius ?? "18%", Math.min(b.w, b.h));
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
    inks.push(...effectLine(f, [a, bb], lineStyle(f, w), f.hand, f.rng.fork("im"), { taperIn: i % 2 === 1, taperOut: i % 2 === 0, inkPool: false }));
  }
  if (p.double !== false) {
    const inner = star(radius * 0.6, 2);
    for (let i = 0; i < inner.length; i++) inks.push(...effectLine(f, [inner[i], inner[(i + 1) % inner.length]], lineStyle(f, w * 0.7), f.hand, f.rng.fork("im2"), { inkPool: false }));
  }
  const rays = (isObj(p.rays) ? p.rays : { count: 24 }) as Obj;
  const rc = Number(rays.count ?? 24);
  const rl: Range = beamRadius === undefined ? R(f, rays.length, { min: 2 * f.k, max: 8 * f.k, dist: "uniform" })
    : { min: radius * 0.3, max: radius * 0.9, dist: "uniform" };
  const rt = R(f, rays.thickness, { min: 0.15 * f.k, max: 0.4 * f.k, dist: "low" });
  for (let i = 0; i < rc; i++) {
    const a = (i / rc) * Math.PI * 2 + f.rng.range(-0.1, 0.1);
    const r0 = radius * (1.5 + f.rng.range(0, 0.3));
    const l = sampleR(f, rl);
    const d = { x: Math.cos(a), y: Math.sin(a) };
    inks.push(...effectLine(f, [{ x: c.x + d.x * r0, y: c.y + d.y * r0 }, { x: c.x + d.x * (r0 + l), y: c.y + d.y * (r0 + l) }], lineStyle(f, sampleR(f, rt)), f.hand, f.rng.fork("ray"), { ruler: true, taperIn: true, taperOut: true, inkPool: false }));
  }
  nodes.push(...inksToNodes(inks, f.color, tag(f.el, "ink")));
  return nodes;
}

// ---- vignette ----------------------------------------------------------------

function materialEffects(f: FxCtx, kind: string): Node[] {
  const { p, rng } = f;
  if (kind === "crack" && p.center === undefined) {
    f.ctx.bag.error("SCHEMA_REQUIRED", "crack requires center", { path: [...f.el.path, "center"] });
    return [];
  }
  const b = f.region.bbox;
  const unit = Math.min(b.w, b.h);
  const nodes: Node[] = [];
  const stroke = resolveStroke({ pen: p.pen, color: p.color, ...(isObj(p.stroke) ? p.stroke : {}) }, f.hand, f.ctx.u, f.ctx.bag, [...f.el.path, "stroke"]);
  const line = (pts: Vec[], width: number, color = f.color) => {
    const lineRng = rng.fork("line");
    const style = { ...stroke, width };
    const inks = stroke.style === "solid"
      ? inkLine(pts, style, stroke.hand, lineRng, { taperOut: true, inkPool: false })
      : inkShape({ pts, closed: false, smooth: true }, { hand: stroke.hand, rng: lineRng, line: style }).inks;
    nodes.push(...inksToNodes(inks, color, tag(f.el, "ink")));
  };
  const plane = (pts: Vec[], paint: unknown, role: "fill" | "tone" = "fill") => {
    const resolved = parsePaint(paint, { u: f.ctx.u, box: b, seed: f.el.seed });
    if (resolved) nodes.push({ kind: "path", path: polyPath(pts, true), fillRule: "nonzero", paint: resolved, tag: tag(f.el, role) });
  };
  const shape = (pts: Vec[], paint: unknown, angular = false) => {
    const s = inkShape({ pts, closed: true, smooth: !angular }, { hand: stroke.hand, rng: rng.fork("shape"), join: "clean", line: stroke });
    plane(s.fill, paint);
    nodes.push(...inksToNodes(s.inks, stroke?.color ?? f.color, tag(f.el, "ink")));
  };
  const point = (v: unknown, fallback: Vec) => v === undefined ? fallback : resolvePoint(v, placeCtx(f.ctx, f.el)) ?? fallback;
  const jag = (o: Vec, angle: number, length: number, jaggedness: number): Vec[] => Array.from({ length: 10 }, (_, i) => {
    const t = i / 9;
    const off = i === 0 ? 0 : rng.range(-1, 1) * length * 0.12 * jaggedness;
    return { x: o.x + Math.cos(angle) * length * t - Math.sin(angle) * off, y: o.y + Math.sin(angle) * length * t + Math.cos(angle) * off };
  });
  if (kind === "lightning") {
    const angle = parseAngle(p.direction as string);
    const thickness = R(f, p.thickness, { min: 3 * f.k, max: 6 * f.k, dist: "uniform" });
    const bolt = (pts: Vec[], width: number) => {
      const left: Vec[] = [], right: Vec[] = [];
      for (let i = 0; i < pts.length; i++) {
        const next = pts[Math.min(i + 1, pts.length - 1)], prev = pts[Math.max(0, i - 1)];
        const a = Math.atan2(next.y - prev.y, next.x - prev.x) + Math.PI / 2;
        const w = width * Math.pow(1 - i / (pts.length - 1), 0.7) / 2;
        left.push({ x: pts[i].x + Math.cos(a) * w, y: pts[i].y + Math.sin(a) * w });
        right.push({ x: pts[i].x - Math.cos(a) * w, y: pts[i].y - Math.sin(a) * w });
      }
      shape([...left, ...right.reverse()], p.fill, true);
    };
    for (let i = 0; i < Number(p.bolts); i++) {
      const o = point(p.origin, { x: b.x + b.w * (i + rng.range(0.2, 0.8)) / Number(p.bolts), y: b.y });
      const length = L(f, p.length, b.h) * rng.range(0.8, 1.1);
      const pts = jag(o, angle, length, Number(p.jaggedness));
      const width = sampleR(f, thickness);
      bolt(pts, width);
      for (let j = 0; j < Number(p.branches); j++) {
        const at = rng.int(2, 6);
        bolt(jag(pts[at], angle + (j % 2 ? -1 : 1) * rng.range(0.5, 1), length * rng.range(0.2, 0.4), Number(p.jaggedness)), width * 0.3);
      }
    }
  } else if (kind === "crack") {
    const c = point(p.center, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const radius = L(f, p.radius, unit);
    const th = R(f, p.thickness, { min: 0.15 * f.k, max: 0.65 * f.k, dist: "uniform" });
    const cracks: Vec[][] = [];
    for (let i = 0; i < Number(p.count); i++) {
      const a = (i + rng.range(-0.25, 0.25)) * Math.PI * 2 / Number(p.count);
      const pts = jag(c, a, radius * rng.range(0.75, 1.2), 0.7);
      cracks.push(pts);
      plane([...pts, ...pts.map((q, j) => ({ x: q.x + radius * 0.035 * (1 - j / 9), y: q.y + radius * 0.012 * (1 - j / 9) })).reverse()], p.shade);
      line(pts, sampleR(f, th));
      for (let j = 2; j < 8; j++) if (rng.chance(Number(p.branching))) line(jag(pts[j], a + rng.range(-1, 1), radius * 0.3, 0.7), sampleR(f, th) * 0.5);
    }
    for (let r = 0; r < Number(p.rings); r++) for (let i = 0; i < cracks.length; i++) {
      const index = Math.min(8, Math.round((r + 1) * 8 / (Number(p.rings) + 1)));
      const a = cracks[i][index], z = cracks[(i + 1) % cracks.length][index];
      line([a, { x: (a.x + z.x) / 2 + rng.range(-1, 1) * radius * 0.06, y: (a.y + z.y) / 2 + rng.range(-1, 1) * radius * 0.06 }, z], th.min);
    }
  } else {
    const dust = kind === "dust";
    const o = point(p.origin, { x: b.x + b.w / 2, y: b.y + b.h });
    const angle = p.direction === "both" ? -Math.PI / 2 : parseAngle(p.direction as string);
    const n = dust ? Number(p.puffs) : Math.round(Number(p.density) * 22);
    const size = dust ? L(f, p.size, unit) : unit * 0.3;
    for (let i = n - 1; i >= 0; i--) {
      const t = (i + 0.5) / Math.max(1, n);
      const travel = dust ? size * t * 1.9 : b.h * t;
      const side = dust && p.direction === "both" ? (i % 2 ? -1 : 1) * travel : rng.range(-1, 1) * size * (0.25 + t);
      const c = !dust && p.origin === undefined ? { x: b.x + rng.next() * b.w, y: b.y + rng.next() * b.h } : { x: o.x + Math.cos(angle) * travel - Math.sin(angle) * side, y: o.y + Math.sin(angle) * travel * (dust ? 0.4 : 1) + Math.cos(angle) * side };
      const rx = size * (dust ? 0.65 - 0.35 * t : rng.range(0.6, 1.2));
      const ry = rx * (dust ? 0.7 : 1.15);
      const phase = rng.range(0, Math.PI * 2);
      const lobes = dust ? 9 : 7;
      const anchors = Array.from({ length: lobes }, (_, j) => {
        const a = phase + j / lobes * Math.PI * 2;
        const r = rng.range(0.9, 1.08);
        return { x: c.x + Math.cos(a) * rx * r, y: c.y + Math.sin(a) * ry * r };
      });
      const pts: Vec[] = [];
      for (let j = 0; j < lobes; j++) {
        const a = anchors[j], z = anchors[(j + 1) % lobes];
        const dx = (z.x - a.x) / 2, dy = (z.y - a.y) / 2;
        const bulge = rng.range(0.75, 1.05);
        for (let s = 0; s < 12; s++) {
          const t = s / 12 * Math.PI;
          pts.push({ x: (a.x + z.x) / 2 - dx * Math.cos(t) + dy * Math.sin(t) * bulge, y: (a.y + z.y) / 2 - dy * Math.cos(t) - dx * Math.sin(t) * bulge });
        }
      }
      shape(pts, p.fill);
      const underside = pts.filter(q => q.y >= c.y + ry * 0.35);
      plane(underside, p.tone, "tone");
      const curl = Array.from({ length: 28 }, (_, j) => {
        const a = j / 27 * Math.PI * (dust ? 1.1 : 2.1) + phase;
        const r = (1 - j / 32) * rx * 0.6;
        return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * (dust ? 0.8 : 1.4) };
      });
      if (i % 3 === 0) line(curl, (dust ? 0.15 : 0.12) * f.k);
    }
    if (dust) for (let i = 0; i < Number(p.debris); i++) {
      const a = rng.range(-Math.PI, 0), d = size * rng.range(1, 2.8), r = rng.range(0.3, 1) * f.k;
      const c = { x: o.x + Math.cos(a) * d, y: o.y + Math.sin(a) * d };
      shape([{ x: c.x - r, y: c.y }, { x: c.x, y: c.y - r * 1.5 }, { x: c.x + r, y: c.y + r }], p.color);
    }
  }
  let result = nodes;
  if (kind === "crack" && p.target !== undefined) {
    const target = resolveRegion(p.target, f.ctx, "panel", [...f.el.path, "target"]);
    result = [{ kind: "group", clip: target.path, clipRule: target.fillRule, children: nodes }];
  }
  return wrap(f, result, backgroundNode(f));
}

function vignette(f: FxCtx): Node[] {
  const p = f.p;
  const b = f.region.bbox;
  const color = parseColor((p.color as string) ?? "paper") ?? WHITE;
  const width = L(f, p.width ?? `${8 * f.k}mm`);
  const soft = (p.softness as number) ?? 0.7;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const shape = (p.shape as string) ?? "rect";
  if (shape === "rect") {
    // four edge bands fading from the ground colour into the picture
    const bandW = width * (0.6 + soft * 0.8);
    const tr0 = { ...color, a: 0 };
    const band = (q: Vec[], x0: number, y0: number, x1: number, y1: number): Node => ({ kind: "path", path: polyPath(q, true), fillRule: "nonzero", paint: { type: "linear-gradient", x0, y0, x1, y1, stops: [{ offset: 0, color }, { offset: 1, color: tr0 }], screen: (p.screen as "am" | "spatter") ?? "am" }, tag: tag(f.el, "fill") });
    const X0 = b.x;
    const Y0 = b.y;
    const X1 = b.x + b.w;
    const Y1 = b.y + b.h;
    return wrap(f, [
      band([{ x: X0, y: Y0 }, { x: X1, y: Y0 }, { x: X1, y: Y0 + bandW }, { x: X0, y: Y0 + bandW }], X0, Y0, X0, Y0 + bandW),
      band([{ x: X0, y: Y1 - bandW }, { x: X1, y: Y1 - bandW }, { x: X1, y: Y1 }, { x: X0, y: Y1 }], X0, Y1, X0, Y1 - bandW),
      band([{ x: X0, y: Y0 }, { x: X0 + bandW, y: Y0 }, { x: X0 + bandW, y: Y1 }, { x: X0, y: Y1 }], X0, Y0, X0 + bandW, Y0),
      band([{ x: X1 - bandW, y: Y0 }, { x: X1, y: Y0 }, { x: X1, y: Y1 }, { x: X1 - bandW, y: Y1 }], X1, Y0, X1 - bandW, Y0),
    ]);
  }
  const r = Math.hypot(b.w, b.h) / 2;
  const innerR = Math.max(0, r - width * 2.2);
  const t0 = innerR / r;
  const tr = { ...color, a: 0 };
  const stops = [{ offset: Math.max(0, t0 - soft * 0.2), color: tr }, { offset: Math.min(1, t0 + (1 - t0) * (1 - soft * 0.5)), color }, { offset: 1, color }];
  const node: Node = { kind: "group", transform: [b.w / Math.max(b.w, b.h) * 1.1, 0, 0, b.h / Math.max(b.w, b.h) * 1.1, cx * (1 - (b.w / Math.max(b.w, b.h)) * 1.1), cy * (1 - (b.h / Math.max(b.w, b.h)) * 1.1)], children: [{ kind: "path", path: polyPath([{ x: cx - r * 2, y: cy - r * 2 }, { x: cx + r * 2, y: cy - r * 2 }, { x: cx + r * 2, y: cy + r * 2 }, { x: cx - r * 2, y: cy + r * 2 }], true), fillRule: "nonzero", paint: { type: "radial-gradient", cx, cy, r, stops, screen: (p.screen as "am" | "spatter") ?? "am" }, tag: tag(f.el, "fill") }], tag: tag(f.el, "fill") };
  return wrap(f, [node]);
}

/** clear: keep the effect off a region for every kind (focus/speed lines also shorten their lines) */
function applyClear(f: FxCtx, nodes: Node[]): Node[] {
  // Line effects are cleared before inking; only filled surfaces need a mask.
  let out = nodes;
  for (const { region: reg, margin } of f.clears) {
    const maskFills = (children: Node[], mask: (node: Node) => Node): Node[] => children.map((node) => node.kind === "group" ? { ...node, children: maskFills(node.children, mask) } : node.tag?.role === "ink" ? node : mask(node));
    if (reg.alphaOf) {
      const t = f.ctx.refs.get(reg.alphaOf);
      if (t?.imagePx) out = maskFills(out, (node) => ({ kind: "group", alphaMaskOf: { ...t.imagePx!, invert: true, dilate: margin }, children: [node] }));
    } else {
      const b = f.region.bbox;
      const outer = polyPath([{ x: b.x - 1, y: b.y - 1 }, { x: b.x + b.w + 1, y: b.y - 1 }, { x: b.x + b.w + 1, y: b.y + b.h + 1 }, { x: b.x - 1, y: b.y + b.h + 1 }], true);
      const path = [...outer, ...reg.path];
      out = maskFills(out, (node) => reg.feather > 0 ? { kind: "group", softClip: { path, fillRule: "evenodd", feather: reg.feather }, children: [node] } : { kind: "group", clip: path, clipRule: "evenodd", children: [node] });
    }
  }
  return out;
}

export async function renderEffect(el: RElement, ctx: ElemCtx): Promise<Node[]> {
  const hold: { f?: FxCtx } = {};
  const out = await renderEffectInner(el, ctx, hold);
  return hold.f ? applyClear(hold.f, out) : out;
}

async function renderEffectInner(el: RElement, ctx: ElemCtx, hold: { f?: FxCtx }): Promise<Node[]> {
  const p = el.props;
  const kind = String(p.kind);
  const hand = resolveHand(p.hand, ctx.u, ctx.draft);
  const pen = resolvePen(p.pen, ctx.u, hand.pen);
  const color = parseColor((p.color as string) ?? "black") ?? BLACK;
  const region = resolveRegion(p.region, ctx, ctx.panel ? "panel" : "page", [...el.path, "region"]);
  const f: FxCtx = { el, p, ctx, region, rng: new Rng(el.seed), hand, pen, color, k: ctx.u.k, clears: [] };
  f.clears = await resolveClears(f);
  hold.f = f;
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
        // a flat tone fades out toward the line ends instead of stopping at a hard edge
        if (tp?.type === "tone" && !tp.tone.gradient && p.toneFade !== false) {
          const bb = region.bbox;
          tp.tone = { ...tp.tone, gradient: { type: "linear", p0: { x: bb.x, y: bb.y }, p1: { x: bb.x, y: bb.y + bb.h }, stops: [[0, tp.tone.density], [0.35, tp.tone.density], [1, 0]], easing: "linear" } };
        }
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
    case "beam": {
      const nodes = renderBeam(el, ctx, region, (center, radius, seed) =>
        impactNodes({
          ...f, el: { ...el, seed }, rng: new Rng(seed),
          p: { ...BUILTIN_EFFECT_DEFAULTS.impact, spikes: 9, double: false, rays: { count: 10 } },
        }, center, radius));
      return nodes.length ? wrap(f, nodes, backgroundNode(f)) : [];
    }
    case "lightning":
    case "crack":
    case "dust":
    case "smoke":
      return materialEffects(f, kind);
    case "vignette":
      return vignette(f);
    case "glow":
    case "light-rays":
    case "spotlight":
      return wrap(f, renderLight(el, ctx, region), backgroundNode(f));
    default: {
      const def = activePlugins()?.effects.get(kind);
      if (def) {
        const stroke = resolveStroke(p.stroke ?? { width: "0.2bmm", color: p.color }, hand, ctx.u, ctx.bag, [...el.path, "stroke"]);
        const b = region.bbox;
        const nodes = runPluginDrawable(def, el, ctx, { rng: f.rng, hand, stroke, bounds: b, center: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, size: Math.min(b.w, b.h), contains: (q) => region.contains(q) });
        return wrap(f, nodes, backgroundNode(f));
      }
      ctx.bag.error("SCHEMA_ENUM", `unknown effect kind "${kind}"`, { path: [...el.path, "kind"] });
      return [];
    }
  }
}
