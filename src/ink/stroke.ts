// Stroke model (spec 9.4): centerline -> variable-width filled outline.
import { fbm1, noise1, type Rng } from "../core/random.js";
import { resample } from "../geom/path.js";
import { type Vec, rot, sub } from "../geom/vec.js";
import type { HandSpec, PenSpec } from "./presets.js";

export interface StrokeOptions {
  width: number;
  pen: PenSpec;
  hand: HandSpec;
  rng: Rng;
  taperIn?: boolean;
  taperOut?: boolean;
  /** explicit taper lengths (mm) overriding pen */
  taperInLen?: number;
  taperOutLen?: number;
  ruler?: boolean;
  /** width multiplier profile hook (0..1 position) */
  profile?: (t: number) => number;
  noPull?: boolean;
  inkPool?: boolean;
  /** sampling step override (mm) for long straight strokes */
  resolution?: number;
}

export interface InkPoly {
  pts: Vec[];
  opacity: number;
}

const PULL_R = norm2(-0.45, 1);
const PULL_L = norm2(0.45, 1);

function norm2(x: number, y: number): Vec {
  const l = Math.hypot(x, y);
  return { x: x / l, y: y / l };
}

/** Build the filled outline polygon(s) for one stroke along `center`. */
export function strokeOutline(center: readonly Vec[], o: StrokeOptions): InkPoly[] {
  const res = o.resolution ?? Math.max(0.05, Math.min(o.hand.resolution, o.width * 0.6 + 0.05));
  const pts = resample(center, res, false);
  const n = pts.length;
  const w0 = o.width;
  const opacity = o.pen.opacity ?? 1;
  if (n < 2) {
    const c = pts[0] ?? center[0];
    return [{ pts: circlePoly(c, w0 / 2, 8), opacity }];
  }
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const L = s[n - 1];
  if (L < Math.max(0.15, w0 * 0.5)) {
    const c = { x: (pts[0].x + pts[n - 1].x) / 2, y: (pts[0].y + pts[n - 1].y) / 2 };
    return [{ pts: circlePoly(c, Math.max(w0 / 2, L / 2), 10), opacity }];
  }
  const win = Math.max(1, Math.round(0.8 / res));
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - win)];
    const b = pts[Math.min(n - 1, i + win)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    tx[i] = dx;
    ty[i] = dy;
  }
  // curvature (turning per mm)
  const kap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - win);
    const i1 = Math.min(n - 1, i + win);
    const c = tx[i0] * ty[i1] - ty[i0] * tx[i1];
    const d = tx[i0] * tx[i1] + ty[i0] * ty[i1];
    const ang = Math.abs(Math.atan2(c, d));
    const span = s[i1] - s[i0];
    kap[i] = span > 0 ? ang / span : 0;
  }

  const seedP = o.rng.nextU32();
  const seedT = o.rng.nextU32();
  const seedJ = o.rng.nextU32();
  const ruler = !!o.ruler;
  const pAmp = o.pen.pressure * o.hand.pressure * (ruler ? 0.3 : 1);
  const tipRatio = Math.min(1, o.pen.tipWidth / Math.max(1e-6, w0));
  const taperIn = o.taperIn !== false;
  const taperOut = o.taperOut !== false;
  const lin = taperIn ? Math.min(o.taperInLen ?? o.pen.taperIn * o.hand.taper, 0.3 * L) : 0;
  const lout = taperOut ? Math.min(o.taperOutLen ?? o.pen.taperOut * o.hand.taper, 0.45 * L) : 0;
  const pull = o.hand.handedness === "left" ? PULL_L : PULL_R;
  const tremAmp = o.hand.tremorAmp * o.pen.tremor * (ruler ? 0.5 : 1);
  const tremLen = Math.max(0.1, o.hand.tremorLen);

  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const si = s[i];
    let P = 1 + pAmp * fbm1(seedP, si / 25);
    P = Math.min(1 + pAmp, Math.max(1 - pAmp, P));
    let T = 1;
    let inTaper = false;
    if (lin > 0 && si < lin) {
      const x = si / lin;
      T *= tipRatio + (1 - tipRatio) * (1 - Math.pow(1 - x, 2.2));
      inTaper = true;
    }
    const rem = L - si;
    if (lout > 0 && rem < lout) {
      const x = rem / lout;
      T *= tipRatio + (1 - tipRatio) * Math.pow(x, 0.75);
      inTaper = true;
    }
    const C = 1 + o.pen.curvature * Math.min(1, kap[i] * 3);
    const H = o.noPull ? 1 : 1 + o.pen.pull * Math.max(0, tx[i] * pull.x + ty[i] * pull.y);
    const J = 1 + 0.03 * o.hand.pressure * noise1(seedJ, si / 0.6);
    const prof = o.profile ? o.profile(si / L) : 1;
    let wi = w0 * P * T * C * H * J * prof;
    if (!inTaper) wi = Math.max(wi, o.pen.minWidth);
    w[i] = Math.max(o.pen.tipWidth * 0.5, wi);
  }

  const left: Vec[] = [];
  const right: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const nx = -ty[i];
    const ny = tx[i];
    const e = tremAmp > 0 ? tremAmp * Math.min(1, w[i] / w0) * noise1(seedT, s[i] / tremLen) : 0;
    const cx = pts[i].x + nx * e;
    const cy = pts[i].y + ny * e;
    const hw = w[i] / 2;
    left.push({ x: cx + nx * hw, y: cy + ny * hw });
    right.push({ x: cx - nx * hw, y: cy - ny * hw });
  }
  const poly: Vec[] = [...left];
  if (o.pen.cap === "round") poly.push(...capArc(pts[n - 1], { x: tx[n - 1], y: ty[n - 1] }, w[n - 1] / 2, false));
  for (let i = n - 1; i >= 0; i--) poly.push(right[i]);
  if (o.pen.cap === "round") poly.push(...capArc(pts[0], { x: tx[0], y: ty[0] }, w[0] / 2, true));

  const out: InkPoly[] = [{ pts: poly, opacity }];
  if (o.inkPool !== false && o.pen.inkPool > 0 && taperIn && o.rng.chance(0.15 * o.pen.inkPool)) {
    const r = w0 * (0.45 + 0.2 * o.pen.inkPool);
    const c = { x: pts[0].x + tx[0] * Math.min(lin, r), y: pts[0].y + ty[0] * Math.min(lin, r) };
    out.push({ pts: blobPoly(c, r, o.rng), opacity });
  }
  return out;
}

function capArc(c: Vec, t: Vec, r: number, start: boolean): Vec[] {
  const out: Vec[] = [];
  const steps = 5;
  // end cap goes from left(+n) around the tip (+t) to right(-n); start cap from right around (-t) to left
  const nx = -t.y;
  const ny = t.x;
  for (let k = 1; k < steps; k++) {
    const a = (Math.PI * k) / steps;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    if (!start) out.push({ x: c.x + (nx * ca + t.x * sa) * r, y: c.y + (ny * ca + t.y * sa) * r });
    else out.push({ x: c.x + (-nx * ca - t.x * sa) * r, y: c.y + (-ny * ca - t.y * sa) * r });
  }
  return out;
}

export function circlePoly(c: Vec, r: number, n = 16): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

export function blobPoly(c: Vec, r: number, rng: Rng, n = 14, irr = 0.12): Vec[] {
  const ph = rng.range(0, Math.PI * 2);
  const a2 = rng.range(0, irr);
  const a3 = rng.range(0, irr * 0.6);
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + a2 * Math.cos(2 * a + ph) + a3 * Math.cos(3 * a + ph * 1.7));
    out.push({ x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr });
  }
  return out;
}

/** Rotate a polyline around its midpoint (ruler angle error). */
export function rotateAboutMid(pts: Vec[], ang: number): Vec[] {
  if (!ang || pts.length < 2) return pts;
  const m = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2 };
  return pts.map((p) => {
    const r = rot(sub(p, m), ang);
    return { x: r.x + m.x, y: r.y + m.y };
  });
}
