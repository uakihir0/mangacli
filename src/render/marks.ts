import type { Rect } from "../geom/vec.js";

/** Japanese-style double corner marks and edge-center crosses, in the caller's units. */
export function cropMarkLines(trim: Rect, bleedPx: number, L: number, line: (x0: number, y0: number, x1: number, y1: number) => void): void {
  const b = bleedPx;
  const x0 = trim.x;
  const y0 = trim.y;
  const x1 = trim.x + trim.w;
  const y1 = trim.y + trim.h;
  for (const [cx, cy, dx, dy] of [
    [x0, y0, -1, -1],
    [x1, y0, 1, -1],
    [x0, y1, -1, 1],
    [x1, y1, 1, 1],
  ] as const) {
    const ox = cx + dx * b;
    const oy = cy + dy * b;
    // horizontal: on the trim line and on the bleed line, outside the bleed
    line(ox, cy, ox + dx * L, cy);
    line(cx, oy, cx + dx * (b + L), oy);
    // vertical
    line(cx, oy, cx, oy + dy * L);
    line(ox, cy, ox, cy + dy * (b + L));
  }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const c = L * 0.5;
  // center marks
  line(mx, y0 - b, mx, y0 - b - L);
  line(mx - c, y0 - b - L * 0.5, mx + c, y0 - b - L * 0.5);
  line(mx, y1 + b, mx, y1 + b + L);
  line(mx - c, y1 + b + L * 0.5, mx + c, y1 + b + L * 0.5);
  line(x0 - b, my, x0 - b - L, my);
  line(x0 - b - L * 0.5, my - c, x0 - b - L * 0.5, my + c);
  line(x1 + b, my, x1 + b + L, my);
  line(x1 + b + L * 0.5, my - c, x1 + b + L * 0.5, my + c);
}
