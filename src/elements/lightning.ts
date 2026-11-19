import type { Rng } from "../core/random.js";
import type { Vec } from "../geom/vec.js";

export function lightningPoints(rng: Rng, o: Vec, angle: number, length: number, jaggedness: number): Vec[] {
  return Array.from({ length: 10 }, (_, i) => {
    const t = i / 9;
    const off = i === 0 ? 0 : rng.range(-1, 1) * length * 0.12 * jaggedness;
    return { x: o.x + Math.cos(angle) * length * t - Math.sin(angle) * off, y: o.y + Math.sin(angle) * length * t + Math.cos(angle) * off };
  });
}

export function lightningOutline(pts: Vec[], width: number): Vec[] {
  const left: Vec[] = [], right: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    const next = pts[Math.min(i + 1, pts.length - 1)], prev = pts[Math.max(0, i - 1)];
    const a = Math.atan2(next.y - prev.y, next.x - prev.x) + Math.PI / 2;
    const w = width * Math.pow(1 - i / (pts.length - 1), 0.7) / 2;
    left.push({ x: pts[i].x + Math.cos(a) * w, y: pts[i].y + Math.sin(a) * w });
    right.push({ x: pts[i].x - Math.cos(a) * w, y: pts[i].y - Math.sin(a) * w });
  }
  return [...left, ...right.reverse()];
}
