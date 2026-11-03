// Drawing context handed to plugin effects and marks (spec 11.8.3).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { type Rng, noise1, noise2 } from "../core/random.js";
import { toMm } from "../core/units.js";
import type { Rect, Vec } from "../geom/vec.js";
import type { HandSpec } from "../ink/presets.js";
import { inkLine, inkShape } from "../ink/shape.js";
import type { RElement } from "../model/resolve.js";
import type { StrokeResolved } from "../model/values.js";
import { parsePaint } from "../model/values.js";
import type { PluginDrawContext, PluginDrawable } from "../plugin.js";
import type { Node, Paint } from "../render/ir.js";
import { type ElemCtx, tag } from "./context.js";
import { fillNode, inksToNodes } from "./inkir.js";
import { renderMark } from "./marks.js";

type Obj = Record<string, unknown>;

export function runPluginDrawable(
  def: PluginDrawable,
  el: RElement,
  ctx: ElemCtx,
  o: { rng: Rng; hand: HandSpec; stroke: StrokeResolved; bounds: Rect; center: Vec; size: number; contains: (p: Vec) => boolean },
): Node[] {
  const nodes: Node[] = [];
  const raw: Node[] = [];
  let params: Obj = el.props;
  if (def.params) {
    const r = def.params.safeParse(el.props);
    if (!r.success) {
      for (const iss of r.error.issues.slice(0, 5)) ctx.bag.error("SCHEMA_TYPE", `${String(el.props.kind)}: ${iss.path.join(".")}: ${iss.message}`, { path: [...el.path, ...(iss.path as (string | number)[])] });
      return [];
    }
    params = { ...el.props, ...(r.data as Obj) };
  }
  const paintOf = (f: Paint | string | null | undefined): Paint | null => {
    if (f === null) return null;
    if (f === undefined) return { type: "solid", color: WHITE };
    if (typeof f === "string") return parsePaint(f, { u: ctx.u, box: o.bounds, seed: el.seed, bag: ctx.bag, path: el.path });
    return f;
  };
  let lineN = 0;
  let markN = 0;
  const dc: PluginDrawContext = {
    rng: o.rng,
    noise: { noise1, noise2 },
    hand: o.hand,
    bounds: o.bounds,
    region: o.bounds,
    center: o.center,
    size: o.size,
    contains: o.contains,
    randomPointIn: () => {
      for (let i = 0; i < 200; i++) {
        const p = { x: o.bounds.x + o.rng.next() * o.bounds.w, y: o.bounds.y + o.rng.next() * o.bounds.h };
        if (o.contains(p)) return p;
      }
      return o.center;
    },
    line: (pts, lo = {}) => {
      const inks = inkLine(pts, { ...o.stroke, width: lo.width ?? o.stroke.width }, o.hand, o.rng.fork(`pl${lineN++}`), { taperIn: lo.taperIn !== false, taperOut: lo.taperOut !== false, ruler: lo.ruler, inkPool: false });
      nodes.push(...inksToNodes(inks, o.stroke.color ?? BLACK, tag(el, "ink")));
    },
    shape: (pts, f) => {
      const res = inkShape({ pts, closed: true, smooth: true }, { line: o.stroke, hand: o.hand, rng: o.rng.fork(`ps${lineN++}`), strokes: 1 });
      const fn = fillNode(res.fill, paintOf(f), tag(el, "fill"));
      if (fn) nodes.push(fn);
      nodes.push(...inksToNodes(res.inks, o.stroke.color ?? BLACK, tag(el, "ink")));
    },
    push: (...n) => raw.push(...n),
    marks: {
      draw: (kind, mp) => {
        const { at, size, rotate, ...rest } = mp;
        const cb = ctx.coordsBox;
        const props: Obj = { ...rest, kind, at: [`${at.x - cb.x}mm`, `${at.y - cb.y}mm`] };
        if (size !== undefined) props.size = `${size}mm`;
        if (rotate !== undefined) props.rotate = `${(rotate * 180) / Math.PI}deg`;
        const sub: RElement = { id: `${el.id}-m${markN}`, type: "mark", props, path: el.path, seed: (el.seed ^ (0x9e37 * ++markN)) >>> 0 };
        return renderMark(sub, ctx).nodes;
      },
    },
    mm: (len) => toMm(len as string, ctx.u),
    report: (code, message, severity = "warning") => ctx.bag.add({ code, message, severity, path: el.path, elementId: el.id }),
  };
  try {
    def.draw?.(dc, params);
    const gen = def.generate?.(dc, params);
    if (gen) raw.push(...gen);
  } catch (e) {
    ctx.bag.error("PLUGIN_ERROR", `${String(el.props.kind)}: ${(e as Error).message}`, { path: el.path, elementId: el.id });
  }
  void parseColor;
  return [...nodes, ...raw];
}
