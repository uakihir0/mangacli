// Manpu marks (spec 8.15).
import { BLACK, parseColor } from "../core/color.js";
import { Rng } from "../core/random.js";
import { parseAngle, toMm } from "../core/units.js";
import { type Rect, type Vec, rot } from "../geom/vec.js";
import { inkLine, inkShape } from "../ink/shape.js";
import type { InkPoly } from "../ink/stroke.js";
import { place, resolvePoint } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { parsePaint, resolveHand, resolveStroke } from "../model/values.js";
import type { Node, Paint } from "../render/ir.js";
import { resolveAssetBlend } from "../render/assets.js";
import { activePlugins } from "../plugin.js";
import { runPluginDrawable } from "./plugindraw.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { fillNode, inksToNodes } from "./inkir.js";

type Obj = Record<string, unknown>;

interface MarkCtx {
  rng: Rng;
  s: number; // size mm
  w: number; // line width
  fill: Paint | null;
  inks: InkPoly[];
  fills: { poly: Vec[]; paint: Paint | null }[];
  line: (pts: Vec[], opts?: { w?: number; tin?: boolean; tout?: boolean; ruler?: boolean }) => void;
  shape: (pts: Vec[], fill?: Paint | null, smooth?: boolean) => void;
}

const T = (pts: Vec[], c: Vec, a = 0, sc = 1): Vec[] => pts.map((p) => {
  const r = rot({ x: p.x * sc, y: p.y * sc }, a);
  return { x: r.x + c.x, y: r.y + c.y };
});

function drop(r: number, n = 40): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    // teardrop: point at top
    const x = r * Math.sin(t) * Math.pow(Math.sin(t / 2), 1.0);
    const y = -r * Math.cos(t) * 1.3;
    pts.push({ x, y: y + r * 0.35 });
  }
  return pts;
}

function star(r: number, points: number, inner = 0.35, n = 12): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < points; i++) {
    const a0 = (i / points) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 0.5) / points) * Math.PI * 2 - Math.PI / 2;
    const a2 = ((i + 1) / points) * Math.PI * 2 - Math.PI / 2;
    const tip = { x: Math.cos(a0) * r, y: Math.sin(a0) * r };
    const val = { x: Math.cos(a1) * r * inner * 0.45, y: Math.sin(a1) * r * inner * 0.45 };
    const tip2 = { x: Math.cos(a2) * r, y: Math.sin(a2) * r };
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      pts.push({ x: u * u * tip.x + 2 * u * t * val.x + t * t * tip2.x, y: u * u * tip.y + 2 * u * t * val.y + t * t * tip2.y });
    }
  }
  return pts;
}

function heart(r: number, n = 60): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push({ x: (x / 17) * r, y: (y / 17) * r });
  }
  return pts;
}

function circle(r: number, n = 24, sx = 1): Vec[] {
  return Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * Math.PI * 2) * r * sx, y: Math.sin((i / n) * Math.PI * 2) * r }));
}

export function renderMark(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect } {
  const p = el.props;
  const u = ctx.u;
  const kind = String(p.kind);
  const rng = new Rng(el.seed);
  const hand = resolveHand(p.hand, u, ctx.draft);
  const stroke = resolveStroke(p.stroke, hand, u, ctx.bag, [...el.path, "stroke"]);
  const color = parseColor((p.color as string) ?? "black") ?? BLACK;
  const sizeV = p.size;
  const s0 = Array.isArray(sizeV) ? toMm(sizeV[0] as string, u) : toMm((sizeV as string) ?? `${6 * u.k}mm`, u);
  const s = s0 * (typeof p.scale === "number" ? p.scale : Array.isArray(p.scale) ? Number(p.scale[0]) : 1);
  const fill = parsePaint(p.fill ?? "none", { u, box: { x: 0, y: 0, w: s, h: s }, seed: el.seed, bag: ctx.bag, path: [...el.path, "fill"] });
  const pc = placeCtx(ctx, el);
  // target-based default position
  let at: Vec | null = null;
  let tbox: Rect | null = null;
  if (typeof p.target === "string") {
    const t = ctx.refs.target(p.target, ctx.panel?.panel.id);
    if (!t) ctx.bag.error("REF_NOT_FOUND", `mark target "${p.target}" not found`, { path: [...el.path, "target"] });
    else {
      tbox = t.regions.face?.bbox ?? t.bbox;
      at = { x: tbox.x + tbox.w / 2, y: tbox.y };
    }
  }
  // `at: taro1.face` also tells face-aware marks (blush) the face box
  if (!tbox && typeof p.at === "string" && p.at.includes(".")) {
    const [rid, rname] = p.at.split(".");
    const t = ctx.refs.target(rid, ctx.panel?.panel.id);
    const rg = t?.regions[rname];
    if (rg) tbox = rg.bbox;
  }
  const pl = place(p, s, s, pc, at ?? undefined);
  const c = { x: pl.bbox.x + pl.bbox.w / 2, y: pl.bbox.y + pl.bbox.h / 2 };
  const rotA = p.rotate !== undefined ? parseAngle(p.rotate as string) : 0;
  const m: MarkCtx = {
    rng,
    s,
    w: stroke.width,
    fill,
    inks: [],
    fills: [],
    line: (pts, o = {}) => m.inks.push(...inkLine(pts, { ...stroke, width: o.w ?? stroke.width }, hand, rng.fork("m"), { taperIn: o.tin !== false, taperOut: o.tout !== false, ruler: o.ruler, inkPool: false })),
    shape: (pts, f, smooth = true) => {
      const res = inkShape({ pts, closed: true, smooth }, { line: stroke, hand, rng: rng.fork("ms"), strokes: 1 });
      m.fills.push({ poly: res.fill, paint: f === undefined ? fill : f });
      m.inks.push(...res.inks);
    },
  };
  const count = typeof p.count === "number" ? p.count : 1;
  const W = (k: number) => stroke.width * k;
  if (kind === "asset") {
    // a mark drawn from an image asset (e.g. a hand-drawn manpu supplied as PNG)
    const info = typeof p.asset === "string" ? ctx.assets.get(p.asset) : undefined;
    if (!info || info.missing) {
      ctx.bag.error("ASSET_NOT_FOUND", `mark asset "${String(p.asset)}" not found`, { path: [...el.path, "asset"] });
      return { nodes: [], bbox: pl.bbox };
    }
    const w = s;
    const h = (s * info.height) / info.width;
    const ca = Math.cos(rotA);
    const sa = Math.sin(rotA);
    const fx = p.flip === "x" || p.flip === "xy" || p.flip === true ? -1 : 1;
    const fy = p.flip === "y" || p.flip === "xy" ? -1 : 1;
    const image: Node = { kind: "image", assetKey: info.key, dest: { x: -w / 2, y: -h / 2, w, h }, sourceRect: { x: 0, y: 0, w: info.width, h: info.height }, transform: [ca * fx, sa * fx, -sa * fy, ca * fy, c.x, c.y], smoothing: "high", lineart: info.kind === "lineart", monoLpi: 60, filters: [], tag: tag(el, "art") };
    return { nodes: [{ kind: "group", opacity: typeof p.opacity === "number" ? p.opacity : undefined, blend: resolveAssetBlend(info, p.blend), children: [image] }], bbox: pl.bbox };
  }
  switch (kind) {
    case "sweat":
      for (let i = 0; i < count; i++) {
        const off = { x: c.x + i * s * 0.7 + rng.range(-0.1, 0.1) * s, y: c.y + i * s * 0.35 };
        const sc = 1 - i * 0.18;
        m.shape(T(drop(s * 0.32), off, rotA + rng.range(-0.15, 0.15), sc), fill ?? { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }, true);
        m.line(T([{ x: s * 0.08, y: -s * 0.02 }, { x: s * 0.14, y: s * 0.12 }], off, rotA, sc), { w: W(0.8) });
      }
      break;
    case "sweat-burst":
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (i - (count - 1) / 2) * 0.55 + rng.range(-0.1, 0.1);
        const d = s * 0.45;
        const off = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
        m.shape(T(drop(s * 0.12), off, a + Math.PI / 2 + Math.PI, 1), fill ?? { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }, true);
      }
      break;
    case "anger": {
      const v = (p.variant as string) ?? "cross";
      for (let q = 0; q < 4; q++) {
        const a = rotA + (q * Math.PI) / 2;
        if (v === "vein") m.line(T([{ x: 0.08 * s, y: -0.5 * s }, { x: 0.2 * s, y: -0.25 * s }, { x: 0.12 * s, y: -0.05 * s }], c, a), { w: W(1.6) });
        else {
          // the classic 💢: four curved corners around an empty centre, ends flaring outward
          const pts: { x: number; y: number }[] = [];
          const q = (A: number[], C: number[], B: number[], t: number) => ({ x: s * ((1 - t) * (1 - t) * A[0] + 2 * t * (1 - t) * C[0] + t * t * B[0]), y: s * ((1 - t) * (1 - t) * A[1] + 2 * t * (1 - t) * C[1] + t * t * B[1]) });
          // two arms meeting at a corner that points at the centre, each bowing outward like a vein
          for (let i = 0; i <= 8; i++) pts.push(q([0.06, -0.5], [0.24, -0.3], [0.13, -0.13], i / 8));
          for (let i = 1; i <= 8; i++) pts.push(q([0.13, -0.13], [0.3, -0.24], [0.5, -0.06], i / 8));
          m.line(T(pts, c, a), { w: W(1.7) });
        }
      }
      break;
    }
    case "blush": {
      const n = Number(p.lines ?? 5);
      const a = parseAngle((p.angle as string) ?? "60deg");
      // on a face: one patch on each cheek, below and outside the eyes
      const centres = tbox ? [{ x: tbox.x + tbox.w * 0.24, y: tbox.y + tbox.h * 0.7 }, { x: tbox.x + tbox.w * 0.76, y: tbox.y + tbox.h * 0.7 }] : [c];
      const sc = tbox ? Math.min(s, tbox.w * 0.28) : s;
      for (const cc of centres)
        for (let i = 0; i < n; i++) {
          const x = (i - (n - 1) / 2) * sc * 0.2;
          const l = sc * rng.range(0.32, 0.46);
          const d = { x: Math.cos(a), y: Math.sin(a) };
          m.line([{ x: cc.x + x - (d.x * l) / 2, y: cc.y - (d.y * l) / 2 }, { x: cc.x + x + (d.x * l) / 2, y: cc.y + (d.y * l) / 2 }], { w: W(0.8) });
        }
      break;
    }
    case "surprise": {
      const n = Number(p.lines ?? 4);
      const spread = parseAngle((p.spread as string) ?? "70deg");
      const base = tbox ? { x: tbox.x + tbox.w / 2, y: tbox.y + tbox.h * 0.35 } : c;
      const R0 = tbox ? Math.max(tbox.w, tbox.h) * 0.55 : s * 0.4;
      for (const side of [-1, 1]) {
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + side * (spread * 0.35 + (i / Math.max(1, n - 1)) * spread * 0.5) + rng.range(-0.05, 0.05);
          const r0 = R0 * rng.range(1.0, 1.08);
          const l = s * rng.range(0.35, 0.55);
          const d = { x: Math.cos(a), y: Math.sin(a) };
          m.line([{ x: base.x + d.x * r0, y: base.y + d.y * r0 }, { x: base.x + d.x * (r0 + l), y: base.y + d.y * (r0 + l) }], { w: W(1.2), tout: true, tin: false });
        }
      }
      break;
    }
    case "sparkle": {
      const pts = Number(p.points ?? 4);
      for (let i = 0; i < count; i++) {
        const off = { x: c.x + (i === 0 ? 0 : rng.range(-1.2, 1.2) * s), y: c.y + (i === 0 ? 0 : rng.range(-1, 1) * s) };
        const sc = i === 0 ? 1 : rng.range(0.4, 0.75);
        m.shape(T(star(s * 0.5, pts), off, rotA + rng.range(-0.1, 0.1), sc), fill ?? { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }, false);
      }
      break;
    }
    case "heart":
      m.shape(T(heart(s * 0.5), c, rotA), fill, true);
      break;
    case "exclamation":
    case "question": {
      for (let i = 0; i < count; i++) {
        const off = { x: c.x + (i - (count - 1) / 2) * s * 0.45, y: c.y };
        if (kind === "exclamation") {
          m.shape(T([{ x: -0.12 * s, y: -0.5 * s }, { x: 0.12 * s, y: -0.5 * s }, { x: 0.03 * s, y: 0.18 * s }, { x: -0.03 * s, y: 0.18 * s }], off, rotA + 0.08), { type: "solid", color }, false);
        } else {
          const q: Vec[] = [];
          for (let k = 0; k <= 16; k++) {
            const a = Math.PI * 1.05 - (k / 16) * Math.PI * 1.45;
            q.push({ x: Math.cos(a) * 0.22 * s, y: -0.28 * s - Math.sin(a) * 0.2 * s });
          }
          q.push({ x: 0.02 * s, y: 0.0 * s }, { x: 0, y: 0.16 * s });
          m.line(T(q, off, rotA), { w: W(2.2), tin: true, tout: true });
        }
        m.shape(T(circle(0.07 * s), { x: off.x, y: off.y + 0.36 * s }), { type: "solid", color }, true);
      }
      break;
    }
    case "motion": {
      const n = Number(p.lines ?? 3);
      const dir = parseAngle((p.direction as string) ?? "0deg");
      const arc = parseAngle((p.arc as string) ?? "60deg");
      for (let i = 0; i < n; i++) {
        const r = s * (0.3 + i * 0.12);
        const pts: Vec[] = [];
        for (let k = 0; k <= 12; k++) {
          const a = dir - arc / 2 + (arc * k) / 12;
          pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
        }
        m.line(pts, { w: W(1) });
      }
      break;
    }
    case "tremble": {
      const box = tbox ?? pl.bbox;
      const pairs = Number(p.pairs ?? 2);
      for (const side of [-1, 1]) {
        const x0 = side < 0 ? box.x - s * 0.25 : box.x + box.w + s * 0.25;
        for (let i = 0; i < pairs; i++) {
          const x = x0 + side * i * s * 0.22;
          const y = box.y + box.h * (0.3 + i * 0.05);
          m.line([{ x, y }, { x: x + side * s * 0.05, y: y + s * 0.5 }], { w: W(1) });
        }
      }
      break;
    }
    case "dots":
      for (let i = 0; i < Number(p.count ?? 3); i++) m.shape(T(circle(0.07 * s), { x: c.x + (i - 1) * s * 0.3, y: c.y }), { type: "solid", color }, true);
      break;
    case "note": {
      if (p.variant === "beamed") {
        // two eighth notes joined by a beam (♫)
        for (const dx of [-0.28, 0.22]) {
          m.shape(T(circle(0.13 * s, 20, 1.35), { x: c.x + dx * s - 0.08 * s, y: c.y + 0.32 * s }, -0.4), { type: "solid", color }, true);
          m.line([{ x: c.x + dx * s + 0.06 * s, y: c.y + 0.3 * s }, { x: c.x + dx * s + 0.06 * s, y: c.y - 0.38 * s + (dx > 0 ? -0.06 * s : 0) }], { w: W(1.1), tin: false, tout: false });
        }
        m.shape([{ x: c.x - 0.22 * s, y: c.y - 0.42 * s }, { x: c.x + 0.28 * s, y: c.y - 0.5 * s }, { x: c.x + 0.28 * s, y: c.y - 0.4 * s }, { x: c.x - 0.22 * s, y: c.y - 0.32 * s }], { type: "solid", color }, false);
        break;
      }
      m.shape(T(circle(0.16 * s, 20, 1.35), { x: c.x - 0.1 * s, y: c.y + 0.3 * s }, -0.4), { type: "solid", color }, true);
      m.line([{ x: c.x + 0.1 * s, y: c.y + 0.28 * s }, { x: c.x + 0.1 * s, y: c.y - 0.45 * s }], { w: W(1.2), tin: false, tout: false });
      m.line([{ x: c.x + 0.1 * s, y: c.y - 0.45 * s }, { x: c.x + 0.32 * s, y: c.y - 0.2 * s }, { x: c.x + 0.28 * s, y: c.y - 0.02 * s }], { w: W(1.4), tin: false });
      break;
    }
    case "zzz": {
      // small -> large, stepping up and to the right without overlapping
      const n = Number(p.count ?? 3);
      const sizes = Array.from({ length: n }, (_, i) => s * (0.2 + i * 0.1));
      let ox = c.x - s * 0.35;
      let oy = c.y + s * 0.3;
      for (let i = 0; i < n; i++) {
        const sz = sizes[i];
        if (i > 0) {
          ox += (sizes[i - 1] + sz) * 0.5 + s * 0.1;
          oy -= (sizes[i - 1] + sz) * 0.5 + s * 0.04;
        }
        const o = { x: ox, y: oy };
        m.line([{ x: o.x - sz / 2, y: o.y - sz / 2 }, { x: o.x + sz / 2, y: o.y - sz / 2 }, { x: o.x - sz / 2, y: o.y + sz / 2 }, { x: o.x + sz / 2, y: o.y + sz / 2 }], { w: W(1.1) });
      }
      break;
    }
    case "steam":
    case "sigh": {
      const n = Number(p.puffs ?? 3);
      for (let i = 0; i < n; i++) {
        const pts: Vec[] = [];
        const x0 = c.x + (i - (n - 1) / 2) * s * 0.3;
        for (let k = 0; k <= 16; k++) {
          const t = k / 16;
          pts.push({ x: x0 + Math.sin(t * Math.PI * 2 + i) * s * 0.08, y: c.y + s * 0.4 - t * s * 0.8 });
        }
        m.line(pts, { w: W(1) });
      }
      break;
    }
    case "spiral": {
      const turns = Number(p.turns ?? 2.5);
      const pts: Vec[] = [];
      for (let k = 0; k <= 60; k++) {
        const t = k / 60;
        const a = t * turns * Math.PI * 2;
        pts.push({ x: c.x + Math.cos(a) * t * s * 0.5, y: c.y + Math.sin(a) * t * s * 0.5 });
      }
      m.line(pts, { w: W(1) });
      break;
    }
    case "tears": {
      const n = Number(p.streams ?? 2);
      for (let i = 0; i < n; i++) {
        const x = c.x + (i - (n - 1) / 2) * s * 0.4;
        m.line([{ x, y: c.y - s * 0.4 }, { x: x + rng.range(-0.05, 0.05) * s, y: c.y }, { x: x + rng.range(-0.08, 0.08) * s, y: c.y + s * 0.5 }], { w: W(1.6), tin: false });
      }
      break;
    }
    case "shine":
    case "pop":
    case "idea": {
      const n = Number(p.rays ?? (kind === "shine" ? 8 : 7));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng.range(-0.08, 0.08) - (kind === "idea" ? 0 : 0);
        const r0 = s * (kind === "shine" ? 0.1 : 0.28);
        const r1 = s * (i % 2 === 0 ? 0.5 : 0.38);
        m.line([{ x: c.x + Math.cos(a) * r0, y: c.y + Math.sin(a) * r0 }, { x: c.x + Math.cos(a) * r1, y: c.y + Math.sin(a) * r1 }], { w: W(1), ruler: true });
      }
      if (kind === "idea") m.shape(T(circle(0.18 * s, 24), c), { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }, true);
      break;
    }
    case "pale": {
      const box = tbox ?? pl.bbox;
      const n = Number(p.lines ?? 6);
      for (let i = 0; i < n; i++) {
        const x = box.x + box.w * (0.15 + (0.7 * i) / Math.max(1, n - 1));
        const l = box.h * rng.range(0.25, 0.45);
        m.line([{ x, y: box.y + box.h * 0.05 }, { x, y: box.y + box.h * 0.05 + l }], { w: W(0.8), tin: false, ruler: true });
      }
      break;
    }
    case "dizzy-stars": {
      const n = Number(p.count ?? 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const off = { x: c.x + Math.cos(a) * s * 0.5, y: c.y + Math.sin(a) * s * 0.18 };
        m.shape(T(star(s * 0.12, 5, 0.9), off, rng.range(0, 1)), { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }, false);
      }
      break;
    }
    case "snot-bubble":
      m.shape(T(circle(0.4 * s, 28), c), { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }, true);
      m.line(T([{ x: -0.15 * s, y: -0.12 * s }, { x: -0.05 * s, y: -0.22 * s }], c), { w: W(0.7) });
      break;
    default: {
      const def = activePlugins()?.marks.get(kind);
      if (def) {
        const nodes = runPluginDrawable(def, el, ctx, { rng, hand, stroke, bounds: pl.bbox, center: c, size: s, contains: (q) => q.x >= pl.bbox.x && q.y >= pl.bbox.y && q.x <= pl.bbox.x + pl.bbox.w && q.y <= pl.bbox.y + pl.bbox.h });
        return { nodes, bbox: pl.bbox };
      }
      ctx.bag.error("SCHEMA_ENUM", `unknown mark kind "${kind}"`, { path: [...el.path, "kind"] });
    }
  }
  const t = tag(el, "ink");
  const nodes: Node[] = [];
  for (const f of m.fills) {
    const fn = fillNode(f.poly, f.paint, tag(el, "fill"));
    if (fn) nodes.push(fn);
  }
  nodes.push(...inksToNodes(m.inks, color, t));
  void resolvePoint;
  // flip mirrors the drawn mark about its centre
  const fx = p.flip === "x" || p.flip === "xy" || p.flip === true;
  const fy = p.flip === "y" || p.flip === "xy";
  if (fx || fy) return { nodes: [{ kind: "group", transform: [fx ? -1 : 1, 0, 0, fy ? -1 : 1, fx ? 2 * c.x : 0, fy ? 2 * c.y : 0], children: nodes }], bbox: pl.bbox };
  return { nodes, bbox: pl.bbox };
}
