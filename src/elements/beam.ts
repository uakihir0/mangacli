import { z } from "zod";
import { parseColor, WHITE } from "../core/color.js";
import { noise1, Rng } from "../core/random.js";
import { isLength, parseAngle, toMm } from "../core/units.js";
import { polyPath } from "../geom/path.js";
import { add, dist, dot, lerp, mul, norm, perp, polar, rot, sub, type Vec } from "../geom/vec.js";
import { resolvePoint } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint } from "../model/values.js";
import { type Node, type Paint, solid } from "../render/ir.js";
import { Angle, Point } from "../schema/schema.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import type { ResolvedRegion } from "./region.js";

const BeamLength = z.custom<string | number>(isLength, "expected a length");
const beamProps = z.object({
  from: Point.optional(),
  to: Point.optional(),
  path: z.array(Point).min(2).max(128).optional(),
  width: z.union([BeamLength, z.tuple([BeamLength, BeamLength])]),
  coreWidth: z.number().gt(0).lt(1),
  jitter: z.number().min(0).max(1),
  edge: z.enum(["lines", "tone"]),
  color: z.string(),
  charge: z.boolean(),
  impact: z.boolean(),
  count: z.number().int().min(1).max(32),
  spread: Angle,
});

interface Station {
  point: Vec;
  normal: Vec;
  t: number;
}

function samplePath(points: Vec[]): Station[] {
  const lengths = points.slice(1).map((p, i) => dist(points[i], p));
  const total = lengths.reduce((a, b) => a + b, 0);
  const normals = points.slice(1).map((p, i) => perp(norm(sub(p, points[i]))));
  const atCorner = (i: number) => {
    if (i === 0) return normals[0];
    if (i === lengths.length) return normals[i - 1];
    const sum = add(normals[i - 1], normals[i]);
    if (Math.hypot(sum.x, sum.y) < 1e-6) return normals[i];
    const bisector = norm(sum);
    return mul(bisector, 1 / Math.max(0.67, dot(normals[i], bisector)));
  };
  const samples: Station[] = [{ point: points[0], normal: atCorner(0), t: 0 }];
  let travelled = 0;
  for (let i = 0; i < lengths.length; i++) {
    const steps = Math.max(1, Math.ceil(120 * lengths[i] / total));
    for (let j = 1; j <= steps; j++) {
      const u = j / steps;
      samples.push({
        point: lerp(points[i], points[i + 1], u),
        normal: j === steps ? atCorner(i + 1) : normals[i],
        t: (travelled + lengths[i] * u) / total,
      });
    }
    travelled += lengths[i];
  }
  return samples;
}

export function renderBeam(
  el: RElement, ctx: ElemCtx, region: ResolvedRegion,
  impact: (at: Vec, radius: number, seed: number) => Node[],
): Node[] {
  const bad = (key: string, message: string): [] => {
    ctx.bag.error("SCHEMA_TYPE", message, { path: [...el.path, key] });
    return [];
  };
  const result = beamProps.safeParse(el.props);
  if (!result.success) {
    const issue = result.error.issues[0];
    return bad(String(issue.path[0]), issue.message);
  }
  const p = result.data;
  if (p.path && (p.from !== undefined || p.to !== undefined))
    return bad("path", "beam requires either path or from and to, not both");
  if (!p.path && (p.from === undefined || p.to === undefined))
    return bad(p.from === undefined ? "from" : "to", "beam requires either path or from and to");
  const pc = placeCtx(ctx, el);
  const points: Vec[] = [];
  for (const [i, value] of (p.path ?? [p.from, p.to]).entries()) {
    const path = p.path ? [...el.path, "path", i] : [...el.path, i === 0 ? "from" : "to"];
    const pt = resolvePoint(value, { ...pc, path });
    if (!pt) return [];
    if (!points.length || dist(points[points.length - 1], pt) > 1e-6) points.push(pt);
  }
  if (points.length < 2) return bad(p.path ? "path" : "to", "beam needs at least two distinct points");
  const base = Math.min(region.bbox.w, region.bbox.h);
  if (!(base > 0)) return [];
  const [startWidth, endWidth] = (Array.isArray(p.width) ? p.width : [p.width, p.width]).map((w) => toMm(w, { ...ctx.u, base }));
  if (![startWidth, endWidth].every((w) => Number.isFinite(w) && w > 0)) return bad("width", "beam widths must be positive");
  const spread = parseAngle(p.spread);
  if (!(spread >= 0 && spread < 2 * Math.PI)) return bad("spread", "beam spread must be at least 0 and less than one turn");
  const color = parseColor(p.color);
  if (!color) return bad("color", "beam color must be a valid color");
  const tone = p.edge === "tone"
    ? parsePaint(el.props.tone, { u: ctx.u, box: region.bbox, seed: el.seed, bag: ctx.bag, path: [...el.path, "tone"] })
    : null;
  if (p.edge === "tone" && tone?.type !== "tone") return bad("tone", "beam tone must be a screentone");

  const white = solid(WHITE);
  const ink = solid(color);
  const shape = (pts: Vec[], paint: Paint, role: "fill" | "ink" | "tone" = "fill"): Node =>
    ({ kind: "path", path: polyPath(pts, true), fillRule: "nonzero", paint, tag: tag(el, role) });
  const source = points[0];
  const stations = samplePath(points);
  const rng = new Rng(el.seed);
  const nodes: Node[] = [];
  const hits: Node[] = [];
  for (let i = 0; i < p.count; i++) {
    const shot = rng.fork(`shot:${i}`);
    const theta = p.count === 1 ? 0 : spread * (i / (p.count - 1) - 0.5);
    const sides = [shot.nextU32(), shot.nextU32()];
    const axis = stations.map(({ point, normal, t }) => {
      const half = (startWidth + (endWidth - startWidth) * t) / 2;
      return {
        point: add(source, rot(sub(point, source), theta)),
        normal: rot(normal, theta),
        edges: sides.map((s) => half * (1 + p.jitter * noise1(s, t * 13))),
        t,
      };
    });
    const offset = (q: typeof axis[number], fraction: number) =>
      add(q.point, mul(q.normal, fraction * q.edges[Number(fraction > 0)]));
    const band = (a: number, b: number, paint: Paint, role?: "ink" | "tone") =>
      shape([...axis.map((q) => offset(q, a)), ...axis.map((q) => offset(q, b)).reverse()], paint, role);
    nodes.push(band(-1, 1, ink, "ink"));
    if (tone) {
      const innerEdge = Math.max(0.94, (1 + p.coreWidth) / 2);
      nodes.push(band(-innerEdge, innerEdge, white), band(-innerEdge, innerEdge, tone, "tone"));
    } else {
      for (const side of [-1, 1]) {
        for (let j = 1; j <= 3; j++) {
          const line = p.coreWidth + (1 - p.coreWidth) * j / 4;
          const start = shot.range(0, 0.22);
          const end = shot.range(0.8, 1);
          const part = axis.filter((q) => q.t >= start && q.t <= end);
          const weight = (q: typeof axis[number]) => (1 - p.coreWidth) * 0.08 * Math.sin(Math.PI * (q.t - start) / (end - start));
          nodes.push(shape([...part.map((q) => offset(q, side * (line - weight(q)))),
            ...part.map((q) => offset(q, side * (line + weight(q)))).reverse()], white));
        }
      }
    }
    nodes.push(band(-p.coreWidth, p.coreWidth, white));
    if (p.impact) hits.push(...impact(axis[axis.length - 1].point, endWidth * 0.48, shot.nextU32()));
  }
  if (p.charge) {
    const orb = (radius: number, paint: Paint) => shape(
      Array.from({ length: 48 }, (_, i) => add(source, polar(radius, i * Math.PI / 24))), paint);
    nodes.push(orb(startWidth * 0.84, white), orb(startWidth * 0.78, ink), orb(startWidth * 0.66, white));
  }
  return [...nodes, ...hits];
}
