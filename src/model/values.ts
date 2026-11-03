// Resolution of hand, pen, stroke and paint values into engine specs.
import { type RGBA, BLACK, WHITE, parseColor } from "../core/color.js";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { type UnitContext, parseAngle, parsePercent, toMm } from "../core/units.js";
import type { Rect } from "../geom/vec.js";
import { HAND_PRESETS, type HandSpec, PEN_PRESETS, type PenSpec, handFromRoughness } from "../ink/presets.js";
import type { LineStyle } from "../ink/shape.js";
import { activePlugins } from "../plugin.js";
import { isObj } from "../load/normalize.js";
import type { DotShape, Paint, ToneSpec } from "../render/ir.js";

type Obj = Record<string, unknown>;

export function resolveHand(h: unknown, u: UnitContext, draft = false): HandSpec {
  const o = (isObj(h) ? h : {}) as Obj;
  let base: HandSpec;
  if (draft) base = { ...HAND_PRESETS.sketch };
  else if (typeof o.roughness === "number") base = handFromRoughness(o.roughness);
  else {
    const name = (o.preset as string) ?? "ink";
    const custom = HAND_PRESETS[name] ? undefined : activePlugins()?.hands.get(name);
    base = { ...(HAND_PRESETS[name] ?? HAND_PRESETS.ink), ...(custom ?? {}) } as HandSpec;
  }
  const k = u.k;
  // scale lengths (B5-based)
  const s: HandSpec = {
    ...base,
    wobbleAmp: base.wobbleAmp * k,
    wobbleLen: base.wobbleLen * k,
    tremorAmp: base.tremorAmp * k,
    tremorLen: base.tremorLen * k,
    overshoot: [base.overshoot[0] * k, base.overshoot[1] * k],
    overlap: [base.overlap[0] * k, base.overlap[1] * k],
    gap: [base.gap[0] * k, base.gap[1] * k],
    misalign: base.misalign * k,
    maxLength: base.maxLength * k,
    passOffset: [base.passOffset[0] * k, base.passOffset[1] * k],
  };
  const L = (v: unknown, d: number) => (v === undefined ? d : toMm(v as string, u));
  const R = (v: unknown, d: [number, number]): [number, number] =>
    v === undefined ? d : Array.isArray(v) ? [L(v[0], d[0]), L(v[1], d[1])] : isObj(v) ? [L(v.min, d[0]), L(v.max, d[1])] : [L(v, d[0]), L(v, d[1])];
  if (isObj(o.wobble)) {
    s.wobbleAmp = L(o.wobble.amplitude, s.wobbleAmp);
    s.wobbleLen = L(o.wobble.wavelength, s.wobbleLen);
  }
  if (isObj(o.tremor)) {
    s.tremorAmp = L(o.tremor.amplitude, s.tremorAmp);
    s.tremorLen = L(o.tremor.wavelength, s.tremorLen);
  }
  if (typeof o.irregularity === "number") s.irregularity = o.irregularity;
  if (typeof o.pressure === "number") s.pressure = o.pressure;
  if (typeof o.taper === "number") s.taper = o.taper;
  if (o.overshoot !== undefined) s.overshoot = R(o.overshoot, s.overshoot);
  if (isObj(o.closure)) {
    const c = o.closure as Obj;
    if (c.overlap !== undefined) s.overlap = R(c.overlap, s.overlap);
    if (c.gap !== undefined) s.gap = R(c.gap, s.gap);
    if (typeof c.gapChance === "number") s.gapChance = c.gapChance;
    if (c.misalign !== undefined) s.misalign = L(c.misalign, s.misalign);
  }
  if (isObj(o.split)) {
    if (o.split.cornerAngle !== undefined) s.cornerAngle = parseAngle(o.split.cornerAngle as string);
    if (o.split.maxLength !== undefined) s.maxLength = L(o.split.maxLength, s.maxLength);
  }
  if (isObj(o.ruler) && o.ruler.angleError !== undefined) s.rulerAngleError = parseAngle(o.ruler.angleError as string);
  if (o.handedness === "left" || o.handedness === "right") s.handedness = o.handedness;
  if (o.resolution !== undefined) s.resolution = Math.max(0.05, L(o.resolution, s.resolution));
  return s;
}

export function resolvePen(p: unknown, u: UnitContext, handPen?: string): PenSpec {
  const o = (isObj(p) ? p : {}) as Obj;
  const name = handPen ?? (o.preset as string) ?? "g-pen";
  const custom = PEN_PRESETS[name] ? undefined : activePlugins()?.pens.get(name);
  const base = PEN_PRESETS[name] ?? ({ ...PEN_PRESETS["g-pen"], ...(custom ?? {}), preset: name } as PenSpec);
  const k = u.k;
  const s: PenSpec = { ...base, taperIn: base.taperIn * k, taperOut: base.taperOut * k };
  if (handPen) return s;
  if (typeof o.pressure === "number") s.pressure = o.pressure;
  if (isObj(o.taper)) {
    if (o.taper.in !== undefined) s.taperIn = toMm(o.taper.in as string, u);
    if (o.taper.out !== undefined) s.taperOut = toMm(o.taper.out as string, u);
  }
  for (const key of ["curvature", "pull", "tremor", "inkPool"] as const) if (typeof o[key] === "number") s[key] = o[key] as number;
  if (o.cap === "round" || o.cap === "flat") s.cap = o.cap;
  if (o.minWidth !== undefined) s.minWidth = toMm(o.minWidth as string, u);
  if (o.tipWidth !== undefined) s.tipWidth = toMm(o.tipWidth as string, u);
  if (o.texture === "graphite" || o.texture === "none") s.texture = o.texture;
  return s;
}

export interface StrokeResolved extends LineStyle {
  color: RGBA;
  hand: HandSpec;
  ruler?: boolean;
  join?: "clean" | "overshoot" | "gap";
}

export function resolveStroke(st: unknown, hand: HandSpec, u: UnitContext, bag?: DiagnosticBag, path?: (string | number)[]): StrokeResolved {
  const o = (isObj(st) ? st : {}) as Obj;
  const h = isObj(o.hand) ? resolveHand(o.hand, u) : hand;
  const pen = resolvePen(o.pen, u, hand.pen);
  const color = parseColor((o.color as string) ?? (pen.color ?? "black")) ?? BLACK;
  if (o.color && !parseColor(o.color as string)) bag?.error("COLOR_INVALID", `invalid color "${o.color}"`, { path });
  let width = o.width !== undefined ? toMm(o.width as string, u) : 0.25 * u.k;
  if (width > 0 && width < pen.minWidth) {
    bag?.info("RENDER_LINE_TOO_THIN", `line width ${width.toFixed(3)}mm raised to ${pen.minWidth}mm`, { path });
    width = pen.minWidth;
  }
  const dash = Array.isArray(o.dash) ? ([toMm(o.dash[0] as string, u), toMm(o.dash[1] as string, u)] as [number, number]) : undefined;
  const dot = isObj(o.dot) ? { size: toMm(o.dot.size as string, u), gap: toMm(o.dot.gap as string, u) } : undefined;
  const dbl = isObj(o.double) ? { gap: toMm(o.double.gap as string, u), inner: toMm(o.double.inner as string, u) } : undefined;
  const style = ((o.style as string) ?? "solid") as LineStyle["style"];
  return {
    width,
    pen,
    style: ["solid", "dashed", "dotted", "double", "none"].includes(style) ? style : "solid",
    dash,
    dot,
    double: dbl,
    color,
    hand: h,
    ruler: typeof o.ruler === "boolean" ? o.ruler : undefined,
    join: o.join as StrokeResolved["join"],
  };
}

// ---- paint -------------------------------------------------------------------

export interface PaintCtx {
  u: UnitContext;
  /** bbox (mm, page coords) the paint applies to, for gradients */
  box: Rect;
  seed: number;
  bag?: DiagnosticBag;
  path?: (string | number)[];
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function densityOf(v: unknown): number | null {
  if (typeof v === "number") return v > 1 ? v / 100 : v;
  const p = parsePercent(v);
  return p === null ? null : p;
}

/** CSS-convention angle (0 = up, clockwise) to direction vector */
function cssDir(rad: number): { x: number; y: number } {
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

function sideToCss(s: string): number | null {
  const parts = s.replace(/^to\s+/, "").split(/\s+/);
  let x = 0;
  let y = 0;
  for (const p of parts) {
    if (p === "top") y = -1;
    else if (p === "bottom") y = 1;
    else if (p === "left") x = -1;
    else if (p === "right") x = 1;
    else return null;
  }
  return Math.atan2(x, -y);
}

function gradientLine(box: Rect, rad: number) {
  const d = cssDir(rad);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const half = (Math.abs(box.w * d.x) + Math.abs(box.h * d.y)) / 2;
  return { x0: cx - d.x * half, y0: cy - d.y * half, x1: cx + d.x * half, y1: cy + d.y * half };
}

export function parsePaint(v: unknown, ctx: PaintCtx): Paint | null {
  const err = (m: string) => {
    ctx.bag?.error("PAINT_INVALID", m, { path: ctx.path });
    return null;
  };
  if (v === undefined || v === null || v === "none") return null;
  if (typeof v === "string") {
    const s = v.trim();
    const fm = s.match(/^([a-z-]+)\((.*)\)$/s);
    if (fm && ["tone", "tone-gradient", "linear-gradient", "radial-gradient"].includes(fm[1])) {
      const args = splitArgs(fm[2]);
      if (fm[1] === "tone") {
        const d = densityOf(args[0]);
        if (d === null) return err(`invalid tone density "${args[0]}"`);
        const t: Obj = { density: d };
        for (const a of args.slice(1)) {
          if (/lpi$/.test(a)) t.lpi = parseFloat(a);
          else if (/(deg|rad|turn)$/.test(a)) t.angle = a;
          else if (["round", "square", "ellipse", "line", "cross", "noise"].includes(a)) t.dot = a;
          else return err(`invalid tone argument "${a}"`);
        }
        return toneFromObj(t, ctx);
      }
      if (fm[1] === "tone-gradient") {
        const a0 = densityOf(args[0]);
        const a1 = densityOf(args[1]);
        if (a0 === null || a1 === null) return err("tone-gradient needs two densities");
        const g: Obj = { stops: [[0, a0], [1, a1]], type: "linear", angle: "180deg" };
        const t: Obj = { gradient: g };
        for (const a of args.slice(2)) {
          if (a === "radial") g.type = "radial";
          else if (/(deg|rad|turn)$/.test(a)) g.angle = a;
          else if (/lpi$/.test(a)) t.lpi = parseFloat(a);
          else if (["round", "square", "ellipse", "line", "cross", "noise"].includes(a)) t.dot = a;
          else return err(`invalid tone-gradient argument "${a}"`);
        }
        return toneFromObj(t, ctx);
      }
      if (fm[1] === "linear-gradient") {
        let ang = Math.PI; // to bottom
        let rest = args;
        if (/^to\s/.test(args[0])) {
          const a = sideToCss(args[0]);
          if (a === null) return err(`invalid gradient direction "${args[0]}"`);
          ang = a;
          rest = args.slice(1);
        } else if (/^-?[\d.]+(deg|rad|turn)$/.test(args[0])) {
          ang = parseAngle(args[0]);
          rest = args.slice(1);
        }
        const stops = parseStops(rest);
        if (!stops) return err("invalid gradient stops");
        return { type: "linear-gradient", ...gradientLine(ctx.box, ang), stops };
      }
      // radial
      let cx = ctx.box.x + ctx.box.w / 2;
      let cy = ctx.box.y + ctx.box.h / 2;
      let rest = args;
      const at = args[0]?.match(/^at\s+(\S+)\s+(\S+)$/);
      if (at) {
        cx = ctx.box.x + toMm(at[1], { ...ctx.u, base: ctx.box.w });
        cy = ctx.box.y + toMm(at[2], { ...ctx.u, base: ctx.box.h });
        rest = args.slice(1);
      }
      const r = Math.max(Math.hypot(cx - ctx.box.x, cy - ctx.box.y), Math.hypot(ctx.box.x + ctx.box.w - cx, cy - ctx.box.y), Math.hypot(cx - ctx.box.x, ctx.box.y + ctx.box.h - cy), Math.hypot(ctx.box.x + ctx.box.w - cx, ctx.box.y + ctx.box.h - cy));
      const stops = parseStops(rest);
      if (!stops) return err("invalid gradient stops");
      return { type: "radial-gradient", cx, cy, r, stops };
    }
    const c = parseColor(s);
    if (!c) return err(`invalid paint "${s}"`);
    return { type: "solid", color: c };
  }
  if (isObj(v)) {
    if (isObj(v.tone)) return toneFromObj(v.tone as Obj, ctx);
    if (isObj(v.gradient)) {
      const g = v.gradient as Obj;
      const stops = parseStops((g.stops as unknown[]).map((s) => (Array.isArray(s) ? `${s[0]} ${s[1]}` : String(s))));
      if (!stops) return err("invalid gradient stops");
      if (g.type === "radial") {
        const at = (g.at as string[]) ?? ["50%", "50%"];
        const cx = ctx.box.x + toMm(at[0], { ...ctx.u, base: ctx.box.w });
        const cy = ctx.box.y + toMm(at[1], { ...ctx.u, base: ctx.box.h });
        return { type: "radial-gradient", cx, cy, r: Math.hypot(ctx.box.w, ctx.box.h) / 2, stops };
      }
      return { type: "linear-gradient", ...gradientLine(ctx.box, parseAngle((g.angle as string) ?? "180deg")), stops };
    }
  }
  return err("invalid paint");
}

function parseStops(args: string[]): { offset: number; color: RGBA }[] | null {
  const out: { offset: number; color: RGBA; given: boolean }[] = [];
  for (const a of args) {
    const m = a.match(/^(.*?)(?:\s+(-?[\d.]+%?))?$/);
    if (!m) return null;
    const c = parseColor(m[1].trim());
    if (!c) return null;
    const pos = m[2] !== undefined ? (m[2].endsWith("%") ? parseFloat(m[2]) / 100 : parseFloat(m[2])) : NaN;
    out.push({ offset: pos, color: c, given: m[2] !== undefined });
  }
  if (out.length < 2) return null;
  if (!out[0].given) out[0].offset = 0;
  if (!out[out.length - 1].given) out[out.length - 1].offset = 1;
  for (let i = 1; i < out.length - 1; i++) {
    if (!out[i].given) {
      let j = i;
      while (!out[j].given && j < out.length - 1) j++;
      const a = out[i - 1].offset;
      const b = out[j].offset;
      for (let k = i; k < j; k++) out[k].offset = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
  }
  return out.map(({ offset, color }) => ({ offset, color }));
}

function toneFromObj(t: Obj, ctx: PaintCtx): Paint | null {
  const dot = ((t.dot as string) ?? "round") as DotShape;
  const spec: ToneSpec = {
    density: densityOf(t.density) ?? 0,
    lpi: typeof t.lpi === "number" ? t.lpi : 60,
    angle: parseAngle((t.angle as string) ?? "45deg"),
    dot,
    grain: t.grain !== undefined ? toMm(t.grain as string, ctx.u) : 0.08,
    invert: !!t.invert,
    offset: Array.isArray(t.offset) ? [toMm(t.offset[0] as string, ctx.u), toMm(t.offset[1] as string, ctx.u)] : [0, 0],
    seed: ctx.seed,
  };
  if (isObj(t.gradient)) {
    const g = t.gradient as Obj;
    const stops = (g.stops as unknown[][]).map((s) => [parsePercent(s[0]) ?? Number(s[0]), densityOf(s[1]) ?? 0] as [number, number]);
    if (g.type === "radial") {
      const c = (g.center as string[]) ?? ["50%", "50%"];
      const center = { x: ctx.box.x + toMm(c[0], { ...ctx.u, base: ctx.box.w }), y: ctx.box.y + toMm(c[1], { ...ctx.u, base: ctx.box.h }) };
      const radius = g.radius !== undefined ? toMm(g.radius as string, { ...ctx.u, base: Math.max(ctx.box.w, ctx.box.h) }) : Math.hypot(ctx.box.w, ctx.box.h) / 2;
      spec.gradient = { type: "radial", p0: center, p1: center, center, radius, stops, easing: (g.easing as "linear") ?? "linear" };
    } else {
      const L = gradientLine(ctx.box, parseAngle((g.angle as string) ?? "180deg"));
      spec.gradient = { type: "linear", p0: { x: L.x0, y: L.y0 }, p1: { x: L.x1, y: L.y1 }, stops, easing: (g.easing as "linear") ?? "linear" };
    }
  }
  const color = parseColor((t.color as string) ?? "black") ?? BLACK;
  return { type: "tone", tone: spec, color };
}

export function paintAvgLuminance(p: Paint | null): number {
  if (!p) return 1;
  if (p.type === "solid") return p.color.a < 0.5 ? 1 : 0.2126 * p.color.r + 0.7152 * p.color.g + 0.0722 * p.color.b;
  if (p.type === "tone") return 1 - (p.tone.gradient ? p.tone.gradient.stops.reduce((a, s) => a + s[1], 0) / p.tone.gradient.stops.length : p.tone.density);
  const st = p.stops;
  return st.reduce((a, s) => a + (0.2126 * s.color.r + 0.7152 * s.color.g + 0.0722 * s.color.b), 0) / st.length;
}

export { WHITE, BLACK };
