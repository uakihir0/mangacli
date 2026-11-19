import type { Rect } from "../geom/vec.js";

export function cropMarkLines(trim: Rect, b: number, length: number): [number, number, number, number][] {
  const lines: [number, number, number, number][] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => lines.push([x0, y0, x1, y1]);
  const x0 = trim.x, y0 = trim.y, x1 = trim.x + trim.w, y1 = trim.y + trim.h;
  for (const [cx, cy, dx, dy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]]) {
    const ox = cx + dx * b, oy = cy + dy * b;
    line(ox, cy, ox + dx * length, cy);
    line(cx, oy, cx + dx * (b + length), oy);
    line(cx, oy, cx, oy + dy * length);
    line(ox, cy, ox, cy + dy * (b + length));
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, c = length * 0.5;
  line(mx, y0 - b, mx, y0 - b - length);
  line(mx - c, y0 - b - length * 0.5, mx + c, y0 - b - length * 0.5);
  line(mx, y1 + b, mx, y1 + b + length);
  line(mx - c, y1 + b + length * 0.5, mx + c, y1 + b + length * 0.5);
  line(x0 - b, my, x0 - b - length, my);
  line(x0 - b - length * 0.5, my - c, x0 - b - length * 0.5, my + c);
  line(x1 + b, my, x1 + b + length, my);
  line(x1 + b + length * 0.5, my - c, x1 + b + length * 0.5, my + c);
  return lines;
}
