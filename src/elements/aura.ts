import polygonClipping, { type Ring } from "polygon-clipping";
import { BLACK, WHITE } from "../core/color.js";
import { Rng } from "../core/random.js";
import { toMm } from "../core/units.js";
import { isObj } from "../load/normalize.js";
import { polyPath } from "../geom/path.js";
import { type Vec, boundsOf } from "../geom/vec.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint, resolveHand, resolveStroke } from "../model/values.js";
import { inkShape } from "../ink/shape.js";
import { type Node, solid } from "../render/ir.js";
import { signedArea } from "./alpha-contour.js";
import { type ElemCtx, tag } from "./context.js";
import { inksToNodes } from "./inkir.js";
import { lightningOutline, lightningPoints } from "./lightning.js";
import type { ResolvedRegion } from "./region.js";

function samples(loop: Vec[], count: number): { p: Vec; n: Vec }[] {
  const lengths = loop.map((p, i) => Math.hypot(p.x - loop[(i + 1) % loop.length].x, p.y - loop[(i + 1) % loop.length].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  const sign = signedArea(loop) < 0 ? -1 : 1;
  let j = 0, acc = 0;
  const points = Array.from({ length: count }, (_, i) => {
    const d = i * total / count;
    while (j < loop.length - 1 && acc + lengths[j] < d) acc += lengths[j++];
    const a = loop[j], b = loop[(j + 1) % loop.length], t = (d - acc) / (lengths[j] || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
  return points.map((p, i) => {
    const a = points[(i + count - 2) % count], b = points[(i + 2) % count];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { p, n: { x: sign * (b.y - a.y) / d, y: -sign * (b.x - a.x) / d } };
  });
}

export function renderAura(el: RElement, ctx: ElemCtx, region: ResolvedRegion): Node[] {
  const p = el.props;
  const bad = (key: string, code: string, message: string): Node[] => {
    ctx.bag.error(code, message, { path: [...el.path, key] });
    return [];
  };
  if (p.target === undefined) return bad("target", "SCHEMA_REQUIRED", `${p.kind} requires target`);
  const target = typeof p.target === "string" ? ctx.refs.target(p.target, ctx.panel?.panel.id) : undefined;
  if (!target) return bad("target", "REF_NOT_FOUND", `image target "${p.target}" not found`);
  if (target.type !== "image") return bad("target", "SCHEMA_TYPE", `${p.kind} target must be an image`);
  if (!target.imagePx) return [];
  const loops = ctx.alphaContours?.get(target.id) ?? [];
  const b = loops.length ? boundsOf(loops.flat()) : target.bbox;
  const length = toMm(p.length as string, { ...ctx.u, base: Math.max(b.w, b.h) });
  if (!Number.isFinite(length) || length <= 0) return bad("length", "SCHEMA_TYPE", "length must be positive");
  if (!loops.length) return [];
  const density = (p.density as number) ?? 1;
  if (density <= 0) return [];
  const rng = new Rng(el.seed);
  const ring = (q: Vec[]): Ring => [...q, q[0]].map(v => [v.x, v.y]);
  const [first, ...rest] = loops.map(q => [ring(q)]);
  const subject = polygonClipping.union(first, ...rest);
  const frame = region.bbox;
  const outer = ring([{ x: frame.x - length * 4, y: frame.y - length * 4 }, { x: frame.x + frame.w + length * 4, y: frame.y - length * 4 }, { x: frame.x + frame.w + length * 4, y: frame.y + frame.h + length * 4 }, { x: frame.x - length * 4, y: frame.y + frame.h + length * 4 }]);
  const pathOf = (mp: ReturnType<typeof polygonClipping.union>) => mp.flatMap(poly => poly.flatMap(r => polyPath(r.slice(0, -1).map(([x, y]) => ({ x, y })), true)));
  const clip = pathOf(polygonClipping.difference([outer], subject));
  const nodes: Node[] = [];
  const hand = resolveHand(p.hand, ctx.u, ctx.draft);
  const stroke = resolveStroke({ pen: p.pen, color: p.color, ...(isObj(p.stroke) ? p.stroke : {}) }, hand, ctx.u, ctx.bag, [...el.path, "stroke"]);
  const paint = parsePaint(p.fill, { u: ctx.u, box: b, seed: el.seed, bag: ctx.bag, path: [...el.path, "fill"] });
  const draw = (q: Vec[], fill: typeof paint, seed: Rng) => {
    const cut = polygonClipping.difference([ring(q)], subject);
    if (fill && cut.length) nodes.push({ kind: "path", path: pathOf(cut), fillRule: "evenodd", paint: fill, tag: tag(el, "fill") });
    const ink = inkShape({ pts: q, closed: true, smooth: false }, { hand: stroke.hand, rng: seed, line: stroke, join: "clean" });
    nodes.push(...inksToNodes(ink.inks, stroke.color ?? BLACK, tag(el, "ink")));
  };
  const usable = loops.filter(q => Math.abs(signedArea(q)) >= b.w * b.h / 10000);
  if (p.kind === "aura") {
    const tongues = Number(p.tongues) * density, layers = Number(p.layers), bias = Number(p.upwardBias);
    for (let layer = 0; layer < layers; layer++) for (const [component, loop] of usable.entries()) {
      const r = new Rng(el.seed).fork(`component-${component}`);
      const factor = 1 - layer * 0.26;
      const count = Math.max(4, Math.round(tongues * Math.sqrt(Math.abs(signedArea(loop)) / Math.max(1e-9, b.w * b.h))));
      const contour = samples(loop, count * 16);
      const heights = Array.from({ length: count }, () => r.range(0.65, 1.25));
      const flame = contour.map(({ p: q, n }, i) => {
        const t = (i % 16) / 16;
        const peak = t <= 0.625 ? Math.pow(t / 0.625, 2) : Math.pow((1 - t) / 0.375, 1.5);
        const h = length * factor * (0.16 + peak * heights[Math.floor(i / 16)]) * (1 + bias * (-n.y * 0.65 + 0.25));
        return { x: q.x + n.x * h + n.y * peak * length * factor * 0.16, y: q.y + n.y * h - bias * peak * length * factor * 0.65 };
      });
      draw(flame, layer === layers - 1 ? paint : solid(WHITE), r.fork(`ink-${layer}`));
    }
  } else {
    const bias = Number(p.upwardBias);
    const pool = usable.flatMap(loop => {
      const maxY = Math.max(...loop.map(q => q.y));
      return samples(loop, 256).filter(({ p: q, n }) => n.y <= 1 - bias && q.y <= maxY - bias * length);
    });
    if (!pool.length) return [];
    const count = Math.round(Number(p.count) * density);
    for (let i = 0; i < count; i++) {
      const r = rng.fork(`arc-${i}`);
      const { p: q, n } = pool[Math.floor((i + r.next()) / count * pool.length)];
      const start = { x: q.x + n.x * length * 0.12, y: q.y + n.y * length * 0.12 };
      const direction = Math.atan2(n.y, n.x) + r.range(-1.15, 1.15);
      const dy = Math.sin(direction);
      const angle = Math.atan2(dy - bias * (Math.max(0, dy) + 0.65), Math.cos(direction));
      const pts = lightningPoints(r, start, angle, length * r.range(0.65, 1.2), 1).map(v => ({
        x: v.x, y: v.y - bias * Math.max(0, v.y - start.y),
      }));
      draw(lightningOutline(pts, length * 0.14), paint, r.fork("ink"));
    }
  }
  return nodes.length ? [{ kind: "group", clip, clipRule: "evenodd", children: nodes, tag: tag(el, "ink") }] : [];
}
