// Display list (spec 2.5). All coordinates in mm, origin at bleed-box top-left.
import type { RGBA } from "../core/color.js";
import type { PathData } from "../geom/path.js";
import type { Matrix, Rect } from "../geom/vec.js";

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn"
  | "hard-light" | "soft-light" | "difference" | "exclusion" | "destination-out";

export type DotShape = "round" | "square" | "ellipse" | "line" | "cross" | "noise";

export interface ToneSpec {
  density: number; // 0..1 (used when no gradient)
  lpi: number;
  angle: number; // radians
  dot: DotShape;
  grain: number; // mm, for noise
  invert: boolean;
  offset: [number, number];
  gradient?: ToneGradient;
  seed: number;
  /** soft edge: density falloff within this distance (mm) from the clip boundary */
  softEdge?: number;
}

export interface ToneGradient {
  type: "linear" | "radial";
  /** linear: unit vector of travel; start/end in mm page coords */
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  /** radial: center & radius */
  center?: { x: number; y: number };
  radius?: number;
  stops: [number, number][]; // [position 0..1, density 0..1]
  easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}

export interface GradientStop {
  offset: number;
  color: RGBA;
}

export type Paint =
  | { type: "solid"; color: RGBA }
  | { type: "tone"; tone: ToneSpec; color: RGBA }
  | { type: "linear-gradient"; x0: number; y0: number; x1: number; y1: number; stops: GradientStop[]; screen?: "am" | "spatter" }
  | { type: "radial-gradient"; cx: number; cy: number; r: number; stops: GradientStop[]; screen?: "am" | "spatter" };

export interface NodeTag {
  elementId: string;
  elementType: string;
  role: "art" | "fill" | "tone" | "ink" | "text" | "frame" | "furniture" | "debug" | "background";
  separation: string;
}

export interface GroupNode {
  kind: "group";
  transform?: Matrix;
  opacity?: number;
  blend?: BlendMode;
  clip?: PathData;
  clipRule?: "nonzero" | "evenodd";
  /** soft-edged clip: the outline blurred by `feather` mm (feathered regions, masks) */
  softClip?: { path: PathData; fillRule: "nonzero" | "evenodd"; feather: number };
  /** render children on their own layer (needed when a child erases with destination-out) */
  isolate?: boolean;
  /** multiply children by the alpha of an image (region mode: alpha) */
  alphaMaskOf?: { matrix: Matrix; assetKey: string; w: number; h: number; invert?: boolean; dilate?: number };
  /** Tint and blur the children's silhouette, replacing their original colors. */
  glow?: { color: RGBA; blur: number; bounds: Rect };
  children: Node[];
  tag?: NodeTag;
}

export interface PathNode {
  kind: "path";
  path: PathData;
  fillRule: "nonzero" | "evenodd";
  paint: Paint | null;
  /** Source ink centerlines for device-dependent mono hairline protection. */
  inkStrokes?: { path: PathData; width: number; outline?: PathData }[];
  inkBasePath?: PathData;
  /** outline stroke (used for text outlines / faux bold); drawn before fill */
  stroke?: { width: number; paint: Paint; join: "round" | "miter" };
  tag?: NodeTag;
}

export interface ImageNode {
  kind: "image";
  assetKey: string;
  /** destination rectangle in mm (before transform), image drawn into it with sourceRect */
  dest: Rect;
  sourceRect: Rect;
  transform?: Matrix;
  smoothing: "high" | "medium" | "none";
  lineart: boolean;
  monoLpi: number;
  filters: ImageFilter[];
  flipX?: boolean;
  flipY?: boolean;
  /** silhouette outlines (largest first): width mm */
  outline?: { w: number; color: RGBA; threshold?: number; join?: "round" | "miter" }[];
  /** drop shadow of the silhouette (mm) */
  shadow?: { dx: number; dy: number; blur: number; color: RGBA };
  tag?: NodeTag;
}

export interface ImageFilter {
  name: string;
  args: (number | string)[];
  /** object form parameters ({ halftone: { lpi: 60 } }) */
  opts?: Record<string, unknown>;
}

export type Node = GroupNode | PathNode | ImageNode;

export interface DisplayList {
  version: 1;
  page: { id: string; index: number };
  size: { width: number; height: number };
  boxes: { bleed: Rect; trim: Rect; baseFrame: Rect; safe: Rect };
  background: Paint | null;
  root: GroupNode;
}

export const solid = (color: RGBA): Paint => ({ type: "solid", color });
