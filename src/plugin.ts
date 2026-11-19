// Plugins (spec 11.8): extra balloon shapes, effects, marks, pens, hand presets, layout templates,
// page sizes, styles and processing hooks. The active plugin set is scoped to one render call.
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Rng } from "./core/random.js";
import { noise1, noise2 } from "./core/random.js";
import type { Vec } from "./geom/vec.js";
import { parseSvgPath, flattenPath } from "./geom/path.js";
import type { HandSpec, PenSpec } from "./ink/presets.js";
import type { DisplayList, Node, Paint } from "./render/ir.js";
import type { PagePreset } from "./model/defaults.js";

type Obj = Record<string, unknown>;
export type PluginPageSize = Omit<PagePreset, "w" | "h" | "unit"> & { width: number; height: number; unit?: "mm" | "px" };

/** a closed outline with chainable transforms (centered coordinates, mm) */
export class Contour {
  constructor(readonly points: Vec[]) {}
  static ellipse(rx: number, ry: number, n = 72): Contour {
    return new Contour(Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * Math.PI * 2) * rx, y: Math.sin((i / n) * Math.PI * 2) * ry })));
  }
  static polygon(pts: ([number, number] | Vec)[]): Contour {
    return new Contour(pts.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p)));
  }
  /** SVG path data in a unit box (0..1), centered on the origin */
  static fromSvgPath(dPath: string): Contour {
    const pts = flattenPath(parseSvgPath(dPath), 0.002).flatMap((c) => c.pts);
    return new Contour(pts.map((p) => ({ x: p.x - 0.5, y: p.y - 0.5 })));
  }
  scale(s: number | { width: number; height: number } | [number, number]): Contour {
    const [sx, sy] = typeof s === "number" ? [s, s] : Array.isArray(s) ? s : [s.width, s.height];
    return new Contour(this.points.map((p) => ({ x: p.x * sx, y: p.y * sy })));
  }
  translate(dx: number, dy: number): Contour {
    return new Contour(this.points.map((p) => ({ x: p.x + dx, y: p.y + dy })));
  }
  rotate(rad: number): Contour {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return new Contour(this.points.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })));
  }
  /** low-frequency radial irregularity (amount relative to size) */
  jitter(amount: number, seed = 1): Contour {
    const cx = this.points.reduce((a, p) => a + p.x, 0) / Math.max(1, this.points.length);
    const cy = this.points.reduce((a, p) => a + p.y, 0) / Math.max(1, this.points.length);
    return new Contour(
      this.points.map((p, i) => {
        const f = 1 + amount * 0.08 * noise1(seed, (i / this.points.length) * 6);
        return { x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f };
      }),
    );
  }
}

export interface ShapeSize {
  width: number;
  height: number;
}

export interface PluginShapeContext {
  rng: Rng;
  irregularity: number;
  contour: typeof Contour;
}

export interface PluginBalloonShape {
  params?: z.ZodType;
  /** closed outline centered on the origin, sized to `size` (mm) */
  outline(ctx: PluginShapeContext, params: Obj, size: ShapeSize): Contour | Vec[];
  /** text-safe area (defaults to the outline shrunk to 70 %) */
  textArea?(ctx: PluginShapeContext, params: Obj, size: ShapeSize): Contour | Vec[];
  defaultTail?: string;
  ruler?: boolean;
}

export interface PluginDrawContext {
  rng: Rng;
  noise: { noise1: typeof noise1; noise2: typeof noise2 };
  hand: HandSpec;
  /** effect: region polygon and bounds (mm); mark: placed box */
  bounds: { x: number; y: number; w: number; h: number };
  center: Vec;
  size: number;
  /** same as bounds (effects: the effect region's bounding box) */
  region: { x: number; y: number; w: number; h: number };
  contains(p: Vec): boolean;
  /** a uniformly random point inside the region (the argument is accepted for readability and ignored) */
  randomPointIn(region?: unknown): Vec;
  /** draw a built-in (or plugin) mark at a point (mm) */
  marks: { draw(kind: string, props: { at: Vec; size?: number; rotate?: number; color?: string } & Record<string, unknown>): Node[] };
  /** draw a hand-inked line (open polyline) */
  line(pts: Vec[], opts?: { width?: number; taperIn?: boolean; taperOut?: boolean; ruler?: boolean }): void;
  /** draw a hand-inked closed shape, filled with `fill` (paper by default; null for none) */
  shape(pts: Vec[], fill?: Paint | string | null): void;
  /** add raw display list nodes */
  push(...nodes: Node[]): void;
  mm(length: string | number): number;
  report(code: string, message: string, severity?: "error" | "warning" | "info"): void;
}

export interface PluginDrawable {
  params?: z.ZodType;
  /** draw with the context helpers (line, shape, push) */
  draw?(ctx: PluginDrawContext, params: Obj): void;
  /** or return display list nodes directly */
  generate?(ctx: PluginDrawContext, params: Obj): Node[] | void;
}

export interface MangaPlugin {
  name: string;
  version?: string;
  /** replace built-ins / earlier plugins with the same names */
  override?: boolean;
  balloonShapes?: Record<string, PluginBalloonShape>;
  effects?: Record<string, PluginDrawable>;
  marks?: Record<string, PluginDrawable>;
  pens?: Record<string, Partial<PenSpec>>;
  handPresets?: Record<string, Partial<HandSpec>>;
  /** expands to a layout object ({ rows } or { split }) */
  layoutTemplates?: Record<string, (params: Obj) => Obj>;
  pageSizes?: Record<string, PluginPageSize>;
  styles?: Record<string, Obj>;
  hooks?: {
    afterLoad?(doc: Obj): Obj | void;
    afterResolve?(resolved: unknown): unknown | void;
    beforeRender?(list: DisplayList): DisplayList | void;
    afterRender?(raster: { data: Uint8ClampedArray; width: number; height: number }): { data: Uint8ClampedArray; width: number; height: number } | void;
  };
}

export function definePlugin(p: MangaPlugin): MangaPlugin {
  return p;
}

export class PluginSet {
  readonly shapes = new Map<string, PluginBalloonShape>();
  readonly effects = new Map<string, PluginDrawable>();
  readonly marks = new Map<string, PluginDrawable>();
  readonly pens = new Map<string, Partial<PenSpec>>();
  readonly hands = new Map<string, Partial<HandSpec>>();
  readonly templates = new Map<string, (params: Obj) => Obj>();
  readonly pageSizes = new Map<string, PluginPageSize>();
  readonly styles: Record<string, Obj> = {};
  readonly conflicts: string[] = [];

  constructor(
    readonly plugins: MangaPlugin[],
    builtins: { shapes: Set<string>; effects: Set<string>; marks: Set<string>; pens: Set<string>; hands: Set<string>; templates: Set<string>; pageSizes: Set<string>; styles: Set<string> },
  ) {
    for (const pl of plugins) {
      const reg = <T>(kind: keyof typeof builtins, map: Map<string, T> | Record<string, T>, entries: Record<string, T> | undefined) => {
        for (const [name, v] of Object.entries(entries ?? {})) {
          const exists = builtins[kind].has(name) || (map instanceof Map ? map.has(name) : name in map);
          if (exists && !pl.override) {
            this.conflicts.push(`${pl.name}: ${String(kind)} "${name}" already exists`);
            continue;
          }
          if (map instanceof Map) map.set(name, v);
          else map[name] = v;
        }
      };
      reg("shapes", this.shapes, pl.balloonShapes);
      reg("effects", this.effects, pl.effects);
      reg("marks", this.marks, pl.marks);
      reg("pens", this.pens, pl.pens);
      reg("hands", this.hands, pl.handPresets);
      reg("templates", this.templates, pl.layoutTemplates);
      reg("pageSizes", this.pageSizes, pl.pageSizes);
      reg("styles", this.styles, pl.styles);
    }
  }

  hook<K extends keyof NonNullable<MangaPlugin["hooks"]>>(name: K, value: Parameters<NonNullable<NonNullable<MangaPlugin["hooks"]>[K]>>[0]): typeof value {
    let v = value;
    for (const pl of this.plugins) {
      const fn = pl.hooks?.[name] as ((x: unknown) => unknown) | undefined;
      if (!fn) continue;
      const r = fn(v);
      if (r !== undefined) v = r as typeof value;
    }
    return v;
  }
}

const store = new AsyncLocalStorage<PluginSet>();

/** the plugin set of the render in progress (undefined outside a render with plugins) */
export function activePlugins(): PluginSet | undefined {
  return store.getStore();
}

export function withPlugins<T>(set: PluginSet | undefined, fn: () => Promise<T>): Promise<T> {
  return set ? store.run(set, fn) : fn();
}

export { z };
