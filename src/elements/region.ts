// Region resolution (spec 3.4.11).
import { toMm } from "../core/units.js";
import { type PathData, parseSvgPath, polyPath, transformPath } from "../geom/path.js";
import { type Rect, type Vec, boundsOf } from "../geom/vec.js";
import { isObj } from "../load/normalize.js";
import type { ElemCtx } from "./context.js";

type Obj = Record<string, unknown>;

export interface ResolvedRegion {
  path: PathData;
  fillRule: "nonzero" | "evenodd";
  bbox: Rect;
  polys: Vec[][];
  feather: number;
  /** alpha mask from an image element */
  alphaOf?: string;
  /** convex-ish containment test */
  contains: (p: Vec) => boolean;
}

function rectP(r: Rect): Vec[] {
  return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
}

function ellipseP(cx: number, cy: number, rx: number, ry: number, n = 96): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

function inPoly(p: Vec, pts: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function resolveRegion(spec: unknown, ctx: ElemCtx, fallback: "panel" | "page", path: (string | number)[]): ResolvedRegion {
  const s = spec ?? fallback;
  const base = ctx.coordsBox;
  const u = ctx.u;
  const X = (v: unknown) => base.x + toMm(v as string, { ...u, base: base.w });
  const Y = (v: unknown) => base.y + toMm(v as string, { ...u, base: base.h });
  const W = (v: unknown) => toMm(v as string, { ...u, base: base.w });
  const H = (v: unknown) => toMm(v as string, { ...u, base: base.h });
  const mk = (polys: Vec[][], feather = 0, rule: "nonzero" | "evenodd" = "nonzero"): ResolvedRegion => {
    const all = polys.flat();
    return {
      path: polys.flatMap((p) => polyPath(p, true)),
      fillRule: rule,
      bbox: boundsOf(all),
      polys,
      feather,
      contains: (p) => {
        let c = 0;
        for (const pl of polys) if (inPoly(p, pl)) c++;
        return rule === "evenodd" ? c % 2 === 1 : c > 0;
      },
    };
  };
  const feather = isObj(s) && s.feather !== undefined ? toMm(s.feather as string, u) : 0;
  if (typeof s === "string") {
    switch (s) {
      case "panel":
        return ctx.panelPoly ? mk([ctx.panelPoly]) : mk([rectP(ctx.geom.bleedBox)]);
      case "page":
      case "bleed":
        return mk([rectP(ctx.geom.bleedBox)]);
      case "trim":
        return mk([rectP(ctx.geom.trim)]);
      case "baseFrame":
        return mk([rectP(ctx.geom.baseFrame)]);
    }
  }
  if (isObj(s)) {
    const o = s as Obj;
    if (Array.isArray(o.rect)) {
      const r = o.rect as unknown[];
      return mk([rectP({ x: X(r[0]), y: Y(r[1]), w: W(r[2]), h: H(r[3]) })], feather);
    }
    if (Array.isArray(o.ellipse)) {
      const r = o.ellipse as unknown[];
      return mk([ellipseP(X(r[0]), Y(r[1]), W(r[2]), H(r[3]))], feather);
    }
    if (Array.isArray(o.polygon)) return mk([(o.polygon as unknown[][]).map((q) => ({ x: X(q[0]), y: Y(q[1]) }))], feather);
    if (typeof o.path === "string") {
      const pd = transformPath(parseSvgPath(o.path), [1, 0, 0, 1, base.x, base.y]);
      const r = mk([rectP(base)], feather);
      return { ...r, path: pd, bbox: base };
    }
    if (isObj(o.band)) {
      const b = o.band as Obj;
      const side = b.side as string;
      const area = ctx.panel ? ctx.panel.fullBox : ctx.geom.bleedBox;
      const sz = side === "top" || side === "bottom" ? toMm(b.size as string, { ...u, base: area.h }) : toMm(b.size as string, { ...u, base: area.w });
      const r =
        side === "top" ? { x: area.x, y: area.y, w: area.w, h: sz + (base.y - area.y) } : side === "bottom" ? { x: area.x, y: area.y + area.h - sz, w: area.w, h: sz } : side === "left" ? { x: area.x, y: area.y, w: sz, h: area.h } : { x: area.x + area.w - sz, y: area.y, w: sz, h: area.h };
      return mk([rectP(r)], feather);
    }
    if (typeof o.element === "string") {
      const t = ctx.refs.target(o.element, ctx.panel?.panel.id);
      if (!t) {
        ctx.bag.error("REF_NOT_FOUND", `region element "${o.element}" not found`, { path });
        return mk([rectP(base)]);
      }
      const r = mk([t.shape ?? rectP(t.bbox)], feather);
      if (o.mode === "alpha" && t.imagePx) r.alphaOf = t.id;
      return r;
    }
    if (Array.isArray(o.union)) {
      const parts = (o.union as unknown[]).map((x, i) => resolveRegion(x, ctx, fallback, [...path, "union", i]));
      return mk(parts.flatMap((p) => p.polys), feather);
    }
    if (Array.isArray(o.subtract)) {
      const a = resolveRegion(o.subtract[0], ctx, fallback, [...path, "subtract", 0]);
      const b = resolveRegion(o.subtract[1], ctx, fallback, [...path, "subtract", 1]);
      const r = mk([...a.polys, ...b.polys], feather, "evenodd");
      r.contains = (p) => a.contains(p) && !b.contains(p);
      return r;
    }
    if (o.invert !== undefined) {
      const a = resolveRegion(o.invert, ctx, fallback, [...path, "invert"]);
      const outer = ctx.panelPoly ?? rectP(ctx.geom.bleedBox);
      const r = mk([outer, ...a.polys], feather, "evenodd");
      r.contains = (p) => inPoly(p, outer) && !a.contains(p);
      return r;
    }
  }
  ctx.bag.error("REGION_INVALID", "invalid region", { path });
  return mk([rectP(base)]);
}
