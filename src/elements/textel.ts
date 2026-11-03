// Free text (spec 7.13) and SFX lettering (spec 7.14).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { Rng, noise1, noise2 } from "../core/random.js";
import { parseAngle, toMm, toRange } from "../core/units.js";
import { type PathData, flattenPath, polyPath, smoothPath, transformPath } from "../geom/path.js";
import { type Rect, type Vec, applyMat, matMul, matRotate, matScale, matTranslate } from "../geom/vec.js";
import { place, sizeValue } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint, resolveHand, resolveStroke } from "../model/values.js";
import { inkShape } from "../ink/shape.js";
import { inksToNodes } from "./inkir.js";
import { glyphNodes } from "./glyphs.js";
import type { Node, Paint } from "../render/ir.js";
import { type TextLayout, layoutText } from "../text/layout.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { resolveTextStyle, textValue } from "./textstyle.js";

type Obj = Record<string, unknown>;

function outlineNodes(path: PathData, outlines: unknown, ctx: ElemCtx, el: RElement): Node[] {
  const list = Array.isArray(outlines) ? (outlines as Obj[]) : [];
  return list
    .map((o) => ({ w: toMm(o.width as string, ctx.u), c: parseColor((o.color as string) ?? "white") ?? WHITE }))
    .sort((a, b) => b.w - a.w)
    .map((o) => ({ kind: "path" as const, path, fillRule: "nonzero" as const, paint: null, stroke: { width: o.w * 2, paint: { type: "solid" as const, color: o.c }, join: "round" as const }, tag: tag(el, "text") }));
}

export function renderText(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect } {
  const p = el.props;
  const u = ctx.u;
  const style = resolveTextStyle(p, u, ctx.lang, false, el.seed);
  const pc = placeCtx(ctx, el);
  const text = textValue(p.text, ctx.lang, ctx.defaultLang);
  let boxLimit: number | undefined;
  let fixed: [number, number] | null = null;
  if (Array.isArray(p.size)) {
    const w = sizeValue(p.size[0], ctx.coordsBox.w, pc);
    const h = sizeValue(p.size[1], ctx.coordsBox.h, pc);
    if (w !== "auto" && h !== "auto") {
      fixed = [w, h];
      boxLimit = style.writing === "vertical" ? h : w;
    }
  }
  let tl = layoutText(text, style, ctx.fonts, boxLimit);
  if (fixed && (tl.width > fixed[0] + 0.01 || tl.height > fixed[1] + 0.01)) {
    if ((p.overflow as string) !== "clip") {
      let s = 1;
      while (s > 0.5 && (tl.width > fixed[0] || tl.height > fixed[1])) {
        s -= 0.05;
        tl = layoutText(text, { ...style, fontSize: style.fontSize * s }, ctx.fonts, boxLimit);
      }
    }
    if (tl.width > fixed[0] + 0.01 || tl.height > fixed[1] + 0.01) {
      const mode = (p.overflow as string) ?? "shrink";
      if (mode === "error") ctx.bag.error("TEXT_OVERFLOW", `text ${el.id} does not fit its box`, { path: el.path, elementId: el.id });
      else if (mode === "clip") ctx.bag.warn("TEXT_CLIPPED", `text ${el.id} is clipped by its box`, { path: el.path, elementId: el.id });
      else ctx.bag.warn("TEXT_OVERFLOW", `text ${el.id} does not fit its box`, { path: el.path, elementId: el.id });
    }
  }
  reportText(tl, el, ctx);
  const emCtx = { ...u, em: style.fontSize };
  const pad = Array.isArray(p.padding) ? p.padding : ["0.3em", "0.3em"];
  const padV = toMm(pad[0] as string, emCtx);
  const padH = toMm(pad[1] as string, emCtx);
  const bw = fixed ? fixed[0] : tl.width + padH * 2;
  const bh = fixed ? fixed[1] : tl.height + padV * 2;
  const pl = place(p, bw, bh, pc);
  // fixed boxes: align along the line, blockAlign across lines (vertical text starts at the right)
  const vert = style.writing === "vertical";
  // overflowing text keeps its beginning visible
  const pos = (free: number, a0: string, reverse = false) => {
    const a = free < 0 ? "start" : a0;
    return a === "start" ? (reverse ? free : 0) : a === "end" ? (reverse ? 0 : free) : free / 2;
  };
  const inl = (p.align as string) ?? "center";
  const blk = (p.blockAlign as string) ?? "center";
  const ox = fixed ? (vert ? pos(bw - tl.width, blk, true) : pos(bw - tl.width, inl === "justify" ? "start" : inl)) : (bw - tl.width) / 2;
  const oy = fixed ? (vert ? pos(bh - tl.height, inl === "justify" ? "start" : inl) : pos(bh - tl.height, blk)) : (bh - tl.height) / 2;
  const m = matMul(pl.matrix, matTranslate(ox, oy));
  const glyphPath = tl.glyphs.flatMap((g) => transformPath(g.path, m));
  const nodes: Node[] = [];
  const bg = parsePaint(p.background, { u, box: pl.bbox, seed: el.seed, bag: ctx.bag, path: [...el.path, "background"] });
  if (bg) {
    const corners = [applyMat(pl.matrix, { x: 0, y: 0 }), applyMat(pl.matrix, { x: bw, y: 0 }), applyMat(pl.matrix, { x: bw, y: bh }), applyMat(pl.matrix, { x: 0, y: bh })];
    nodes.push({ kind: "path", path: polyPath(corners, true), fillRule: "nonzero", paint: bg, tag: tag(el, "fill") });
  }
  const corners = [applyMat(pl.matrix, { x: 0, y: 0 }), applyMat(pl.matrix, { x: bw, y: 0 }), applyMat(pl.matrix, { x: bw, y: bh }), applyMat(pl.matrix, { x: 0, y: bh })];
  const textNodes: Node[] = [...outlineNodes(glyphPath, p.outline, ctx, el)];
  const color = textPaint(p.color, ctx, el, pl.bbox);
  textNodes.push(...glyphNodes(tl.glyphs, (g) => transformPath(g, m), color, tl.fontSize, tag(el, "text")));
  if (fixed && p.overflow === "clip") nodes.push({ kind: "group", clip: polyPath(corners, true), children: textNodes });
  else nodes.push(...textNodes);
  // the plate's outline
  if (p.stroke !== undefined && (p.stroke as Obj | undefined)?.style !== "none") {
    const hand = resolveHand(p.hand, u, ctx.draft);
    const st = resolveStroke(p.stroke, hand, u, ctx.bag, [...el.path, "stroke"]);
    if (st.width > 0 && st.style !== "none") {
      const res = inkShape({ pts: corners, closed: true, corners: corners.map((_, i) => ({ index: i, kind: "convex" as const })) }, { line: st, hand, rng: new Rng(el.seed ^ 0x77), ruler: true, join: "clean" });
      nodes.push(...inksToNodes(res.inks, st.color, tag(el, "ink")));
    }
  }
  return { nodes, bbox: pl.bbox };
}

function textPaint(c: unknown, ctx: ElemCtx, el: RElement, box: Rect): Paint {
  return parsePaint(c ?? "black", { u: ctx.u, box, seed: el.seed, bag: ctx.bag, path: [...el.path, "color"] }) ?? { type: "solid", color: BLACK };
}

function reportText(tl: TextLayout, el: RElement, ctx: ElemCtx) {
  if (tl.missing.length) ctx.bag.warn("FONT_MISSING_GLYPH", `missing glyphs: ${[...new Set(tl.missing)].join("")}`, { path: el.path, elementId: el.id });
  for (const e of tl.errors) ctx.bag.error(e.code, e.message, { path: [...el.path, "text"], elementId: el.id });
  for (const e of tl.infos) ctx.bag.add({ code: e.code, message: e.message, severity: e.severity ?? "info", path: [...el.path, "text"], elementId: el.id });
}

export function renderSfx(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect } {
  const p = el.props;
  const u = ctx.u;
  const style = resolveTextStyle({ ...p, wrap: "none", maxChars: undefined, punctCompress: "none", tcy: p.tcy ?? "none" }, u, ctx.lang, false, el.seed);
  const text = textValue(p.text, ctx.lang, ctx.defaultLang).replace(/\n/g, "");
  const tl = layoutText(text, { ...style, lettering: null }, ctx.fonts);
  reportText(tl, el, ctx);
  const em = style.fontSize;
  const rng = new Rng(el.seed);
  const vertical = style.writing === "vertical";
  const grow = typeof p.grow === "number" ? p.grow : 0;
  const pcs = (p.perChar ?? {}) as Obj;
  const rotR = toRange(pcs.rotate as never, (x) => parseAngle(x as string), { min: -0.1, max: 0.1, dist: "uniform" });
  const scR = toRange(pcs.scale as never, (x) => Number(x), { min: 1, max: 1, dist: "uniform" });
  const jitter = pcs.jitter !== undefined ? toMm(pcs.jitter as string, u) : 0;
  const chars = Array.isArray(p.chars) ? (p.chars as Obj[]) : [];
  // group glyphs by unit (char index order)
  const units = [...new Set(tl.glyphs.map((g) => g.unit))].sort((a, b) => a - b);
  const idxOf = new Map(units.map((uu, i) => [uu, i]));
  const scales = units.map((_, i) => (1 + grow * i) * rng.range(scR.min, scR.max));
  const shift: number[] = [];
  let acc = 0;
  units.forEach((_, i) => {
    shift.push(acc + (scales[i] - 1) * em * 0.5);
    acc += (scales[i] - 1) * em;
  });
  const dist = (p.distort ?? {}) as Obj;
  const roughen = typeof dist.roughen === "number" ? dist.roughen : 0.25;
  const warp = typeof dist.warp === "number" ? dist.warp : 0.15;
  const skew = dist.skew !== undefined ? parseAngle(dist.skew as string) : 0;
  const seedW = rng.nextU32();
  const seedR = rng.nextU32();
  const totalW = vertical ? tl.width : tl.width + acc;
  const totalH = vertical ? tl.height + acc : tl.height;
  const perCharT = units.map((uu, i) => {
    const ov = chars.find((c) => c.index === i);
    const r = ov?.rotate !== undefined ? parseAngle(ov.rotate as string) : rng.range(rotR.min, rotR.max);
    const s = scales[i] * (typeof ov?.scale === "number" ? (ov.scale as number) : 1);
    const jx = rng.range(-jitter, jitter) + (Array.isArray(ov?.offset) ? toMm(ov!.offset[0] as string, u) : 0);
    const jy = rng.range(-jitter, jitter) + (Array.isArray(ov?.offset) ? toMm(ov!.offset[1] as string, u) : 0);
    void uu;
    return { r, s, jx, jy, color: ov?.color as string | undefined };
  });
  const paths: PathData[] = [];
  const colorsPer: (string | undefined)[] = [];
  for (const g of tl.glyphs) {
    const i = idxOf.get(g.unit) ?? 0;
    const t = perCharT[i];
    const sh = shift[i] ?? 0;
    const cx = g.cx;
    const cy = g.cy;
    const m = matMul(matTranslate(cx + t.jx + (vertical ? 0 : sh), cy + t.jy + (vertical ? sh : 0)), matMul(matRotate(t.r), matMul(matScale(t.s), matTranslate(-cx, -cy))));
    let path = transformPath(g.path, m);
    // distort: flatten -> displace -> smooth
    if (warp > 0 || roughen > 0 || skew) {
      const polys = flattenPath(path, 0.05 * u.k);
      const out: PathData = [];
      for (const pl of polys) {
        let s = 0;
        const pts = pl.pts.map((q, k) => {
          if (k > 0) s += Math.hypot(q.x - pl.pts[k - 1].x, q.y - pl.pts[k - 1].y);
          const wx = warp * em * 0.12 * noise2(seedW, q.x / (em * 1.6), q.y / (em * 1.6));
          const wy = warp * em * 0.12 * noise2(seedW + 7, q.x / (em * 1.6), q.y / (em * 1.6));
          const rr = roughen * em * 0.02 * noise1(seedR + i, s / (em * 0.25));
          const sk = skew ? Math.tan(skew) * (q.y - totalH / 2) : 0;
          return { x: q.x + wx + rr + sk, y: q.y + wy + rr };
        });
        out.push(...(pts.length > 3 ? smoothPath(pts, true) : polyPath(pts, true)));
      }
      path = out;
    }
    paths.push(path);
    colorsPer.push(t.color);
  }
  const allPath = paths.flat();
  const pc = placeCtx(ctx, el);
  const pl = place(p, totalW, totalH, pc);
  const placed = transformPath(allPath, pl.matrix);
  const nodes: Node[] = [];
  nodes.push(...outlineNodes(placed, p.outline, ctx, el));
  const paint = textPaint(p.color, ctx, el, pl.bbox);
  // hollow letters keep only the traced outline (black by default)
  const edge = (p.edge as Obj | undefined) ?? (p.hollow ? { width: "0.35bmm", color: (p.color as string) ?? "black" } : undefined);
  if (!p.hollow) nodes.push({ kind: "path", path: placed, fillRule: "nonzero", paint, tag: tag(el, "text", "sfx") });
  else nodes.push({ kind: "path", path: placed, fillRule: "nonzero", paint: { type: "solid", color: WHITE }, tag: tag(el, "text", "sfx") });
  if (edge && edge.style !== "none") {
    // trace the glyph contours with a hand-drawn pen line
    const hand = resolveHand(p.hand, u, ctx.draft);
    const line = resolveStroke({ pen: { preset: "g-pen" }, ...edge, width: edge.width ?? "0.3bmm" }, hand, u, ctx.bag, [...el.path, "edge"]);
    const rng = new Rng(el.seed ^ 0x2f6b);
    const inks = flattenPath(placed, 0.05).filter((c) => c.pts.length > 2).flatMap((c, i) => inkShape({ pts: c.pts, closed: true }, { line, hand: { ...hand, wobbleAmp: hand.wobbleAmp * 0.3 }, rng: rng.fork(`c${i}`), strokes: 1, sizeHint: 4 * u.k }).inks);
    nodes.push(...inksToNodes(inks, line.color, tag(el, "ink")));
  }
  void colorsPer;
  void sizeValue;
  return { nodes, bbox: pl.bbox };
}

export type { Vec };
