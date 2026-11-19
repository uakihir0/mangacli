import polygonClipping, { type Polygon, type Ring } from "polygon-clipping";
import { type PathData, distToPolyline, flattenPath, pointInPolygon, polygonArea, polyPath, polylineLength } from "../geom/path.js";
import { type Rect, type Vec, boundsOf } from "../geom/vec.js";
import type { Node, PathNode } from "./ir.js";

const MIN_FRAGMENT_MM = 3;
const FLATNESS_MM = 0.025;
const EDGE_EPS = 1e-6;
const MASK_PAD = 0.05;

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

function extendCornerFill(node: Node, panel: Vec[], panelPoly: Polygon, boxes: Rect[]): Node {
  if (node.kind !== "path" || node.tag?.elementType !== "balloon" || node.tag.role !== "fill"
    || node.paint?.type !== "solid" || node.paint.color.a !== 1 || node.stroke || node.fillRule !== "nonzero") return node;
  const paths = flattenPath(node.path, FLATNESS_MM);
  if (paths.length !== 1 || !paths[0].closed || paths[0].pts.length < 3) return node;
  const pts = paths[0].pts;
  const unfilled = polygonClipping.difference(panelPoly, [ring(pts)]);
  const patches: PathData = [];
  for (const { x, y, w, h } of boxes) {
    const box = boxRing({ x, y, w, h }, MASK_PAD);
    const covered = polygonClipping.intersection(unfilled, [box]);
    if (covered.length !== 1) continue;
    const pocket = unfilled.find((poly) => {
      const outer = points(poly[0]);
      return outer.every((p) => p.x >= x - EDGE_EPS && p.x <= x + w + EDGE_EPS && p.y >= y - EDGE_EPS && p.y <= y + h + EDGE_EPS)
        && outer.some((p) => distToPolyline(p, panel) < EDGE_EPS);
    });
    if (!pocket) continue;
    const patch = points(box);
    if (polygonArea(pts) < 0) patch.reverse();
    patches.push(...polyPath(patch, true));
  }
  return patches.length ? { ...node, path: [...node.path, ...patches] } : node;
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
    const boxes: Rect[] = [];
    try {
      const original = polygonClipping.union(ink);
      const visible = polygonClipping.intersection(original, panelPoly);
      const originalRings = original.map((poly) => poly.map(points));
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
        if (nearby.length && polygonClipping.intersection(nearby, [boxRing(bounds, 2 * MASK_PAD)]).length) continue;
        boxes.push(bounds);
      }
      if (!boxes.length) return nodes;
      const holes = boxes.map((bounds) => [boxRing(bounds, MASK_PAD)]);
      const keep = polygonClipping.difference([boxRing(panelBounds, 1)], holes).flatMap((poly) => poly.flatMap((r) => polyPath(points(r), true)));
      const mask = (node: Node): Node => {
        if (canDescend(node)) return { ...node, children: node.children.map(mask) };
        if (outline(node)) return { kind: "group", clip: keep, children: [node] };
        // Close a tiny, fully enclosed corner pocket where the exposed art
        // would otherwise read as another fragment of the outline.
        return extendCornerFill(node, panel, panelPoly, boxes);
      };
      return nodes.map(mask);
    } catch {
      // Leave the renderer's ordinary panel clip in place for degenerate geometry.
      return nodes;
    }
  };
}
