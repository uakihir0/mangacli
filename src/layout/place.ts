// Element placement & references (spec 3.6, 3.7.2, 5.3).
import type { DiagnosticBag } from "../core/diagnostics.js";
import { type UnitContext, parseAngle, parseLength, quantityToMm, toMm } from "../core/units.js";
import { type Matrix, type Rect, type Vec, applyMat, matMul, matRotate, matScale, matTranslate } from "../geom/vec.js";
import type { GroupNode } from "../render/ir.js";

type Obj = Record<string, unknown>;

export const KEYWORDS: Record<string, [number, number]> = {
  "top-left": [0, 0],
  top: [0.5, 0],
  "top-right": [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  "bottom-left": [0, 1],
  bottom: [0.5, 1],
  "bottom-right": [1, 1],
};

export interface RefTarget {
  id: string;
  type: string;
  bbox: Rect;
  anchors: Record<string, Vec>;
  regions: Record<string, { poly: Vec[]; bbox: Rect }>;
  character?: string;
  panelId?: string;
  shape?: Vec[];
  /** for images: page matrix mapping image px -> page mm and asset key (alpha regions) */
  imagePx?: { matrix: Matrix; assetKey: string; w: number; h: number };
  imageSilhouette?: GroupNode;
}

export class RefRegistry {
  private map = new Map<string, RefTarget>();
  private chars: { char: string; panelId?: string; target: RefTarget; order: number }[] = [];
  private panels = new Map<string, Set<string>>();
  constructor(private anchorPriority: (char: string) => string[]) {}
  add(t: RefTarget, order = 0) {
    this.map.set(t.id, t);
    if (t.character) this.chars.push({ char: t.character, panelId: t.panelId, target: t, order });
  }
  get(id: string): RefTarget | undefined {
    return this.map.get(id);
  }
  includeInPanel(id: string, panelId: string) {
    const ids = this.panels.get(id) ?? new Set<string>();
    ids.add(panelId);
    this.panels.set(id, ids);
  }
  character(char: string, panelId?: string): RefTarget | undefined {
    const inPanel = this.chars.filter((c) => c.char === char && (panelId === undefined || c.panelId === panelId || (c.panelId === undefined && this.panels.get(c.target.id)?.has(panelId))));
    const pool = inPanel.length ? inPanel : panelId === undefined ? [] : [];
    pool.sort((a, b) => a.order - b.order);
    return pool[0]?.target;
  }
  /** resolve "id", "id.name" or character id to a point */
  point(ref: string, panelId: string | undefined): Vec | null {
    const [id, name, sub] = ref.split(".", 3);
    let t = this.map.get(id);
    let isChar = false;
    if (!t) {
      t = this.character(id, panelId);
      isChar = !!t;
    }
    if (!t) return null;
    if (name) {
      if (t.anchors[name]) return t.anchors[name];
      if (t.regions[name]) return sub && KEYWORDS[sub] ? boxPoint(t.regions[name].bbox, KEYWORDS[sub]) : center(t.regions[name].bbox);
      if (KEYWORDS[name]) return boxPoint(t.bbox, KEYWORDS[name]);
      return null;
    }
    if (isChar || t.type === "image") {
      for (const a of this.anchorPriority(t.character ?? "")) {
        if (t.anchors[a]) return t.anchors[a];
        if (t.regions[a]) return center(t.regions[a].bbox);
      }
      if (isChar) return { x: t.bbox.x + t.bbox.w / 2, y: t.bbox.y + t.bbox.h * 0.12 };
    }
    return center(t.bbox);
  }
  target(ref: string, panelId?: string): RefTarget | undefined {
    const [id] = ref.split(".", 2);
    return this.map.get(id) ?? this.character(id, panelId);
  }
  all(): RefTarget[] {
    return [...this.map.values()];
  }
}

export function center(r: Rect): Vec {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function boxPoint(r: Rect, uv: [number, number]): Vec {
  return { x: r.x + r.w * uv[0], y: r.y + r.h * uv[1] };
}

export interface PlaceCtx {
  u: UnitContext;
  coordsBox: Rect;
  /** for text-bearing elements: `place` stays inside this box */
  safeBox?: Rect;
  refs: RefRegistry;
  panelId?: string;
  bag: DiagnosticBag;
  path: (string | number)[];
}

export function lenX(v: unknown, ctx: PlaceCtx): number {
  return toMm(v as string, { ...ctx.u, base: ctx.coordsBox.w });
}
export function lenY(v: unknown, ctx: PlaceCtx): number {
  return toMm(v as string, { ...ctx.u, base: ctx.coordsBox.h });
}

/** resolve a Point (array, keyword, or reference) to page coords */
export function resolvePoint(v: unknown, ctx: PlaceCtx): Vec | null {
  if (Array.isArray(v)) return { x: ctx.coordsBox.x + lenX(v[0], ctx), y: ctx.coordsBox.y + lenY(v[1], ctx) };
  if (typeof v === "string") {
    if (KEYWORDS[v]) return boxPoint(ctx.coordsBox, KEYWORDS[v]);
    const p = ctx.refs.point(v, ctx.panelId);
    if (!p) ctx.bag.error("REF_NOT_FOUND", `reference "${v}" not found`, { path: ctx.path });
    return p;
  }
  return null;
}

export interface Placement {
  matrix: Matrix; // element local (0..w,0..h) -> page
  w: number;
  h: number;
  bbox: Rect; // page-space AABB
  at: Vec;
}

export function sizeValue(v: unknown, base: number, ctx: PlaceCtx): number | "auto" {
  if (v === "auto" || v === undefined) return "auto";
  const q = parseLength(v as string);
  if (!q) return "auto";
  return quantityToMm(q, { ...ctx.u, base });
}

/** compute placement for an element of given size */
export function place(props: Obj, w: number, h: number, ctx: PlaceCtx, defaultAt?: Vec, defaultAnchor: [number, number] = [0.5, 0.5]): Placement {
  let anchorUV = defaultAnchor;
  let at: Vec | null = null;
  if (typeof props.place === "string" && KEYWORDS[props.place]) {
    const inset = props.inset !== undefined ? toMm(props.inset as string, ctx.u) : 2 * ctx.u.k;
    let r = { x: ctx.coordsBox.x + inset, y: ctx.coordsBox.y + inset, w: ctx.coordsBox.w - 2 * inset, h: ctx.coordsBox.h - 2 * inset };
    if (ctx.safeBox) {
      const s = ctx.safeBox;
      const x0 = Math.max(r.x, s.x);
      const y0 = Math.max(r.y, s.y);
      const x1 = Math.min(r.x + r.w, s.x + s.w);
      const y1 = Math.min(r.y + r.h, s.y + s.h);
      if (x1 > x0 && y1 > y0) r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    anchorUV = KEYWORDS[props.place];
    at = boxPoint(r, anchorUV);
  }
  if (props.at !== undefined) at = resolvePoint(props.at, ctx);
  if (typeof props.anchor === "string" && KEYWORDS[props.anchor]) anchorUV = KEYWORDS[props.anchor];
  else if (Array.isArray(props.anchor)) anchorUV = props.anchor as [number, number];
  if (!at) at = defaultAt ?? center(ctx.coordsBox);
  if (Array.isArray(props.offset)) at = { x: at.x + lenX(props.offset[0], ctx), y: at.y + lenY(props.offset[1], ctx) };
  const rot = props.rotate !== undefined ? parseAngle(props.rotate as string) : 0;
  const sc = props.scale;
  const sx = Array.isArray(sc) ? (sc[0] as number) : typeof sc === "number" ? sc : 1;
  const sy = Array.isArray(sc) ? (sc[1] as number) : typeof sc === "number" ? sc : 1;
  const ap = { x: w * anchorUV[0], y: h * anchorUV[1] };
  const m = matMul(matTranslate(at.x, at.y), matMul(matRotate(rot), matMul(matScale(sx, sy), matTranslate(-ap.x, -ap.y))));
  const corners = [applyMat(m, { x: 0, y: 0 }), applyMat(m, { x: w, y: 0 }), applyMat(m, { x: w, y: h }), applyMat(m, { x: 0, y: h })];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  return { matrix: m, w, h, bbox, at };
}
