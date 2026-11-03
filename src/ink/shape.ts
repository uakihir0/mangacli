// Shape -> strokes decomposition (spec 9.3.2, 9.5).
import { fbm1, fbm1p, type Rng } from "../core/random.js";
import { polygonArea } from "../geom/path.js";
import type { Vec } from "../geom/vec.js";
import type { HandSpec, PenSpec } from "./presets.js";
import { type InkPoly, blobPoly, rotateAboutMid, strokeOutline } from "./stroke.js";

export type CornerKind = "convex" | "concave" | "tip" | "valley";

export interface Corner {
  index: number;
  kind: CornerKind;
}

export interface ShapeContour {
  pts: Vec[];
  closed: boolean;
  corners?: Corner[];
  /** preferred start range for closed smooth contours, as fractions of perimeter (from vertex 0) */
  startRange?: [number, number];
  /** do not auto-detect corners */
  smooth?: boolean;
}

export interface LineStyle {
  width: number;
  pen: PenSpec;
  style: "solid" | "dashed" | "dotted" | "double" | "none";
  dash?: [number, number];
  dot?: { size: number; gap: number };
  double?: { gap: number; inner: number };
}

export interface InkShapeOptions {
  line?: LineStyle;
  hand: HandSpec;
  rng: Rng;
  ruler?: boolean;
  join?: "clean" | "overshoot" | "gap";
  wobble?: boolean;
  strokes?: number | "auto";
  /** taper at stroke ends (default true) */
  taper?: boolean;
  /** cap wobble amplitude relative to shape size */
  sizeHint?: number;
}

export interface InkResult {
  fill: Vec[];
  inks: InkPoly[];
}

interface Dense {
  pts: Vec[];
  s: number[];
  total: number;
  vmap: number[]; // original vertex index -> dense index
  closed: boolean;
}

function densify(pts: readonly Vec[], closed: boolean, step: number): Dense {
  const out: Vec[] = [];
  const vmap: number[] = [];
  const n = pts.length;
  const edges = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    vmap.push(out.length);
    out.push(pts[i]);
    if (i >= edges) break;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.floor(d / step);
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  const s: number[] = [0];
  for (let i = 1; i < out.length; i++) s.push(s[i - 1] + Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
  let total = s[s.length - 1];
  if (closed && out.length > 1) total += Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y);
  return { pts: out, s, total, vmap, closed };
}

function normals(pts: readonly Vec[], closed: boolean): Vec[] {
  const n = pts.length;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? pts[(i - 2 + n) % n] : pts[Math.max(0, i - 2)];
    const b = closed ? pts[(i + 2) % n] : pts[Math.min(n - 1, i + 2)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    out.push({ x: -dy / l, y: dx / l });
  }
  return out;
}

/** Apply path-level wobble (L2) once to the whole contour. */
export function wobbleContour(d: Dense, hand: HandSpec, rng: Rng, sizeHint?: number): Vec[] {
  let amp = hand.wobbleAmp * Math.min(1, d.total / Math.max(1e-6, hand.wobbleLen));
  if (sizeHint !== undefined) amp = Math.min(amp, sizeHint * 0.02);
  if (amp <= 0 || d.pts.length < 3) return d.pts.slice();
  const seed = rng.nextU32();
  const nrm = normals(d.pts, d.closed);
  const out: Vec[] = [];
  if (d.closed) {
    const cycles = Math.max(1, Math.round(d.total / hand.wobbleLen));
    for (let i = 0; i < d.pts.length; i++) {
      const x = (d.s[i] / d.total) * cycles;
      const e = amp * fbm1p(seed, x, cycles);
      out.push({ x: d.pts[i].x + nrm[i].x * e, y: d.pts[i].y + nrm[i].y * e });
    }
  } else {
    for (let i = 0; i < d.pts.length; i++) {
      const e = amp * fbm1(seed, d.s[i] / hand.wobbleLen);
      out.push({ x: d.pts[i].x + nrm[i].x * e, y: d.pts[i].y + nrm[i].y * e });
    }
  }
  return out;
}

/** Turning-angle corner detection (spec 9.5.1). */
export function detectCorners(pts: readonly Vec[], closed: boolean, thresh: number): Corner[] {
  const n = pts.length;
  if (n < 3) return [];
  const area = closed ? polygonArea(pts) : 0;
  const orient = area >= 0 ? 1 : -1;
  const angs: number[] = new Array(n).fill(0);
  const reach = 0.5;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    let j = i;
    let acc = 0;
    do {
      const pj = closed ? (j - 1 + n) % n : j - 1;
      if (pj < 0) break;
      acc += Math.hypot(pts[j].x - pts[pj].x, pts[j].y - pts[pj].y);
      j = pj;
    } while (acc < reach && j !== i);
    let k = i;
    acc = 0;
    do {
      const nk = closed ? (k + 1) % n : k + 1;
      if (nk >= n) break;
      acc += Math.hypot(pts[nk].x - pts[k].x, pts[nk].y - pts[k].y);
      k = nk;
    } while (acc < reach && k !== i);
    const a = pts[j];
    const b = pts[i];
    const c = pts[k];
    const d1 = { x: b.x - a.x, y: b.y - a.y };
    const d2 = { x: c.x - b.x, y: c.y - b.y };
    const cr = d1.x * d2.y - d1.y * d2.x;
    const dt = d1.x * d2.x + d1.y * d2.y;
    angs[i] = Math.atan2(cr, dt);
  }
  const out: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.abs(angs[i]);
    if (a < thresh) continue;
    const prev = Math.abs(angs[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]);
    const next = Math.abs(angs[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]);
    if (a < prev || a < next) continue;
    const convex = angs[i] * orient > 0;
    out.push({ index: i, kind: convex ? "convex" : "concave" });
  }
  return out;
}

/** Ink a closed or open shape: returns the fill contour (wobbled) and stroke outlines. */
export function inkShape(c: ShapeContour, o: InkShapeOptions): InkResult {
  const hand = o.hand;
  const ruler = !!o.ruler;
  const d = densify(c.pts, c.closed, Math.max(0.1, hand.resolution));
  const wob = o.wobble === false || ruler ? d.pts.slice() : wobbleContour(d, hand, o.rng.fork("contour"), o.sizeHint);
  const dense: Dense = { ...d, pts: wob };
  // recompute arc length after wobble
  dense.s = [0];
  for (let i = 1; i < wob.length; i++) dense.s.push(dense.s[i - 1] + Math.hypot(wob[i].x - wob[i - 1].x, wob[i].y - wob[i - 1].y));
  dense.total = dense.s[dense.s.length - 1] + (c.closed ? Math.hypot(wob[0].x - wob[wob.length - 1].x, wob[0].y - wob[wob.length - 1].y) : 0);

  const res: InkResult = { fill: wob, inks: [] };
  const line = o.line;
  if (!line || line.style === "none" || line.width <= 0) return res;

  const rng = o.rng.fork("strokes");
  const passes = Math.max(1, hand.passes);
  for (let pass = 0; pass < passes; pass++) {
    const prng = rng.fork(`pass${pass}`);
    let inks: InkPoly[];
    if (line.style === "dashed") inks = dashed(dense, line, hand, prng, ruler);
    else if (line.style === "dotted") inks = dotted(dense, line, prng);
    else inks = solid(dense, c, line, o, prng);
    if (line.style === "double" && line.double) {
      const inner = offsetDense(dense, -line.double.gap - line.width / 2);
      const innerLine: LineStyle = { ...line, width: line.double.inner, style: "solid" };
      inks.push(...solid(inner, { ...c, corners: undefined }, innerLine, o, prng.fork("inner")));
    }
    if (pass > 0) {
      const off = prng.range(hand.passOffset[0], hand.passOffset[1]);
      const ang = prng.range(0, Math.PI * 2);
      inks = inks.map((k) => ({
        opacity: k.opacity * hand.passOpacity,
        pts: k.pts.map((p) => ({ x: p.x + Math.cos(ang) * off, y: p.y + Math.sin(ang) * off })),
      }));
    }
    res.inks.push(...inks);
  }
  return res;
}

function offsetDense(d: Dense, off: number): Dense {
  const nrm = normals(d.pts, d.closed);
  const orient = d.closed && polygonArea(d.pts) < 0 ? -1 : 1;
  const pts = d.pts.map((p, i) => ({ x: p.x - nrm[i].x * off * orient, y: p.y - nrm[i].y * off * orient }));
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = s[s.length - 1] + (d.closed ? Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) : 0);
  return { pts, s, total, vmap: d.vmap, closed: d.closed };
}

/** point at arc length s (closed contours wrap) */
function pointAt(d: Dense, s: number): Vec {
  const n = d.pts.length;
  if (d.closed) s = ((s % d.total) + d.total) % d.total;
  else s = Math.max(0, Math.min(d.total, s));
  // binary search
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d.s[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = d.pts[lo];
  const bIdx = lo + 1 < n ? lo + 1 : d.closed ? 0 : lo;
  const b = d.pts[bIdx];
  const segEnd = lo + 1 < n ? d.s[lo + 1] : d.total;
  const segLen = segEnd - d.s[lo];
  const t = segLen > 1e-12 ? (s - d.s[lo]) / segLen : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** extract polyline between arc positions s0..s1 (s1 may exceed total for closed) */
function slice(d: Dense, s0: number, s1: number, step: number): Vec[] {
  const out: Vec[] = [];
  const len = s1 - s0;
  const k = Math.max(2, Math.ceil(Math.abs(len) / step));
  for (let i = 0; i <= k; i++) out.push(pointAt(d, s0 + (len * i) / k));
  return out;
}

function extend(pts: Vec[], atStart: number, atEnd: number): Vec[] {
  const out = pts.slice();
  if (atEnd !== 0 && out.length >= 2) {
    const a = out[Math.max(0, out.length - 4)];
    const b = out[out.length - 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    if (atEnd > 0) out.push({ x: b.x + t.x * atEnd, y: b.y + t.y * atEnd });
  }
  if (atStart !== 0 && out.length >= 2) {
    const a = out[Math.min(out.length - 1, 3)];
    const b = out[0];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    if (atStart > 0) out.unshift({ x: b.x + t.x * atStart, y: b.y + t.y * atStart });
  }
  return out;
}

function shiftNormal(pts: Vec[], off: number): Vec[] {
  if (!off || pts.length < 2) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / l;
  const ny = (b.x - a.x) / l;
  return pts.map((p) => ({ x: p.x + nx * off, y: p.y + ny * off }));
}

function solid(d: Dense, c: ShapeContour, line: LineStyle, o: InkShapeOptions, rng: Rng): InkPoly[] {
  const hand = o.hand;
  const step = Math.max(0.1, hand.resolution);
  const inks: InkPoly[] = [];
  const taper = o.taper !== false;
  let corners: Corner[] = c.corners ? c.corners.map((k) => ({ index: d.vmap[k.index] ?? 0, kind: k.kind })) : [];
  if (!c.corners && !c.smooth) corners = detectCorners(d.pts, d.closed, hand.cornerAngle || Math.PI / 3.6);
  corners.sort((a, b) => a.index - b.index);
  const join = o.join ?? "clean";
  const ruler = !!o.ruler;
  const angErr = ruler ? hand.rulerAngleError : 0;

  const draw = (pts: Vec[], tin: boolean, tout: boolean, tinLen?: number, toutLen?: number) => {
    let p = pts;
    if (angErr > 0 && !d.closed && corners.length === 0) p = rotateAboutMid(p, rng.range(-angErr, angErr));
    inks.push(
      ...strokeOutline(p, {
        width: line.width,
        pen: line.pen,
        hand,
        rng: rng.fork("s"),
        taperIn: taper && tin,
        taperOut: taper && tout,
        taperInLen: tinLen,
        taperOutLen: toutLen,
        ruler,
      }),
    );
  };

  const splitLong = (s0: number, s1: number): [number, number][] => {
    const len = s1 - s0;
    const maxL = ruler ? 250 : Math.max(5, hand.maxLength);
    const k = Math.max(1, Math.ceil(len / maxL));
    const parts: [number, number][] = [];
    for (let i = 0; i < k; i++) parts.push([s0 + (len * i) / k, s0 + (len * (i + 1)) / k]);
    return parts;
  };

  if (corners.length > 0) {
    const segs: { a: Corner; b: Corner; s0: number; s1: number }[] = [];
    if (d.closed) {
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        const s0 = d.s[a.index];
        let s1 = d.s[b.index];
        if (s1 <= s0) s1 += d.total;
        segs.push({ a, b, s0, s1 });
      }
    } else {
      const pts = [{ index: 0, kind: "convex" as CornerKind }, ...corners, { index: d.pts.length - 1, kind: "convex" as CornerKind }];
      for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i], b: pts[i + 1], s0: d.s[pts[i].index], s1: d.s[pts[i + 1].index] });
    }
    for (const sg of segs) {
      const parts = splitLong(sg.s0, sg.s1);
      for (let pi = 0; pi < parts.length; pi++) {
        const [p0, p1] = parts[pi];
        const firstPart = pi === 0;
        const lastPart = pi === parts.length - 1;
        const ov = rng.range(hand.overlap[0], hand.overlap[1]) / 2;
        const ext0 = firstPart ? 0 : ov;
        const ext1 = lastPart ? 0 : ov;
        let pts = slice(d, p0 - ext0, p1 + ext1, step);
        const startKind = firstPart ? sg.a.kind : "smooth";
        const endKind = lastPart ? sg.b.kind : "smooth";
        const extFor = (k: string) => {
          if (k !== "convex") return 0;
          if (join === "overshoot") return rng.range(hand.overshoot[0], hand.overshoot[1]);
          if (join === "gap") return -rng.range(hand.gap[0], hand.gap[1]);
          return line.width * 0.15;
        };
        const e0 = extFor(startKind);
        const e1 = extFor(endKind);
        if (e0 < 0 || e1 < 0) {
          const tot = p1 - p0;
          const a0 = e0 < 0 ? Math.min(-e0, tot * 0.2) : 0;
          const a1 = e1 < 0 ? Math.min(-e1, tot * 0.2) : 0;
          pts = slice(d, p0 + a0, p1 - a1, step);
        }
        pts = extend(pts, Math.max(0, e0), Math.max(0, e1));
        // direction: draw toward tips; concave/valley start strongly (short entry)
        let reverse = false;
        if (endKind === "tip") reverse = false;
        else if (startKind === "tip") reverse = true;
        if (reverse) pts = pts.reverse();
        const sKind = reverse ? endKind : startKind;
        const eKind = reverse ? startKind : endKind;
        const sharpStart = sKind === "concave" || sKind === "valley" || (sKind === "convex" && join !== "overshoot");
        const sharpEnd = eKind === "concave" || eKind === "valley" || (eKind === "convex" && join !== "overshoot");
        const tinLen = sharpStart ? Math.min(0.3, line.width) : undefined;
        const toutLen = sharpEnd ? Math.min(0.3, line.width) : undefined;
        if (!firstPart || !lastPart) pts = shiftNormal(pts, rng.normal() * hand.misalign * 0.3);
        draw(pts, true, true, tinLen, toutLen);
      }
    }
    return inks;
  }

  if (d.closed) {
    const P = d.total;
    let N: number;
    if (typeof o.strokes === "number") N = Math.max(1, Math.round(o.strokes));
    else N = P < 60 ? 1 : P < 140 ? 2 : Math.ceil(P / 70);
    if (hand.overlap[1] <= 0) N = 1;
    const [fa, fb] = c.startRange ?? [0, 1];
    const start = P * rng.range(fa, fb);
    const ovl = () => rng.range(hand.overlap[0], hand.overlap[1]);
    if (hand.overlap[1] <= 0 && hand.gap[1] <= 0) {
      // clean: one seamless stroke without tapers
      const pts = slice(d, start, start + P, step);
      inks.push(...strokeOutline(pts, { width: line.width, pen: line.pen, hand, rng: rng.fork("s"), taperIn: false, taperOut: false, ruler, inkPool: false }));
      return inks;
    }
    for (let k = 0; k < N; k++) {
      let s0 = start + (P * k) / N;
      let s1 = start + (P * (k + 1)) / N;
      if (k > 0) s0 -= ovl() * 0.4;
      if (k < N - 1) s1 += ovl() * 0.6;
      else {
        if (rng.chance(hand.gapChance)) s1 -= rng.range(hand.gap[0], hand.gap[1]);
        else s1 += ovl();
      }
      let pts = slice(d, s0, s1, step);
      pts = shiftNormal(pts, (rng.next() - 0.5) * hand.misalign);
      draw(pts, true, true);
    }
    return inks;
  }

  // open polyline
  for (const [p0, p1] of splitLong(0, d.total)) draw(slice(d, p0, p1, step), true, true);
  return inks;
}

function dashed(d: Dense, line: LineStyle, hand: HandSpec, rng: Rng, ruler: boolean): InkPoly[] {
  const [on, off] = line.dash ?? [1.6, 1.0];
  const inks: InkPoly[] = [];
  let s = rng.range(0, on + off);
  const end = d.total + (d.closed ? 0 : 0);
  const step = Math.max(0.08, hand.resolution * 0.5);
  while (s < end) {
    const l = on * rng.range(0.8, 1.2);
    const e = Math.min(d.closed ? s + l : end, s + l);
    if (!d.closed && e - s < l * 0.3) break;
    const pts = slice(d, s, e, step);
    inks.push(...strokeOutline(pts, { width: line.width, pen: line.pen, hand, rng: rng.fork("d"), taperInLen: l * 0.3, taperOutLen: l * 0.35, ruler, inkPool: false }));
    s = e + off * rng.range(0.8, 1.2);
    if (d.closed && s > d.total - off * 0.5) break;
  }
  return inks;
}

function dotted(d: Dense, line: LineStyle, rng: Rng): InkPoly[] {
  const size = line.dot?.size ?? Math.max(line.width * 1.6, 0.3);
  const gap = line.dot?.gap ?? size * 2;
  const inks: InkPoly[] = [];
  const pitch = size + gap;
  const n = Math.max(3, Math.round(d.total / pitch));
  const real = d.total / n;
  for (let i = 0; i < (d.closed ? n : n + 1); i++) {
    const p = pointAt(d, i * real + rng.range(-0.1, 0.1) * real);
    inks.push({ pts: blobPoly(p, (size / 2) * rng.range(0.85, 1.15), rng, 12, 0.15), opacity: line.pen.opacity ?? 1 });
  }
  return inks;
}

/** Ink a single open line (effects, marks). */
export function inkLine(pts: Vec[], line: LineStyle, hand: HandSpec, rng: Rng, opts: { ruler?: boolean; taperIn?: boolean; taperOut?: boolean; taperInLen?: number; taperOutLen?: number; wobble?: boolean; profile?: (t: number) => number } = {}): InkPoly[] {
  let p = pts;
  if (opts.wobble !== false && !opts.ruler && hand.wobbleAmp > 0) {
    const d = densify(pts, false, Math.max(0.1, hand.resolution));
    p = wobbleContour(d, hand, rng.fork("w"));
  }
  if (opts.ruler && hand.rulerAngleError > 0) p = rotateAboutMid(p, rng.range(-hand.rulerAngleError, hand.rulerAngleError));
  return strokeOutline(p, {
    width: line.width,
    pen: line.pen,
    hand,
    rng: rng.fork("l"),
    ruler: opts.ruler,
    taperIn: opts.taperIn,
    taperOut: opts.taperOut,
    taperInLen: opts.taperInLen,
    taperOutLen: opts.taperOutLen,
    profile: opts.profile,
  });
}
