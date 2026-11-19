import { noise2 } from "../core/random.js";
import { flattenPath, polyPath, type PathData } from "../geom/path.js";
import type { Vec } from "../geom/vec.js";

export interface BrushSpec { taper?: number; entry?: number; wobble?: number }
export interface BrushTerminal { edge: number; width: number; direction: Vec; kind: "entry" | "exit" }
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const length = (a: Vec): number => Math.hypot(a.x, a.y);
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const mix = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const area = (pts: Vec[]): number => pts.reduce((s, p, i) => s + cross(p, pts[(i + 1) % pts.length]), 0);
const winding = (pts: Vec[]): number => Math.sign(area(pts)) || 1;
function sideLength(pts: Vec[], start: number, step: number): number {
  let total = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const i = (start + step * k + pts.length) % pts.length, j = (i + step + pts.length) % pts.length;
    const v = sub(pts[j], pts[i]), next = sub(pts[(j + step + pts.length) % pts.length], pts[j]);
    total += length(v);
    if (Math.abs(cross(v, next)) > length(v) * length(next) * 0.4) break;
  }
  return total;
}

export function detectBrushTerminals(pts: Vec[], em: number): BrushTerminal[] {
  const sign = winding(pts);
  const result: BrushTerminal[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i + pts.length - 1) % pts.length], a = pts[i], b = pts[(i + 1) % pts.length], next = pts[(i + 2) % pts.length];
    const v = sub(b, a), incoming = sub(a, prev), outgoing = sub(next, b);
    const width = length(v), before = length(incoming), after = length(outgoing);
    if (width < em * 0.08 || width > em * 0.25 || sideLength(pts, i, -1) < width * 1.4 || sideLength(pts, (i + 1) % pts.length, 1) < width * 1.4) continue;
    if (sign * cross(incoming, v) < before * width * 0.35 || sign * cross(v, outgoing) < width * after * 0.35) continue;
    const direction = { x: sign * v.y / width, y: -sign * v.x / width };
    const kind = direction.y > 0.25 || (Math.abs(direction.y) <= 0.25 && direction.x > 0) ? "exit" : "entry";
    result.push({ edge: i, width, direction, kind });
  }
  return result;
}

function corners(points: Vec[]): Vec[] {
  const pts = points.filter((p, i) => !i || length(sub(p, points[i - 1])) > 1e-7);
  if (pts.length > 1 && length(sub(pts[0], pts.at(-1)!)) < 1e-7) pts.pop();
  return pts.filter((p, i) => {
    const a = sub(p, pts[(i + pts.length - 1) % pts.length]), b = sub(pts[(i + 1) % pts.length], p);
    return Math.abs(cross(a, b)) > length(a) * length(b) * 1e-6 || a.x * b.x + a.y * b.y < 0;
  });
}

export function brushGlyph(path: PathData, em: number, seed: number, spec: BrushSpec | false = {}): PathData {
  if (spec === false || em <= 0 || !path.length) return path;
  const { taper = 1, entry = 1, wobble = 0.04 } = spec;
  if (!taper && !entry && !wobble) return path;
  const output: PathData = [];
  const contours = flattenPath(path, em * 0.002);
  const outer = contours.reduce((largest, c) => Math.abs(area(c.pts)) > Math.abs(largest) ? area(c.pts) : largest, 0);
  for (const contour of contours) {
    let pts = corners(contour.pts);
    if (!contour.closed || pts.length < 3) { output.push(...polyPath(contour.pts, contour.closed)); continue; }
    const hole = winding(pts) !== Math.sign(outer);
    const caps = new Set((hole ? [] : detectBrushTerminals(pts, em)).map(t => t.edge));
    pts = pts.flatMap((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const steps = caps.has(i) ? 1 : Math.max(1, Math.ceil(length(sub(b, a)) / (em * 0.025)));
      return Array.from({ length: steps }, (_, k) => mix(a, b, k / steps));
    });
    const sign = winding(pts), n = pts.length;
    const terminals = hole ? [] : detectBrushTerminals(pts, em);
    const changes = pts.map(() => ({ x: 0, y: 0 }));
    const tips = new Map<number, Vec>();
    const normals = pts.map((p, i) => {
      const a = sub(p, pts[(i + n - 1) % n]), b = sub(pts[(i + 1) % n], p);
      return { x: sign * (a.y / length(a) + b.y / length(b)) / 2, y: -sign * (a.x / length(a) + b.x / length(b)) / 2 };
    });
    const spread = (start: number, step: number, delta: Vec, lead: number) => {
      let distance = 0;
      for (let k = 0; k < n && distance < lead; k++) {
        const i = (start + step * k + n) % n;
        const weight = (1 - distance / lead) ** 2;
        changes[i].x += delta.x * weight;
        changes[i].y += delta.y * weight;
        distance += length(sub(pts[(i + step + n) % n], pts[i]));
      }
    };
    for (const terminal of terminals) {
      const i = terminal.edge, j = (i + 1) % n, a = pts[i], b = pts[j], mid = mix(a, b, 0.5);
      const w = terminal.width, d = terminal.direction;
      const pressure = 0.95 + noise2(seed, mid.x / em, mid.y / em) * 0.1;
      if (terminal.kind === "exit" && taper) {
        const amount = Math.min(1, taper * pressure);
        for (const [k, step] of [[i, -1], [j, 1]]) spread(k, step, { x: (mid.x - pts[k].x) * 0.88 * amount + d.x * w * 0.08 * amount, y: (mid.y - pts[k].y) * 0.88 * amount + d.y * w * 0.08 * amount }, Math.min(sideLength(pts, k, step) * 0.25, w * 2));
        tips.set(i, { x: mid.x + d.x * w * 0.5 * taper * pressure, y: mid.y + d.y * w * 0.5 * taper * pressure });
      } else if (terminal.kind === "entry" && entry) {
        const tangent = sub(b, a);
        spread(i, -1, { x: -tangent.x * 0.07 * entry + d.x * w * 0.12 * entry, y: -tangent.y * 0.07 * entry + d.y * w * 0.12 * entry }, Math.min(sideLength(pts, i, -1) * 0.25, w * 2));
        spread(j, 1, { x: tangent.x * 0.07 * entry - d.x * w * 0.08 * entry, y: tangent.y * 0.07 * entry - d.y * w * 0.08 * entry }, Math.min(sideLength(pts, j, 1) * 0.25, w * 2));
      }
    }
    const out: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = pts[i], b = pts[j], v = sub(b, a), len = length(v);
      const steps = Math.max(1, Math.ceil(len / (em * 0.025)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, p = mix(a, b, t);
        const wa = 1 - t, wb = t;
        const wave = noise2(seed ^ 0x739a, p.x / (em * 0.5), p.y / (em * 0.5)) * wobble * em * 0.16;
        const normal = mix(normals[i], normals[j], t);
        out.push({ x: p.x + changes[i].x * wa + changes[j].x * wb + normal.x * wave, y: p.y + changes[i].y * wa + changes[j].y * wb + normal.y * wave });
        if (tips.has(i)) { out.push(tips.get(i)!); break; }
      }
    }
    output.push(...polyPath(out, true));
  }
  return output;
}
