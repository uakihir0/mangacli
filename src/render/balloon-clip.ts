import polygonClipping, { type Polygon, type Ring } from "polygon-clipping";
import { type PathData, distToPolyline, flattenPath, pointInPolygon, polyPath, polylineLength } from "../geom/path.js";
import { type Rect, type Vec, boundsOf } from "../geom/vec.js";
import type { Node, PathNode } from "./ir.js";

const MIN_FRAGMENT_MM = 3;
const FLATNESS_MM = 0.025;
const EDGE_EPS = 1e-6;

function ring(pts: Vec[]): Ring {
  return [...pts, pts[0]].map(({ x, y }) => [x, y]);
}

function points(r: Ring): Vec[] {
  return r.slice(0, -1).map(([x, y]) => ({ x, y }));
}

function boxRing({ x, y, w, h }: Rect, pad: number): Ring {
  return ring([{ x: x - pad, y: y - pad }, { x: x + w + pad, y: y - pad }, { x: x + w + pad, y: y + h + pad }, { x: x - pad, y: y + h + pad }]);
}

function outline(node: Node): node is PathNode {
  return node.kind === "path" && node.tag?.elementType === "balloon" && node.tag.role === "ink" && !!node.paint && !node.stroke;
}

function canDescend(node: Node): node is Extract<Node, { kind: "group" }> {
  return node.kind === "group" && !node.transform;
}

/** Remove only isolated short pieces cut by a panel, not intentionally short, uncut ink. */
export function cleanClippedBalloonInk(clip: PathData): (nodes: Node[]) => Node[] {
  const panel = flattenPath(clip, FLATNESS_MM)[0]?.pts;
  if (!panel || panel.length < 3) return (nodes) => nodes;
  const panelBounds = boundsOf(panel);
  const panelPoly = [ring(panel)];
  return (nodes) => {
    const ink: Polygon[] = [];
    const collect = (node: Node) => {
      if (canDescend(node)) node.children.forEach(collect);
      if (outline(node)) {
        for (const { pts } of flattenPath(node.path, FLATNESS_MM)) if (pts.length >= 3) ink.push([ring(pts)]);
      }
    };
    nodes.forEach(collect);
    if (!ink.length) return nodes;

    // Measure connected visible ink across pen strokes and opacity passes. For a
    // thin strip, half its perimeter approximates its length (including the caps).
    let keep: PathData;
    try {
      const original = polygonClipping.union(ink);
      const visible = polygonClipping.intersection(original, panelPoly);
      const originalRings = original.map((poly) => poly.map(points));
      const holes: Polygon[] = [];
      for (const [i, component] of visible.entries()) {
        const edge = points(component[0]);
        if (polylineLength(edge, true) >= MIN_FRAGMENT_MM * 2) continue;
        const wasCut = edge.some((a, j) => {
          const b = edge[(j + 1) % edge.length];
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return [a, b, mid].every((p) => distToPolyline(p, panel) < EDGE_EPS)
            && originalRings.some(([outer, ...holes]) => pointInPolygon(mid, outer) && distToPolyline(mid, outer) > EDGE_EPS
              && holes.every((hole) => !pointInPolygon(mid, hole) && distToPolyline(mid, hole) > EDGE_EPS));
        });
        if (!wasCut) continue;
        const bounds = boundsOf(edge);
        const nearby = visible.filter((_, j) => i !== j);
        // Erase using a padded clip hole rather than redrawing the remaining curves.
        // If a fragment is too close to other ink, leave it alone.
        if (nearby.length && polygonClipping.intersection(nearby, [boxRing(bounds, 0.1)]).length) continue;
        holes.push([boxRing(bounds, 0.05)]);
      }
      if (!holes.length) return nodes;
      keep = polygonClipping.difference([boxRing(panelBounds, 1)], holes).flatMap((poly) => poly.flatMap((r) => polyPath(points(r), true)));
    } catch {
      // Leave the renderer's ordinary panel clip in place for degenerate geometry.
      return nodes;
    }
    const mask = (node: Node): Node => {
      if (canDescend(node)) return { ...node, children: node.children.map(mask) };
      return outline(node) ? { kind: "group", clip: keep, children: [node] } : node;
    };
    return nodes.map(mask);
  };
}
