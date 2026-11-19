import { toMm } from "../core/units.js";
import type { PathData } from "../geom/path.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint } from "../model/values.js";
import type { Node } from "../render/ir.js";
import { type ElemCtx, tag } from "./context.js";

type Obj = Record<string, unknown>;

export function outlineNodes(path: PathData, outlines: unknown, ctx: ElemCtx, el: RElement, key: "outline" | "textOutline" = "outline"): Node[] {
  if (!Array.isArray(outlines) || !outlines.length || !path.length) return [];
  return (outlines as Obj[]).map((o, i) => {
    const at = [...el.path, key, i];
    const paint = parsePaint(o.color ?? "white", { u: ctx.u, box: ctx.coordsBox, seed: el.seed, bag: ctx.bag, path: [...at, "color"] });
    if (!paint) return null;
    if (paint.type !== "solid") {
      ctx.bag.error("PAINT_INVALID", "text outline color must be solid", { path: [...at, "color"] });
      return null;
    }
    const width = toMm(o.width as string, ctx.u) * 2;
    const fillHoles = o.fillHoles === undefined ? 0 : toMm(o.fillHoles as string, ctx.u);
    const miterLimit = typeof o.miterLimit === "number" ? o.miterLimit : 2;
    if (fillHoles < 0 || !Number.isFinite(miterLimit) || miterLimit < 1) {
      ctx.bag.error("SCHEMA_RANGE", "outline requires fillHoles >= 0 and miterLimit >= 1", { path: at });
      return null;
    }
    return { kind: "path" as const, path, fillRule: "nonzero" as const, paint: null, stroke: { width, paint, join: o.join === "miter" ? "miter" as const : "round" as const, miterLimit, fillHoles }, tag: tag(el, "text", key === "textOutline" ? "text" : undefined) };
  }).filter((node) => node !== null).sort((a, b) => b.stroke.width - a.stroke.width);
}
