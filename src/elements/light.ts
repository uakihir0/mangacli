import polygonClipping, { type Ring } from "polygon-clipping";
import { BLACK, parseColor } from "../core/color.js";
import { isLength, parseAngle, toMm } from "../core/units.js";
import { polyPath } from "../geom/path.js";
import type { Rect, Vec } from "../geom/vec.js";
import { center, resolvePoint } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { type Node, type Paint, solid } from "../render/ir.js";
import { Angle, Point, Region } from "../schema/schema.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { type ResolvedRegion, resolveRegion } from "./region.js";

function corners({ x, y, w, h }: Rect): Vec[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function renderLight(el: RElement, ctx: ElemCtx, region: ResolvedRegion): Node[] {
  const p = el.props;
  const b = region.bbox;
  const short = Math.min(b.w, b.h);
  const bad = (key: string, message: string): [] => {
    ctx.bag.error("SCHEMA_TYPE", message, { path: [...el.path, key] });
    return [];
  };
  const length = (value: unknown, base: number) =>
    isLength(value) ? toMm(value as string | number, { ...ctx.u, base }) : NaN;
  const point = (key: string): Vec | null => {
    if (!Point.safeParse(p[key]).success) {
      bad(key, `${key} must be a point or a point reference`);
      return null;
    }
    return resolvePoint(p[key], { ...placeCtx(ctx, el), path: [...el.path, key] });
  };
  const color = typeof p.color === "string" ? parseColor(p.color) : null;
  if (!color) return bad("color", "light color must be a valid color");
  if (!(short > 0)) return [];
  const lightTag = tag(el, "fill");
  const fill = (pts: Vec[], paint: Paint): Node => ({ kind: "path", path: polyPath(pts, true), fillRule: "nonzero", paint, tag: lightTag });
  const tint = (a: number) => ({ ...color, a: color.a * a });

  switch (p.kind) {
    case "glow": {
      const blur = length(p.blur, short);
      if (!Number.isFinite(blur) || blur <= 0) return bad("blur", "glow blur must be a positive length");
      const isId = typeof p.target === "string";
      if (!isId && !Region.safeParse(p.target).success) return bad("target", "glow target must be an element ID or region");
      const target = isId ? { element: p.target, mode: "alpha" } : p.target;
      const resolved = resolveRegion(target, ctx, ctx.panel ? "panel" : "page", [...el.path, "target"]);
      if (!resolved.path.length) return [];
      const image = resolved.alphaOf ? ctx.refs.get(resolved.alphaOf)?.imageSilhouette : undefined;
      const mask: Node = image ?? { kind: "path", path: resolved.path, fillRule: resolved.fillRule, paint: solid(BLACK) };
      return [{ kind: "group", glow: { blur, color, bounds: resolved.bbox }, children: [mask], tag: lightTag }];
    }
    case "light-rays": {
      const c = p.center === undefined ? center(b) : point("center");
      if (!c) return [];
      const count = Number(p.count);
      if (typeof p.count !== "number" || !Number.isInteger(count) || count < 1 || count > 1024)
        return bad("count", "light-rays count must be an integer from 1 to 1024");
      if (typeof p.density !== "number" || !Number.isFinite(p.density) || p.density < 0)
        return bad("density", "light-rays density must be non-negative");
      const n = Math.round(count * p.density);
      if (n > 1024) return bad("density", "light-rays count × density must not exceed 1024");
      const spread = p.spread;
      if (typeof spread !== "number" || !(spread > 0 && spread <= 1))
        return bad("spread", "light-rays spread must be greater than 0 and at most 1");
      if (!Angle.safeParse(p.angle).success) return bad("angle", "light-rays angle must be a valid angle");
      const phase = parseAngle(p.angle as string | number);
      if (!Number.isFinite(phase)) return bad("angle", "light-rays angle must be finite");
      if (n === 0) return [];
      const far = Math.max(...corners(b).map((q) => Math.hypot(c.x - q.x, c.y - q.y)));
      const step = 2 * Math.PI / n;
      const path = Array.from({ length: n }, (_, i) => {
        const a = phase + i * step;
        const half = Math.min(step * spread / 2, Math.PI / 2 - 0.01);
        // The outer edge must extend past the clip even for very wide rays.
        const r = far / Math.cos(half);
        return polyPath([c, { x: c.x + Math.cos(a - half) * r, y: c.y + Math.sin(a - half) * r },
          { x: c.x + Math.cos(a + half) * r, y: c.y + Math.sin(a + half) * r }], true);
      }).flat();
      const paint: Paint = { type: "radial-gradient", cx: c.x, cy: c.y, r: far, stops: [
        { offset: 0, color: tint(1) }, { offset: 0.4, color: tint(0.86) }, { offset: 1, color: tint(0.3) },
      ] };
      return [{ kind: "path", path, fillRule: "nonzero", paint, tag: lightTag }];
    }
    case "spotlight": {
      const source = point("source");
      const target = point("target");
      if (!source || !target) return [];
      const dx = target.x - source.x, dy = target.y - source.y;
      const distance = Math.hypot(dx, dy);
      if (!(distance > 0)) return bad("target", "spotlight source and target must be distinct");
      const width = length(p.width, b.w);
      if (!Number.isFinite(width) || width <= 0) return bad("width", "spotlight width must be a positive length");
      const shade = p.shade;
      if (typeof shade !== "number" || !(shade >= 0 && shade <= 1)) return bad("shade", "spotlight shade must be between 0 and 1");
      const rx = width / 2, ry = Math.min(width * 0.15, distance * 0.5);
      const poolCircle = Array.from({ length: 64 }, (_, i) => {
        const a = 2 * Math.PI * i / 64;
        return { x: rx * Math.cos(a), y: rx * Math.sin(a) };
      });
      const pool = poolCircle.map(({ x, y }) => ({ x: target.x + x, y: target.y + y * ry / rx }));
      // In the ellipse's unit circle, the sides meet the pool at its tangent points.
      const sx = -dx / rx, sy = -dy / ry;
      const d2 = sx * sx + sy * sy;
      const tangent = (side: number): Vec => {
        const k = side * Math.sqrt(d2 - 1) / d2;
        return { x: target.x + rx * (sx / d2 - k * sy), y: target.y + ry * (sy / d2 + k * sx) };
      };
      const cone = d2 > 1 ? [source, tangent(-1), tangent(1)] : [];
      const ring = (pts: Vec[]): Ring => [...pts, pts[0]].map(({ x, y }) => [x, y]);
      const opening = cone.length ? polygonClipping.union([ring(cone)], [ring(pool)]) : [[ring(pool)]];
      const shadow = polygonClipping.difference([ring(corners(b))], opening).flatMap((poly) =>
        poly.flatMap((r) => polyPath(r.slice(0, -1).map(([x, y]) => ({ x, y })), true)));
      const shadowTag = tag(el, "tone");
      const beam: Paint = { type: "linear-gradient", x0: source.x, y0: source.y, x1: target.x, y1: target.y, stops: [
        { offset: 0, color: tint(0.74) }, { offset: 1, color: tint(0.3) },
      ] };
      const floor: Paint = { type: "radial-gradient", cx: 0, cy: 0, r: rx, stops: [
        { offset: 0, color: tint(0.98) }, { offset: 0.65, color: tint(0.9) }, { offset: 1, color: tint(0.45) },
      ] };
      return [
        ...(shade > 0 && shadow.length ? [{ kind: "group", opacity: shade, children: [
          { kind: "path", path: shadow, fillRule: "evenodd", paint: solid(BLACK), tag: shadowTag },
        ], tag: shadowTag } satisfies Node] : []),
        ...(cone.length ? [fill(cone, beam)] : []),
        { kind: "group", transform: [1, 0, 0, ry / rx, target.x, target.y], children: [fill(poolCircle, floor)] },
      ];
    }
    default:
      return [];
  }
}
