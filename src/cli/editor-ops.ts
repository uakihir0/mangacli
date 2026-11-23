// Operations of the browser editor (spec 12.3.12): a drag or a button on the page becomes a YAML edit.
// All positions are page millimetres (the trim's top-left at 0), as in the render's layout information.

import type { ElementEdit, LayoutEdit } from "../layout/edit-info.js";
import type { Rect, Vec } from "../geom/vec.js";
import { parse as parseYaml } from "yaml";
import { YamlEditError, YamlText } from "./yaml-edit.js";

type Obj = Record<string, unknown>;
type Key = string | number;

export interface ElState {
  id: string;
  type: string;
  page: string;
  panel?: string;
  /** where the element's node starts in the edited text */
  src?: number;
  /** the panel or page node that lists it, and the keys from there (["layers", 2]) */
  owner?: { src: number; keys: Key[] };
  edit?: ElementEdit;
}

export interface PanelState {
  id: string;
  src?: number;
  /** index in the page's `panels` list */
  index: number;
  overlay: boolean;
  box: Rect;
  polygon: Vec[];
}

export interface PageState {
  id: string;
  src?: number;
  layout?: LayoutEdit;
  panels: PanelState[];
  trim: Rect;
}

export interface EditState {
  text: string;
  elements: Map<string, ElState>;
  pages: Map<string, PageState>;
}

export type Op =
  | { op: "move"; id: string; dx: number; dy: number }
  | { op: "resize"; id: string; box: Rect }
  | { op: "rotate"; id: string; deg: number }
  | { op: "tail"; id: string; index: number; tip: Vec }
  | { op: "set"; target: Target; key: Key[]; string?: string; yaml?: string }
  | { op: "unset"; target: Target; key: Key[] }
  | { op: "add"; page: string; panel?: string; kind: "balloon" | "text"; at: Vec; text: string }
  | { op: "remove"; id: string }
  | { op: "duplicate"; id: string }
  | { op: "divider"; page: string; index: number; delta: number }
  | { op: "slant"; page: string; index: number; slant: number }
  | { op: "line"; page: string; index: number; end: 0 | 1; point: Vec }
  | { op: "splitPanel"; panel: string; dir: "h" | "v" }
  | { op: "removePanel"; panel: string }
  | { op: "addPanel"; page: string }
  | { op: "panelShape"; panel: string; points: Vec[]; box: boolean }
  | { op: "toFree"; page: string };

export type Target = { kind: "element" | "panel" | "page"; id: string };

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const mm = (v: number) => `${r1(v)}mm`;
const pct = (v: number, base: number) => `${r1(base ? (v / base) * 100 : 0)}%`;
const deg = (rad: number) => `${r1((rad * 180) / Math.PI)}deg`;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (msg: string): never => {
  throw new YamlEditError(msg);
};

/** a length written like `old`: the same unit family, else mm */
function lengthLike(old: unknown, v: number): string {
  if (typeof old === "string") {
    if (/Q\s*$/.test(old)) return `${r1(v * 4)}Q`;
    if (/pt\s*$/.test(old)) return `${r1((v * 72) / 25.4)}pt`;
  }
  return mm(v);
}

/** a coordinate written like `old`: percent of the frame unless it was a length */
function coordLike(old: unknown, v: number, base: number): string {
  if (typeof old === "number" || (typeof old === "string" && !old.trim().endsWith("%"))) return lengthLike(old, v);
  return pct(v, base);
}

export function applyOp(state: EditState, op: Op): string {
  const y = new YamlText(state.text);
  const el = (id: string) => {
    const e = state.elements.get(id) ?? fail(`unknown element ${id}`);
    if (e.src === undefined) fail(`${id} is not written in this file`);
    return e as ElState & { src: number };
  };
  const geo = (e: ElState) => e.edit ?? fail(`${e.id} cannot be moved here`);
  const pageOf = (id: string) => state.pages.get(id) ?? fail(`unknown page ${id}`);
  const pageSrc = (p: PageState) => (p.src ?? fail(`page ${p.id} is not written in this file`)) as number;

  /** writes the anchor point `at` (offset included) as the element's `at` */
  const writeAt = (e: ElState & { src: number }, at: Vec) => {
    const g = geo(e);
    const own = y.value(e.src) as unknown;
    const props = isObj(own) ? own : {};
    const old = Array.isArray(props.at) ? props.at : undefined;
    const x = at.x - g.offset.x - g.frame.x;
    const yy = at.y - g.offset.y - g.frame.y;
    y.set(e.src, ["at"], [coordLike(old?.[0], x, g.frame.w), coordLike(old?.[1], yy, g.frame.h)], { rootWrap: "text" });
    // a box held to the frame would snap back to its corner
    if (g.attached) y.set(e.src, ["attach"], "none", { rootWrap: "text" });
    if (props.place !== undefined) {
      // `at` replaces `place`; keep the anchor the place keyword gave
      if (props.anchor === undefined && typeof props.place === "string") y.set(e.src, ["anchor"], props.place);
      y.delete(e.src, ["place"]);
    }
  };

  switch (op.op) {
    case "move": {
      const e = el(op.id);
      const g = geo(e);
      writeAt(e, { x: g.at.x + op.dx, y: g.at.y + op.dy });
      break;
    }
    case "resize": {
      const e = el(op.id);
      const g = geo(e);
      const b = op.box;
      if (b.w < 1 || b.h < 1) fail("too small");
      const fx = b.w / g.box.w;
      const fy = b.h / g.box.h;
      const own = y.value(e.src);
      const props = isObj(own) ? own : {};
      if (e.type === "text" || e.type === "sfx") {
        const f = Math.sqrt(fx * fy);
        if (g.fontSize) y.set(e.src, ["fontSize"], lengthLike(props.fontSize, g.fontSize * f), { rootWrap: "text" });
        if (Array.isArray(props.size) && g.size) y.set(e.src, ["size"], [mm(g.size[0] * fx), mm(g.size[1] * fy)]);
      } else if (e.type === "image") {
        y.set(e.src, ["size"], [mm(b.w), "auto"]);
      } else if (g.size) {
        y.set(e.src, ["size"], [mm(g.size[0] * fx), mm(g.size[1] * fy)], { rootWrap: "text" });
      }
      writeAt(e, { x: b.x + b.w * g.uv[0] + (g.at.x - (g.box.x + g.box.w * g.uv[0])), y: b.y + b.h * g.uv[1] + (g.at.y - (g.box.y + g.box.h * g.uv[1])) });
      break;
    }
    case "rotate": {
      const e = el(op.id);
      geo(e);
      const d = ((Math.round(op.deg * 10) / 10) % 360 + 540) % 360 - 180;
      if (Math.abs(d) < 0.05) y.delete(e.src, ["rotate"]);
      else y.set(e.src, ["rotate"], `${r1(d)}deg`, { rootWrap: "text" });
      break;
    }
    case "tail": {
      const e = el(op.id);
      const g = geo(e);
      if (!g.center || !g.body) fail("not a balloon");
      const c = g.center!;
      const d = { x: op.tip.x - c.x, y: op.tip.y - c.y };
      const dist = Math.hypot(d.x, d.y);
      if (dist < 1e-6) fail("the tip is at the centre");
      const dir = { x: d.x / dist, y: d.y / dist };
      const hit = rayExit(c, dir, g.body!);
      if (hit === null || hit >= dist - 0.3) fail("the tip must be outside the balloon");
      const length = dist - hit!;
      const own = y.value(e.src);
      const props = isObj(own) ? own : {};
      const keys: Key[] = Array.isArray(props.tails) ? ["tails", op.index] : ["tail"];
      const frame = g.frame;
      const wrap = (k: Key) => (k === "tail" || typeof k === "number" ? "to" : undefined);
      y.set(e.src, [...keys, "to"], [pct(op.tip.x - frame.x, frame.w), pct(op.tip.y - frame.y, frame.h)], { wrap, rootWrap: "text" });
      y.set(e.src, [...keys, "length"], mm(length), { wrap });
      for (const k of ["direction", "maxLength", "curl"]) y.delete(e.src, [...keys, k]);
      // a tail aimed nearly straight down or up would otherwise be turned aside
      const a = Math.atan2(dir.y, dir.x);
      const vertical = Math.abs(a - Math.PI / 2) < (40 * Math.PI) / 180 || Math.abs(a + Math.PI / 2) < (40 * Math.PI) / 180;
      if (vertical) y.set(e.src, [...keys, "allowVertical"], true, { wrap });
      else y.delete(e.src, [...keys, "allowVertical"]);
      break;
    }
    case "set":
    case "unset": {
      const src = targetSrc(state, op.target);
      if (op.op === "unset") {
        y.delete(src, op.key);
        break;
      }
      let value: unknown = op.string;
      let raw: string | undefined;
      if (op.yaml !== undefined) {
        try {
          value = parseYaml(op.yaml);
        } catch (e) {
          fail((e as Error).message.split("\n")[0]);
        }
        // a one-line value is written as typed
        raw = op.yaml.includes("\n") ? undefined : op.yaml;
      }
      y.set(src, op.key, value, { raw, rootWrap: "text" });
      break;
    }
    case "add": {
      const page = pageOf(op.page);
      const panel = op.panel ? (page.panels.find((p) => p.id === op.panel) ?? fail(`unknown panel ${op.panel}`)) : undefined;
      const frame = panel ? panel.box : page.trim;
      const owner = panel ? (panel.src ?? fail(`panel ${panel.id} is not written in this file`)) : pageSrc(page);
      const at = [pct(op.at.x - frame.x, frame.w), pct(op.at.y - frame.y, frame.h)];
      y.insert(owner as number, ["layers"], Infinity, { [op.kind]: op.text, at });
      break;
    }
    case "remove":
    case "duplicate": {
      const e = el(op.id);
      if (!e.owner) fail(`${op.id} cannot be removed here`);
      const { src, keys } = e.owner!;
      const index = keys[keys.length - 1] as number;
      if (op.op === "remove") y.delete(src, keys);
      else {
        const v = y.value(e.src);
        const copy: Obj = isObj(v) ? { ...v } : { text: v };
        delete copy.id;
        y.insert(src, keys.slice(0, -1), index + 1, copy);
      }
      break;
    }
    case "divider": {
      const page = pageOf(op.page);
      const d = page.layout?.dividers[op.index] ?? fail("unknown divider");
      const i = d.index;
      const move = d.axis === "x" && d.rtl ? -op.delta : op.delta;
      const sizes = d.sizes.slice();
      const min = 5;
      const m = Math.max(min - sizes[i], Math.min(sizes[i + 1] - min, move));
      sizes[i] += m;
      sizes[i + 1] -= m;
      const spec = (j: number) => {
        const s = d.specs[j] ?? 1;
        return typeof s === "number" ? r2((s * sizes[j]) / (d.sizes[j] || 1)) : lengthLike(s, sizes[j]);
      };
      const src = pageSrc(page);
      if (d.kind === "rows") {
        const rowWrap = (k: Key) => (typeof k === "number" ? "cols" : undefined);
        for (const j of [i, i + 1]) y.set(src, ["layout", "rows", j, "height"], spec(j), { wrap: rowWrap });
      } else if (d.kind === "cols") {
        const cols = d.specs.map((s, j) => (j === i || j === i + 1 ? spec(j) : s));
        const row = y.find(src, ["layout", "rows", d.row!]);
        if (row && Array.isArray(y.value(src, ["layout", "rows", d.row!]))) y.set(src, ["layout", "rows", d.row!], cols);
        else y.set(src, ["layout", "rows", d.row!, "cols"], cols);
      } else {
        y.set(src, ["layout", ...nodeKeys(d.node!), "sizes"], d.specs.map((s, j) => (j === i || j === i + 1 ? spec(j) : s)));
      }
      break;
    }
    case "slant": {
      const page = pageOf(op.page);
      const d = page.layout?.dividers[op.index] ?? fail("unknown divider");
      const src = pageSrc(page);
      const lay = y.value(src, ["layout"]);
      const angleOf = (old: unknown) => typeof old === "string" && /(?:deg|rad|turn)\s*$/.test(old);
      const write = (old: unknown) => (Math.abs(op.slant) < 0.05 ? 0 : angleOf(old) ? deg(Math.atan2(op.slant, d.span)) : mm(op.slant));
      if (d.kind === "rows") {
        const old = (isObj(lay) && Array.isArray(lay.rows) && isObj(lay.rows[d.index]) ? (lay.rows[d.index] as Obj).slant : undefined);
        y.set(src, ["layout", "rows", d.index, "slant"], write(old), { wrap: (k) => (typeof k === "number" ? "cols" : undefined) });
      } else {
        const keys: Key[] = d.kind === "cols" ? ["layout", "rows", d.row!, "colSlant"] : ["layout", ...nodeKeys(d.node!), "slant"];
        const old = y.value(src, keys);
        const list = Array.isArray(old) ? old.slice() : [];
        while (list.length < d.sizes.length - 1) list.push(0);
        list[d.index] = write(list[d.index]);
        y.set(src, keys, list, { wrap: (k) => (typeof k === "number" ? "cols" : undefined) });
      }
      break;
    }
    case "line": {
      const page = pageOf(op.page);
      const l = page.layout?.lines[op.index] ?? fail("unknown split line");
      const b = l.box;
      y.set(pageSrc(page), ["layout", ...nodeKeys(l.node), "split", "line", op.end], [pct(op.point.x - b.x, b.w), pct(op.point.y - b.y, b.h)]);
      break;
    }
    case "splitPanel":
    case "removePanel": {
      const { page, panel } = panelOf(state, op.panel);
      const lay = page.layout ?? fail("no layout");
      const src = pageSrc(page);
      if (panel.overlay) {
        if (op.op === "removePanel") y.delete(src, ["panels", panel.index]);
        else fail("an overlay panel cannot be split");
        break;
      }
      if (lay.mode === "template") fail("convert the template to free layout first");
      const slot = lay.slots[panel.id];
      const layout = y.value(src, ["layout"]);
      if (op.op === "splitPanel") {
        if (lay.mode === "free") {
          const box = boundsOf(lay.polys[panel.id] ?? panel.polygon);
          const [a, b] = op.dir === "v" ? halves(box, "x", lay.rtl) : halves(box, "y", false);
          y.set(panel.src ?? fail("panel not in this file"), ["box"], boxValue(a, lay.area));
          y.delete(panel.src!, ["polygon"]);
          y.insert(src, ["panels"], panel.index + 1, { box: boxValue(b, lay.area), layers: [] });
          break;
        }
        const next = splitLayout(layout, lay.mode, slot, op.dir);
        y.insert(src, ["panels"], panel.index + 1, { layers: [] });
        writeLayout(y, src, layout, next);
      } else {
        if (lay.mode === "rows" || lay.mode === "split") writeLayout(y, src, layout, removeSlot(layout, lay.mode, slot));
        y.delete(src, ["panels", panel.index]);
      }
      break;
    }
    case "addPanel": {
      const page = pageOf(op.page);
      if (page.layout?.mode !== "free") fail("panels can be added in free layout");
      y.insert(pageSrc(page), ["panels"], Infinity, { box: ["35%", "35%", "30%", "30%"], layers: [] });
      break;
    }
    case "panelShape": {
      const { page, panel } = panelOf(state, op.panel);
      const lay = page.layout;
      if (lay?.mode !== "free") fail("only free layout panels can be reshaped");
      const psrc = panel.src ?? fail("panel not in this file");
      const area = lay!.area;
      if (op.box) {
        y.set(psrc as number, ["box"], boxValue(boundsOf(op.points), area));
        y.delete(psrc as number, ["polygon"]);
      } else {
        y.set(psrc as number, ["polygon"], op.points.map((p) => [pct(p.x - area.x, area.w), pct(p.y - area.y, area.h)]));
        y.delete(psrc as number, ["box"]);
      }
      break;
    }
    case "toFree": {
      const page = pageOf(op.page);
      const lay = page.layout ?? fail("no layout");
      const src = pageSrc(page);
      const area = lay.area;
      // the panels as they are now, from the last one so that earlier offsets stay valid
      for (const p of [...page.panels].filter((x) => !x.overlay).sort((a, b) => b.index - a.index)) {
        const poly = lay.polys[p.id];
        if (!poly || p.src === undefined) continue;
        const rect = isAxisRect(poly);
        if (rect) y.set(p.src, ["box"], boxValue(rect, area));
        else y.set(p.src, ["polygon"], poly.map((q) => [pct(q.x - area.x, area.w), pct(q.y - area.y, area.h)]));
      }
      const layout = y.value(src, ["layout"]);
      if (isObj(layout) && layout.area !== undefined) y.set(src, ["layout"], { free: true, area: layout.area });
      else if (layout !== undefined) y.set(src, ["layout"], "free");
      else y.set(src, ["layout"], "free");
      break;
    }
  }
  return y.text;
}

function targetSrc(state: EditState, t: Target): number {
  if (t.kind === "element") {
    const e = state.elements.get(t.id);
    if (e?.src === undefined) fail(`${t.id} is not written in this file`);
    return e!.src!;
  }
  if (t.kind === "panel") {
    const p = panelOf(state, t.id).panel;
    if (p.src === undefined) fail(`${t.id} is not written in this file`);
    return p.src!;
  }
  const p = state.pages.get(t.id);
  if (p?.src === undefined) fail(`page ${t.id} is not written in this file`);
  return p!.src!;
}

function panelOf(state: EditState, id: string): { page: PageState; panel: PanelState } {
  for (const page of state.pages.values()) {
    const panel = page.panels.find((p) => p.id === id);
    if (panel) return { page, panel };
  }
  return fail(`unknown panel ${id}`);
}

const nodeKeys = (node: number[]): Key[] => node.flatMap((i) => ["children", i]);

/** distance from `o` along `d` to where the ray leaves the polygon */
function rayExit(o: Vec, d: Vec, poly: Vec[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const e = { x: b.x - a.x, y: b.y - a.y };
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - o.x) * e.y - (a.y - o.y) * e.x) / den;
    const s = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den;
    if (t >= 0 && s >= 0 && s <= 1 && (best === null || t > best)) best = t;
  }
  return best;
}

function boundsOf(pts: Vec[]): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function isAxisRect(poly: Vec[]): Rect | null {
  const b = boundsOf(poly);
  const near = (v: number, a: number) => Math.abs(v - a) < 0.05;
  const onCorner = poly.every((p) => (near(p.x, b.x) || near(p.x, b.x + b.w)) && (near(p.y, b.y) || near(p.y, b.y + b.h)));
  return onCorner && poly.length <= 5 ? b : null;
}

const boxValue = (b: Rect, area: Rect) => [pct(b.x - area.x, area.w), pct(b.y - area.y, area.h), pct(b.w, area.w), pct(b.h, area.h)];

/** two halves of a box with a 2.5 mm gap, in reading order */
function halves(b: Rect, axis: "x" | "y", rtl: boolean): [Rect, Rect] {
  const g = 2.5;
  if (axis === "y") {
    const h = (b.h - g) / 2;
    return [{ ...b, h }, { ...b, y: b.y + h + g, h }];
  }
  const w = (b.w - g) / 2;
  const left = { ...b, w };
  const right = { ...b, x: b.x + w + g, w };
  return rtl ? [right, left] : [left, right];
}

// ---- layout trees -----------------------------------------------------------------

type Layout = unknown;
type Slot = LayoutEdit["slots"][string] | undefined;

const halfSpec = (s: unknown): [unknown, unknown] => {
  if (typeof s === "number") return [r2(s / 2), r2(s / 2)];
  if (typeof s === "string") {
    const m = s.match(/^([\d.]+)\s*([a-zA-Z%]*)$/);
    if (m) return [`${r1(Number(m[1]) / 2)}${m[2]}`, `${r1(Number(m[1]) / 2)}${m[2]}`];
  }
  return [1, 1];
};

function rowsOf(layout: Layout): Obj[] {
  const rows = isObj(layout) && Array.isArray(layout.rows) ? layout.rows : [[1]];
  return rows.map((r) => (Array.isArray(r) ? { cols: r } : isObj(r) ? { ...r } : { cols: [1] }));
}

/** the same panels as a split tree */
function rowsToSplit(layout: Layout): Obj {
  const L = isObj(layout) ? layout : {};
  const rows = rowsOf(layout);
  const gutter = L.gutter;
  const gRow = isObj(gutter) ? gutter.row : gutter;
  const gCol = isObj(gutter) ? gutter.col : gutter;
  const tree: Obj = { split: "rows" };
  if (rows.some((r) => r.height !== undefined)) tree.sizes = rows.map((r) => r.height ?? 1);
  if (rows.some((r) => r.slant !== undefined)) tree.slant = rows.slice(0, -1).map((r) => r.slant ?? 0);
  if (gRow !== undefined) tree.gutter = gRow;
  tree.children = rows.map((r) => {
    const cols = (r.cols as unknown[]) ?? [1];
    if (cols.length === 1) return "panel";
    const c: Obj = { split: "cols", sizes: cols };
    if (Array.isArray(r.colSlant)) c.slant = r.colSlant;
    const rg = isObj(r.gutter) ? r.gutter.col : undefined;
    if (rg !== undefined || gCol !== undefined) c.gutter = rg ?? gCol;
    c.children = cols.map(() => "panel");
    return c;
  });
  if (L.area !== undefined) tree.area = L.area;
  return tree;
}

function splitLayout(layout: Layout, mode: string, slot: Slot, dir: "h" | "v"): Obj {
  if (mode === "single" || !slot) return { rows: dir === "v" ? [[1, 1]] : [[1], [1]] };
  if (mode === "rows" && slot.kind === "rows") {
    const L = isObj(layout) ? { ...layout } : {};
    const rows = rowsOf(layout);
    const row = rows[slot.row];
    const cols = ((row.cols as unknown[]) ?? [1]).slice();
    if (dir === "v") {
      const [a, b] = halfSpec(cols[slot.col]);
      cols.splice(slot.col, 1, a, b);
      row.cols = cols;
      if (Array.isArray(row.colSlant)) row.colSlant = [...row.colSlant.slice(0, slot.col), 0, ...row.colSlant.slice(slot.col)];
      L.rows = rows.map(compactRow);
      return L;
    }
    if (cols.length === 1) {
      const [a, b] = halfSpec(row.height ?? 1);
      const below: Obj = { cols: [1], height: b };
      if (row.slant !== undefined) below.slant = row.slant;
      if (row.gutter !== undefined) below.gutter = row.gutter;
      const above: Obj = { ...row, height: a };
      delete above.slant;
      rows.splice(slot.row, 1, above, below);
      L.rows = rows.map(compactRow);
      return L;
    }
    return splitLayout(rowsToSplit(layout), "split", { kind: "split", node: [slot.row, slot.col] }, dir);
  }
  if (mode === "rows" && slot.kind === "split") return splitLayout(rowsToSplit(layout), "split", slot, dir);
  if (mode === "split" && slot.kind === "split") {
    const tree = structuredClone(layout) as Obj;
    const want = dir === "h" ? "rows" : "cols";
    const node = slot.node;
    const parent = node.length ? nodeAt(tree, node.slice(0, -1)) : undefined;
    const idx = node[node.length - 1];
    if (parent && parent.split === want && Array.isArray(parent.children)) {
      const n = parent.children.length;
      parent.children.splice(idx + 1, 0, "panel");
      if (Array.isArray(parent.sizes)) {
        const [a, b] = halfSpec(parent.sizes[idx]);
        parent.sizes.splice(idx, 1, a, b);
      }
      if (Array.isArray(parent.slant)) {
        const s = parent.slant.slice();
        while (s.length < n - 1) s.push(0);
        s.splice(idx, 0, 0);
        parent.slant = s;
      }
      return tree;
    }
    if (!parent) return { split: want, children: [tree, "panel"] };
    const leaf = (parent.children as unknown[])[idx];
    (parent.children as unknown[])[idx] = { split: want, children: [leaf ?? "panel", "panel"] };
    return tree;
  }
  return fail("this layout cannot be split here");
}

/** removes a slot; the neighbours share its room */
function removeSlot(layout: Layout, mode: string, slot: Slot): Obj | undefined {
  if (!slot) return isObj(layout) ? layout : undefined;
  if (mode === "rows" && slot.kind === "rows") {
    const L = isObj(layout) ? { ...layout } : {};
    const rows = rowsOf(layout);
    const row = rows[slot.row];
    const cols = ((row.cols as unknown[]) ?? [1]).slice();
    if (cols.length > 1) {
      cols.splice(slot.col, 1);
      row.cols = cols;
      if (Array.isArray(row.colSlant)) {
        const cs = row.colSlant as unknown[];
        row.colSlant = cs.filter((_, j) => j !== Math.min(slot.col, cs.length - 1));
      }
    } else {
      // the row above keeps the slant of the boundary below the removed row
      if (slot.row > 0 && rows[slot.row - 1]) {
        if (row.slant !== undefined) rows[slot.row - 1].slant = row.slant;
        else delete rows[slot.row - 1].slant;
      }
      rows.splice(slot.row, 1);
    }
    if (!rows.length) return undefined;
    L.rows = rows.map(compactRow);
    return L;
  }
  if (slot.kind === "split") {
    const tree = (mode === "rows" ? rowsToSplit(layout) : structuredClone(layout)) as Obj;
    const node = slot.node;
    if (!node.length) return undefined;
    const parentPath = node.slice(0, -1);
    const parent = nodeAt(tree, parentPath);
    const idx = node[node.length - 1];
    if (!parent || !Array.isArray(parent.children)) return tree;
    const n = parent.children.length;
    parent.children.splice(idx, 1);
    if (Array.isArray(parent.sizes)) parent.sizes.splice(idx, 1);
    if (Array.isArray(parent.slant)) parent.slant.splice(Math.min(idx, n - 2), 1);
    if (isObj(parent.split) && parent.children.length === 1) {
      // a line split needs two sides
    }
    if (parent.children.length === 1) {
      const only = parent.children[0];
      if (!parentPath.length) return only === "panel" || (isObj(only) && typeof only.panel === "string") ? undefined : (only as Obj);
      const grand = nodeAt(tree, parentPath.slice(0, -1))!;
      (grand.children as unknown[])[parentPath[parentPath.length - 1]] = only;
    }
    return tree;
  }
  return isObj(layout) ? layout : undefined;
}

function nodeAt(tree: Obj, path: number[]): Obj | undefined {
  let cur: unknown = tree;
  for (const i of path) {
    if (!isObj(cur) || !Array.isArray(cur.children)) return undefined;
    cur = cur.children[i];
  }
  return isObj(cur) ? cur : undefined;
}

/** a row as the short list form when it has nothing but cols */
function compactRow(r: Obj): unknown {
  const keys = Object.keys(r).filter((k) => r[k] !== undefined);
  return keys.length === 1 && keys[0] === "cols" ? r.cols : r;
}

function writeLayout(y: YamlText, pageSrc: number, old: Layout, next: Obj | undefined) {
  if (next === undefined) return y.delete(pageSrc, ["layout"]);
  if (old === undefined || old === null || typeof old === "string") return y.set(pageSrc, ["layout"], next);
  // keep the author's other layout keys (area, gutter, …) as they were
  const o = old as Obj;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k, v] of Object.entries(next)) {
    if (same(o[k], v)) continue;
    const ov = o[k];
    // a list of the same length is changed item by item, keeping the comments on the others
    if (Array.isArray(ov) && Array.isArray(v) && ov.length === v.length) {
      v.forEach((x, i) => !same(ov[i], x) && y.set(pageSrc, ["layout", k, i], x));
    } else y.set(pageSrc, ["layout", k], v);
  }
  for (const k of Object.keys(o)) if (!(k in next)) y.delete(pageSrc, ["layout", k]);
}
