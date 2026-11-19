import { WHITE } from "../core/color.js";
import { isLength, toMm } from "../core/units.js";
import { type PathData, polyPath } from "../geom/path.js";
import { type Rect, type Vec, add, boundsOf, dot, mul, rectInset, sub } from "../geom/vec.js";
import { resolvePoint } from "../layout/place.js";
import { isObj } from "../load/normalize.js";
import type { RElement } from "../model/resolve.js";
import { type Node, solid } from "../render/ir.js";
import { Point } from "../schema/schema.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";

const EPS = 1e-8;
const MAX_CUTS = 8;

interface Cut {
  from: Vec;
  normal: Vec;
  shift: number;
}

interface Piece {
  polygon: Vec[];
  offset: Vec;
  stationaryEdges: Cut[];
}

type Slice = (nodes: Node[]) => Node[];

function corners({ x, y, w, h }: Rect): Vec[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

const distance = (cut: Cut, p: Vec) => dot(sub(p, cut.from), cut.normal);

function split(polygon: Vec[], cut: Cut): [Vec[] | null, Vec[] | null] {
  const distances = polygon.map((p) => distance(cut, p));
  if (!distances.some((d) => d > EPS)) return [polygon, null];
  if (!distances.some((d) => d < -EPS)) return [null, polygon];
  const neg: Vec[] = [];
  const pos: Vec[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const a = polygon[i];
    const d = distances[i];
    const e = distances[j];
    if (d <= EPS) neg.push(a);
    if (d >= -EPS) pos.push(a);
    if ((d > EPS && e < -EPS) || (d < -EPS && e > EPS)) {
      const m = add(a, mul(sub(polygon[j], a), d / (d - e)));
      neg.push(m);
      pos.push(m);
    }
  }
  return [neg, pos];
}

export function planSlice(el: RElement, ctx: ElemCtx, outline: Vec[], outlinePath = polyPath(outline, true)): Slice | undefined {
  const path = el.path;
  const bad = (at: (string | number)[], message: string) => ctx.bag.error("SCHEMA_TYPE", message, { path: [...path, ...at] });
  const pc = placeCtx(ctx, el);
  const point = (v: unknown, at: (string | number)[]): Vec | null => {
    if (Point.safeParse(v).success) {
      try {
        const p = resolvePoint(v, { ...pc, path: [...path, ...at] });
        if (!p || (Number.isFinite(p.x) && Number.isFinite(p.y))) return p;
      } catch { /* report a length that cannot be used in a point */ }
    }
    bad(at, "slice endpoint must be a point or point reference");
    return null;
  };
  const length = (v: unknown): number => {
    try {
      if (isLength(v)) return toMm(v, ctx.u);
    } catch { /* report an unsupported length unit */ }
    return NaN;
  };
  const cuts = el.props.cuts;
  if (!Array.isArray(cuts) || !cuts.length || cuts.length > MAX_CUTS) {
    bad(["cuts"], `slice needs 1–${MAX_CUTS} cuts`);
    return;
  }
  const width = length(el.props.width === undefined ? "0.8bmm" : el.props.width);
  if (!Number.isFinite(width) || width <= 0) {
    bad(["width"], "slice width must be a positive length");
    return;
  }
  const lines: Cut[] = [];
  for (const [i, line] of cuts.entries()) {
    if (!isObj(line)) {
      bad(["cuts", i], "slice cut must contain from and to points");
      continue;
    }
    const from = point(line.from, ["cuts", i, "from"]);
    const to = point(line.to, ["cuts", i, "to"]);
    const shift = length(line.shift === undefined ? "2bmm" : line.shift);
    if (!Number.isFinite(shift) || shift < 0) bad(["cuts", i, "shift"], "slice shift must be a non-negative length");
    if (!from || !to) continue;
    const d = sub(to, from);
    const l = Math.hypot(d.x, d.y);
    if (!Number.isFinite(l) || l <= EPS) {
      bad(["cuts", i, "to"], "slice endpoints must be distinct");
    } else if (Number.isFinite(shift) && shift >= 0) {
      lines.push({ from, normal: { x: -d.y / l, y: d.x / l }, shift });
    }
  }
  if (lines.length !== cuts.length || !outline.length) return;
  const active = lines.filter((cut) =>
    outline.some((p) => distance(cut, p) < -EPS) && outline.some((p) => distance(cut, p) > EPS),
  );
  if (!active.length) return;

  // Partition the drawable area, not just the outline: strokes and shadows can extend outside it.
  const travel = active.reduce((total, cut) => total + cut.shift, 0);
  const area = corners(rectInset(ctx.geom.bleedBox, -travel - 1));
  if (area.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
    bad(["cuts"], "total slice shift must be finite");
    return;
  }
  let pieces: Piece[] = [{ polygon: area, offset: { x: 0, y: 0 }, stationaryEdges: [] }];
  for (const cut of active) {
    const halves = pieces.map((piece) => split(piece.polygon, cut));
    // A coincident cut has no interior left to split.
    if (!halves.some(([neg, pos]) => neg && pos)) continue;
    pieces = pieces.flatMap((piece, i) => {
      const [neg, pos] = halves[i];
      return [
        ...(neg ? [{ ...piece, polygon: neg, stationaryEdges: [...piece.stationaryEdges, cut] }] : []),
        ...(pos ? [{ ...piece, polygon: pos, offset: add(piece.offset, mul(cut.normal, cut.shift)) }] : []),
      ];
    });
  }
  if (pieces.length < 2) return;

  const box = boundsOf(outline);
  const flashes = new Map<Cut, PathData>();
  for (const cut of active) {
    const t = { x: cut.normal.y, y: -cut.normal.x };
    const projections = corners(box).map((p) => dot(sub(p, cut.from), t));
    const a = add(cut.from, mul(t, Math.min(...projections)));
    const b = add(cut.from, mul(t, Math.max(...projections)));
    const inset = mul(cut.normal, -Math.max(width, 2 * 25.4 / ctx.outputDpi));
    // Extend just past the common edge so the piece clip, not two antialiased edges, trims the flash.
    const overlap = mul(cut.normal, width);
    flashes.set(cut, polyPath([add(a, inset), add(b, inset), add(b, overlap), add(a, overlap)], true));
  }
  return (nodes) => {
    if (!nodes.length) return nodes;
    return pieces.map(({ polygon, offset, stationaryEdges }) => {
      const highlights: Node[] = stationaryEdges
        .filter((cut) => polygon.filter((p) => Math.abs(distance(cut, p)) < EPS).length >= 2)
        .map((cut) => ({ kind: "path", path: flashes.get(cut)!, paint: solid(WHITE), fillRule: "nonzero", tag: tag(el, "fill") }));
      return {
        kind: "group", transform: [1, 0, 0, 1, offset.x, offset.y], clip: polyPath(polygon, true),
        children: highlights.length ? [...nodes, { kind: "group", clip: outlinePath, children: highlights }] : nodes,
      };
    });
  };
}
