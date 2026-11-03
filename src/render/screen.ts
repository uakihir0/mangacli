// Halftone screening via threshold functions (spec 8.13.2).
import { hash2 } from "../core/random.js";
import type { DotShape, ToneGradient, ToneSpec } from "./ir.js";

const T_TABLES = new Map<string, Float64Array>();

function spot(dot: DotShape, x: number, y: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  switch (dot) {
    case "square":
      return Math.max(ax, ay);
    case "line":
      return ay;
    case "cross":
      return Math.min(ax, ay);
    case "ellipse":
      return 0.6 * x * x + 1.4 * y * y;
    case "round":
    default:
      return ax + ay <= 1 ? x * x + y * y : 2 - (1 - ax) * (1 - ax) - (1 - ay) * (1 - ay);
  }
}

/** quantile table: T(d) for d in [0,1] with 1024 steps */
function table(dot: DotShape): Float64Array {
  let t = T_TABLES.get(dot);
  if (t) return t;
  const N = 256;
  const vals = new Float64Array(N * N);
  let k = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) vals[k++] = spot(dot, ((i + 0.5) / N) * 2 - 1, ((j + 0.5) / N) * 2 - 1);
  vals.sort();
  t = new Float64Array(1025);
  for (let q = 0; q <= 1024; q++) {
    const d = q / 1024;
    if (d <= 0) t[q] = -Infinity;
    else if (d >= 1) t[q] = Infinity;
    else t[q] = vals[Math.min(vals.length - 1, Math.floor(d * vals.length))];
  }
  T_TABLES.set(dot, t);
  return t;
}

function ease(e: ToneGradient["easing"], t: number): number {
  if (e === "ease-in") return t * t;
  if (e === "ease-out") return 1 - (1 - t) * (1 - t);
  if (e === "ease-in-out") return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  return t;
}

export function gradientDensity(g: ToneGradient, x: number, y: number): number {
  let t: number;
  if (g.type === "radial") {
    const c = g.center ?? g.p0;
    t = Math.hypot(x - c.x, y - c.y) / Math.max(1e-6, g.radius ?? 1);
  } else {
    const dx = g.p1.x - g.p0.x;
    const dy = g.p1.y - g.p0.y;
    const l2 = dx * dx + dy * dy || 1;
    t = ((x - g.p0.x) * dx + (y - g.p0.y) * dy) / l2;
  }
  t = Math.min(1, Math.max(0, t));
  const st = g.stops;
  if (t <= st[0][0]) return st[0][1];
  for (let i = 0; i + 1 < st.length; i++) {
    const [a, da] = st[i];
    const [b, db] = st[i + 1];
    if (t >= a && t <= b) {
      const f = b > a ? ease(g.easing, (t - a) / (b - a)) : 0;
      return da + (db - da) * f;
    }
  }
  return st[st.length - 1][1];
}

export interface ScreenTarget {
  /** device pixel -> page mm */
  toMm: (px: number, py: number) => [number, number];
  /** mm per device pixel (approx) */
  mmPerPx: number;
}

/**
 * Compute coverage (0..1) for device pixel (px,py) of a tone.
 * densityAt overrides density (e.g. from an image luminance) — evaluated per cell center when gradient.
 */
export function makeToneSampler(spec: ToneSpec, target: ScreenTarget, densityOverride?: (x: number, y: number) => number) {
  const tab = table(spec.dot);
  const c = 25.4 / Math.max(1, spec.lpi);
  const ca = Math.cos(-spec.angle);
  const sa = Math.sin(-spec.angle);
  const [ox, oy] = spec.offset;
  const grain = Math.max(spec.grain, target.mmPerPx * 1.5);
  const dotMinPx = 2;
  return (px: number, py: number): number => {
    const [x, y] = target.toMm(px, py);
    let d: number;
    const xr = (x - ox) * ca - (y - oy) * sa;
    const yr = (x - ox) * sa + (y - oy) * ca;
    if (spec.dot === "noise") {
      const gx = Math.floor(xr / grain);
      const gy = Math.floor(yr / grain);
      d = densityOverride ? densityOverride(x, y) : spec.gradient ? gradientDensity(spec.gradient, x, y) : spec.density;
      if (spec.invert) d = 1 - d;
      const r = hash2(spec.seed, gx, gy) / 4294967296;
      return r < d ? 1 : 0;
    }
    const cx = Math.floor(xr / c);
    const cy = Math.floor(yr / c);
    const u = ((xr / c - cx) * 2 - 1);
    const v = ((yr / c - cy) * 2 - 1);
    if (densityOverride) d = densityOverride(x, y);
    else if (spec.gradient) {
      // density at cell center (inverse rotate)
      const ccx = (cx + 0.5) * c;
      const ccy = (cy + 0.5) * c;
      const wx = ccx * ca + ccy * sa + ox;
      const wy = -ccx * sa + ccy * ca + oy;
      d = gradientDensity(spec.gradient, wx, wy);
    } else d = spec.density;
    if (spec.invert) d = 1 - d;
    if (d <= 0.0005) return 0;
    if (d >= 0.9995) return 1;
    // skip unprintably small dots
    const cellPx = c / target.mmPerPx;
    if (spec.dot === "round" && d < 0.5 && 2 * cellPx * Math.sqrt(d / Math.PI) < dotMinPx * 0.5) return 0;
    const T = tab[Math.min(1024, Math.max(0, Math.round(d * 1024)))];
    return spot(spec.dot, u, v) < T ? 1 : 0;
  };
}
