// Glyph runs to display list nodes: inline colour and bold markup (spec 7.7).
import { BLACK, parseColor } from "../core/color.js";
import type { PathData } from "../geom/path.js";
import type { Matrix } from "../geom/vec.js";
import type { RElement } from "../model/resolve.js";
import type { NodeTag, Paint, PathNode } from "../render/ir.js";
import type { GlyphOut } from "../text/layout.js";

export interface GlyphRun {
  el: RElement;
  glyphs: GlyphOut[];
  transform: Matrix;
}

/** one node per (colour, bold) run; `<b>` without a bold font face is emboldened with a stroke */
export function glyphNodes(glyphs: GlyphOut[], xform: (p: PathData) => PathData, base: Paint, fontSize: number, t: NodeTag): PathNode[] {
  const runs = new Map<string, { color?: string; bold: boolean; path: PathData }>();
  for (const g of glyphs) {
    const key = `${g.color ?? ""}|${g.bold ? 1 : 0}`;
    let r = runs.get(key);
    if (!r) runs.set(key, (r = { color: g.color, bold: !!g.bold, path: [] }));
    r.path.push(...xform(g.path));
  }
  const out: PathNode[] = [];
  for (const r of runs.values()) {
    const c = r.color ? parseColor(r.color) : null;
    const paint: Paint = c ? { type: "solid", color: c } : base;
    const solid = paint.type === "solid" ? paint.color : BLACK;
    out.push({ kind: "path", path: r.path, fillRule: "nonzero", paint, ...(r.bold ? { stroke: { width: fontSize * 0.05, paint: { type: "solid" as const, color: solid }, join: "round" as const } } : {}), tag: t });
  }
  return out;
}

/** Outline layers precede every fill; faux-bold strokes grow by half their width with round joins, so their outline is round-joined too. */
export function glyphOutlineNodes(outlines: PathNode[], runs: PathNode[]): PathNode[] {
  if (!runs.some(r => r.stroke)) return outlines;
  return outlines.flatMap(outline => runs.map(run => ({
    ...outline,
    path: run.path,
    stroke: run.stroke ? { ...outline.stroke!, width: outline.stroke!.width + run.stroke.width, join: "round" as const } : outline.stroke,
  })));
}
