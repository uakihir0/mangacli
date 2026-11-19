import { type Vec, cross, norm, sub } from "./vec.js";

/** Offset-edge intersections for a polygon frame, with independent edge widths. */
export function miterFrameEdges(poly: readonly Vec[], widths: readonly number[]): Vec[][] {
  const n = poly.length;
  if (n < 3) return [];
  const dirs = poly.map((p, i) => norm(sub(poly[(i + 1) % n], p)));
  const offset = (i: number, sign: number): Vec => ({
    x: poly[i].x - dirs[i].y * widths[i] * sign / 2,
    y: poly[i].y + dirs[i].x * widths[i] * sign / 2,
  });
  const corner = (i: number, sign: number, edge: number): Vec => {
    const j = (i + n - 1) % n;
    const p = offset(i, sign);
    const q = offset(j, sign);
    const end = {
      x: poly[i].x - dirs[edge].y * widths[edge] * sign / 2,
      y: poly[i].y + dirs[edge].x * widths[edge] * sign / 2,
    };
    const den = cross(dirs[i], dirs[j]);
    if (Math.abs(den) < 1e-9) return end;
    const t = cross(sub(q, p), dirs[j]) / den;
    const miter = { x: p.x + dirs[i].x * t, y: p.y + dirs[i].y * t };
    return Math.hypot(miter.x - poly[i].x, miter.y - poly[i].y) > 4 * Math.max(widths[i], widths[j]) ? end : miter;
  };
  return poly.map((_, i) => [corner(i, 1, i), corner((i + 1) % n, 1, i), corner((i + 1) % n, -1, i), corner(i, -1, i)]);
}
