// Glyph runs to display list nodes: inline colour and bold markup (spec 7.7).
import { BLACK, parseColor } from "../core/color.js";
import type { PathData } from "../geom/path.js";
import type { Node, NodeTag, Paint } from "../render/ir.js";
import type { GlyphOut } from "../text/layout.js";

/** one node per (colour, bold) run; `<b>` without a bold font face is emboldened with a stroke */
export function glyphNodes(glyphs: GlyphOut[], xform: (p: PathData) => PathData, base: Paint, fontSize: number, t: NodeTag): Node[] {
  const runs = new Map<string, { color?: string; bold: boolean; path: PathData }>();
  for (const g of glyphs) {
    const key = `${g.color ?? ""}|${g.bold ? 1 : 0}`;
    let r = runs.get(key);
    if (!r) runs.set(key, (r = { color: g.color, bold: !!g.bold, path: [] }));
    r.path.push(...xform(g.path));
  }
  const out: Node[] = [];
  for (const r of runs.values()) {
    const c = r.color ? parseColor(r.color) : null;
    const paint: Paint = c ? { type: "solid", color: c } : base;
    const solid = paint.type === "solid" ? paint.color : BLACK;
    out.push({ kind: "path", path: r.path, fillRule: "nonzero", paint, ...(r.bold ? { stroke: { width: fontSize * 0.05, paint: { type: "solid" as const, color: solid }, join: "round" as const } } : {}), tag: t });
  }
  return out;
}
