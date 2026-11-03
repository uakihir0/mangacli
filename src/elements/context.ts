import type { DiagnosticBag } from "../core/diagnostics.js";
import type { UnitContext } from "../core/units.js";
import type { FontRegistry } from "../fonts/registry.js";
import type { Rect, Vec } from "../geom/vec.js";
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
}

export function placeCtx(ctx: ElemCtx, el: RElement): PlaceCtx {
  const textual = el.type === "balloon" || el.type === "text";
  const safeBox = textual && ctx.u.units !== "px" ? ctx.geom.safe : undefined;
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
