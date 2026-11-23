import clipper, { type Paths } from "clipper-lib";
import { flattenPath, polyPath, type PathData } from "../geom/path.js";

const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree, JS } = clipper;
const SCALE = 10_000;
const NONZERO = PolyFillType.pftNonZero;

function rings(path: PathData, tolerance: number): Paths {
  return flattenPath(path, tolerance).filter(c => c.closed && c.pts.length >= 3).map(c =>
    c.pts.map(({ x, y }) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
}

export function inkPath(rings: Paths): PathData {
  return rings.flatMap(ring => polyPath(ring.map(({ X, Y }) => ({ x: X / SCALE, y: Y / SCALE })), true));
}

export function glyphInk(path: PathData, tolerance: number): Paths {
  return Clipper.SimplifyPolygons(rings(path, tolerance), NONZERO);
}

export function unionInk(paths: Paths): Paths {
  return Clipper.SimplifyPolygons(paths, NONZERO);
}

export function offsetInk(paths: Paths, radius: number, tolerance: number, miter = false): Paths {
  if (Math.abs(radius) < 1 / SCALE) return paths;
  const offset = new ClipperOffset(2, tolerance * SCALE);
  offset.AddPaths(paths, miter ? JoinType.jtMiter : JoinType.jtRound, EndType.etClosedPolygon);
  const result: Paths = [];
  offset.Execute(result, radius * SCALE);
  return result;
}

function separateStrokes(paths: Paths): Paths[] {
  const op = new Clipper();
  const tree = new PolyTree();
  op.AddPaths(paths, PolyType.ptSubject, true);
  op.Execute(ClipType.ctUnion, tree, NONZERO, NONZERO);
  return JS.PolyTreeToExPolygons(tree).map(({ outer, holes }) => [outer, ...holes]);
}

export function weightInk(paths: Paths, radius: number, tolerance: number, compactSpan = 0): Paths {
  const count = (ink: Paths) => ink.filter(Clipper.Orientation).length;
  if (!compactSpan) {
    const expanded = offsetInk(paths, radius, tolerance);
    if (count(expanded) === count(paths)) return expanded;
  }

  const strokes = separateStrokes(paths);
  const radii = strokes.map(([outer]) => {
    if (!compactSpan) return radius;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const { X, Y } of outer) {
      left = Math.min(left, X); right = Math.max(right, X);
      top = Math.min(top, Y); bottom = Math.max(bottom, Y);
    }
    const span = Math.max(right - left, bottom - top) / SCALE;
    return radius * Math.min(1, (span / compactSpan) ** 2.4);
  });
  const rims = strokes.map((stroke, i) => offsetInk(stroke, radii[i], tolerance));
  const clearance = Math.max(tolerance * 10, compactSpan * 0.055);
  const guards = strokes.map((stroke, i) => offsetInk(stroke, radii[i] + clearance, tolerance));
  // Keep the original strokes and remove only the added weight that would bridge them.
  return strokes.flatMap((stroke, i) => {
    const rim = partitionInk(rims[i], guards.flatMap((guard, j) => j === i ? [] : guard), false);
    return separateStrokes(unionInk([...stroke, ...rim]))
      .filter(component => partitionInk(component, stroke, true).length).flat();
  });
}

export function partitionInk(ink: Paths, region: Paths, inside: boolean): Paths {
  const op = new Clipper();
  op.AddPaths(ink, PolyType.ptSubject, true);
  op.AddPaths(region, PolyType.ptClip, true);
  const result: Paths = [];
  op.Execute(inside ? ClipType.ctIntersection : ClipType.ctDifference, result, NONZERO, NONZERO);
  return result;
}
