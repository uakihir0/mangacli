import clipper, { type Paths } from "clipper-lib";
import { flattenPath, polyPath, type PathData } from "../geom/path.js";

const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType } = clipper;
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

export function partitionInk(ink: Paths, region: Paths, inside: boolean): Paths {
  const op = new Clipper();
  op.AddPaths(ink, PolyType.ptSubject, true);
  op.AddPaths(region, PolyType.ptClip, true);
  const result: Paths = [];
  op.Execute(inside ? ClipType.ctIntersection : ClipType.ctDifference, result, NONZERO, NONZERO);
  return result;
}
