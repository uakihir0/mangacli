// Ink polygons -> display list nodes.
import type { RGBA } from "../core/color.js";
import { type PathData, polygonArea, smoothPath } from "../geom/path.js";
import type { Vec } from "../geom/vec.js";
import type { InkPoly } from "../ink/stroke.js";
import type { Node, NodeTag, Paint } from "../render/ir.js";

export function polysToPath(polys: Vec[][], smooth = true): PathData {
  const out: PathData = [];
  for (const p of polys) if (p.length >= 3) out.push(...(smooth ? smoothPath(p, true) : smoothPath(p, true)));
  return out;
}

export function inksToNodes(inks: InkPoly[], color: RGBA, tag?: NodeTag): Node[] {
  const byOp = new Map<number, Vec[][]>();
  for (const k of inks) {
    const key = Math.round(k.opacity * 1000) / 1000;
    if (!byOp.has(key)) byOp.set(key, []);
    byOp.get(key)!.push(k.pts);
  }
  const out: Node[] = [];
  for (const [op, polys] of byOp) {
    const path: Node = { kind: "path", path: polysToPath(polys), fillRule: "nonzero", paint: { type: "solid", color }, tag };
    path.inkStrokes = inks.filter((k) => Math.round(k.opacity * 1000) / 1000 === op && k.centerline).map((k) => ({
      width: k.centerline!.width,
      path: k.centerline!.points.map((p, i) => [i ? "L" : "M", p.x, p.y]),
      outline: polysToPath([polygonArea(k.pts) < 0 ? [...k.pts].reverse() : k.pts]),
    }));
    path.inkBasePath = polysToPath(inks.filter((k) => Math.round(k.opacity * 1000) / 1000 === op && !k.centerline).map((k) => polygonArea(k.pts) < 0 ? [...k.pts].reverse() : k.pts));
    if (op >= 0.999) out.push(path);
    else out.push({ kind: "group", opacity: op, children: [path], tag });
  }
  return out;
}

export function fillNode(poly: Vec[], paint: Paint | null, tag?: NodeTag): Node | null {
  if (!paint) return null;
  return { kind: "path", path: smoothPath(poly, true), fillRule: "nonzero", paint, tag };
}
