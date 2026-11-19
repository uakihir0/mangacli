// Free text (spec 7.13) and SFX lettering (spec 7.14).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { Rng, noise1, noise2 } from "../core/random.js";
import { parseAngle, toMm, toRange } from "../core/units.js";
import { type PathData, flattenPath, polyPath, transformPath } from "../geom/path.js";
import { type Rect, type Vec, applyMat, boundsOf, matMul, matRotate, matScale, matTranslate } from "../geom/vec.js";
import { place, sizeValue } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint, resolveHand, resolveStroke } from "../model/values.js";
import { isObj } from "../load/normalize.js";
import { inkShape } from "../ink/shape.js";
import { inksToNodes } from "./inkir.js";
import { glyphNodes } from "./glyphs.js";
import type { Node, Paint } from "../render/ir.js";
import { type TextLayout, layoutText } from "../text/layout.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { resolveTextStyle, textValue } from "./textstyle.js";
import { parseMarkup } from "../text/markup.js";
import { fullSizeKana, isSmallKana, sfxScale, sfxShifts, sfxWeightRadius } from "../text/sfx.js";
import { brushGlyph, emboldenGlyph, type BrushSpec } from "../text/brush.js";

type Obj = Record<string, unknown>;

function outlineNodes(path: PathData, outlines: unknown, ctx: ElemCtx, el: RElement): Node[] {
  const list = Array.isArray(outlines) ? (outlines as Obj[]) : [];
  return list
    .map((o) => ({ w: toMm(o.width as string, ctx.u), c: parseColor((o.color as string) ?? "white") ?? WHITE }))
    .sort((a, b) => b.w - a.w)
    .map((o) => ({ kind: "path" as const, path, fillRule: "nonzero" as const, paint: null, stroke: { width: o.w * 2, paint: { type: "solid" as const, color: o.c }, join: "round" as const }, tag: tag(el, "text") }));
}

export function renderText(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect; layout?: TextLayout } {
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
  return { nodes, bbox: pl.bbox, layout: tl };
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
  const tl = layoutText(text, { ...style, lettering: null, smallKanaFix: false }, ctx.fonts);
  reportText(tl, el, ctx);
  const em = style.fontSize;
  const rng = new Rng(el.seed);
  const vertical = style.writing === "vertical";
  const grow = typeof p.grow === "number" ? p.grow : undefined;
  const brush = p.brush as BrushSpec | false | undefined;
  const pressureStyle = brush && brush.style === "speed" ? "speed" : "impact";
  const pcs = (p.perChar ?? {}) as Obj;
  const rotR = toRange(pcs.rotate as never, (x) => parseAngle(x as string), { min: -0.1, max: 0.1, dist: "uniform" });
  const scR = toRange(pcs.scale as never, (x) => Number(x), { min: 1, max: 1, dist: "uniform" });
  const jitter = pcs.jitter !== undefined ? toMm(pcs.jitter as string, u) : 0;
  const chars = Array.isArray(p.chars) ? (p.chars as Obj[]) : [];
  // group glyphs by unit (char index order)
  const units = [...new Set(tl.glyphs.map((g) => g.unit))].sort((a, b) => a - b);
  const idxOf = new Map(units.map((uu, i) => [uu, i]));
  const parsed = parseMarkup(text, { markup: style.markup, normalize: style.normalize, vertical });
  const unitChars = units.map(unit => {
    const char = parsed.units[unit];
    return char?.kind === "char" ? char.ch : "";
  });
  const fullCount = unitChars.filter(char => !isSmallKana(char)).length;
  let fullIndex = -1;
  const scales = units.map((_, i) => {
    if (!isSmallKana(unitChars[i])) fullIndex++;
    return sfxScale(grow === undefined ? Math.max(0, fullIndex) : i, grow === undefined ? fullCount : units.length, unitChars[i], grow, p.smallKanaScale as number | undefined, pressureStyle) * rng.range(scR.min, scR.max);
  });
  const shift = sfxShifts(scales, em);
  const acc = scales.reduce((sum, scale) => sum + (scale - 1) * em, 0);
  const dist = (p.distort ?? {}) as Obj;
  const roughen = typeof dist.roughen === "number" ? dist.roughen : 0.25;
  const warp = typeof dist.warp === "number" ? dist.warp : 0.15;
  const skew = dist.skew !== undefined ? parseAngle(dist.skew as string) : 0;
  const persp = Array.isArray(dist.perspective) ? (dist.perspective as number[]).map(Number) : null;
  const bulge = typeof dist.bulge === "number" ? dist.bulge : 0;
  const seedW = rng.nextU32();
  const seedR = rng.nextU32();
  const totalW = vertical ? tl.width : tl.width + acc;
  const totalH = vertical ? tl.height + acc : tl.height;
  let boxW = totalW;
  let boxH = totalH;
  const perCharT = units.map((uu, i) => {
    const ov = chars.find((c) => c.index === i);
    const r = ov?.rotate !== undefined ? parseAngle(ov.rotate as string) : rng.range(rotR.min, rotR.max);
    const s = scales[i] * (typeof ov?.scale === "number" ? (ov.scale as number) : 1);
    const perpendicular = pcs.jitter === undefined ? rng.range(-0.015, 0.015) * em : 0;
    const jx = rng.range(-jitter, jitter) + (vertical ? perpendicular : 0) + (Array.isArray(ov?.offset) ? toMm(ov!.offset[0] as string, u) : 0);
    const jy = rng.range(-jitter, jitter) + (vertical ? 0 : perpendicular) + (Array.isArray(ov?.offset) ? toMm(ov!.offset[1] as string, u) : 0);
    void uu;
    return { r, s, jx, jy, color: (ov?.color as string | undefined) };
  });
  // the path the letters follow (spec 7.14): along-axis position -> point and tangent turn
  const pathSpec = isObj(p.path) ? (p.path as Obj) : null;
  const along = (g: { cx: number; cy: number }, i: number) => (vertical ? g.cy + (shift[i] ?? 0) : g.cx + (shift[i] ?? 0));
  const Ltot = vertical ? totalH : totalW;
  const curveAt = (sPos: number): { dx: number; dy: number; ang: number } => {
    if (!pathSpec) return { dx: 0, dy: 0, ang: 0 };
    const kind = String(pathSpec.kind ?? "line");
    const tt = Ltot > 0 ? sPos / Ltot : 0;
    // offsets are expressed as (along, across); across points away from the reading start side
    let a = sPos;
    let n = 0;
    let ang = 0;
    if (kind === "line") {
      ang = parseAngle((pathSpec.angle as string) ?? "0deg");
      a = sPos * Math.cos(ang);
      n = sPos * Math.sin(ang);
    } else if (kind === "arc") {
      const A = parseAngle((pathSpec.angle as string) ?? "40deg");
      const r = pathSpec.radius !== undefined ? toMm(pathSpec.radius as string, u) : Ltot / Math.max(1e-3, A);
      const phi = (tt - 0.5) * (Ltot / r);
      a = Ltot / 2 + r * Math.sin(phi);
      n = r * (1 - Math.cos(phi));
      ang = phi;
    } else if (kind === "wave") {
      const amp = pathSpec.amplitude !== undefined ? toMm(pathSpec.amplitude as string, u) : em * 0.3;
      const wl = pathSpec.wavelength !== undefined ? toMm(pathSpec.wavelength as string, u) : em * 3;
      n = amp * Math.sin((sPos / wl) * Math.PI * 2);
      ang = Math.atan(((amp * Math.PI * 2) / wl) * Math.cos((sPos / wl) * Math.PI * 2));
    } else if (kind === "points" && Array.isArray(pathSpec.points) && pathSpec.points.length > 1) {
      const pts = (pathSpec.points as unknown[][]).map((q) => ({ x: toMm(q[0] as string, u), y: toMm(q[1] as string, u) }));
      const segL: number[] = [0];
      for (let k = 1; k < pts.length; k++) segL.push(segL[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
      const target = tt * segL[segL.length - 1];
      let k = 1;
      while (k < pts.length - 1 && segL[k] < target) k++;
      const f0 = (target - segL[k - 1]) / Math.max(1e-6, segL[k] - segL[k - 1]);
      const q = { x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * f0, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * f0 };
      const dir = Math.atan2(pts[k].y - pts[k - 1].y, pts[k].x - pts[k - 1].x);
      // points are in page-like (x, y); map onto the writing axis
      a = vertical ? q.y : q.x;
      n = vertical ? -q.x : q.y;
      ang = vertical ? dir - Math.PI / 2 : dir;
    }
    return vertical ? { dx: -n, dy: a - sPos, ang } : { dx: a - sPos, dy: n, ang };
  };
  const paths: PathData[] = [];
  const colorsPer: (string | undefined)[] = [];
  for (const g of tl.glyphs) {
    const i = idxOf.get(g.unit) ?? 0;
    const t = perCharT[i];
    const sh = shift[i] ?? 0;
    const cx = g.cx;
    const cy = g.cy;
    const cv = curveAt(along(g, i));
    const m = matMul(matTranslate(cx + t.jx + (vertical ? 0 : sh) + cv.dx, cy + t.jy + (vertical ? sh : 0) + cv.dy), matMul(matRotate(t.r + cv.ang), matMul(matScale(t.s), matTranslate(-cx, -cy))));
    const small = isSmallKana(unitChars[i]);
    let source = g.path;
    if (small) {
      const full = layoutText(fullSizeKana(unitChars[i]), { ...style, lettering: null, smallKanaFix: false }, ctx.fonts).glyphs;
      if (full.length) source = transformPath(full.flatMap(g => g.path), matTranslate(cx - full[0].cx, cy - full[0].cy));
    }
    const smallScale = typeof p.smallKanaScale === "number" ? p.smallKanaScale : 0.7;
    source = emboldenGlyph(source, em, sfxWeightRadius(pressureStyle, small ? smallScale : 1) * em);
    let path = transformPath(brushGlyph(source, em, el.seed ^ Math.imul(i + 1, 0x45d9f3b), brush), m);
    // distort: flatten -> displace
    if (warp > 0 || roughen > 0 || skew || persp || bulge) {
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
          // perspective: horizontal scale changes from top to bottom; bulge swells the middle
          let x = q.x + wx + rr + sk;
          let y = q.y + wy + rr;
          if (persp) {
            const ty = Math.max(0, Math.min(1, y / Math.max(1e-6, totalH)));
            const k = persp[0] + (persp[1] - persp[0]) * ty;
            x = totalW / 2 + (x - totalW / 2) * k;
          }
          if (bulge) {
            const nx = (x - totalW / 2) / Math.max(1e-6, totalW / 2);
            const ny = (y - totalH / 2) / Math.max(1e-6, totalH / 2);
            const f = 1 + bulge * 0.35 * Math.max(0, 1 - (nx * nx + ny * ny) * 0.5);
            x = totalW / 2 + (x - totalW / 2) * f;
            y = totalH / 2 + (y - totalH / 2) * f;
          }
          return { x, y };
        });
        out.push(...polyPath(pts, true));
      }
      path = out;
    }
    paths.push(path);
    colorsPer.push(t.color ?? g.color);
  }
  if (!pathSpec && style.letterSpacing < 0) {
    let end: number | undefined;
    for (const unit of units) {
      const indices = tl.glyphs.flatMap((g, i) => g.unit === unit ? [i] : []);
      const points = indices.flatMap(i => flattenPath(paths[i], 0.05).flatMap(c => c.pts));
      if (!points.length) continue;
      const bb = boundsOf(points);
      const start = vertical ? bb.y : bb.x;
      const spacing = isSmallKana(unitChars[idxOf.get(unit)!]) ? 0.04 : Math.max(0.03, style.letterSpacing);
      const delta = end === undefined ? 0 : end + spacing * em - start;
      for (const i of indices) paths[i] = transformPath(paths[i], matTranslate(vertical ? 0 : delta, vertical ? delta : 0));
      end = start + delta + (vertical ? bb.h : bb.w);
    }
  }
  let footprintScale = 1;
  {
    const pts = flattenPath(paths.flat(), 0.2).flatMap((c) => c.pts);
    if (pts.length) {
      const bb = boundsOf(pts);
      const baseAlong = (vertical ? tl.height : tl.width) + Math.max(0, units.length - 1) * Math.max(0, -0.05 - style.letterSpacing) * em;
      const baseArea = baseAlong * (vertical ? tl.width : tl.height);
      if (grow === undefined && bb.w * bb.h > 0) footprintScale = Math.max(1, Math.sqrt(baseArea * 1.15 / (bb.w * bb.h)));
      for (let k = 0; k < paths.length; k++) paths[k] = transformPath(paths[k], [footprintScale, 0, 0, footprintScale, -bb.x * footprintScale, -bb.y * footprintScale]);
      boxW = bb.w * footprintScale;
      boxH = bb.h * footprintScale;
    }
  }
  const allPath = paths.flat();
  const pc = placeCtx(ctx, el);
  const pl = place(p, boxW, boxH, pc);
  const placed = transformPath(allPath, pl.matrix);
  const nodes: Node[] = [];
  paths.forEach((path, i) => {
    const scale = perCharT[idxOf.get(tl.glyphs[i].unit) ?? 0].s * footprintScale;
    nodes.push(...outlineNodes(transformPath(path, pl.matrix), p.outline ?? [{ width: `${em * scale * 0.06}mm`, color: "white" }], ctx, el));
  });
  const paint = textPaint(p.color, ctx, el, pl.bbox);
  // hollow letters keep only the traced outline (black by default)
  const edge = (p.edge as Obj | undefined) ?? (p.hollow ? { width: "0.35bmm", color: (p.color as string) ?? "black" } : undefined);
  if (!p.hollow) {
    // per-character colours (chars[].color, <color>) split the fill into runs
    const runs = new Map<string, PathData>();
    paths.forEach((pd, k) => {
      const key = colorsPer[k] ?? "";
      runs.set(key, [...(runs.get(key) ?? []), ...transformPath(pd, pl.matrix)]);
    });
    for (const [key, pd] of runs) {
      const c = key ? parseColor(key) : null;
      nodes.push({ kind: "path", path: pd, fillRule: "nonzero", paint: c ? { type: "solid", color: c } : paint, tag: tag(el, "text", "sfx") });
    }
  }
  else nodes.push({ kind: "path", path: placed, fillRule: "nonzero", paint: { type: "solid", color: WHITE }, tag: tag(el, "text", "sfx") });
  if (edge && edge.style !== "none") {
    // trace the glyph contours with a hand-drawn pen line
    const hand = resolveHand(p.hand, u, ctx.draft);
    const line = resolveStroke({ pen: { preset: "g-pen" }, ...edge, width: edge.width ?? "0.3bmm" }, hand, u, ctx.bag, [...el.path, "edge"]);
    const rng = new Rng(el.seed ^ 0x2f6b);
    const inks = flattenPath(placed, 0.05).filter((c) => c.pts.length > 2).flatMap((c, i) => inkShape({ pts: c.pts, closed: true }, { line, hand: { ...hand, wobbleAmp: hand.wobbleAmp * 0.3 }, rng: rng.fork(`c${i}`), strokes: 1, sizeHint: 4 * u.k }).inks);
    nodes.push(...inksToNodes(inks, line.color, tag(el, "ink")));
  }
  void sizeValue;
  return { nodes, bbox: pl.bbox };
}

export type { Vec };
