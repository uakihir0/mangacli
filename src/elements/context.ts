import type { DiagnosticBag } from "../core/diagnostics.js";
import type { UnitContext } from "../core/units.js";
import type { FontRegistry } from "../fonts/registry.js";
import { type Rect, type Vec, applyMat } from "../geom/vec.js";
import type { PageGeom, PanelGeom } from "../layout/page.js";
import { type PlaceCtx, RefRegistry } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import type { AssetRegistry } from "../render/assets.js";
import type { Node, NodeTag } from "../render/ir.js";

export interface ElemCtx {
  u: UnitContext;
  geom: PageGeom;
  refs: RefRegistry;
  bag: DiagnosticBag;
  fonts: FontRegistry;
  assets: AssetRegistry;
  lang: string;
  defaultLang: string;
  draft: boolean;
  panel?: PanelGeom;
  coordsBox: Rect;
  panelPoly?: Vec[];
  characters: Record<string, Record<string, unknown>>;
  /** output resolution for asset resolution checks */
  outputDpi: number;
  /** children of a sized group: coordinates are local, so the page safe area does not apply */
  localFrame?: boolean;
  /** coarse alpha maps of the panel's character art (tails stop short of the figures) */
  silhouettes?: Silhouette[];
}

export interface Silhouette {
  id: string;
  inv: import("../geom/vec.js").Matrix;
  w: number;
  h: number;
  gw: number;
  gh: number;
  alpha: Uint8Array;
}

/** whether a page point falls on the opaque part of a silhouette */
export function silhouetteHit(s: Silhouette, p: Vec): boolean {
  const q = applyMat(s.inv, p);
  const gx = Math.floor((q.x / s.w) * s.gw);
  const gy = Math.floor((q.y / s.h) * s.gh);
  return gx >= 0 && gy >= 0 && gx < s.gw && gy < s.gh && s.alpha[gy * s.gw + gx] > 128;
}

export function placeCtx(ctx: ElemCtx, el: RElement): PlaceCtx {
  const textual = el.type === "balloon" || el.type === "text";
  const safeBox = textual && ctx.u.units !== "px" && !ctx.localFrame ? ctx.geom.safe : undefined;
  return { u: ctx.u, coordsBox: ctx.coordsBox, refs: ctx.refs, panelId: ctx.panel?.panel.id, bag: ctx.bag, path: el.path, safeBox };
}

export function tag(el: RElement, role: NodeTag["role"], sep?: string): NodeTag {
  const defSep: Record<string, string> = { image: "art", balloon: "balloon", text: "text", sfx: "sfx", effect: "fx", fill: "fx", mark: "fx", scatter: "fx", draw: "fx", group: "fx" };
  return { elementId: el.id, elementType: el.type, role, separation: (el.props.separation as string) ?? sep ?? defSep[el.type] ?? "fx" };
}

export interface ElementOutput {
  nodes: Node[];
  bbox: Rect;
  /** obstacles for auto-placement (text etc.) */
  obstacle?: boolean;
}
