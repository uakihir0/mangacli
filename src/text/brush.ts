import { noise2 } from "../core/random.js";
import { flattenPath, offsetPolygon, polyPath, type PathData } from "../geom/path.js";
import type { Vec } from "../geom/vec.js";

export interface BrushSpec { style?: "impact" | "speed"; taper?: number; entry?: number; wobble?: number }
export interface BrushTerminal { edge: number; width: number; direction: Vec; kind: "entry" | "exit" }
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const length = (a: Vec): number => Math.hypot(a.x, a.y);
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
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
    const alignmentA = dot(incoming, direction) / before, alignmentB = -dot(outgoing, direction) / after;
    if (alignmentA < 0.85 || alignmentB < 0.85) continue;
    const flankA = { x: a.x - incoming.x * width / (2 * before * alignmentA), y: a.y - incoming.y * width / (2 * before * alignmentA) };
    const flankB = { x: b.x + outgoing.x * width / (2 * after * alignmentB), y: b.y + outgoing.y * width / (2 * after * alignmentB) };
    const localWidth = Math.abs(cross(sub(flankB, flankA), direction));
    if (width < localWidth * 0.7 || width > localWidth * 1.3) continue;
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

function hull(points: Vec[]): Vec[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (ps: Vec[]) => {
    const out: Vec[] = [];
    for (const p of ps) {
      while (out.length > 1 && cross(sub(out.at(-1)!, out.at(-2)!), sub(p, out.at(-1)!)) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  const result = [...half(sorted), ...half([...sorted].reverse())];
  return winding(result) === winding(points) ? result : result.reverse();
}

function brushDab(pts: Vec[], em: number, taper: number): Vec[] | undefined {
  const center = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
  const offsets = pts.map(p => sub(p, center));
  const xx = offsets.reduce((s, p) => s + p.x * p.x, 0), yy = offsets.reduce((s, p) => s + p.y * p.y, 0), xy = offsets.reduce((s, p) => s + p.x * p.y, 0);
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  let axis = { x: Math.cos(angle), y: Math.sin(angle) };
  if (axis.y < -0.25 || (Math.abs(axis.y) <= 0.25 && axis.x < 0)) axis = { x: -axis.x, y: -axis.y };
  const across = { x: -axis.y, y: axis.x };
  const alongs = offsets.map(p => dot(p, axis)), widths = offsets.map(p => dot(p, across));
  const lo = Math.min(...alongs), hi = Math.max(...alongs), width = Math.max(...widths) - Math.min(...widths);
  if (width > em * 0.27 || (hi - lo >= width * 2 && hi - lo > em * 0.36) || width <= 0) return undefined;
  const sign = winding(pts);
  if (!taper || pts.some((p, i) => sign * cross(sub(p, pts[(i + pts.length - 1) % pts.length]), sub(pts[(i + 1) % pts.length], p)) < -1e-7)) return pts;
  const strength = Math.min(1, taper);
  const result = offsets.map((p, i) => {
    const t = Math.max(0, ((alongs[i] - lo) / (hi - lo) - 0.82) / 0.18);
    const w = dot(p, across) * (1 - 0.3 * strength * t * t);
    return { x: center.x + axis.x * alongs[i] + across.x * w, y: center.y + axis.y * alongs[i] + across.y * w };
  });
  result.push({ x: center.x + axis.x * (hi + width * 0.05 * strength), y: center.y + axis.y * (hi + width * 0.05 * strength) });
  return hull(result);
}

export function brushGlyph(path: PathData, em: number, seed: number, spec: BrushSpec | false = {}): PathData {
  if (spec === false || em <= 0 || !path.length) return path;
  const { style = "impact", taper = 1, entry = style === "impact" ? 1 : 0.35, wobble = style === "impact" ? 0.01 : 0.04 } = spec;
  if (!taper && !entry && !wobble) return path;
  const output: PathData = [];
  const contours = flattenPath(path, em * 0.002);
  const outer = contours.reduce((largest, c) => Math.abs(area(c.pts)) > Math.abs(largest) ? area(c.pts) : largest, 0);
  for (const contour of contours) {
    let pts = corners(contour.pts);
    if (!contour.closed || pts.length < 3) { output.push(...polyPath(contour.pts, contour.closed)); continue; }
    const hole = winding(pts) !== Math.sign(outer);
    const dab = hole ? undefined : brushDab(pts, em, taper);
    if (dab) { output.push(...polyPath(dab, true)); continue; }
    const caps = new Set((hole ? [] : detectBrushTerminals(pts, em)).map(t => t.edge));
    pts = pts.flatMap((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const steps = caps.has(i) ? 1 : Math.max(1, Math.ceil(length(sub(b, a)) / (em * 0.025)));
      return Array.from({ length: steps }, (_, k) => mix(a, b, k / steps));
    });
    const sign = winding(pts), n = pts.length;
    const terminals = hole ? [] : detectBrushTerminals(pts, em);
    const changes = pts.map(() => ({ x: 0, y: 0 }));
    const waveScale = pts.map(() => 1);
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
        const amount = Math.min(1, taper);
        for (const [k, step] of [[i, -1], [j, 1]]) {
          const lead = sideLength(pts, k, step) * (style === "impact" ? 0.18 : 0.25);
          let distance = 0;
          for (let q = 0; q < n && distance < lead; q++) {
            const index = (k + step * q + n) % n, relative = sub(pts[index], mid);
            const weight = (1 - distance / lead) ** 2 * amount;
            const transverse = { x: relative.x - d.x * dot(relative, d), y: relative.y - d.y * dot(relative, d) };
            const extension = Math.min(0.3, (style === "impact" ? 0.25 : 0.3) * taper * pressure);
            changes[index].x += (-transverse.x + d.x * w * extension) * weight;
            changes[index].y += (-transverse.y + d.y * w * extension) * weight;
            waveScale[index] *= 1 - weight;
            distance += length(sub(pts[(index + step + n) % n], pts[index]));
          }
        }
      } else if (terminal.kind === "entry" && entry) {
        const tangent = sub(b, a);
        spread(i, -1, { x: -tangent.x * 0.07 * entry + d.x * w * 0.12 * entry, y: -tangent.y * 0.07 * entry + d.y * w * 0.12 * entry }, Math.min(sideLength(pts, i, -1) * 0.18, w));
        spread(j, 1, { x: tangent.x * 0.07 * entry - d.x * w * 0.08 * entry, y: tangent.y * 0.07 * entry - d.y * w * 0.08 * entry }, Math.min(sideLength(pts, j, 1) * 0.18, w));
      }
    }
    const out: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = pts[i], b = pts[j], v = sub(b, a), len = length(v);
      const steps = Math.max(1, Math.ceil(len / (em * 0.025)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, p = mix(a, b, t);
        const wa = 1 - t, wb = t;
        const wave = noise2(seed ^ 0x739a, p.x / (em * 0.5), p.y / (em * 0.5)) * wobble * em * 0.16 * (waveScale[i] * wa + waveScale[j] * wb);
        const normal = mix(normals[i], normals[j], t);
        out.push({ x: p.x + changes[i].x * wa + changes[j].x * wb + normal.x * wave, y: p.y + changes[i].y * wa + changes[j].y * wb + normal.y * wave });
      }
    }
    output.push(...polyPath(corners(out), true));
  }
  return output;
}

export function emboldenGlyph(path: PathData, em: number, radius: number): PathData {
  if (radius <= 0 || em <= 0) return path;
  const contours = flattenPath(path, em * 0.002);
  const outer = contours.reduce((largest, c) => Math.abs(area(c.pts)) > Math.abs(largest) ? area(c.pts) : largest, 0);
  const shapes = contours.map(c => ({ ...c, pts: corners(c.pts) }));
  const nearest = (a: Vec[], b: Vec[]) => {
    let distance = Infinity, delta = { x: 0, y: 0 };
    for (const [from, to, sign] of [[a, b, 1], [b, a, -1]] as const) for (const p of from) for (let i = 0; i < to.length; i++) {
      const q = to[i], edge = sub(to[(i + 1) % to.length], q);
      const t = Math.max(0, Math.min(1, dot(sub(p, q), edge) / Math.max(1e-12, dot(edge, edge))));
      const d = sub(p, { x: q.x + edge.x * t, y: q.y + edge.y * t });
      if (length(d) < distance) { distance = length(d); delta = { x: d.x * sign, y: d.y * sign }; }
    }
    return { distance, delta };
  };
  const offsets = shapes.map(() => ({ x: 0, y: 0 }));
  const pairs: { i: number; j: number; distance: number; delta: Vec }[] = [];
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    const a = shapes[i], b = shapes[j];
    if (!a.closed || !b.closed || winding(a.pts) !== Math.sign(outer) || winding(b.pts) !== Math.sign(outer)) continue;
    const { distance, delta } = nearest(a.pts, b.pts);
    if (distance > 1e-8) pairs.push({ i, j, distance, delta });
  }
  for (let pass = 0; pass < 4; pass++) for (const { i, j, distance, delta } of pairs) {
    const a = shapes[i], b = shapes[j];
    const axis = { x: delta.x / distance, y: delta.y / distance };
    const gap = distance + dot(sub(offsets[i], offsets[j]), axis);
    const clearance = radius * 2 + em * 0.04;
    if (gap >= clearance) continue;
    const moveA = Math.abs(area(a.pts)) < Math.abs(area(b.pts));
    const target = offsets[moveA ? i : j], amount = (clearance - gap) * (moveA ? 1 : -1);
    target.x += axis.x * amount;
    target.y += axis.y * amount;
  }
  return shapes.flatMap((c, i) => {
    const pts = c.pts.map(p => ({ x: p.x + offsets[i].x, y: p.y + offsets[i].y }));
    if (!c.closed || pts.length < 3) return polyPath(pts, c.closed);
    return polyPath(offsetPolygon(pts, winding(pts) === Math.sign(outer) ? radius : -radius), true);
  });
}
