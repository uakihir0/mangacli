// Balloons: sizing, tails, inking (spec 6).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { DiagnosticBag } from "../core/diagnostics.js";
import { Rng } from "../core/random.js";
import { type UnitContext, parseAngle, toMm } from "../core/units.js";
import { type PathData, distToPolyline, flattenPath, offsetPolygon, pointInPolygon, polyPath, polygonArea, rayPolygon, transformPath } from "../geom/path.js";
import { type Rect, type Vec, boundsOf, dot, lerp, matTranslate, rot, sub } from "../geom/vec.js";
import type { HandSpec } from "../ink/presets.js";
import { type ShapeContour, inkShape } from "../ink/shape.js";
import { blobPoly } from "../ink/stroke.js";
import { isObj } from "../load/normalize.js";
import type { RElement } from "../model/resolve.js";
import { paintAvgLuminance, parsePaint, resolveHand, resolveStroke } from "../model/values.js";
import type { Node, Paint } from "../render/ir.js";
import polygonClipping from "polygon-clipping";
import { BODY_GENERATORS, type BodyGeom, type ShapeParams } from "../shapes/balloon.js";
import { Contour, type PluginBalloonShape, activePlugins } from "../plugin.js";
import { type TextLayout, layoutText } from "../text/layout.js";
import { type ElemCtx, silhouetteHit, tag } from "./context.js";
import { fillNode, inksToNodes, polysToPath } from "./inkir.js";
import { glyphNodes } from "./glyphs.js";
import { resolveTextStyle, textValue } from "./textstyle.js";
import { resolvePoint, sizeValue } from "../layout/place.js";

type Obj = Record<string, unknown>;

export interface BalloonPlan {
  el: RElement;
  text: TextLayout;
  textColor: string;
  params: ShapeParams;
  seed: number;
  base: { w: number; h: number };
  body: BodyGeom; // centered
  outer: Rect; // centered coords bbox of contour
  center?: Vec; // page coords
  edgeCut?: boolean;
  explicit: boolean;
  fill: Paint | null;
  hand: HandSpec;
  innerCenter: Vec; // text block center relative to body center
  props: Obj;
  textOffset: Vec;
  fontScaleApplied: number;
  tailObstacles?: { id: string; contour: Vec[] }[];
}

export function prepareBalloonObstacles(plans: BalloonPlan[]): void {
  const bodies = plans.filter(p => p.center).map(p => {
    const a = p.props.rotate === undefined ? 0 : parseAngle(p.props.rotate as string);
    return { id: p.el.id, contour: p.body.contour.pts.map(q => ({ x: p.center!.x + q.x * Math.cos(a) - q.y * Math.sin(a), y: p.center!.y + q.x * Math.sin(a) + q.y * Math.cos(a) })) };
  });
  const links = new Map(plans.map(p => [p.el.id, new Set<string>()]));
  for (const p of plans) {
    const cs = p.props.connect;
    for (const c of (Array.isArray(cs) ? cs : cs ? [cs] : []) as Obj[]) {
      links.get(p.el.id)!.add(String(c.to));
      links.get(String(c.to))?.add(p.el.id);
    }
  }
  for (const p of plans) {
    const excluded = new Set([p.el.id]);
    const visit = (id: string) => {
      for (const next of links.get(id) ?? []) if (!excluded.has(next)) { excluded.add(next); visit(next); }
    };
    visit(p.el.id);
    p.tailObstacles = bodies.filter(b => !excluded.has(b.id));
  }
}

function shapeParams(props: Obj, rng: Rng, hand: HandSpec, u: UnitContext): ShapeParams {
  const s = (isObj(props.shape) ? props.shape : { kind: "ellipse" }) as Obj;
  const tiltSpec = s.tilt;
  let tilt = 0;
  if (Array.isArray(tiltSpec)) tilt = rng.range(parseAngle(tiltSpec[0] as string), parseAngle(tiltSpec[1] as string));
  else if (tiltSpec !== undefined) tilt = parseAngle(tiltSpec as string);
  const irr = (typeof s.irregularity === "number" ? s.irregularity : 0.35) / 0.35 * hand.irregularity;
  return {
    kind: String(s.kind ?? "ellipse"),
    irregularity: irr * (hand.irregularity > 0 ? 1 : 0),
    tilt: hand.irregularity > 0 ? tilt : 0,
    squareness: s.squareness as number | undefined,
    egg: s.egg as number | undefined,
    radius: s.radius !== undefined ? toMm(s.radius as string, u) : undefined,
    lobes: s.lobes as ShapeParams["lobes"],
    lobeSize: s.lobeSize as [number, number] | undefined,
    depth: s.depth as ShapeParams["depth"],
    count: s.count as ShapeParams["count"],
    angleJitter: s.angleJitter as number | undefined,
    curve: s.curve as number | undefined,
    waves: s.waves as ShapeParams["waves"],
    amplitude: s.amplitude !== undefined ? toMm(s.amplitude as string, u) : 0.5 * u.k,
    waveform: s.waveform as ShapeParams["waveform"],
    secondary: s.secondary as boolean | undefined,
    corners: s.corners as number | undefined,
    jag: s.jag as number | undefined,
    points: s.points as [number, number][] | undefined,
    strokes: s.strokes as ShapeParams["strokes"],
    join: s.join as ShapeParams["join"],
    ruler: s.ruler as boolean | undefined,
    raw: s,
  };
}

function genBody(kind: string, w: number, h: number, p: ShapeParams, seed: number): BodyGeom {
  const g = BODY_GENERATORS[kind];
  if (g) return g(w, h, p, seed);
  const plug = activePlugins()?.shapes.get(kind);
  if (plug) return pluginBody(kind, plug, w, h, p, seed);
  return BODY_GENERATORS.ellipse(w, h, p, seed);
}

/** balloon body from a plugin shape (spec 11.8) */
function pluginBody(kind: string, def: PluginBalloonShape, w: number, h: number, p: ShapeParams, seed: number): BodyGeom {
  const raw = (p.raw ?? {}) as Obj;
  let params: Obj = raw;
  if (def.params) {
    const r = def.params.safeParse(raw);
    if (r.success) params = { ...raw, ...(r.data as Obj) };
  }
  const sctx = { rng: new Rng(seed), irregularity: p.irregularity, contour: Contour };
  const pts = (c: Contour | Vec[]) => (c instanceof Contour ? c.points : c);
  let outline = pts(def.outline(sctx, params, { width: w, height: h }));
  if (polygonArea(outline) < 0) outline = outline.slice().reverse();
  let inner = def.textArea ? pts(def.textArea({ ...sctx, rng: new Rng(seed ^ 0x51) }, params, { width: w, height: h })) : outline.map((q) => ({ x: q.x * 0.7, y: q.y * 0.7 }));
  if (polygonArea(inner) < 0) inner = inner.slice().reverse();
  return { contour: { pts: outline, closed: true, smooth: true }, inner, kind, smooth: true, ruler: !!def.ruler };
}

/** Plan a balloon: layout text & fit body (no position yet). */
export function planBalloon(el: RElement, ctx: ElemCtx): BalloonPlan {
  return planBalloonWithFit(el, ctx);
}

function planBalloonWithFit(el: RElement, ctx: ElemCtx, fallback?: { lineEm: number; depth?: number }): BalloonPlan {
  const p = el.props;
  const u = ctx.u;
  const rng = new Rng(el.seed);
  const hand = resolveHand(p.hand, u, ctx.draft);
  const params = shapeParams(p, rng, hand, u);
  if (fallback?.depth !== undefined) params.depth = fallback.depth;
  if (fallback && (params.count === undefined || params.count === "auto")) params.count = 40;
  if (fallback) params.compactCore = true;
  if (!BODY_GENERATORS[params.kind] && !activePlugins()?.shapes.has(params.kind)) ctx.bag.error("SCHEMA_ENUM", `unknown balloon shape "${params.kind}"`, { path: [...el.path, "shape"] });
  const shapeSeed = rng.nextU32();
  const text = textValue(p.text, ctx.lang, ctx.defaultLang, () => ctx.bag.warn("TEXT_MISSING_TRANSLATION", `no "${ctx.lang}" text`, { path: el.path, elementId: el.id }));
  const fill = parsePaint(p.fill ?? "paper", { u, box: { x: 0, y: 0, w: 10, h: 10 }, seed: el.seed, bag: ctx.bag, path: [...el.path, "fill"] });
  const lum = paintAvgLuminance(fill);
  const textColor = (p.color as string) ?? (lum < 0.5 ? "white" : "black");
  const minFontScale = typeof p.minFontScale === "number" ? p.minFontScale : 0.75;
  const fixedSize = Array.isArray(p.size) ? p.size : undefined;
  const pc = { u, coordsBox: ctx.coordsBox, refs: ctx.refs, bag: ctx.bag, path: el.path };
  const maxSz = Array.isArray(p.maxSize) ? p.maxSize : ["70%", "70%"];
  const maxW = sizeValue(maxSz[0], ctx.coordsBox.w, pc);
  const maxH = sizeValue(maxSz[1], ctx.coordsBox.h, pc);
  const ellipse = params.kind === "ellipse" || params.kind === "flash";
  const minSz = Array.isArray(p.minSize) ? p.minSize : ellipse ? ["auto", "auto"] : ["8bmm", "8bmm"];
  const minW = sizeValue(minSz[0], ctx.coordsBox.w, pc);
  const minH = sizeValue(minSz[1], ctx.coordsBox.h, pc);
  const overflow = (p.overflow as string) ?? (fixedSize ? "shrink" : "grow");
  const strokeW = resolveStroke(p.stroke, hand, u).width;
  const margin = hand.wobbleAmp + strokeW * 0.6 + 0.15 * u.k;
  const kind = params.kind === "flash" ? "ellipse" : params.kind;

  let scale = 1;
  let constrainAuto = p.as === "aside";
  for (let attempt = 0; attempt < 12; attempt++) {
    const style = resolveTextStyle({ ...p, fontScale: ((p.fontScale as number) ?? 1) * scale }, u, ctx.lang, true, el.seed);
    if (kind === "electronic") params.toothPitch = Math.max(style.fontSize / 2, 0.3 * u.k);
    const emCtx = { ...u, em: style.fontSize };
    const pad = Array.isArray(p.padding) ? p.padding : ["0.45em", "0.9em"];
    let padV = toMm(pad[0] as string, emCtx);
    let padH = toMm(pad[1] as string, emCtx);
    if (fallback && (el.builtinProps?.includes("padding") ?? p.padding === undefined)) {
      padV = Math.min(padV, style.fontSize * 0.2);
      padH = Math.min(padH, style.fontSize * 0.4);
    }
    let boxLimit: number | undefined;
    let fixedBase: { w: number; h: number } | undefined;
    if (fixedSize) {
      const fw = sizeValue(fixedSize[0], ctx.coordsBox.w, pc);
      const fh = sizeValue(fixedSize[1], ctx.coordsBox.h, pc);
      if (fw !== "auto" && fh !== "auto") {
        const probe = genBody(kind, fw, fh, params, shapeSeed);
        const ob = boundsOf(probe.contour.pts);
        fixedBase = { w: fw * (fw / ob.w), h: fh * (fh / ob.h) };
        const ib = boundsOf(genBody(kind, fixedBase.w, fixedBase.h, params, shapeSeed).inner);
        boxLimit = (style.writing === "vertical" ? ib.h * 0.86 : ib.w * 0.86) - 2 * (style.writing === "vertical" ? padV : padH);
      }
    }
    if (!fixedBase && constrainAuto) {
      // keep auto-sized balloons within maxSize: wrap before the line outgrows it (organic bodies lose ~30% to curvature)
      const mx = style.writing === "vertical" ? maxH : maxW;
      const lim = mx === "auto" ? Infinity : mx * 0.72 - 2 * (style.writing === "vertical" ? padV : padH) - 2 * margin;
      if (isFinite(lim)) boxLimit = Math.min(boxLimit ?? Infinity, Math.max(lim, style.fontSize * 4.5));
    }
    if (fallback) boxLimit = Math.min(boxLimit ?? Infinity, style.fontSize * fallback.lineEm + 1e-6);
    let tl = layoutText(text, style, ctx.fonts, boxLimit);
    if (p.as === "aside") {
      const pts = tl.glyphs.flatMap(g => flattenPath(g.path).flatMap(q => q.pts));
      if (pts.length) {
        const b = boundsOf(pts);
        tl = { ...tl, width: b.w, height: b.h, glyphs: tl.glyphs.map(g => ({ ...g, path: transformPath(g.path, matTranslate(-b.x, -b.y)) })) };
      }
    }
    const compact = kind === "ellipse" && !fixedBase && tl.lines.length <= 1 && Math.max(tl.width, tl.height) <= style.fontSize * 3.5;
    if (compact && (el.builtinProps?.includes("padding") ?? p.padding === undefined)) {
      const inset = (extent: number) => Math.max(0, (extent / 2 + style.fontSize * 0.65) / Math.SQRT2 - extent / 2 - margin);
      padV = Math.min(padV, inset(tl.height));
      padH = Math.min(padH, inset(tl.width));
    }
    // a full block of text gets a balloon with a squarer core; a short word a round one
    if (kind === "ellipse" && !(isObj(p.shape) && (p.shape as Obj).squareness !== undefined)) {
      const lens = tl.lines.map((l) => l.length);
      const L = lens.length;
      const maxL = Math.max(1e-6, ...lens);
      const fill = lens.reduce((a, b) => a + b, 0) / (L * maxL);
      const elong = Math.max(tl.width, tl.height) / Math.max(1e-6, Math.min(tl.width, tl.height));
      params.squareness = Math.max(0, Math.min(0.3, 0.03 * (L - 1) + (fill - 0.7) * 0.1 + (elong > 2.5 ? 0.25 : 0)));
      if (compact) params.squareness = 0;
    }
    // points relative to text block center
    const cx = tl.width / 2;
    const cy = tl.height / 2;
    const pts: Vec[] = [];
    for (const ln of p.as === "aside" ? [{ rect: { x: 0, y: 0, w: tl.width, h: tl.height } }] : tl.lines) {
      const r = ln.rect;
      pts.push({ x: r.x - padH - cx, y: r.y - padV - cy }, { x: r.x + r.w + padH - cx, y: r.y - padV - cy }, { x: r.x + r.w + padH - cx, y: r.y + r.h + padV - cy }, { x: r.x - padH - cx, y: r.y + r.h + padV - cy });
    }
    if (!pts.length) pts.push({ x: -padH, y: -padV }, { x: padH, y: padV });
    // include ruby area (full block)
    pts.push({ x: tl.width / 2 + padH * 0.5 - 0, y: 0 });
    const withMargin = pts.map((q) => {
      const l = Math.hypot(q.x, q.y) || 1;
      return { x: q.x + (q.x / l) * margin, y: q.y + (q.y / l) * margin };
    });
    let base: { w: number; h: number };
    let body: BodyGeom;
    let fits = true;
    let centerOverride: Vec | null = null;
    if (fixedBase) {
      base = fixedBase;
      body = genBody(kind, base.w, base.h, params, shapeSeed);
      const ic = innerCenterOf(body);
      fits = withMargin.every((q) => pointInPolygon({ x: q.x + ic.x, y: q.y + ic.y }, body.inner));
    } else {
      let ar = (p.aspectRange as [number, number]) ?? [0.55, 1.8];
      const defaultAspectRange = el.builtinProps?.includes("aspectRange") ?? p.aspectRange === undefined;
      if (fallback && defaultAspectRange) ar = [1 / 3.5, 3.5];
      if (compact && defaultAspectRange) ar = [0.15, 6.7];
      // a box follows its text block; horizontal lines make wider balloons than vertical columns
      if (kind === "rect" || kind === "none") ar = [0.05, 20];
      else if (style.writing === "horizontal" && defaultAspectRange) ar = [ar[0], Math.max(ar[1], 2.6)];
      const fixedAspect = typeof p.aspect === "number" ? p.aspect : undefined;
      base = fitBody(kind, params, shapeSeed, withMargin, fixedAspect, ar, maxW, maxH);
      body = genBody(kind, base.w, base.h, params, shapeSeed);
      // balance text inside the organic contour, then tighten
      let ic = bestOffset(withMargin, body.inner, innerCenterOf(body), boundsOf(body.contour.pts));
      let lo = 0.78;
      let hi = 1;
      for (let it = 0; it < 7; it++) {
        const f = (lo + hi) / 2;
        const b2 = genBody(kind, base.w * f, base.h * f, params, shapeSeed);
        const ob2 = boundsOf(b2.contour.pts);
        const c2 = bestOffset(withMargin, b2.inner, innerCenterOf(b2), ob2);
        if (withMargin.every((q) => pointInPolygon({ x: q.x + c2.x, y: q.y + c2.y }, b2.inner))) hi = f;
        else lo = f;
      }
      if (hi < 1) {
        base = { w: base.w * hi, h: base.h * hi };
        body = genBody(kind, base.w, base.h, params, shapeSeed);
        ic = bestOffset(withMargin, body.inner, innerCenterOf(body), boundsOf(body.contour.pts));
      }
      // minimum size last, so tightening cannot undo it
      let ob = boundsOf(body.contour.pts);
      for (let it = 0; it < 3; it++) {
        const gw = minW !== "auto" && ob.w < minW ? minW / ob.w : 1;
        const gh = minH !== "auto" && ob.h < minH ? minH / ob.h : 1;
        if (gw <= 1 && gh <= 1) break;
        base = { w: base.w * gw, h: base.h * gh };
        body = genBody(kind, base.w, base.h, params, shapeSeed);
        ob = boundsOf(body.contour.pts);
        ic = bestOffset(withMargin, body.inner, innerCenterOf(body), ob);
      }
      if ((maxW !== "auto" && ob.w > maxW + 0.01) || (maxH !== "auto" && ob.h > maxH + 0.01)) fits = false;
      centerOverride = ic;
    }
    if (!fits && !fixedBase && !constrainAuto) {
      constrainAuto = true;
      attempt--;
      continue;
    }
    if (!fits && overflow !== "grow" && scale > minFontScale + 1e-6 && overflow !== "clip" && overflow !== "error") {
      constrainAuto = false;
      scale = Math.max(minFontScale, scale - 0.05);
      continue;
    }
    if (!fits && overflow === "grow" && scale > minFontScale + 1e-6) {
      constrainAuto = false;
      scale = Math.max(minFontScale, scale - 0.05);
      continue;
    }
    if (!fits && !fallback && !fixedSize && p.overflow === undefined && (kind === "spike" || kind === "burst")) {
      const depths = params.depth === undefined ? [undefined, 0.22, 0.14] : [undefined];
      let best: { plan: BalloonPlan; bag: DiagnosticBag } | undefined;
      for (const depth of depths) for (const lineEm of [3, 2, 1]) {
        const bag = new DiagnosticBag();
        const candidate = planBalloonWithFit(el, { ...ctx, bag }, { lineEm, depth });
        if ((maxW === "auto" || candidate.outer.w <= maxW + 0.01) && (maxH === "auto" || candidate.outer.h <= maxH + 0.01)) {
          if (!best || candidate.outer.w * candidate.outer.h < best.plan.outer.w * best.plan.outer.h) best = { plan: candidate, bag };
        }
      }
      if (best) {
        for (const diagnostic of best.bag.items) ctx.bag.add(diagnostic);
        return best.plan;
      }
    }
    if (!fits) {
      if (overflow === "grow") ctx.bag.warn("BALLOON_TOO_LARGE", `balloon ${el.id} exceeds maxSize`, { path: el.path, elementId: el.id });
      else if (overflow === "error") ctx.bag.error("TEXT_OVERFLOW", `text does not fit in balloon ${el.id}`, { path: el.path, elementId: el.id });
      else ctx.bag.warn("TEXT_OVERFLOW", `text in balloon ${el.id} does not fit even at ${Math.round(scale * 100)}%`, { path: el.path, elementId: el.id });
    } else if (scale < 1) ctx.bag.info("TEXT_SHRUNK", `balloon ${el.id}: font scaled to ${Math.round(scale * 100)}%`, { path: el.path, elementId: el.id });
    if (tl.missing.length) ctx.bag.warn("FONT_MISSING_GLYPH", `missing glyphs: ${[...new Set(tl.missing)].join("")}`, { path: el.path, elementId: el.id });
    for (const e of tl.errors) ctx.bag.error(e.code, e.message, { path: [...el.path, "text"], elementId: el.id });
    for (const e of tl.infos) ctx.bag.add({ code: e.code, message: e.message, severity: e.severity ?? "info", path: [...el.path, "text"], elementId: el.id });
    const outer = boundsOf(body.contour.pts);
    const to = Array.isArray(p.textOffset) ? { x: toMm(p.textOffset[0] as string, u), y: toMm(p.textOffset[1] as string, u) } : { x: 0, y: 0 };
    return { el, text: tl, textColor, params, seed: shapeSeed, base, body, outer, explicit: p.at !== undefined || p.place !== undefined, fill, hand, innerCenter: centerOverride ?? innerCenterOf(body), props: p, textOffset: to, fontScaleApplied: scale };
  }
  throw new Error("unreachable");
}

function signedDist(q: Vec, poly: Vec[]): number {
  const d = distToPolyline(q, poly, true);
  return pointInPolygon(q, poly) ? d : -d;
}

/** offset maximizing the minimum clearance of points inside poly */
function bestOffset(pts: Vec[], poly: Vec[], start: Vec, ob: Rect): Vec {
  let best = start;
  let bestScore = -Infinity;
  const score = (c: Vec) => {
    let m = Infinity;
    for (const q of pts) {
      const s = signedDist({ x: q.x + c.x, y: q.y + c.y }, poly);
      if (s < m) m = s;
    }
    return m;
  };
  let span = Math.max(ob.w, ob.h) * 0.12;
  for (let pass = 0; pass < 3; pass++) {
    const c0 = best;
    for (let i = -3; i <= 3; i++)
      for (let j = -3; j <= 3; j++) {
        const c = { x: c0.x + (i / 3) * span, y: c0.y + (j / 3) * span };
        const s = score(c);
        if (s > bestScore + 1e-9) {
          bestScore = s;
          best = c;
        }
      }
    span /= 3;
  }
  return best;
}

function innerCenterOf(body: BodyGeom): Vec {
  const b = boundsOf(body.inner);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function fitBody(kind: string, params: ShapeParams, seed: number, pts: Vec[], fixedAspect: number | undefined, ar: [number, number], maxW: number | "auto", maxH: number | "auto"): { w: number; h: number } {
  const ext = pts.reduce((m, q) => Math.max(m, Math.abs(q.x), Math.abs(q.y)), 1);
  const fitsAt = (w: number, h: number) => {
    const b = genBody(kind, w, h, params, seed);
    const ic = innerCenterOf(b);
    for (const q of pts) if (!pointInPolygon({ x: q.x + ic.x, y: q.y + ic.y }, b.inner)) return false;
    return true;
  };
  const minScale = (r: number) => {
    let lo = ext * 0.5;
    let hi = ext * 8;
    if (!fitsAt(hi * r, hi)) return hi * 2;
    for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2;
      if (fitsAt(m * r, m)) hi = m;
      else lo = m;
    }
    return hi;
  };
  if (fixedAspect) {
    const s = minScale(fixedAspect);
    return { w: s * fixedAspect, h: s };
  }
  // golden-section search on log aspect minimizing area
  let a = Math.log(ar[0]);
  let b = Math.log(ar[1]);
  const gr = (Math.sqrt(5) - 1) / 2;
  const area = (lr: number) => {
    const r = Math.exp(lr);
    const s = minScale(r);
    const ob = boundsOf(genBody(kind, s * r, s, params, seed).contour.pts);
    const excess = Math.max(1, maxW === "auto" ? 1 : ob.w / maxW, maxH === "auto" ? 1 : ob.h / maxH);
    const footprint = s * s * r;
    // Feasible contours rank below 1, then by area; oversized contours rank by excess.
    return excess > 1 ? excess : footprint / (1 + footprint);
  };
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = area(c);
  let fd = area(d);
  for (let i = 0; i < 14; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = area(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = area(d);
    }
  }
  const r = Math.exp((a + b) / 2);
  const s = minScale(r);
  return { w: s * r, h: s };
}

// ---- tails --------------------------------------------------------------------

interface TailCtx {
  ctx: ElemCtx;
  plan: BalloonPlan;
  center: Vec;
  rng: Rng;
}

function balloonTails(props: Obj): Obj[] {
  return Array.isArray(props.tails) ? (props.tails as Obj[]) : isObj(props.tail) ? [props.tail as Obj] : [];
}

function offscreenTailSide(tail: Obj, props: Obj): string | undefined {
  return tail.kind === "none" ? undefined : (tail.offscreen as string | undefined) ?? (props.as === "offscreen" ? "nearest" : undefined);
}

export function hasOffscreenTail(props: Obj): boolean {
  return balloonTails(props).some((tail) => offscreenTailSide(tail, props) !== undefined);
}

function arcLengths(pts: Vec[]): number[] {
  const s = [0];
  for (let i = 1; i <= pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i % pts.length].x - pts[i - 1].x, pts[i % pts.length].y - pts[i - 1].y));
  return s;
}

/** the outline point at least `half` (straight-line) away from `at`, walking backward (dir -1) or forward */
function pointAtChord(pts: Vec[], s: number[], at: number, half: number, dir: 1 | -1): { p: Vec; i: number } {
  const P = s[s.length - 1];
  const o = pointAtArc(pts, s, at).p;
  const step = Math.max(1e-3, half / 24);
  let q = pointAtArc(pts, s, at + dir * half);
  // a spiky outline packs much arc into little width: walk on until the chord is wide enough
  for (let d = half; d < P * 0.45; d += step) {
    q = pointAtArc(pts, s, at + dir * d);
    if (Math.hypot(q.p.x - o.x, q.p.y - o.y) >= half) break;
  }
  return q;
}

function pointAtArc(pts: Vec[], s: number[], at: number): { p: Vec; i: number } {
  const P = s[s.length - 1];
  at = ((at % P) + P) % P;
  let lo = 0;
  let hi = pts.length;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (s[m] <= at) lo = m;
    else hi = m;
  }
  const a = pts[lo];
  const b = pts[(lo + 1) % pts.length];
  const t = (at - s[lo]) / (s[lo + 1] - s[lo] || 1);
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, i: lo };
}

interface TailResult {
  contour?: ShapeContour; // spliced body contour (page coords)
  extra: { pts: Vec[]; closed: boolean; kind: "bubble" | "line" }[];
  footprints: { pts: Vec[]; closed: boolean }[];
  rootAngle?: number;
  length?: number;
}

/** distance along ray to entering a rect (null if missed) */
/** distance along the ray to the ellipse inscribed in `r`; 0 when the origin is already inside */
function rayEllipseEntry(o: Vec, d: Vec, r: Rect): number | null {
  const a = r.w / 2;
  const b = r.h / 2;
  const px = (o.x - (r.x + a)) / a;
  const py = (o.y - (r.y + b)) / b;
  const dx = d.x / a;
  const dy = d.y / b;
  const A = dx * dx + dy * dy;
  const B = 2 * (px * dx + py * dy);
  const C = px * px + py * py - 1;
  if (C <= 0) return 0;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return null;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t > 0 ? t : null;
}

function nearestSide(c: Vec, b: Rect): string {
  const d = { left: c.x - b.x, right: b.x + b.w - c.x, top: c.y - b.y, bottom: b.y + b.h - c.y };
  return (Object.entries(d).sort((x, y) => x[1] - y[1])[0] ?? ["right"])[0];
}

function quad(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** the face box if the tail target lies on it (the box grown by 30 %), else undefined */
function faceOf(face: Rect | undefined, target: Vec): Rect | undefined {
  if (!face) return undefined;
  const mx = face.w * 0.3;
  const my = face.h * 0.3;
  return target.x >= face.x - mx && target.x <= face.x + face.w + mx && target.y >= face.y - my && target.y <= face.y + face.h + my ? face : undefined;
}

function applyTails(contour: ShapeContour, tails: Obj[], tc: TailCtx): TailResult {
  let cur = contour;
  const extra: TailResult["extra"] = [];
  const footprints: TailResult["footprints"] = [];
  const { plan, ctx } = tc;
  const stroke = resolveStroke(plan.props.stroke, plan.hand, ctx.u);
  const clearance = 0.35 * ctx.u.k + stroke.width / 2;
  const obstacles = (plan.tailObstacles ?? []).map(b => ({ ...b, contour: offsetPolygon(b.contour, clearance) }));
  const score = (r: TailResult) => {
    const hits = new Map<string, number>();
    const ring = (pts: Vec[]) => [pts.map(p => [p.x, p.y] as [number, number])];
    const footprints = r.footprints.map(f => {
      if (f.closed) return [ring(f.pts)];
      const [first, ...rest] = lineFootprint(f.pts, Math.max(stroke.width * 1.1 / 2, 0.01 * ctx.u.k)).map(ring);
      return first ? polygonClipping.union(first, ...rest) : [];
    });
    for (const b of obstacles) {
      let area = 0;
      for (const footprint of footprints) {
        if (!footprint.length) continue;
        const intersection = polygonClipping.intersection(footprint, ring(b.contour));
        for (const polygon of intersection) for (const [i, points] of polygon.entries()) area += (i ? -1 : 1) * Math.abs(polygonArea(points.map(([x, y]) => ({ x, y }))));
      }
      if (area > 1e-8) hits.set(b.id, area);
    }
    return { hits, area: [...hits.values()].reduce((a, b) => a + b, 0) };
  };
  for (const [index, tail] of tails.entries()) {
    const start = Object.assign(Object.create(Rng.prototype) as Rng, tc.rng);
    const initial = makeTails(cur, [tail], tc);
    let best = initial;
    let bestScore = score(initial);
    let bestRng = Object.assign(Object.create(Rng.prototype) as Rng, tc.rng);
    if (bestScore.area > 0) {
      const explicit = plan.el.tailExplicit;
      const own = explicit ? balloonTails(explicit)[index] ?? {} : tail;
      const roots: Obj[] = [{}];
      if (own.root === undefined || own.root === "auto") {
        for (const degrees of [15, -15, 30, -30, 45, -45, 60, -60]) roots.push({ root: `${((initial.rootAngle ?? 0) * 180 / Math.PI + degrees).toFixed(10)}deg` });
      }
      const candidates = roots.slice(1);
      if (own.curl === undefined && (tail.kind === undefined || tail.kind === "wedge")) for (const root of roots) for (const curl of [false, true]) candidates.push({ ...root, curl });
      if (own.bend === undefined) for (const root of roots) for (const bend of [-0.3, 0.3, -0.5, 0.5]) candidates.push({ ...root, bend, ...(own.curl === undefined ? { curl: false } : {}) });
      if (own.length === undefined && initial.length !== undefined) {
        const minimum = Math.min(initial.length, 2 * ctx.u.k);
        for (const factor of [0.75, 0.5, 0.25, 0]) for (const root of roots) candidates.push({ ...root, length: `${Math.max(minimum, initial.length * factor)}mm` });
      }
      for (const changes of candidates) {
        const rng = Object.assign(Object.create(Rng.prototype) as Rng, start);
        const candidate = makeTails(cur, [{ ...tail, ...changes }], { ...tc, rng, ctx: { ...ctx, bag: new DiagnosticBag() } });
        const cost = score(candidate);
        if (candidate.footprints.length && cost.area === 0) { best = candidate; bestScore = cost; bestRng = rng; }
        if (bestScore.area === 0) break;
      }
      Object.assign(tc.rng, bestRng);
      for (const id of bestScore.hits.keys()) ctx.bag.warn("BALLOON_TAIL_CROSSES", `the tail of ${plan.el.id} crosses ${id}`, { path: plan.el.path, elementId: plan.el.id });
    }
    cur = best.contour ?? cur;
    extra.push(...best.extra);
    footprints.push(...best.footprints);
  }
  return { contour: cur, extra, footprints };
}

function lineFootprint(pts: Vec[], radius: number): Vec[][] {
  const out: Vec[][] = [];
  for (const [i, p] of pts.entries()) {
    out.push(Array.from({ length: 16 }, (_, j) => ({ x: p.x + radius * Math.cos(j * Math.PI / 8), y: p.y + radius * Math.sin(j * Math.PI / 8) })));
    if (!i) continue;
    const a = pts[i - 1];
    const length = Math.hypot(p.x - a.x, p.y - a.y) || 1;
    const nx = -(p.y - a.y) / length * radius;
    const ny = (p.x - a.x) / length * radius;
    out.push([{ x: a.x + nx, y: a.y + ny }, { x: p.x + nx, y: p.y + ny }, { x: p.x - nx, y: p.y - ny }, { x: a.x - nx, y: a.y - ny }]);
  }
  return out;
}

function makeTails(contour: ShapeContour, tails: Obj[], tc: TailCtx): TailResult {
  const { ctx, plan, center } = tc;
  const u = ctx.u;
  let cur: ShapeContour = { ...contour, pts: contour.pts.slice(), corners: contour.corners?.slice() };
  const extra: TailResult["extra"] = [];
  const footprints: TailResult["footprints"] = [];
  let rootAngle: number | undefined;
  let tailLength: number | undefined;
  const minSide = Math.min(plan.outer.w, plan.outer.h);
  const pc = { u, coordsBox: ctx.coordsBox, refs: ctx.refs, panelId: ctx.panel?.panel.id, bag: ctx.bag, path: plan.el.path };
  for (const t of tails) {
    const kind = (t.kind as string) ?? "wedge";
    if (kind === "none") continue;
    if (plan.params.kind === "none" && kind !== "line") {
      ctx.bag.warn("BALLOON_TAIL_UNSUPPORTED", `shape "none" supports only line tails`, { path: plan.el.path, elementId: plan.el.id });
      continue;
    }
    // target
    let target: Vec | null = null;
    const who = plan.props.who as string | undefined;
    // `as: offscreen` without a side: the speaker is beyond the nearest panel edge
    const side = offscreenTailSide(t, plan.props);
    const offSide = side === "nearest" ? nearestSide(center, ctx.panel?.box ?? ctx.coordsBox) : side;
    const offscreenOvershoot = 4 * u.k;
    if (offSide) {
      const pb = ctx.panel ? ctx.panel.box : ctx.coordsBox;
      const ext = offscreenOvershoot;
      target = offSide === "right" ? { x: pb.x + pb.w + ext, y: center.y + (pb.y + pb.h / 2 - center.y) * 0.3 } : offSide === "left" ? { x: pb.x - ext, y: center.y } : offSide === "top" ? { x: center.x, y: pb.y - ext } : { x: center.x, y: pb.y + pb.h + ext };
    } else if (t.to !== undefined) target = resolvePoint(t.to, pc);
    else if (who) {
      target = ctx.refs.point(who, ctx.panel?.panel.id);
      if (!target) ctx.bag.info("DIALOGUE_SPEAKER_NOT_IN_PANEL", `speaker "${who}" has no image in this panel`, { path: plan.el.path, elementId: plan.el.id });
    }
    let dir: Vec;
    if (target) {
      const d = { x: target.x - center.x, y: target.y - center.y };
      const l = Math.hypot(d.x, d.y) || 1;
      dir = { x: d.x / l, y: d.y / l };
    } else {
      const a = parseAngle((t.direction as string) ?? "100deg");
      dir = { x: Math.cos(a), y: Math.sin(a) };
    }
    // manga tails leave the side of the balloon: one aimed (nearly) straight down or up is turned
    // to the lower/upper left or right, by default toward the left
    let clamped = false;
    if (t.allowVertical !== true && !offSide && plan.params.kind !== "cloud") {
      const a = Math.atan2(dir.y, dir.x);
      const lim = (40 * Math.PI) / 180;
      const fromDown = Math.abs(a - Math.PI / 2);
      const fromUp = Math.abs(a + Math.PI / 2);
      if (fromDown < lim || fromUp < lim) {
        const down = fromDown < lim;
        const left = dir.x <= Math.sin(lim) * 0.25;
        const na = down ? (left ? Math.PI / 2 + lim : Math.PI / 2 - lim) : left ? -Math.PI / 2 - lim : -Math.PI / 2 + lim;
        dir = { x: Math.cos(na), y: Math.sin(na) };
        clamped = true;
      }
    }
    // root picks where the tail leaves the body; the tip still heads for the target / direction
    let rootDir = dir;
    if (t.root !== undefined && t.root !== "auto") {
      const a = parseAngle(t.root as string);
      rootDir = { x: Math.cos(a), y: Math.sin(a) };
    }
    const hit = rayPolygon(center, rootDir, cur.pts);
    if (!hit) continue;
    const R = { x: center.x + rootDir.x * hit.t, y: center.y + rootDir.y * hit.t };
    rootAngle = Math.atan2(rootDir.y, rootDir.x);
    if (rootDir !== dir && target && !clamped) {
      const d2 = { x: target.x - R.x, y: target.y - R.y };
      const l2 = Math.hypot(d2.x, d2.y) || 1;
      dir = { x: d2.x / l2, y: d2.y / l2 };
    }
    if (target && pointInPolygon(target, cur.pts)) {
      ctx.bag.warn("BALLOON_TAIL_TARGET_INSIDE", `tail target of ${plan.el.id} is inside the balloon`, { path: plan.el.path, elementId: plan.el.id });
      continue;
    }
    const gap = t.gap !== undefined ? toMm(t.gap as string, u) : 2 * u.k;
    const whisperWedge = plan.props.as === "whisper" && kind === "wedge";
    const maxLen = t.maxLength !== undefined ? toMm(t.maxLength as string, u) : Math.min(9 * u.k, Math.max((whisperWedge ? 6 : 4.5) * u.k, minSide * 0.4));
    let length: number;
    if (t.length !== undefined) length = toMm(t.length as string, u);
    else if (offSide && target) length = Math.min(maxLen, Math.hypot(target.x - R.x, target.y - R.y));
    else if (target) {
      const dist = Math.hypot(target.x - R.x, target.y - R.y);
      let avail = dist - gap;
      let stopped = false;
      // do not run into the speaker's face
      const tgtRef = typeof t.to === "string" ? ctx.refs.target(t.to, ctx.panel?.panel.id) : who ? ctx.refs.target(who, ctx.panel?.panel.id) : undefined;
      // the face region is the speaker's only when the target lies on it (an image may also carry
      // anchors for other characters: `close.hayato`)
      const face = faceOf(tgtRef?.regions.face?.bbox, target);
      if (face) {
        const tf = rayEllipseEntry(R, dir, face);
        if (tf !== null) {
          avail = Math.min(avail, tf - gap * 0.5);
          stopped = true;
        }
      }
      // nor into the speaker's figure: the tip stops just short of the art's silhouette
      const sil = tgtRef ? ctx.silhouettes?.find((q) => q.id === tgtRef.id) : undefined;
      if (sil && !face) {
        const step = 0.25 * u.k;
        for (let d = step; d < avail; d += step)
          if (silhouetteHit(sil, { x: R.x + dir.x * d, y: R.y + dir.y * d })) {
            avail = Math.min(avail, d - 0.5 * u.k);
            stopped = true;
            break;
          }
      }
      // a bare point (a mouth or face anchor, no face region to stop at) is the middle of the face:
      // the tail points at it from at most halfway so it never reaches into the face
      if (!stopped) avail = Math.min(avail, dist * 0.5);
      // a tail always reads as a pointer, even when the speaker's face is right beside the body
      length = Math.min(maxLen, Math.max(4.5 * u.k, avail));
    } else length = (kind === "zigzag" ? 11 : 4.5) * u.k;
    if (whisperWedge && !target && !offSide && t.length === undefined) length = Math.min(maxLen, Math.max(length, 6 * u.k));
    // on a spiky body the tail must outreach the spikes to read as the pointer
    if (!offSide && t.length === undefined && (plan.params.kind === "spike" || plan.params.kind === "burst")) length = Math.max(length * 1.15, 6 * u.k);
    tailLength = length;
    const widthScale = typeof t.widthScale === "number" ? t.widthScale : 1;
    // a lightning-bolt tail is a narrower band than a wedge
    // a wedge's base is about a sixth of the body
    const bw0 = Math.min(2.8 * u.k, Math.max(1.6 * u.k, minSide * 0.13));
    const bwAuto = kind === "zigzag" ? bw0 * 1.5 : offSide ? bw0 : whisperWedge ? minSide / 6 : Math.max(bw0, Math.min(minSide / 6, length * 0.6));
    const bw = (t.width !== undefined ? toMm(t.width as string, u) : bwAuto) * widthScale;
    // on a spiky body the tail is one more, larger spike of the outline (the shout/scream presets
    // also set bend/sideCurve 0 for straight sides)
    const spiky = plan.params.kind === "spike" || plan.params.kind === "burst";
    const bend = typeof t.bend === "number" ? t.bend : 0.1;
    const sideCurve = typeof t.sideCurve === "number" ? t.sideCurve : 0.12;
    const perp = { x: -dir.y, y: dir.x };
    let tip = { x: R.x + dir.x * length, y: R.y + dir.y * length };
    // a tail with a speaker curls toward the face: its centre line is a circular arc whose centre
    // lies on the face's side, leaving the body along `dir` and turning toward the face
    let arcFn: ((tt: number) => Vec) | null = null;
    if (kind === "wedge" && !offSide && (t.curl === true || (t.curl !== false && !spiky)) && target) {
      const ref = typeof t.to === "string" ? ctx.refs.target(t.to, ctx.panel?.panel.id) : who ? ctx.refs.target(who, ctx.panel?.panel.id) : undefined;
      const fb = faceOf(ref?.regions.face?.bbox, target);
      const F = fb ? { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 } : target;
      const toF = { x: F.x - R.x, y: F.y - R.y };
      const ang = Math.atan2(dir.x * toF.y - dir.y * toF.x, dir.x * toF.x + dir.y * toF.y);
      const turn = Math.max(-1.0, Math.min(1.0, ang * 0.85));
      if (Math.abs(turn) > 0.03) {
        const sgn = Math.sign(turn);
        const r = length / Math.abs(turn);
        const C = { x: R.x - dir.y * sgn * r, y: R.y + dir.x * sgn * r };
        const v0 = { x: R.x - C.x, y: R.y - C.y };
        arcFn = (tt: number) => {
          const a = sgn * Math.abs(turn) * tt;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          return { x: C.x + v0.x * ca - v0.y * sa, y: C.y + v0.x * sa + v0.y * ca };
        };
        tip = arcFn(1);
      }
    }
    const ctrl = { x: (R.x + tip.x) / 2 + perp.x * bend * length * 0.5, y: (R.y + tip.y) / 2 + perp.y * bend * length * 0.5 };
    const tipBent = { x: tip.x + perp.x * bend * length * 0.25, y: tip.y + perp.y * bend * length * 0.25 };
    const frameAxis = offSide === "left" || offSide === "right" ? "x" : "y";
    const frameSign = offSide === "left" || offSide === "top" ? -1 : 1;
    const frameCut = offSide && target && t.length === undefined && (tipBent[frameAxis] - target[frameAxis]) * frameSign > -offscreenOvershoot;

    if (kind === "bubbles") {
      const count = typeof t.count === "number" ? t.count : 3;
      let size = t.bubbleSize !== undefined ? toMm(t.bubbleSize as string, u) : Math.min(5 * u.k, Math.max(1.5 * u.k, minSide * 0.2));
      const shrink = typeof t.shrink === "number" ? t.shrink : 0.62;
      // the bubble chain must stop short of the speaker (face): scale it down to the available run
      let spacing = 0.45;
      if (target && t.length === undefined) {
        const spanOf = (sp: number, sz0: number) => {
          let span = gap * 0.6;
          let sz = sz0;
          for (let i = 0; i < count; i++) {
            span += sz + (i + 1 < count ? sz * sp : 0);
            sz *= shrink;
          }
          return span;
        };
        // a short run tightens the chain first, then shrinks it, but keeps all bubbles readable
        if (spanOf(spacing, size) > length) spacing = 0.15;
        const span = spanOf(spacing, size);
        if (span > length) size = Math.max(1.4 * u.k, size * Math.max(0.5, length / span));
      }
      let dpos = gap * 0.6 + size / 2;
      const total = target ? length : length + size;
      // an explicit length spreads the chain evenly over it
      const spread = t.length !== undefined && count > 1 ? Math.max(0, (length - dpos) / (count - 1)) : 0;
      for (let i = 0; i < count; i++) {
        if (!spread && dpos + size / 2 > total + 1e-6 && i > 1) break;
        if (spread) dpos = gap * 0.6 + size / 2 + 0 + i * spread;
        const tt = Math.min(1, dpos / Math.max(1e-6, total));
        const c = quad(R, ctrl, tipBent, tt);
        const r = size / 2;
        const pts = blobPoly(c, r, tc.rng, 28, 0.06).map((q) => ({ x: c.x + (q.x - c.x) * 1, y: c.y + (q.y - c.y) * 0.88 }));
        extra.push({ pts, closed: true, kind: "bubble" });
        footprints.push({ pts, closed: true });
        if (spread) {
          size *= shrink;
          continue;
        }
        dpos += size / 2 + size * spacing;
        size *= shrink;
        dpos += size / 2;
      }
      continue;
    }
    if (kind === "line") {
      const pts: Vec[] = [];
      for (let i = 0; i <= 20; i++) pts.push(quad(R, ctrl, tipBent, i / 20));
      extra.push({ pts, closed: false, kind: "line" });
      footprints.push({ pts, closed: false });
      continue;
    }
    // wedge / zigzag: splice into contour
    const s = arcLengths(cur.pts);
    const sR = s[hit.index] + hit.u * (s[hit.index + 1] - s[hit.index]);
    let A = pointAtChord(cur.pts, s, sR, bw / 2, -1);
    let B = pointAtChord(cur.pts, s, sR, bw / 2, 1);
    if (spiky && kind === "wedge" && !offSide && t.width === undefined) {
      const cap = minSide / 6;
      const valleys = (cur.corners ?? []).filter((c) => c.kind === "valley");
      if (valleys.length > 1) {
        const P = s[s.length - 1];
        const before = valleys.reduce((a, b) => (sR - s[a.index] + P) % P < (sR - s[b.index] + P) % P ? a : b);
        const after = valleys.reduce((a, b) => ((s[a.index] - sR + P) % P || P) < ((s[b.index] - sR + P) % P || P) ? a : b);
        const left = s[before.index];
        let right = s[after.index];
        if (right <= left) right += P;
        const peak = (cur.corners ?? []).find((c) => c.kind === "tip" && (s[c.index] - left + P) % P < right - left);
        if (peak) {
          const apex = left + (s[peak.index] - left + P) % P;
          A = pointAtArc(cur.pts, s, left);
          B = pointAtArc(cur.pts, s, right);
          if (Math.hypot(B.p.x - A.p.x, B.p.y - A.p.y) > Math.min(cap, bw)) {
            let lo = 0;
            let hi = 1;
            for (let k = 0; k < 40; k++) {
              const f = (lo + hi) / 2;
              const a = pointAtArc(cur.pts, s, left + (apex - left) * f);
              const b = pointAtArc(cur.pts, s, right + (apex - right) * f);
              if (Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) > Math.min(cap, bw)) lo = f;
              else hi = f;
            }
            A = pointAtArc(cur.pts, s, left + (apex - left) * hi);
            B = pointAtArc(cur.pts, s, right + (apex - right) * hi);
          }
        }
      }
    }
    const sideA: Vec[] = [];
    const sideB: Vec[] = [];
    const N = Math.max(12, Math.ceil(length / (0.3 * u.k)));
    const zig = kind === "zigzag";
    const straightBolt = zig && plan.params.kind === "electronic";
    const segs = Math.max(2, typeof t.segments === "number" ? Math.round(t.segments) : 3);
    const zigV: Vec[] = [];
    if (zig) {
      const amp = Math.min(bw * 0.8, (length / segs) * 0.5);
      for (let k = 0; k <= segs; k++) {
        const tt = k / segs;
        const o = k === 0 || k === segs ? 0 : (k % 2 ? 1 : -1) * amp * (1 - tt * 0.4);
        zigV.push({ x: R.x + (tip.x - R.x) * tt + perp.x * o, y: R.y + (tip.y - R.y) * tt + perp.y * o });
      }
    }
    const steps = straightBolt ? segs : zig ? segs * Math.max(4, Math.ceil(N / segs)) : N;
    // outward normal at the root (from the body centre); a tail that runs along the outline is "slanted"
    const nl = Math.hypot(R.x - center.x, R.y - center.y) || 1;
    const nOut = { x: (R.x - center.x) / nl, y: (R.y - center.y) / nl };
    const straight = !zig && !offSide && bend === 0 && sideCurve === 0 && !arcFn;
    const slanted = !straight && !zig && !offSide && nOut.x * dir.x + nOut.y * dir.y < 0.55;
    const boltSign = Math.sign(dot(sub(A.p, B.p), perp)) || 1;
    const zigCorners: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const tt = i / steps;
      if (straightBolt) {
        // Both sides run directly from the same root opening to the first bend.
        if (i === 0) {
          sideA.push(A.p);
          sideB.push(B.p);
        } else {
          const mid = zigV[i];
          const half = bw * (1 - tt) / 2 * boltSign;
          sideA.push({ x: mid.x + perp.x * half, y: mid.y + perp.y * half });
          sideB.push({ x: mid.x - perp.x * half, y: mid.y - perp.y * half });
          if (i < steps) zigCorners.push(i);
        }
        continue;
      }
      if (straight) {
        sideA.push({ x: A.p.x + (tip.x - A.p.x) * tt, y: A.p.y + (tip.y - A.p.y) * tt });
        sideB.push({ x: B.p.x + (tip.x - B.p.x) * tt, y: B.p.y + (tip.y - B.p.y) * tt });
        continue;
      }
      let cl = arcFn ? arcFn(tt) : quad(R, ctrl, tipBent, tt);
      if (zig) {
        const pos = tt * segs;
        const k = Math.min(segs - 1, Math.floor(pos));
        const u = pos - k;
        cl = lerp(zigV[k], zigV[k + 1], u);
        if (i > 0 && i < steps && Math.abs(u) < 1e-9) zigCorners.push(i);
      }
      // automatic off-panel tails stay open where the frame cuts them
      const f = zig ? Math.max(0, 1 - tt) ** 1.15 : frameCut ? 1 - 0.65 * Math.pow(tt, 0.8) : Math.pow(1 - tt, 1 + sideCurve * 1.6);
      if (slanted) {
        // the tail leaves the outline at a slant: bow the centre line outward first, and keep
        // the width square to the local direction so it never collapses into a line
        const c0 = { x: R.x + nOut.x * length * 0.45 + dir.x * length * 0.2, y: R.y + nOut.y * length * 0.45 + dir.y * length * 0.2 };
        const cq = (x: number) => (arcFn ? arcFn(x) : quad(R, c0, tip, x));
        const q = cq(tt);
        const q2 = cq(Math.min(1, tt + 0.01));
        const q1 = cq(Math.max(0, tt - 0.01));
        const tg = { x: q2.x - q1.x, y: q2.y - q1.y };
        const tl2 = Math.hypot(tg.x, tg.y) || 1;
        let nn = { x: -tg.y / tl2, y: tg.x / tl2 };
        if (nn.x * (A.p.x - R.x) + nn.y * (A.p.y - R.y) < 0) nn = { x: -nn.x, y: -nn.y };
        const half = (bw / 2) * Math.pow(1 - tt, 1 + sideCurve);
        const w8 = Math.min(1, tt * 4);
        sideA.push({ x: A.p.x * (1 - w8) + (q.x + nn.x * half) * w8, y: A.p.y * (1 - w8) + (q.y + nn.y * half) * w8 });
        sideB.push({ x: B.p.x * (1 - w8) + (q.x - nn.x * half) * w8, y: B.p.y * (1 - w8) + (q.y - nn.y * half) * w8 });
        continue;
      }
      if (zig) {
        // the bolt keeps an even band square to the tail axis (blended from the root points)
        const sg = perp.x * (A.p.x - R.x) + perp.y * (A.p.y - R.y) < 0 ? -1 : 1;
        const half = (bw / 2) * f;
        const w8 = Math.min(1, tt * 5);
        sideA.push({ x: (cl.x + (A.p.x - R.x) * f) * (1 - w8) + (cl.x + perp.x * sg * half) * w8, y: (cl.y + (A.p.y - R.y) * f) * (1 - w8) + (cl.y + perp.y * sg * half) * w8 });
        sideB.push({ x: (cl.x + (B.p.x - R.x) * f) * (1 - w8) + (cl.x - perp.x * sg * half) * w8, y: (cl.y + (B.p.y - R.y) * f) * (1 - w8) + (cl.y - perp.y * sg * half) * w8 });
        continue;
      }
      sideA.push({ x: cl.x + (A.p.x - R.x) * f, y: cl.y + (A.p.y - R.y) * f });
      sideB.push({ x: cl.x + (B.p.x - R.x) * f, y: cl.y + (B.p.y - R.y) * f });
    }
    footprints.push({ pts: [...sideA, ...sideB.slice().reverse()], closed: true });
    // new contour: from B forward around to A, then A->tip, tip->B
    const n = cur.pts.length;
    const out: Vec[] = [B.p];
    const idxMap = new Map<number, number>();
    let i = (B.i + 1) % n;
    let guard = 0;
    while (guard++ < n + 2) {
      const prev = out[out.length - 1];
      if (Math.hypot(cur.pts[i].x - prev.x, cur.pts[i].y - prev.y) > 1e-9) out.push(cur.pts[i]);
      idxMap.set(i, out.length - 1);
      if (i === A.i) break;
      i = (i + 1) % n;
    }
    const last = out[out.length - 1];
    if (Math.hypot(A.p.x - last.x, A.p.y - last.y) > 1e-9) out.push(A.p);
    const aIndex = out.length - 1;
    for (let k = 1; k < sideA.length; k++) out.push(sideA[k]);
    const tipIndex = out.length - 1;
    const bStart = out.length;
    for (let k = sideB.length - 2; k >= 1; k--) out.push(sideB[k]);
    const corners = (cur.corners ?? []).filter((c) => idxMap.has(c.index)).map((c) => ({ index: idxMap.get(c.index)!, kind: c.kind })).filter((c) => c.index !== 0 && c.index !== aIndex);
    corners.push({ index: 0, kind: "concave" }, { index: aIndex, kind: "concave" }, { index: tipIndex, kind: "point" });
    for (const zc of zigCorners) {
      corners.push({ index: aIndex + zc, kind: "convex" });
      corners.push({ index: bStart + (sideB.length - 2 - zc), kind: "convex" });
    }
    const smoothBody = cur.smooth || !cur.corners;
    cur = { pts: out, closed: true, corners, smooth: false };
    void smoothBody;
  }
  return { contour: cur, extra, footprints, rootAngle, length: tailLength };
}

// ---- render -------------------------------------------------------------------

interface BodyBuild {
  contour: ShapeContour;
  extra: TailResult["extra"];
  stroke: ReturnType<typeof resolveStroke>;
  ruler: boolean;
  rng: Rng;
}

function buildBody(plan: BalloonPlan, ctx: ElemCtx, skipTails = false): BodyBuild {
  const el = plan.el;
  const p = plan.props;
  const center = plan.center!;
  const rng = new Rng(el.seed ^ 0x5bd1e995);
  // rotate: the body turns about its centre; tails are then aimed from the rotated outline
  const ra = p.rotate !== undefined ? parseAngle(p.rotate as string) : 0;
  const cr = Math.cos(ra);
  const sr = Math.sin(ra);
  const translate = (pts: Vec[]) => pts.map((q) => ({ x: q.x * cr - q.y * sr + center.x, y: q.x * sr + q.y * cr + center.y }));
  const body = plan.body;
  let contour: ShapeContour = { ...body.contour, pts: translate(body.contour.pts) };
  const tails = skipTails ? [] : balloonTails(p);
  let tailContour = contour;
  if (p.as === "aside" && plan.text.glyphs.length) {
    const pts = plan.text.glyphs.flatMap(g => flattenPath(g.path).flatMap(q => q.pts));
    if (pts.length) {
      const b = boundsOf(pts);
      const x = plan.innerCenter.x - plan.text.width / 2 + plan.textOffset.x + b.x;
      const y = plan.innerCenter.y - plan.text.height / 2 + plan.textOffset.y + b.y;
      tailContour = { pts: translate([{ x, y }, { x: x + b.w, y }, { x: x + b.w, y: y + b.h }, { x, y: y + b.h }]), closed: true };
    }
  }
  const tr = applyTails(tailContour, tails, { ctx, plan, center, rng });
  if (tr.contour && p.as !== "aside") contour = tr.contour;
  const stroke = resolveStroke(p.stroke, plan.hand, ctx.u, ctx.bag, [...el.path, "stroke"]);
  const ruler = !!(plan.params.ruler ?? body.ruler) && !contour.corners?.some((c) => c.kind === "tip" || c.kind === "point");
  return { contour, extra: tr.extra, stroke, ruler, rng };
}

export function balloonTailRegions(plan: BalloonPlan, ctx: ElemCtx): Vec[][] {
  const quiet = { ...ctx, bag: new DiagnosticBag() };
  const body = buildBody(plan, quiet, true);
  const tailed = buildBody(plan, quiet);
  const ring = (pts: Vec[]): polygonClipping.Ring => pts.map(p => [p.x, p.y]);
  const added = polygonClipping.difference([ring(tailed.contour.pts)], [ring(body.contour.pts)]);
  return [...added.flatMap(poly => poly.map(r => r.map(([x, y]) => ({ x, y })))), ...tailed.extra.map(e => e.pts)];
}

function balloonFill(poly: Vec[], plan: BalloonPlan): Node | null {
  const fill = fillNode(poly, plan.fill, tag(plan.el, "fill"));
  if (fill?.kind !== "path" || plan.fill?.type !== "tone") return fill;
  const paper: Node = { ...fill, paint: { type: "solid", color: WHITE } };
  return { kind: "group", children: [paper, fill], tag: fill.tag };
}

function inkBody(plan: BalloonPlan, bb: BodyBuild, ctx: ElemCtx, contour: ShapeContour): { nodes: Node[]; fill: Vec[] } {
  const el = plan.el;
  const nodes: Node[] = [];
  const t = tag(el, "ink");
  const isNone = plan.params.kind === "none";
  const isFlash = plan.params.kind === "flash";
  let fillPoly: Vec[] = contour.pts;
  if (!isNone) {
    const cleanJoin = bb.ruler || plan.body.kind === "electronic";
    const res = inkShape(contour, { line: isFlash ? { ...bb.stroke, style: "none" } : bb.stroke, hand: plan.hand, rng: bb.rng.fork("body"), ruler: bb.ruler, join: plan.params.join ?? (cleanJoin ? "clean" : "overshoot"), strokes: plan.params.strokes, sizeHint: Math.min(plan.outer.w, plan.outer.h) });
    fillPoly = res.fill;
    const fn = balloonFill(res.fill, plan);
    // a thin rim of the fill colour outside the outline keeps it readable over black art
    const halo = plan.props.halo === "none" || plan.props.halo === false ? 0 : plan.props.halo !== undefined ? toMm(plan.props.halo as string, ctx.u) : 0.3 * ctx.u.k;
    if (fn && halo > 0 && !isFlash && fn.kind === "path" && fn.paint?.type === "solid" && fn.paint.color.a > 0.99) nodes.push({ kind: "path", path: polyPath(res.fill, true), fillRule: "nonzero", paint: null, stroke: { width: bb.stroke.width + halo * 2, paint: fn.paint, join: "round" }, tag: tag(el, "fill") });
    if (fn) nodes.push(fn);
    if (isFlash) {
      const compact = plan.text.lines.length <= 1 && Math.max(plan.text.width, plan.text.height) <= plan.text.fontSize * 3.5 && !Array.isArray(plan.props.size);
      nodes.push(...flashLines(res.fill, plan.center!, ctx, bb.rng, el, compact ? plan.text.fontSize * 0.12 : Infinity));
    }
    nodes.push(...inksToNodes(res.inks, bb.stroke.color, t));
  }
  for (const ex of bb.extra) {
    if (ex.kind === "bubble") {
      const res = inkShape({ pts: ex.pts, closed: true, smooth: true }, { line: bb.stroke, hand: plan.hand, rng: bb.rng.fork("bub"), strokes: 1 });
      const fn = balloonFill(res.fill, plan);
      if (fn) nodes.push(fn);
      nodes.push(...inksToNodes(res.inks, bb.stroke.color, t));
    } else {
      const res = inkShape({ pts: ex.pts, closed: false, smooth: true }, { line: { ...bb.stroke, width: bb.stroke.width * 1.1 }, hand: plan.hand, rng: bb.rng.fork("lt") });
      nodes.push(...inksToNodes(res.inks, bb.stroke.color, t));
    }
  }
  return { nodes, fill: fillPoly };
}

function textNodes(plan: BalloonPlan, ctx: ElemCtx): Node[] {
  const ra = plan.props.rotate !== undefined ? parseAngle(plan.props.rotate as string) : 0;
  const nodes = textNodesFlat(plan, ctx);
  if (!ra) return nodes;
  const c = plan.center!;
  const cr = Math.cos(ra);
  const sr = Math.sin(ra);
  return [{ kind: "group", transform: [cr, sr, -sr, cr, c.x - cr * c.x + sr * c.y, c.y - sr * c.x - cr * c.y], children: nodes }];
}

function textNodesFlat(plan: BalloonPlan, ctx: ElemCtx): Node[] {
  const el = plan.el;
  const p = plan.props;
  const u = ctx.u;
  const center = plan.center!;
  const tl = plan.text;
  const ox = center.x + plan.innerCenter.x - tl.width / 2 + plan.textOffset.x;
  const oy = center.y + plan.innerCenter.y - tl.height / 2 + plan.textOffset.y;
  const color = parseColor(plan.textColor) ?? BLACK;
  const shift = (path: PathData): PathData => path.map((c) => (c[0] === "Z" ? c : (c.map((v, i) => (i === 0 ? v : i % 2 === 1 ? (v as number) + ox : (v as number) + oy)) as typeof c)));
  const glyphs = tl.glyphs.map((g) => shift(g.path));
  const textNode: Node = { kind: "path", path: glyphs.flat(), fillRule: "nonzero", paint: { type: "solid", color }, tag: tag(el, "text", "text") };
  const nodes: Node[] = [];
  const outlines = Array.isArray(p.textOutline) ? (p.textOutline as Obj[]) : [];
  const ow = outlines.map((o) => ({ w: toMm(o.width as string, u), c: parseColor((o.color as string) ?? "white") ?? WHITE })).sort((a, b) => b.w - a.w);
  for (const o of ow) nodes.push({ kind: "path", path: textNode.path, fillRule: "nonzero", paint: null, stroke: { width: o.w * 2, paint: { type: "solid", color: o.c }, join: "round" }, tag: tag(el, "text", "text") });
  nodes.push(...glyphNodes(p.as === "aside" ? tl.glyphs.map(g => ({ ...g, bold: true })) : tl.glyphs, shift, { type: "solid", color }, tl.fontSize, tag(el, "text", "text")));
  return nodes;
}

export function renderBalloon(plan: BalloonPlan, ctx: ElemCtx): { nodes: Node[]; bbox: Rect; contour: Vec[] } {
  const bb = buildBody(plan, ctx);
  const body = inkBody(plan, bb, ctx, bb.contour);
  let nodes: Node[] = [...body.nodes, ...textNodes(plan, ctx)];
  // offscreen tails are cut by the panel frame (spec 6.5): clip to panel ∪ body box
  const tails: Obj[] = Array.isArray(plan.props.tails) ? (plan.props.tails as Obj[]) : isObj(plan.props.tail) ? [plan.props.tail as Obj] : [];
  if (ctx.panelPoly && (tails.some((t) => t.offscreen) || plan.props.as === "offscreen")) {
    const c = plan.center!;
    const m = plan.outer;
    const pad = 1.5 * ctx.u.k;
    const x0 = c.x + m.x - pad;
    const y0 = c.y + m.y - pad;
    const x1 = c.x + m.x + m.w + pad;
    const y1 = c.y + m.y + m.h + pad;
    const box: Vec[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const ring = (pts: Vec[]) => [[...pts.map((q) => [q.x, q.y] as [number, number]), [pts[0].x, pts[0].y] as [number, number]]];
    try {
      const u = polygonClipping.union(ring(ctx.panelPoly), ring(box));
      const clip: PathData = u.flatMap((poly) => poly.flatMap((r) => polyPath(r.slice(0, -1).map(([x, y]) => ({ x, y })), true)));
      nodes = [{ kind: "group", clip, children: nodes }];
    } catch {
      /* keep unclipped */
    }
  }
  return { nodes, bbox: boundsOf(body.fill), contour: body.fill };
}

/** two balloons joined by a neck or merged outline (spec 6.9.1) */
export function renderConnected(a: BalloonPlan, b: BalloonPlan, style: string, widthSpec: unknown, ctx: ElemCtx): { nodes: Node[]; bbox: Rect; contour: Vec[] } {
  // one speaker -> one tail: only the body nearer to the speaker keeps its tail(s)
  const speakerDist = (pl: BalloonPlan) => {
    const who = pl.props.who as string | undefined;
    const tp = who ? ctx.refs.point(who, ctx.panel?.panel.id) : null;
    return tp ? Math.hypot(tp.x - pl.center!.x, tp.y - pl.center!.y) : Infinity;
  };
  // no speaker on either side counts as one voice too (the connect target keeps its tail)
  const sameSpeaker = a.props.who === b.props.who;
  const da = speakerDist(a);
  const db = speakerDist(b);
  const ba = buildBody(a, ctx, sameSpeaker && db < da);
  const bbb = buildBody(b, ctx, sameSpeaker && da <= db);
  const toRing = (pts: Vec[]) => {
    const r = pts.map((q) => [q.x, q.y] as [number, number]);
    r.push(r[0]);
    return [r];
  };
  if (style === "line") {
    // two separate bodies joined by one short pen line between their outlines
    const ra = renderBalloon(a, ctx);
    const rb = renderBalloon(b, ctx);
    const ca = a.center!;
    const cb = b.center!;
    const d = { x: cb.x - ca.x, y: cb.y - ca.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const dir = { x: d.x / l, y: d.y / l };
    const ha = rayPolygon(ca, dir, ra.contour);
    const hb = rayPolygon(cb, { x: -dir.x, y: -dir.y }, rb.contour);
    const nodes = [...ra.nodes, ...rb.nodes];
    if (ha && hb) {
      const p0 = { x: ca.x + dir.x * ha.t, y: ca.y + dir.y * ha.t };
      const p1 = { x: cb.x - dir.x * hb.t, y: cb.y - dir.y * hb.t };
      const st = resolveStroke(a.props.stroke, a.hand, ctx.u);
      const inks = inkShape({ pts: [p0, p1], closed: false }, { line: st, hand: a.hand, rng: new Rng(a.el.seed ^ 0x3c), taper: false }).inks;
      nodes.push(...inksToNodes(inks, st.color, tag(a.el, "ink")));
    }
    const bx = boundsOf([...ra.contour, ...rb.contour]);
    return { nodes, bbox: bx, contour: ra.contour };
  }
  const polys: [number, number][][][] = [toRing(ba.contour.pts), toRing(bbb.contour.pts)];
  let neck = style !== "overlap";
  if (!neck) {
    // overlap needs the bodies to touch; otherwise fall back to a neck (spec 6.9.1)
    let touching = false;
    try {
      touching = polygonClipping.intersection(polys[0], polys[1]).length > 0;
    } catch {
      touching = false;
    }
    if (!touching) {
      ctx.bag.warn("BALLOON_CONNECT_DISJOINT", `connected balloons ${a.el.id} and ${b.el.id} do not overlap; joined with a neck`, { path: a.el.path, elementId: a.el.id });
      neck = true;
    }
  }
  if (neck) {
    const ca = a.center!;
    const cb = b.center!;
    const d = { x: cb.x - ca.x, y: cb.y - ca.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const n = { x: -d.y / l, y: d.x / l };
    const minSide = Math.min(a.outer.w, a.outer.h, b.outer.w, b.outer.h);
    const w = (widthSpec !== undefined ? toMm(widthSpec as string, { ...ctx.u, base: minSide }) : minSide * 0.35) / 2;
    polys.push(toRing([{ x: ca.x + n.x * w, y: ca.y + n.y * w }, { x: cb.x + n.x * w, y: cb.y + n.y * w }, { x: cb.x - n.x * w, y: cb.y - n.y * w }, { x: ca.x - n.x * w, y: ca.y - n.y * w }]));
  }
  let merged: Vec[] = ba.contour.pts;
  try {
    const u = polygonClipping.union(polys[0], ...polys.slice(1));
    let best: [number, number][] | null = null;
    let bestA = 0;
    for (const poly of u) {
      const ring = poly[0];
      const ar = Math.abs(polygonArea(ring.map(([x, y]) => ({ x, y }))));
      if (ar > bestA) {
        bestA = ar;
        best = ring;
      }
    }
    if (best) merged = best.slice(0, -1).map(([x, y]) => ({ x, y }));
    if (u.length > 1) ctx.bag.warn("BALLOON_CONNECT_DISJOINT", `connected balloons ${a.el.id} and ${b.el.id} do not touch`, { path: a.el.path, elementId: a.el.id });
    void neck;
  } catch (e) {
    ctx.bag.warn("RENDER_FEATURE_APPROXIMATED", `connect failed: ${(e as Error).message}`, { path: a.el.path });
  }
  if (polygonArea(merged) < 0) merged = merged.slice().reverse();
  const contour: ShapeContour = { pts: resampleClosed(merged, 0.4 * ctx.u.k), closed: true };
  const body = inkBody(a, { ...ba, extra: [...ba.extra, ...bbb.extra], ruler: false }, ctx, contour);
  return { nodes: [...body.nodes, ...textNodes(a, ctx), ...textNodes(b, ctx)], bbox: boundsOf(body.fill), contour: body.fill };
}

function resampleClosed(pts: Vec[], step: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(1, Math.round(d / step));
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  return out;
}

function flashLines(poly: Vec[], center: Vec, ctx: ElemCtx, rng: Rng, el: RElement, maxInset = Infinity): Node[] {
  const u = ctx.u;
  const hand = resolveHand(el.props.hand, u, ctx.draft);
  const pen = { ...resolveStroke({ pen: { preset: "maru-pen" } }, hand, u).pen };
  const s = arcLengths(poly);
  const P = s[s.length - 1];
  const n = Math.round(P / (1.2 * u.k));
  const polys: Vec[][] = [];
  for (let i = 0; i < n; i++) {
    const at = pointAtArc(poly, s, (i / n) * P + rng.range(-0.3, 0.3) * u.k);
    const d = { x: at.p.x - center.x, y: at.p.y - center.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const dir = { x: d.x / l, y: d.y / l };
    const len = rng.range(2, 6) * u.k;
    const inset = Math.min(rng.range(0.2, 1.2) * u.k, maxInset);
    const a = { x: at.p.x - dir.x * inset, y: at.p.y - dir.y * inset };
    const b = { x: at.p.x + dir.x * (len - inset), y: at.p.y + dir.y * (len - inset) };
    const w = rng.sample(0.1, 0.3, "low") * u.k;
    // simple tapered spindle
    const nx = -dir.y;
    const ny = dir.x;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    polys.push([a, { x: m.x + nx * w, y: m.y + ny * w }, b, { x: m.x - nx * w, y: m.y - ny * w }]);
  }
  void pen;
  return [{ kind: "path", path: polysToPath(polys), fillRule: "nonzero", paint: { type: "solid", color: BLACK }, tag: tag(el, "ink") }];
}

/** centered bbox of a plan (for placement) */
export function planBox(plan: BalloonPlan): Rect {
  return plan.outer;
}

export { rot, polygonArea };
