// Balloon body shape generators (spec 6.3, 9.3.1). All shapes centered at origin.
import type { Rng } from "../core/random.js";
import { Rng as RngCls } from "../core/random.js";
import { pointInPolygon, polylineLength } from "../geom/path.js";
import { type Vec, rot } from "../geom/vec.js";
import type { Corner, ShapeContour } from "../ink/shape.js";

export interface ShapeParams {
  kind: string;
  irregularity: number;
  tilt: number; // radians (resolved)
  squareness?: number;
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
  const egg = p.egg ?? 0.06;
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
  const ls = p.lobeSize ?? [0.75, 1.3];
  const sizes = Array.from({ length: nl }, () => rng.range(ls[0], ls[1]));
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
    const chordMid = { x: (V0.x + V1.x) / 2, y: (V0.y + V1.y) / 2 };
    const apex = { x: chordMid.x + out.x * sag, y: chordMid.y + out.y * sag };
    corners.push({ index: pts.length, kind: "concave" });
    // cubic-ish arc through V0 -> apex -> V1 using quadratic Béziers with tangent pull
    const k = Math.max(8, Math.ceil((chord + sag) / 0.35));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      // circular-ish profile: sample along chord with bulge sin(pi t)^0.8
      const bx = V0.x + (V1.x - V0.x) * t;
      const by = V0.y + (V1.y - V0.y) * t;
      const bulge = Math.pow(Math.sin(Math.PI * t), 0.75) * sag;
      pts.push({ x: bx + out.x * bulge, y: by + out.y * bulge });
    }
    void apex;
    s += len;
  }
  const tilted = pts.map((q) => rot(q, p.tilt));
  const inner = sampleRadial(base, 180, p.tilt);
  return { contour: { pts: tilted, closed: true, corners }, inner, kind: "cloud", smooth: false, ruler: false };
};

function spiky(w: number, h: number, p: ShapeParams, seed: number, burst: boolean): BodyGeom {
  const rng = new RngCls(seed);
  const a = w / 2;
  const b = h / 2;
  const base = organicEllipse(a, b, { ...p, squareness: 0.05, egg: p.egg ?? 0.03 }, rng);
  const per = ellipsePerimeter(a, b);
  const pitch = burst ? 6.5 : 6;
  const n = p.count === undefined || p.count === "auto" ? Math.max(burst ? 8 : 10, Math.round(per / pitch)) : Math.max(5, Math.round(p.count));
  const dep: [number, number] = Array.isArray(p.depth) ? p.depth : typeof p.depth === "number" ? [p.depth * 0.8, p.depth * 1.2] : burst ? [0.2, 0.6] : [0.22, 0.34];
  const jit = p.angleJitter ?? 0.3;
  const curve = p.curve ?? (burst ? 0.35 : 0.5);
  const step = TAU / n;
  const phase = rng.range(0, step);
  const tipAng: number[] = [];
  for (let i = 0; i < n; i++) tipAng.push(phase + i * step + rng.range(-jit / 2, jit / 2) * step);
  const Rm = (a + b) / 2;
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
  const valleyAt = (ang: number) => {
    const r = base(ang) * (1 + rng.range(-0.03, 0.03));
    return { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
  };
  let prevValley = valleyAt((tipAng[n - 1] - TAU + tipAng[0]) / 2);
  const firstValley = prevValley;
  for (let i = 0; i < n; i++) {
    const ta = tipAng[i];
    const nextA = i + 1 < n ? tipAng[i + 1] : tipAng[0] + TAU;
    const nextValley = i + 1 < n ? valleyAt((ta + nextA) / 2) : firstValley;
    let d = rng.sample(dep[0], dep[1], "uniform");
    if (burst && p.secondary !== false && rng.chance(0.3)) d = rng.range(0.07, 0.14);
    else if (burst && rng.chance(0.25)) d *= 1.3;
    const rb = base(ta);
    const tip = { x: Math.cos(ta) * (rb + Rm * d), y: Math.sin(ta) * (rb + Rm * d) };
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
  const inner = valleys.map((q) => rot(q, p.tilt));
  return { contour: { pts: tilted, closed: true, corners }, inner, kind: burst ? "burst" : "spike", smooth: false, ruler: false };
}

function edgeCtrl(A: Vec, B: Vec, curve: number): Vec {
  // pull midpoint toward center (origin) for inward-bowed (concave) spike edges
  const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const ml = Math.hypot(m.x, m.y) || 1;
  return { x: m.x - (m.x / ml) * curve * L * 0.25, y: m.y - (m.y / ml) * curve * L * 0.25 };
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
  const amps = Array.from({ length: waves }, () => amp * rng.range(0.75, 1.25));
  const phSeed = rng.range(0, 100);
  const n = Math.max(240, waves * 16);
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU;
    const x = (i / n) * waves;
    const wi = Math.floor(x) % waves;
    const f = x - Math.floor(x);
    let wv: number;
    if (form === "zigzag") wv = f < 0.5 ? f * 4 - 1 : 3 - f * 4;
    else wv = Math.sin(f * TAU + 0.3 * Math.sin(phSeed + x));
    if (form === "irregular") wv *= rng.range(0.6, 1.3);
    const r = base(th) + amps[wi] * wv;
    pts.push(rot({ x: Math.cos(th) * r, y: Math.sin(th) * r }, p.tilt));
  }
  const inner = sampleRadial((t) => base(t) - amp, 180, p.tilt);
  return { contour: { pts, closed: true, smooth: form !== "zigzag", startRange: [0.62, 0.86] }, inner, kind: "wavy", smooth: true, ruler: false };
};

const electronic: BodyGenerator = (w, h, p, seed) => {
  const rng = new RngCls(seed);
  const n = Math.max(5, p.corners ?? 8);
  const jag = p.jag ?? 0.25;
  const a = w / 2;
  const b = h / 2;
  const pts: Vec[] = [];
  const ph = rng.range(0, TAU / n);
  for (let i = 0; i < n; i++) {
    const th = ph + (i / n) * TAU + rng.range(-jag, jag) * (TAU / n) * 0.4;
    const r = seRadius(a * 1.08, b * 1.08, 3.2, th) * (1 + rng.range(-jag, jag) * 0.12);
    pts.push(rot({ x: Math.cos(th) * r, y: Math.sin(th) * r }, p.tilt));
  }
  const inner = sampleRadial((t) => seRadius(a, b, 2, t) * 0.92, 120, p.tilt);
  return { contour: { pts, closed: true, corners: pts.map((_, i) => ({ index: i, kind: "convex" as const })) }, inner, kind: "electronic", smooth: false, ruler: false };
};

const polygon: BodyGenerator = (w, h, p) => {
  const ptsIn = p.points ?? [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  const pts = ptsIn.map(([u, v]) => rot({ x: (u - 0.5) * w, y: (v - 0.5) * h }, p.tilt));
  const inner = [
    { x: -w * 0.35, y: -h * 0.35 }, { x: w * 0.35, y: -h * 0.35 }, { x: w * 0.35, y: h * 0.35 }, { x: -w * 0.35, y: h * 0.35 },
  ];
  return { contour: { pts, closed: true }, inner, kind: "polygon", smooth: false, ruler: false };
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
  polygon,
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
