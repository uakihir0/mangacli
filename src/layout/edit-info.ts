// Geometry recorded for the browser editor (`mangacli edit`, spec 12.3.12): where each element was placed and
// where the layout put its dividers, so that a drag on the page can be written back as a YAML value.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Rect, Vec } from "../geom/vec.js";

/** a call of `place()`: the element's anchor point `at` (offset included) and its unrotated box */
export interface PlacementRecord {
  frame: Rect;
  at: Vec;
  offset: Vec;
  uv: [number, number];
  w: number;
  h: number;
  rotate: number;
  scale: [number, number];
}

/** the editable geometry of an element, in page mm */
export interface ElementEdit {
  /** the coordinate box `at` is written in */
  frame: Rect;
  /** the point the element's `anchor` sits on (offset included) */
  at: Vec;
  /** the element's own offset, in mm */
  offset: Vec;
  uv: [number, number];
  /** the unrotated placement box */
  box: Rect;
  /** rotation in radians, and the point it turns about */
  rotate: number;
  pivot: Vec;
  /** what `size` means for this element (the body of a balloon), in mm */
  size?: [number, number];
  fontSize?: number;
  /** balloon outline (page mm) and tail tips */
  body?: Vec[];
  center?: Vec;
  tails?: { tip: Vec; root: Vec }[];
}

/** a boundary between two layout slots that can be dragged */
export interface LayoutDivider {
  /** rows: between rows i and i+1; cols: in row `row` between cols i and i+1; split: in the split node at `node` (child indices) */
  kind: "rows" | "cols" | "split";
  row?: number;
  node?: number[];
  index: number;
  /** "rows" boundaries are horizontal (move in y), "cols" vertical (move in x) */
  axis: "x" | "y";
  /** the boundary's centre line across its region, page mm */
  a: Vec;
  b: Vec;
  /** sizes in mm of every slot in this run, and the raw specs (number ratio or length) */
  sizes: number[];
  specs: (number | string)[];
  /** the span the slant is measured over (width for horizontal lines, height for vertical) */
  span: number;
  slant: number;
  rtl: boolean;
}

/** a straight split line (`split: { line }`): its points as written, relative to the parent's box */
export interface LayoutLine {
  node: number[];
  a: Vec;
  b: Vec;
  box: Rect;
}

/** where a layout slot comes from */
export type LayoutSlot = { kind: "rows"; row: number; col: number } | { kind: "split"; node: number[] } | { kind: "free" } | { kind: "single" };

export interface LayoutEdit {
  mode: "rows" | "split" | "free" | "single" | "template";
  rtl: boolean;
  area: Rect;
  dividers: LayoutDivider[];
  lines: LayoutLine[];
  /** panel id -> its slot */
  slots: Record<string, LayoutSlot>;
  /** panel id -> its slot's polygon before bleed (page mm) */
  polys: Record<string, Vec[]>;
}

export interface EditStore {
  placements: Map<string, PlacementRecord>;
  layout?: LayoutEdit;
}

const store = new AsyncLocalStorage<EditStore>();

export function withEditStore<T>(s: EditStore, fn: () => T): T {
  return store.run(s, fn);
}

export function editStore(): EditStore | undefined {
  return store.getStore();
}

export const pathKey = (path: (string | number)[]) => path.join("\u0000");

export function recordPlacement(path: (string | number)[], rec: PlacementRecord): void {
  store.getStore()?.placements.set(pathKey(path), rec);
}
