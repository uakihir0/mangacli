// Balloons: sizing, tails, inking (spec 6).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import { Rng } from "../core/random.js";
import { type UnitContext, parseAngle, toMm } from "../core/units.js";
import { type PathData, distToPolyline, pointInPolygon, polyPath, polygonArea, rayPolygon } from "../geom/path.js";
import { type Rect, type Vec, boundsOf, rot } from "../geom/vec.js";
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
import { type ElemCtx, tag } from "./context.js";
import { fillNode, inksToNodes, polysToPath } from "./inkir.js";
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
  explicit: boolean;
  fill: Paint | null;
  hand: HandSpec;
  innerCenter: Vec; // text block center relative to body center
  props: Obj;
  textOffset: Vec;
  fontScaleApplied: number;
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
  const p = el.props;
  const u = ctx.u;
  const rng = new Rng(el.seed);
  const hand = resolveHand(p.hand, u, ctx.draft);
  const params = shapeParams(p, rng, hand, u);
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
  const minSz = Array.isArray(p.minSize) ? p.minSize : ["8bmm", "8bmm"];
  const minW = sizeValue(minSz[0], ctx.coordsBox.w, pc);
  const minH = sizeValue(minSz[1], ctx.coordsBox.h, pc);
  const overflow = (p.overflow as string) ?? (fixedSize ? "shrink" : "grow");
  const strokeW = resolveStroke(p.stroke, hand, u).width;
  const margin = hand.wobbleAmp + strokeW * 0.6 + 0.15 * u.k;
  const kind = params.kind === "flash" ? "ellipse" : params.kind;

  let scale = 1;
  for (let attempt = 0; attempt < 12; attempt++) {
    const style = resolveTextStyle({ ...p, fontScale: ((p.fontScale as number) ?? 1) * scale }, u, ctx.lang, true, el.seed);
    const emCtx = { ...u, em: style.fontSize };
    const pad = Array.isArray(p.padding) ? p.padding : ["0.45em", "0.9em"];
    const padV = toMm(pad[0] as string, emCtx);
    const padH = toMm(pad[1] as string, emCtx);
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
    if (!fixedBase) {
      // keep auto-sized balloons within maxSize: wrap before the line outgrows it (organic bodies lose ~30% to curvature)
      const mx = style.writing === "vertical" ? maxH : maxW;
      const lim = mx === "auto" ? Infinity : mx * 0.72 - 2 * (style.writing === "vertical" ? padV : padH) - 2 * margin;
      if (isFinite(lim)) boxLimit = Math.min(boxLimit ?? Infinity, Math.max(lim, style.fontSize * 4.5));
    }
    const tl = layoutText(text, style, ctx.fonts, boxLimit);
    // points relative to text block center
    const cx = tl.width / 2;
    const cy = tl.height / 2;
    const pts: Vec[] = [];
    for (const ln of tl.lines) {
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
      const ar = (p.aspectRange as [number, number]) ?? [0.55, 1.8];
      const fixedAspect = typeof p.aspect === "number" ? p.aspect : undefined;
      base = fitBody(kind, params, shapeSeed, withMargin, fixedAspect, ar);
      body = genBody(kind, base.w, base.h, params, shapeSeed);
      let ob = boundsOf(body.contour.pts);
      // min size
      if (minW !== "auto" && minH !== "auto" && (ob.w < minW || ob.h < minH)) {
        const f = Math.max(minW / ob.w, minH / ob.h);
        base = { w: base.w * Math.max(1, ob.w < minW ? minW / ob.w : 1), h: base.h * Math.max(1, ob.h < minH ? minH / ob.h : 1) };
        void f;
        body = genBody(kind, base.w, base.h, params, shapeSeed);
        ob = boundsOf(body.contour.pts);
      }
      if ((maxW !== "auto" && ob.w > maxW) || (maxH !== "auto" && ob.h > maxH)) fits = false;
      // balance text inside the organic contour, then tighten
      let ic = bestOffset(withMargin, body.inner, innerCenterOf(body), ob);
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
        const minOk = minW === "auto" || minH === "auto" ? true : true;
        void minOk;
        base = { w: base.w * hi, h: base.h * hi };
        body = genBody(kind, base.w, base.h, params, shapeSeed);
        ic = bestOffset(withMargin, body.inner, innerCenterOf(body), boundsOf(body.contour.pts));
      }
      centerOverride = ic;
    }
    if (!fits && overflow !== "grow" && scale > minFontScale + 1e-6 && overflow !== "clip" && overflow !== "error") {
      scale = Math.max(minFontScale, scale - 0.05);
      continue;
    }
    if (!fits && overflow === "grow" && scale > minFontScale + 1e-6) {
      scale = Math.max(minFontScale, scale - 0.05);
      continue;
    }
    if (!fits) {
      if (overflow === "grow") ctx.bag.warn("BALLOON_TOO_LARGE", `balloon ${el.id} exceeds maxSize`, { path: el.path, elementId: el.id });
      else if (overflow === "error") ctx.bag.error("TEXT_OVERFLOW", `text does not fit in balloon ${el.id}`, { path: el.path, elementId: el.id });
      else ctx.bag.warn("TEXT_OVERFLOW", `text in balloon ${el.id} does not fit even at ${Math.round(scale * 100)}%`, { path: el.path, elementId: el.id });
    } else if (scale < 1) ctx.bag.info("TEXT_SHRUNK", `balloon ${el.id}: font scaled to ${Math.round(scale * 100)}%`, { path: el.path, elementId: el.id });
    if (tl.missing.length) ctx.bag.warn("FONT_MISSING_GLYPH", `missing glyphs: ${[...new Set(tl.missing)].join("")}`, { path: el.path, elementId: el.id });
    for (const e of tl.errors) ctx.bag.error(e.code, e.message, { path: [...el.path, "text"], elementId: el.id });
    for (const e of tl.infos) ctx.bag.info(e.code, e.message, { path: [...el.path, "text"], elementId: el.id });
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

function fitBody(kind: string, params: ShapeParams, seed: number, pts: Vec[], fixedAspect: number | undefined, ar: [number, number]): { w: number; h: number } {
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
    return s * s * r;
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

function arcLengths(pts: Vec[]): number[] {
  const s = [0];
  for (let i = 1; i <= pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i % pts.length].x - pts[i - 1].x, pts[i % pts.length].y - pts[i - 1].y));
  return s;
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

function quad(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function applyTails(contour: ShapeContour, tails: Obj[], tc: TailCtx): TailResult {
  const { ctx, plan, center } = tc;
  const u = ctx.u;
  let cur: ShapeContour = { ...contour, pts: contour.pts.slice(), corners: contour.corners?.slice() };
  const extra: TailResult["extra"] = [];
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
    if (t.offscreen) {
      const pb = ctx.panel ? ctx.panel.box : ctx.coordsBox;
      const side = t.offscreen as string;
      const ext = 4 * u.k;
      target = side === "right" ? { x: pb.x + pb.w + ext, y: center.y + (pb.y + pb.h / 2 - center.y) * 0.3 } : side === "left" ? { x: pb.x - ext, y: center.y } : side === "top" ? { x: center.x, y: pb.y - ext } : { x: center.x, y: pb.y + pb.h + ext };
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
    if (t.root !== undefined && t.root !== "auto") {
      const a = parseAngle(t.root as string);
      dir = { x: Math.cos(a), y: Math.sin(a) };
    }
    const hit = rayPolygon(center, dir, cur.pts);
    if (!hit) continue;
    const R = { x: center.x + dir.x * hit.t, y: center.y + dir.y * hit.t };
    if (target && pointInPolygon(target, cur.pts)) {
      ctx.bag.warn("BALLOON_TAIL_TARGET_INSIDE", `tail target of ${plan.el.id} is inside the balloon`, { path: plan.el.path, elementId: plan.el.id });
      continue;
    }
    const gap = t.gap !== undefined ? toMm(t.gap as string, u) : 2 * u.k;
    const maxLen = t.maxLength !== undefined ? toMm(t.maxLength as string, u) : Math.min(14 * u.k, Math.max(4 * u.k, minSide * 0.8));
    let length: number;
    if (t.length !== undefined) length = toMm(t.length as string, u);
    else if (target) {
      let avail = Math.hypot(target.x - R.x, target.y - R.y) - gap;
      // do not run into the speaker's face
      const tgtRef = typeof t.to === "string" ? ctx.refs.target(t.to, ctx.panel?.panel.id) : who ? ctx.refs.target(who, ctx.panel?.panel.id) : undefined;
      const face = tgtRef?.regions.face?.bbox;
      if (face) {
        const tf = rayEllipseEntry(R, dir, face);
        if (tf !== null) avail = Math.min(avail, tf - gap * 0.5);
      }
      length = Math.min(maxLen, Math.max(2.5 * u.k, avail));
    } else length = (kind === "zigzag" ? 7 : 5) * u.k;
    if (t.offscreen && target) length = Math.min(maxLen * 1.5, Math.hypot(target.x - R.x, target.y - R.y));
    const widthScale = typeof t.widthScale === "number" ? t.widthScale : 1;
    const bw = (t.width !== undefined ? toMm(t.width as string, u) : Math.min(7 * u.k, Math.max(2.6 * u.k, minSide * 0.3))) * widthScale;
    const bend = typeof t.bend === "number" ? t.bend : 0.1;
    const sideCurve = typeof t.sideCurve === "number" ? t.sideCurve : 0.12;
    const perp = { x: -dir.y, y: dir.x };
    const tip = { x: R.x + dir.x * length, y: R.y + dir.y * length };
    const ctrl = { x: (R.x + tip.x) / 2 + perp.x * bend * length * 0.5, y: (R.y + tip.y) / 2 + perp.y * bend * length * 0.5 };
    const tipBent = { x: tip.x + perp.x * bend * length * 0.25, y: tip.y + perp.y * bend * length * 0.25 };

    if (kind === "bubbles") {
      const count = typeof t.count === "number" ? t.count : 3;
      let size = t.bubbleSize !== undefined ? toMm(t.bubbleSize as string, u) : Math.min(5 * u.k, Math.max(1.5 * u.k, minSide * 0.2));
      const shrink = typeof t.shrink === "number" ? t.shrink : 0.62;
      // the bubble chain must stop short of the speaker (face): scale it down to the available run
      if (target && t.length === undefined) {
        let span = gap * 0.6;
        let sz = size;
        for (let i = 0; i < count; i++) {
          span += sz + (i + 1 < count ? sz * 0.45 : 0);
          sz *= shrink;
        }
        if (span > length) size *= Math.max(0.55, length / span);
      }
      let dpos = gap * 0.6 + size / 2;
      const total = target ? length : length + size;
      for (let i = 0; i < count; i++) {
        if (dpos + size / 2 > total + 1e-6 && i > 0) break;
        const tt = Math.min(1, dpos / Math.max(1e-6, total));
        const c = quad(R, ctrl, tipBent, tt);
        const r = size / 2;
        const pts = blobPoly(c, r, tc.rng, 28, 0.06).map((q) => ({ x: c.x + (q.x - c.x) * 1, y: c.y + (q.y - c.y) * 0.88 }));
        extra.push({ pts, closed: true, kind: "bubble" });
        dpos += size / 2 + size * 0.45;
        size *= shrink;
        dpos += size / 2;
      }
      continue;
    }
    if (kind === "line") {
      const pts: Vec[] = [];
      for (let i = 0; i <= 20; i++) pts.push(quad(R, ctrl, tipBent, i / 20));
      extra.push({ pts, closed: false, kind: "line" });
      continue;
    }
    // wedge / zigzag: splice into contour
    const s = arcLengths(cur.pts);
    const sR = s[hit.index] + hit.u * (s[hit.index + 1] - s[hit.index]);
    const A = pointAtArc(cur.pts, s, sR - bw / 2);
    const B = pointAtArc(cur.pts, s, sR + bw / 2);
    const sideA: Vec[] = [];
    const sideB: Vec[] = [];
    const N = Math.max(12, Math.ceil(length / (0.3 * u.k)));
    const zig = kind === "zigzag";
    const segs = Math.max(2, typeof t.segments === "number" ? Math.round(t.segments) : 3);
    // lightning bolt: straight segments between alternating offsets, sharp joints
    const zigV: Vec[] = [];
    if (zig) {
      // amplitude bounded by the segment length so the band never folds over itself
      const amp = Math.min(bw * 0.55, (length / segs) * 0.42);
      for (let k = 0; k <= segs; k++) {
        const tt = k / segs;
        const o = k === 0 || k === segs ? 0 : (k % 2 ? 1 : -1) * amp * (1 - tt * 0.4);
        zigV.push({ x: R.x + (tip.x - R.x) * tt + perp.x * o, y: R.y + (tip.y - R.y) * tt + perp.y * o });
      }
    }
    const NN = zig ? segs * Math.max(4, Math.ceil(N / segs)) : N;
    const zigCorners: number[] = [];
    for (let i = 0; i <= NN; i++) {
      const tt = i / NN;
      let cl = quad(R, ctrl, tipBent, tt);
      if (zig) {
        const pos = tt * segs;
        const k = Math.min(segs - 1, Math.floor(pos));
        const u = pos - k;
        cl = { x: zigV[k].x + (zigV[k + 1].x - zigV[k].x) * u, y: zigV[k].y + (zigV[k + 1].y - zigV[k].y) * u };
        if (i > 0 && i < NN && Math.abs(u) < 1e-9) zigCorners.push(i);
      }
      const f = zig ? Math.max(0, 1 - tt) ** 1.15 : Math.pow(1 - tt, 1 + sideCurve * 1.6);
      sideA.push({ x: cl.x + (A.p.x - R.x) * f, y: cl.y + (A.p.y - R.y) * f });
      sideB.push({ x: cl.x + (B.p.x - R.x) * f, y: cl.y + (B.p.y - R.y) * f });
    }
    // new contour: from B forward around to A, then A->tip, tip->B
    const n = cur.pts.length;
    const out: Vec[] = [B.p];
    const idxMap = new Map<number, number>();
    let i = (B.i + 1) % n;
    let guard = 0;
    while (guard++ < n + 2) {
      idxMap.set(i, out.length);
      out.push(cur.pts[i]);
      if (i === A.i) break;
      i = (i + 1) % n;
    }
    const aIndex = out.length;
    out.push(A.p);
    for (let k = 1; k < sideA.length; k++) out.push(sideA[k]);
    const tipIndex = out.length - 1;
    const bStart = out.length;
    for (let k = sideB.length - 2; k >= 1; k--) out.push(sideB[k]);
    const corners = (cur.corners ?? []).filter((c) => idxMap.has(c.index)).map((c) => ({ index: idxMap.get(c.index)!, kind: c.kind }));
    corners.push({ index: 0, kind: "concave" }, { index: aIndex, kind: "concave" }, { index: tipIndex, kind: "tip" });
    for (const zc of zigCorners) {
      corners.push({ index: aIndex + zc, kind: "convex" });
      corners.push({ index: bStart + (sideB.length - 2 - zc), kind: "convex" });
    }
    const smoothBody = cur.smooth || !cur.corners;
    cur = { pts: out, closed: true, corners, smooth: false };
    void smoothBody;
  }
  return { contour: cur, extra };
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
  const translate = (pts: Vec[]) => pts.map((q) => ({ x: q.x + center.x, y: q.y + center.y }));
  const body = plan.body;
  let contour: ShapeContour = { ...body.contour, pts: translate(body.contour.pts) };
  const tails: Obj[] = skipTails ? [] : Array.isArray(p.tails) ? (p.tails as Obj[]) : isObj(p.tail) ? [p.tail as Obj] : [];
  const tr = applyTails(contour, tails, { ctx, plan, center, rng });
  if (tr.contour) contour = tr.contour;
  const stroke = resolveStroke(p.stroke, plan.hand, ctx.u, ctx.bag, [...el.path, "stroke"]);
  const ruler = !!(plan.params.ruler ?? body.ruler) && !contour.corners?.some((c) => c.kind === "tip");
  return { contour, extra: tr.extra, stroke, ruler, rng };
}

function inkBody(plan: BalloonPlan, bb: BodyBuild, ctx: ElemCtx, contour: ShapeContour): { nodes: Node[]; fill: Vec[] } {
  const el = plan.el;
  const nodes: Node[] = [];
  const t = tag(el, "ink");
  const isNone = plan.params.kind === "none";
  const isFlash = plan.params.kind === "flash";
  let fillPoly: Vec[] = contour.pts;
  if (!isNone) {
    const res = inkShape(contour, { line: isFlash ? { ...bb.stroke, style: "none" } : bb.stroke, hand: plan.hand, rng: bb.rng.fork("body"), ruler: bb.ruler, join: plan.params.join ?? (bb.ruler ? "clean" : "overshoot"), strokes: plan.params.strokes, sizeHint: Math.min(plan.outer.w, plan.outer.h) });
    fillPoly = res.fill;
    const fn = fillNode(res.fill, plan.fill, tag(el, "fill"));
    if (fn) nodes.push(fn);
    if (isFlash) nodes.push(...flashLines(res.fill, plan.center!, ctx, bb.rng, el));
    nodes.push(...inksToNodes(res.inks, bb.stroke.color, t));
  }
  for (const ex of bb.extra) {
    if (ex.kind === "bubble") {
      const res = inkShape({ pts: ex.pts, closed: true, smooth: true }, { line: bb.stroke, hand: plan.hand, rng: bb.rng.fork("bub"), strokes: 1 });
      const fn = fillNode(res.fill, plan.fill, tag(el, "fill"));
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
  const el = plan.el;
  const p = plan.props;
  const u = ctx.u;
  const center = plan.center!;
  const tl = plan.text;
  const ox = center.x + plan.innerCenter.x - tl.width / 2 + plan.textOffset.x;
  const oy = center.y + plan.innerCenter.y - tl.height / 2 + plan.textOffset.y;
  const color = parseColor(plan.textColor) ?? BLACK;
  const glyphs = tl.glyphs.map((g) => g.path.map((c) => (c[0] === "Z" ? c : (c.map((v, i) => (i === 0 ? v : (i % 2 === 1 ? (v as number) + ox : (v as number) + oy))) as typeof c))));
  const textNode: Node = { kind: "path", path: glyphs.flat(), fillRule: "nonzero", paint: { type: "solid", color }, tag: tag(el, "text", "text") };
  const nodes: Node[] = [];
  const outlines = Array.isArray(p.textOutline) ? (p.textOutline as Obj[]) : [];
  const ow = outlines.map((o) => ({ w: toMm(o.width as string, u), c: parseColor((o.color as string) ?? "white") ?? WHITE })).sort((a, b) => b.w - a.w);
  for (const o of ow) nodes.push({ kind: "path", path: textNode.path, fillRule: "nonzero", paint: null, stroke: { width: o.w * 2, paint: { type: "solid", color: o.c }, join: "round" }, tag: tag(el, "text", "text") });
  if (tl.glyphs.some((g) => g.bold)) (textNode as { stroke?: unknown }).stroke = { width: tl.fontSize * 0.04, paint: { type: "solid", color }, join: "round" };
  nodes.push(textNode);
  return nodes;
}

export function renderBalloon(plan: BalloonPlan, ctx: ElemCtx): { nodes: Node[]; bbox: Rect; contour: Vec[] } {
  const bb = buildBody(plan, ctx);
  const body = inkBody(plan, bb, ctx, bb.contour);
  let nodes: Node[] = [...body.nodes, ...textNodes(plan, ctx)];
  // offscreen tails are cut by the panel frame (spec 6.5): clip to panel ∪ body box
  const tails: Obj[] = Array.isArray(plan.props.tails) ? (plan.props.tails as Obj[]) : isObj(plan.props.tail) ? [plan.props.tail as Obj] : [];
  if (ctx.panelPoly && tails.some((t) => t.offscreen)) {
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
  const sameSpeaker = a.props.who !== undefined && a.props.who === b.props.who;
  const da = speakerDist(a);
  const db = speakerDist(b);
  const ba = buildBody(a, ctx, sameSpeaker && db < da);
  const bbb = buildBody(b, ctx, sameSpeaker && da <= db);
  const toRing = (pts: Vec[]) => {
    const r = pts.map((q) => [q.x, q.y] as [number, number]);
    r.push(r[0]);
    return [r];
  };
  const polys: [number, number][][][] = [toRing(ba.contour.pts), toRing(bbb.contour.pts)];
  if (style !== "overlap") {
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

function flashLines(poly: Vec[], center: Vec, ctx: ElemCtx, rng: Rng, el: RElement): Node[] {
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
    const inset = rng.range(0.2, 1.2) * u.k;
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
