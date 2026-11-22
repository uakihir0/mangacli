// Balloon body shape generators (spec 6.3, 9.3.1). All shapes centered at origin.
import type { Rng } from "../core/random.js";
import { Rng as RngCls } from "../core/random.js";
import { flattenPath, parseSvgPath, pointInPolygon, polygonArea, polylineLength, resample } from "../geom/path.js";
import { type Vec, dist, rot } from "../geom/vec.js";
import type { Corner, ShapeContour } from "../ink/shape.js";

export interface ShapeParams {
  kind: string;
  /** the shape object as written (for plugin shapes) */
  raw?: Record<string, unknown>;
  irregularity: number;
  tilt: number; // radians (resolved)
  squareness?: number;
  compactCore?: boolean;
  unitScale?: number;
  spikeScale?: number;
  egg?: number;
  radius?: number; // mm (round-rect/rect)
  lobes?: number | "auto";
  lobeSize?: [number, number];
  depth?: number | [number, number];
  count?: number | "auto";
  angleJitter?: number;
  curve?: number;
  waves?: number | "auto";
  amplitude?: number; // mm
  waveform?: "sine" | "zigzag" | "irregular";
  secondary?: boolean;
  corners?: number;
  jag?: number;
  toothPitch?: number; // mm (electronic)
  points?: [number, number][];
  strokes?: number | "auto";
  join?: "clean" | "overshoot" | "gap";
  ruler?: boolean;
  lineLength?: [number, number];
  thickness?: [number, number];
}

export interface BodyGeom {
  contour: ShapeContour;
  /** text-safe polygon (centered coordinates) */
  inner: Vec[];
  /** radial boundary function for tail roots (angle -> point on contour), via contour */
  kind: string;
  /** default stroke count etc */
  smooth: boolean;
  /** ruler default for this shape */
  ruler: boolean;
  spikeLength?: number;
  spikeCore?: Vec[];
}

const TAU = Math.PI * 2;

function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** superellipse polar radius */
function seRadius(a: number, b: number, n: number, th: number): number {
  const c = Math.abs(Math.cos(th)) / a;
  const s = Math.abs(Math.sin(th)) / b;
  return Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n);
}

interface Harmonics {
  a: number[];
  ph: number[];
}

function harmonics(rng: Rng, irr: number): Harmonics {
  const a: number[] = [];
  const ph: number[] = [];
  for (let k = 2; k <= 5; k++) {
    a.push(((irr * 0.035) / Math.pow(k, 0.8)) * rng.range(0.5, 1));
    ph.push(rng.range(0, TAU));
  }
  return { a, ph };
}

function harmonic(h: Harmonics, th: number): number {
  let v = 1;
  for (let i = 0; i < h.a.length; i++) v += h.a[i] * Math.cos((i + 2) * th + h.ph[i]);
  return v;
}

/** organic ellipse: polar radius function */
function organicEllipse(a: number, b: number, p: ShapeParams, rng: Rng): (th: number) => number {
  const sq = p.squareness ?? 0.2;
  const n = 2 + 3 * sq;
  const egg = p.egg ?? 0.02;
  const h = harmonics(rng, p.irregularity);
  return (th: number) => seRadius(a, b, n, th) * harmonic(h, th) * (1 + egg * -Math.sin(th) * 0.5);
}

function sampleRadial(R: (th: number) => number, count: number, tilt: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < count; i++) {
    const th = (i / count) * TAU;
    const r = R(th);
    pts.push(rot({ x: Math.cos(th) * r, y: Math.sin(th) * r }, tilt));
  }
  return pts;
}

export type BodyGenerator = (w: number, h: number, p: ShapeParams, seed: number) => BodyGeom;

const ellipse: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const a = w / 2;
  const b = h / 2;
  const R = organicEllipse(a, b, p, rng);
  const n = Math.max(96, Math.round(ellipsePerimeter(a, b) / 0.4));
  const pts = sampleRadial(R, n, p.tilt);
  return {
    contour: { pts, closed: true, smooth: true, startRange: [0.62, 0.86] },
    inner: pts,
    kind: "ellipse",
    smooth: true,
    ruler: false,
  };
};

function roundRectPts(w: number, h: number, r: number, step = 0.4): { pts: Vec[]; corners: number[] } {
  const hw = w / 2;
  const hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  const pts: Vec[] = [];
  const corners: number[] = [];
  const arc = (cx: number, cy: number, a0: number) => {
    if (r < 0.05) {
      corners.push(pts.length);
      pts.push({ x: cx + Math.cos(a0 + Math.PI / 4) * Math.SQRT2 * 0, y: cy });
      return;
    }
    const k = Math.max(4, Math.ceil((r * Math.PI) / 2 / step));
    for (let i = 0; i <= k; i++) {
      const a = a0 + (Math.PI / 2) * (i / k);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  };
  if (r < 0.05) {
    pts.push({ x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }, { x: -hw, y: -hh });
    return { pts, corners: [0, 1, 2, 3] };
  }
  arc(hw - r, -hh + r, -Math.PI / 2);
  arc(hw - r, hh - r, 0);
  arc(-hw + r, hh - r, Math.PI / 2);
  arc(-hw + r, -hh + r, Math.PI);
  return { pts, corners };
}

const roundRect: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const r = p.radius ?? Math.min(w, h) * 0.25;
  const { pts } = roundRectPts(w, h, r);
  const hm = harmonics(rng, p.irregularity * 0.5);
  const out = pts.map((q) => {
    const th = Math.atan2(q.y, q.x);
    const f = harmonic(hm, th);
    return rot({ x: q.x * f, y: q.y * f }, p.tilt * 0.5);
  });
  return { contour: { pts: out, closed: true, smooth: true, startRange: [0.55, 0.95] }, inner: out, kind: "round-rect", smooth: true, ruler: p.ruler ?? false };
};

const rect: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const r = p.radius ?? 0;
  const { pts, corners } = roundRectPts(w, h, r);
  const j = 0.12 * p.irregularity;
  const out = r < 0.05 ? pts.map((q) => ({ x: q.x + rng.range(-j, j), y: q.y + rng.range(-j, j) })) : pts;
  const cs: Corner[] = r < 0.05 ? corners.map((i) => ({ index: i, kind: "convex" as const })) : [];
  return { contour: { pts: out, closed: true, corners: r < 0.05 ? cs : undefined, smooth: r >= 0.05 }, inner: out, kind: "rect", smooth: false, ruler: p.ruler ?? true };
};

const cloud: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const a = w / 2;
  const b = h / 2;
  const base = organicEllipse(a, b, { ...p, squareness: 0, egg: p.egg ?? 0.04 }, rng);
  const per = ellipsePerimeter(a, b);
  const nl = p.lobes === undefined || p.lobes === "auto" ? Math.max(7, Math.round(per / 7)) : Math.max(5, Math.round(p.lobes));
  const ls = p.lobeSize ?? [0.55, 1.5];
  const sizes: number[] = [];
  for (let i = 0; i < nl; i++) {
    const neighbours = i === nl - 1 ? [sizes[i - 1], sizes[0]] : sizes.slice(-1);
    const difference = (v: number) => Math.min(...neighbours.map(n => Math.abs(v - n) / Math.max(v, n)));
    let size = rng.range(ls[0], ls[1]);
    for (let attempt = 0; attempt < 100 && difference(size) < 0.2; attempt++) size = rng.range(ls[0], ls[1]);
    if (difference(size) < 0.2) size = difference(ls[0]) > difference(ls[1]) ? ls[0] : ls[1];
    sizes.push(size);
  }
  const total = sizes.reduce((x, y) => x + y, 0);
  // valley angles by arc-length fraction around the base (approx via angle fraction)
  const dense = sampleRadial(base, 720, 0);
  const cum: number[] = [0];
  for (let i = 1; i <= dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i % dense.length].x - dense[i - 1].x, dense[i % dense.length].y - dense[i - 1].y));
  const P = cum[cum.length - 1];
  const at = (s: number): Vec => {
    s = ((s % P) + P) % P;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
    const A = dense[lo % dense.length];
    const B = dense[hi % dense.length];
    return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
  };
  const offset = rng.range(0, P);
  const depth = typeof p.depth === "number" ? p.depth : 0.16;
  const Rm = (a + b) / 2;
  const pts: Vec[] = [];
  const corners: Corner[] = [];
  let s = offset;
  const meanLen = P / nl;
  for (let i = 0; i < nl; i++) {
    const len = (sizes[i] / total) * P;
    const V0 = at(s);
    const V1 = at(s + len);
    const mid = at(s + len / 2);
    const chord = Math.hypot(V1.x - V0.x, V1.y - V0.y);
    let sag = depth * Rm * (len / meanLen) * 1.6;
    sag = Math.min(sag, chord * 0.62);
    // outward direction: from center through mid (approx normal)
    const ml = Math.hypot(mid.x, mid.y) || 1;
    const out = { x: mid.x / ml, y: mid.y / ml };
    // bulge apex
    const peak = rng.range(0.35, 0.65);
    const fullness = rng.range(0.65, 0.95);
    corners.push({ index: pts.length, kind: "concave" });
    const k = Math.max(8, Math.ceil((chord + sag) / 0.35));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const bx = V0.x + (V1.x - V0.x) * t;
      const by = V0.y + (V1.y - V0.y) * t;
      const phase = t < peak ? t / peak / 2 : 0.5 + (t - peak) / (1 - peak) / 2;
      const bulge = Math.pow(Math.sin(Math.PI * phase), fullness) * sag;
      pts.push({ x: bx + out.x * bulge, y: by + out.y * bulge });
    }
    s += len;
  }
  const tilted = pts.map((q) => rot(q, p.tilt));
  const inner = sampleRadial(base, 180, p.tilt);
  return { contour: { pts: tilted, closed: true, corners, segmentProfile: t => 0.6 + 0.8 * Math.sin(Math.PI * t), seamJitter: 0.15 }, inner, kind: "cloud", smooth: false, ruler: false };
};

function spiky(w: number, h: number, p: ShapeParams, seed: number, burst: boolean): BodyGeom {
  const rng = new RngCls(seed);
  const a = w / 2;
  const b = h / 2;
  const base = organicEllipse(a, b, { ...p, squareness: p.compactCore ? 0.6 : 0.05, egg: p.egg ?? 0.03 }, rng);
  const scale = p.unitScale ?? 1;
  const guide = sampleRadial(base, 256, 0);
  const lengths = [0];
  for (let i = 0; i < guide.length; i++) lengths.push(lengths[i] + dist(guide[i], guide[(i + 1) % guide.length]));
  const per = lengths[lengths.length - 1];
  const pitch = (burst ? 6.5 : 5) * scale;
  const n = p.count === undefined || p.count === "auto" ? Math.max(burst ? 8 : 10, Math.round(per / pitch)) : Math.max(5, Math.round(p.count));
  const dep: [number, number] = Array.isArray(p.depth) ? p.depth : typeof p.depth === "number" ? [p.depth * 0.8, p.depth * 1.2] : [0.9, 1.1];
  const depthMm = p.depth === undefined ? (burst ? 5 : 3) * scale * (p.spikeScale ?? 1) : (a + b) / 2;
  const jit = p.angleJitter ?? (burst ? 0.2 : 0.15);
  const curve = p.curve ?? (burst ? 0.05 : 0.1);
  const step = per / n;
  const phase = rng.range(0, step);
  const tipArc: number[] = [];
  for (let i = 0; i < n; i++) tipArc.push(phase + i * step + rng.range(-jit / 2, jit / 2) * step);
  const angleAt = (s: number) => {
    s = ((s % per) + per) % per;
    let lo = 0;
    let hi = guide.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= s) lo = mid;
      else hi = mid;
    }
    return (lo + (s - lengths[lo]) / (lengths[lo + 1] - lengths[lo])) / guide.length * TAU;
  };
  const coreAt = (t: number) => ({ x: Math.cos(t) * base(t), y: Math.sin(t) * base(t) });
  const pointAt = (s: number) => coreAt(angleAt(s));
  const pts: Vec[] = [];
  const corners: Corner[] = [];
  const valleys: Vec[] = [];
  const quad = (A: Vec, C: Vec, B: Vec, k: number) => {
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      const u = 1 - t;
      pts.push({ x: u * u * A.x + 2 * u * t * C.x + t * t * B.x, y: u * u * A.y + 2 * u * t * C.y + t * t * B.y });
    }
  };
  let prevValley = pointAt((tipArc[n - 1] - per + tipArc[0]) / 2);
  const firstValley = prevValley;
  let totalDepth = 0;
  for (let i = 0; i < n; i++) {
    const ta = angleAt(tipArc[i]);
    const nextA = i + 1 < n ? tipArc[i + 1] : tipArc[0] + per;
    const nextValley = i + 1 < n ? pointAt((tipArc[i] + nextA) / 2 + rng.range(-0.03, 0.03) * step) : firstValley;
    let d = rng.sample(dep[0], dep[1], "uniform") * depthMm;
    if (burst && p.secondary === true && rng.chance(0.3)) d = rng.range(0.07, 0.14) * (p.depth === undefined ? depthMm / 0.4 : depthMm);
    totalDepth += d;
    const root = coreAt(ta);
    const prev = coreAt(ta - 0.0001);
    const next = coreAt(ta + 0.0001);
    const normal = { x: next.y - prev.y, y: prev.x - next.x };
    const nl = Math.hypot(normal.x, normal.y) || 1;
    const tip = { x: root.x + normal.x / nl * d, y: root.y + normal.y / nl * d };
    // edge valley->tip
    corners.push({ index: pts.length, kind: "valley" });
    pts.push(prevValley);
    valleys.push(prevValley);
    const e1 = edgeCtrl(prevValley, tip, curve);
    quad(prevValley, e1, tip, 10);
    corners.push({ index: pts.length - 1, kind: "tip" });
    const e2 = edgeCtrl(tip, nextValley, curve);
    quad(tip, e2, nextValley, 10);
    pts.pop(); // next valley pushed in next iteration
    prevValley = nextValley;
  }
  const tilted = pts.map((q) => rot(q, p.tilt));
  const inner = shrinkTo(valleys, 0.98).map((q) => rot(q, p.tilt));
  return { contour: { pts: tilted, closed: true, corners }, inner, kind: burst ? "burst" : "spike", smooth: false, ruler: false, spikeLength: totalDepth / n, spikeCore: guide.map(q => rot(q, p.tilt)) };
}

function edgeCtrl(A: Vec, B: Vec, curve: number): Vec {
  // pull midpoint toward center (origin) for inward-bowed (concave) spike edges
  const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const ml = Math.hypot(m.x, m.y) || 1;
  return { x: m.x - (m.x / ml) * curve * L * 0.25, y: m.y - (m.y / ml) * curve * L * 0.25 };
}

const WAVE_VARIATION = 0.3;

function irregularWavePoints(base: (th: number) => number, waves: number, amp: number, tilt: number, rng: Rng): Vec[] {
  const n = Math.max(240, waves * 16);
  const guide = sampleRadial(base, n, 0);
  const lengths = [0];
  for (let i = 0; i < n; i++) lengths.push(lengths[i] + dist(guide[i], guide[(i + 1) % n]));

  const widths: number[] = [];
  for (let i = 0; i < waves; i++) {
    const pitch = rng.range(1 - WAVE_VARIATION, 1 + WAVE_VARIATION);
    const split = rng.range(0.44, 0.56);
    widths.push(pitch * split, pitch * (1 - split));
  }
  const heights = widths.map((_, i) => (i % 2 === 0 ? 1 : -1) * amp * rng.range(1 - WAVE_VARIATION, 1 + WAVE_VARIATION));
  const scale = lengths[n] / widths.reduce((sum, width) => sum + width, 0);
  const samples = Math.ceil(n / widths.length);
  const pts: Vec[] = [];
  let start = 0;
  let edge = 0;
  for (let i = 0; i < widths.length; i++) {
    const width = widths[i] * scale;
    const from = heights[i];
    const to = heights[(i + 1) % heights.length];
    for (let j = 0; j < samples; j++) {
      const t = j / samples;
      const s = start + width * t;
      while (edge < n - 1 && lengths[edge + 1] < s) edge++;
      const fraction = (s - lengths[edge]) / (lengths[edge + 1] - lengths[edge]);
      const th = ((edge + fraction) / n) * TAU;
      // Zero slope at each crest and trough keeps the varying half-waves smooth, including the seam.
      const r = base(th) + from + (to - from) * ((1 - Math.cos(Math.PI * t)) / 2);
      pts.push(rot({ x: Math.cos(th) * r, y: Math.sin(th) * r }, tilt));
    }
    start += width;
  }
  return pts;
}

const wavy: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const a = w / 2;
  const b = h / 2;
  const base = organicEllipse(a, b, p, rng);
  const per = ellipsePerimeter(a, b);
  const waves = p.waves === undefined || p.waves === "auto" ? Math.max(12, Math.round(per / 3.5)) : Math.max(4, Math.round(p.waves));
  const amp = p.amplitude ?? 0.5;
  const form = p.waveform ?? "sine";
  if (form === "irregular") {
    const peakScale = 1 + WAVE_VARIATION;
    const limitedAmp = Math.min(Math.max(0, amp), Math.min(a, b) / (2 * peakScale));
    const pts = irregularWavePoints(base, waves, limitedAmp, p.tilt, rng);
    const inner = sampleRadial((t) => base(t) - limitedAmp * peakScale, 180, p.tilt);
    return { contour: { pts, closed: true, smooth: true, startRange: [0.62, 0.86] }, inner, kind: "wavy", smooth: true, ruler: false };
  }
  const amps = Array.from({ length: waves }, () => amp * rng.range(0.75, 1.25));
  const phSeed = rng.range(0, 100);
  const n = Math.max(240, waves * 16);
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU;
    const x = (i / n) * waves;
    const wi = Math.floor(x) % waves;
    const f = x - Math.floor(x);
    const wv = form === "zigzag" ? (f < 0.5 ? f * 4 - 1 : 3 - f * 4) : Math.sin(f * TAU + 0.3 * Math.sin(phSeed + x));
    const r = base(th) + amps[wi] * wv;
    pts.push(rot({ x: Math.cos(th) * r, y: Math.sin(th) * r }, p.tilt));
  }
  const inner = sampleRadial((t) => base(t) - amp, 180, p.tilt);
  return { contour: { pts, closed: true, smooth: form !== "zigzag", startRange: [0.62, 0.86] }, inner, kind: "wavy", smooth: true, ruler: false };
};

const electronic: BodyGenerator = (w, h, p) => {
  const a = w / 2;
  const b = h / 2;
  const exponent = 3.2;
  const base = sampleRadial((t) => seRadius(a, b, exponent, t), 256, 0);
  const perimeter = polylineLength(base, true);
  const n = Math.max(5, Math.round(p.corners ?? (p.toothPitch ? perimeter / p.toothPitch : 8)));
  const pitch = perimeter / n;
  const depth = Math.min(pitch, Math.min(w, h) * 0.5) * Math.max(0, Math.min(p.jag ?? 0.25, 1));
  // Equal arc-length steps keep teeth the same width on long and short sides.
  const pts = resample(base, pitch / 2, true).map((q, i) => {
    if (i % 2 === 0 || depth === 0) return rot(q, p.tilt);
    const nx = Math.sign(q.x) * Math.pow(Math.abs(q.x / a), exponent - 1) / a;
    const ny = Math.sign(q.y) * Math.pow(Math.abs(q.y / b), exponent - 1) / b;
    const l = Math.hypot(nx, ny);
    return rot({ x: q.x + depth * nx / l, y: q.y + depth * ny / l }, p.tilt);
  });
  const corners: Corner[] = depth > 0 ? pts.map((_, i) => ({ index: i, kind: i % 2 ? "convex" : "concave" })) : [];
  const inner = sampleRadial((t) => seRadius(a, b, 2, t) * 0.92, 120, p.tilt);
  return { contour: { pts, closed: true, corners }, inner, kind: "electronic", smooth: false, ruler: false };
};

/** a squared-off balloon (flat, blunt voices): straight sides, softly rounded corners */
const hexagon: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const n = Math.max(5, Math.round(p.corners ?? 6));
  const a = w / 2;
  const b = h / 2;
  // vertices on a superellipse; with 6 sides the flats run up the left and right
  const ph = Math.PI / 2;
  const V: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const th = ph + (i / n) * TAU + rng.range(-0.04, 0.04) * p.irregularity * 4;
    const r = seRadius(a, b, 2.4, th) * (1.06 + rng.range(-0.02, 0.02) * p.irregularity * 4);
    V.push({ x: Math.cos(th) * r, y: Math.sin(th) * r });
  }
  const rad = Math.min(a, b) * 0.22;
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const P0 = V[(i + n - 1) % n];
    const P1 = V[i];
    const P2 = V[(i + 1) % n];
    const l0 = Math.hypot(P1.x - P0.x, P1.y - P0.y);
    const l2 = Math.hypot(P2.x - P1.x, P2.y - P1.y);
    const r0 = Math.min(rad, l0 * 0.35);
    const r2 = Math.min(rad, l2 * 0.35);
    const A = { x: P1.x + ((P0.x - P1.x) / l0) * r0, y: P1.y + ((P0.y - P1.y) / l0) * r0 };
    const B = { x: P1.x + ((P2.x - P1.x) / l2) * r2, y: P1.y + ((P2.y - P1.y) / l2) * r2 };
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      pts.push({ x: (1 - t) * (1 - t) * A.x + 2 * t * (1 - t) * P1.x + t * t * B.x, y: (1 - t) * (1 - t) * A.y + 2 * t * (1 - t) * P1.y + t * t * B.y });
    }
    // the straight side to the next corner
    const nl = Math.hypot(V[(i + 2) % n].x - P2.x, V[(i + 2) % n].y - P2.y);
    const C = { x: P2.x + ((P1.x - P2.x) / l2) * Math.min(rad, l2 * 0.35), y: P2.y + ((P1.y - P2.y) / l2) * Math.min(rad, l2 * 0.35) };
    const steps = Math.max(2, Math.ceil(Math.hypot(C.x - B.x, C.y - B.y) / 0.8));
    for (let k = 1; k < steps; k++) pts.push({ x: B.x + ((C.x - B.x) * k) / steps, y: B.y + ((C.y - B.y) * k) / steps });
    void nl;
  }
  const out = pts.map((q) => rot(q, p.tilt));
  return { contour: { pts: out, closed: true, smooth: true }, inner: shrinkTo(out, 0.97), kind: "hexagon", smooth: true, ruler: false };
};

/** the outline shrunk toward its centroid: a text area that follows the shape */
function shrinkTo(pts: Vec[], f: number): Vec[] {
  const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
  const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
  return pts.map((q) => ({ x: cx + (q.x - cx) * f, y: cy + (q.y - cy) * f }));
}

function textAreaRect(p: ShapeParams, w: number, h: number): Vec[] | null {
  const ta = (p.raw?.textArea as number[] | undefined) ?? undefined;
  if (!Array.isArray(ta) || ta.length !== 4) return null;
  const [x, y, tw, th] = ta.map(Number);
  return [{ x: (x - 0.5) * w, y: (y - 0.5) * h }, { x: (x + tw - 0.5) * w, y: (y - 0.5) * h }, { x: (x + tw - 0.5) * w, y: (y + th - 0.5) * h }, { x: (x - 0.5) * w, y: (y + th - 0.5) * h }];
}

const polygon: BodyGenerator = (w, h, p) => {
  const ptsIn = p.points ?? [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  const pts = ptsIn.map(([u, v]) => rot({ x: (u - 0.5) * w, y: (v - 0.5) * h }, p.tilt));
  const inner = textAreaRect(p, w, h) ?? shrinkTo(pts, 0.72);
  return { contour: { pts, closed: true }, inner, kind: "polygon", smooth: false, ruler: false };
};

/** any outline as SVG path data in a unit box (0..1) */
const pathShape: BodyGenerator = (w, h, p) => {
  const d = (p.raw?.d as string | undefined) ?? "M0.5 0 L1 0.5 L0.5 1 L0 0.5 Z";
  const contours = flattenPath(parseSvgPath(d), 0.004).filter((c) => c.pts.length > 2);
  const main = contours.sort((a, b) => Math.abs(polygonArea(b.pts)) - Math.abs(polygonArea(a.pts)))[0]?.pts ?? [];
  let pts = main.map((q) => rot({ x: (q.x - 0.5) * w, y: (q.y - 0.5) * h }, p.tilt));
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts = pts.slice(0, -1);
  if (polygonArea(pts) < 0) pts.reverse();
  const inner = textAreaRect(p, w, h) ?? shrinkTo(pts, 0.7);
  return { contour: { pts, closed: true, smooth: true }, inner, kind: "path", smooth: true, ruler: false };
};

const none: BodyGenerator = (w, h) => {
  const pts = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
  return { contour: { pts, closed: true }, inner: pts, kind: "none", smooth: false, ruler: false };
};

export const BODY_GENERATORS: Record<string, BodyGenerator> = {
  ellipse,
  "round-rect": roundRect,
  rect,
  cloud,
  spike: (w, h, p, s) => spiky(w, h, p, s, false),
  burst: (w, h, p, s) => spiky(w, h, p, s, true),
  wavy,
  flash: ellipse,
  electronic,
  hexagon,
  polygon,
  path: pathShape,
  none,
};

/** Check all points are inside polygon (with margin via scaled test). */
export function containsAll(poly: readonly Vec[], pts: readonly Vec[]): boolean {
  for (const q of pts) if (!pointInPolygon(q, poly)) return false;
  return true;
}

export function perimeterOf(pts: readonly Vec[]): number {
  return polylineLength(pts, true);
}
