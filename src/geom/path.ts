import { type Matrix, type Rect, type Vec, applyMat, dist } from "./vec.js";

export type PathCmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["Q", number, number, number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

export type PathData = PathCmd[];

export function pathBounds(pd: PathData, m?: Matrix): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of pd) {
    for (let i = 1; i + 1 < c.length; i += 2) {
      const p = { x: c[i] as number, y: c[i + 1] as number };
      const q = m ? applyMat(m, p) : p;
      if (q.x < x0) x0 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.x > x1) x1 = q.x;
      if (q.y > y1) y1 = q.y;
    }
  }
  if (!isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function polyPath(pts: readonly Vec[], closed: boolean): PathData {
  const out: PathData = [];
  if (pts.length === 0) return out;
  out.push(["M", pts[0].x, pts[0].y]);
  for (let i = 1; i < pts.length; i++) out.push(["L", pts[i].x, pts[i].y]);
  if (closed) out.push(["Z"]);
  return out;
}

/** Uniform Catmull-Rom through points converted to cubic Béziers (spec 9.4.7). */
export function smoothPath(pts: readonly Vec[], closed: boolean): PathData {
  const n = pts.length;
  if (n < 3) return polyPath(pts, closed);
  const out: PathData = [["M", pts[0].x, pts[0].y]];
  const get = (i: number): Vec => {
    if (closed) return pts[((i % n) + n) % n];
    return pts[Math.max(0, Math.min(n - 1, i))];
  };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    out.push([
      "C",
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    ]);
  }
  if (closed) out.push(["Z"]);
  return out;
}

export function transformPath(path: PathData, m: Matrix): PathData {
  return path.map((c): PathCmd => {
    switch (c[0]) {
      case "M":
      case "L": {
        const p = applyMat(m, { x: c[1], y: c[2] });
        return [c[0], p.x, p.y];
      }
      case "Q": {
        const a = applyMat(m, { x: c[1], y: c[2] });
        const b = applyMat(m, { x: c[3], y: c[4] });
        return ["Q", a.x, a.y, b.x, b.y];
      }
      case "C": {
        const a = applyMat(m, { x: c[1], y: c[2] });
        const b = applyMat(m, { x: c[3], y: c[4] });
        const d = applyMat(m, { x: c[5], y: c[6] });
        return ["C", a.x, a.y, b.x, b.y, d.x, d.y];
      }
      default:
        return c;
    }
  });
}

/** Flatten path into polylines (each subpath). */
export function flattenPath(path: PathData, tol = 0.1): { pts: Vec[]; closed: boolean }[] {
  const out: { pts: Vec[]; closed: boolean }[] = [];
  let cur: Vec[] = [];
  let last: Vec = { x: 0, y: 0 };
  let start: Vec = { x: 0, y: 0 };
  const flush = (closed: boolean) => {
    if (cur.length > 1) out.push({ pts: cur, closed });
    cur = [];
  };
  for (const c of path) {
    if (c[0] === "M") {
      flush(false);
      last = { x: c[1], y: c[2] };
      start = last;
      cur.push(last);
    } else if (c[0] === "L") {
      last = { x: c[1], y: c[2] };
      cur.push(last);
    } else if (c[0] === "Q") {
      const p1 = { x: c[1], y: c[2] };
      const p2 = { x: c[3], y: c[4] };
      const n = Math.max(2, Math.ceil((dist(last, p1) + dist(p1, p2)) / tol / 4));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        cur.push({ x: u * u * last.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * last.y + 2 * u * t * p1.y + t * t * p2.y });
      }
      last = p2;
    } else if (c[0] === "C") {
      const p1 = { x: c[1], y: c[2] };
      const p2 = { x: c[3], y: c[4] };
      const p3 = { x: c[5], y: c[6] };
      const n = Math.max(2, Math.ceil((dist(last, p1) + dist(p1, p2) + dist(p2, p3)) / tol / 4));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        cur.push({
          x: u * u * u * last.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * last.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        });
      }
      last = p3;
    } else {
      if (cur.length && dist(cur[cur.length - 1], start) < 1e-9) cur.pop();
      flush(true);
      last = start;
    }
  }
  flush(false);
  return out;
}

export function pathFromJson(cmds: { type: string; values: number[] }[], m: Matrix): PathData {
  const out: PathData = [];
  for (const c of cmds) {
    const vals = c.values;
    switch (c.type) {
      case "M":
        out.push(["M", vals[0], vals[1]]);
        break;
      case "L":
        out.push(["L", vals[0], vals[1]]);
        break;
      case "Q":
        out.push(["Q", vals[0], vals[1], vals[2], vals[3]]);
        break;
      case "C":
        out.push(["C", vals[0], vals[1], vals[2], vals[3], vals[4], vals[5]]);
        break;
      case "Z":
        out.push(["Z"]);
        break;
    }
  }
  return transformPath(out, m);
}

/** Parse a simple absolute/relative SVG path string (M L H V C Q Z, upper/lower case). */
export function parseSvgPath(d: string): PathData {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: PathData = [];
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") {
      out.push(["Z"]);
      cx = sx;
      cy = sy;
      continue;
    }
    if (C === "M" || C === "L") {
      let x = num();
      let y = num();
      if (rel) {
        x += cx;
        y += cy;
      }
      out.push([C === "M" ? "M" : "L", x, y]);
      if (C === "M") {
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L";
      }
      cx = x;
      cy = y;
    } else if (C === "H" || C === "V") {
      let val = num();
      if (C === "H") {
        if (rel) val += cx;
        cx = val;
      } else {
        if (rel) val += cy;
        cy = val;
      }
      out.push(["L", cx, cy]);
    } else if (C === "Q") {
      const a = [num(), num(), num(), num()];
      if (rel) {
        a[0] += cx;
        a[1] += cy;
        a[2] += cx;
        a[3] += cy;
      }
      out.push(["Q", a[0], a[1], a[2], a[3]]);
      cx = a[2];
      cy = a[3];
    } else if (C === "C") {
      const a = [num(), num(), num(), num(), num(), num()];
      if (rel) for (let k = 0; k < 6; k++) a[k] += k % 2 === 0 ? cx : cy;
      out.push(["C", a[0], a[1], a[2], a[3], a[4], a[5]]);
      cx = a[4];
      cy = a[5];
    } else {
      i++;
    }
  }
  return out;
}

export function pathToSvg(path: PathData, digits = 3): string {
  const f = (n: number) => +n.toFixed(digits);
  return path
    .map((c) => (c[0] === "Z" ? "Z" : c[0] + (c.slice(1) as number[]).map(f).join(" ")))
    .join("");
}

// ---- polylines ---------------------------------------------------------------

export function polylineLength(pts: readonly Vec[], closed = false): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) l += dist(pts[pts.length - 1], pts[0]);
  return l;
}

/** Resample a polyline at roughly uniform arc-length steps. */
export function resample(pts: readonly Vec[], step: number, closed = false): Vec[] {
  if (pts.length < 2) return pts.slice();
  const src = closed ? [...pts, pts[0]] : pts.slice();
  const total = polylineLength(src);
  if (total < 1e-9) return [src[0]];
  const n = Math.max(closed ? 3 : 1, Math.round(total / step));
  const ds = total / n;
  const out: Vec[] = [src[0]];
  let seg = 0;
  let segStart = 0;
  let segLen = dist(src[0], src[1]);
  for (let k = 1; k <= n; k++) {
    const target = k * ds;
    while (seg < src.length - 2 && segStart + segLen < target) {
      segStart += segLen;
      seg++;
      segLen = dist(src[seg], src[seg + 1]);
    }
    const t = segLen > 0 ? Math.min(1, (target - segStart) / segLen) : 0;
    out.push({ x: src[seg].x + (src[seg + 1].x - src[seg].x) * t, y: src[seg].y + (src[seg + 1].y - src[seg].y) * t });
  }
  if (closed) out.pop();
  return out;
}

/** Signed area (positive = clockwise in y-down coordinates). */
export function polygonArea(pts: readonly Vec[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x * pts[i].y - pts[i].x * pts[j].y);
  return a / 2;
}

export function pointInPolygon(p: Vec, pts: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** distance from point to polygon boundary */
export function distToPolyline(p: Vec, pts: readonly Vec[], closed = true): number {
  let best = Infinity;
  const n = pts.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/** intersection of ray from origin o in direction d with closed polygon; returns smallest t>0 */
export function rayPolygon(o: Vec, d: Vec, pts: readonly Vec[]): { t: number; index: number; u: number } | null {
  let best: { t: number; index: number; u: number } | null = null;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den;
    const u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den;
    if (t > 1e-9 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t, index: i, u };
  }
  return best;
}

/** Offset a polygon (simple miter-free approach via vertex normals). Positive d = outward for CW (y-down) polygons. */
export function offsetPolygon(pts: readonly Vec[], d: number): Vec[] {
  const n = pts.length;
  const sign = polygonArea(pts) > 0 ? 1 : -1;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const t1x = p1.x - p0.x;
    const t1y = p1.y - p0.y;
    const t2x = p2.x - p1.x;
    const t2y = p2.y - p1.y;
    const l1 = Math.hypot(t1x, t1y) || 1;
    const l2 = Math.hypot(t2x, t2y) || 1;
    // outward normal for clockwise(y-down positive area) polygon is (ty, -tx)
    const n1x = (t1y / l1) * sign;
    const n1y = (-t1x / l1) * sign;
    const n2x = (t2y / l2) * sign;
    const n2y = (-t2x / l2) * sign;
    let nx = n1x + n2x;
    let ny = n1y + n2y;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const cosHalf = Math.max(0.35, nx * n1x + ny * n1y);
    out.push({ x: p1.x + (nx * d) / cosHalf, y: p1.y + (ny * d) / cosHalf });
  }
  return out;
}
