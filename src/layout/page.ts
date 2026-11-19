// Page geometry & panel layout (spec 4).
import { activePlugins } from "../plugin.js";
import { deriveSeed, Rng } from "../core/random.js";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { type UnitContext, parseLength, quantityToMm, toMm } from "../core/units.js";
import polygonClipping from "polygon-clipping";
import { polygonArea } from "../geom/path.js";
import { type Rect, type Vec, boundsOf, rectIntersect } from "../geom/vec.js";
import { isObj } from "../load/normalize.js";
import { PAGE_PRESETS } from "../model/defaults.js";
import type { RPage, RPanel } from "../model/resolve.js";

type Obj = Record<string, unknown>;

export interface PageGeom {
  id: string;
  index: number;
  type: string;
  trimW: number;
  trimH: number;
  bleed: number;
  trim: Rect;
  bleedBox: Rect;
  baseFrame: Rect;
  safe: Rect;
  /** half-width of the spread fold danger band in mm (spreads only; 0 otherwise) */
  foldMargin: number;
  units: UnitContext;
  side: "left" | "right" | "spread";
  physical: number[];
  rtl: boolean;
  color: "mono" | "color";
  dpi: number;
  printScale: number;
  k: number;
}

export interface PanelGeom {
  panel: RPanel;
  polygon: Vec[];
  /** polygon before bleed (for border drawing of non-bled sides) */
  bledSides: string[];
  box: Rect; // visible box (polygon ∩ trim)
  fullBox: Rect;
  order: number;
  edgeSides: (string | null)[]; // for each polygon edge i->i+1: side name if edge lies on area boundary
}

export function pageSize(settings: Obj, bag: DiagnosticBag, path: (string | number)[]): { w: number; h: number; unit: "mm" | "px" } {
  let w = 182;
  let h = 257;
  let unit: "mm" | "px" = "mm";
  const size = settings.size;
  if (typeof size === "string") {
    const p = PAGE_PRESETS[size];
    const plug = activePlugins()?.pageSizes.get(size);
    if (plug) ({ width: w, height: h, unit = "mm" } = plug);
    else if (p) ({ w, h, unit } = p);
    else bag.error("SCHEMA_ENUM", `unknown page size "${size}"`, { path: [...path, "size"] });
  } else if (Array.isArray(size)) {
    const a = parseLength(size[0] as string);
    const b = parseLength(size[1] as string);
    if (a && b) {
      unit = a.unit === "px" ? "px" : "mm";
      const ctx: UnitContext = { units: (settings.units as UnitContext["units"]) ?? unit, dpi: 96, k: 1 };
      if (unit === "px") {
        w = a.value;
        h = b.value;
      } else {
        w = quantityToMm(a, ctx);
        h = quantityToMm(b, ctx);
      }
    }
  }
  if (settings.orientation === "landscape" && w < h) [w, h] = [h, w];
  return { w, h, unit };
}

/** book settings with defaults that depend on the document (non-Japanese books bind on the left; spec 4.3) */
export function bookOf(doc: Obj): Obj {
  const book = (isObj(doc.book) ? doc.book : {}) as Obj;
  if (book.binding !== undefined) return book;
  const lang = String(((doc.meta ?? {}) as Obj).lang ?? "ja");
  return { ...book, binding: /^ja\b/.test(lang) ? "right" : "left" };
}

export function computePageGeom(page: RPage, physicalIndex: number, book: Obj, bag: DiagnosticBag): PageGeom {
  const raw = page.settings;
  const preset = typeof raw.size === "string" ? activePlugins()?.pageSizes.get(raw.size) ?? PAGE_PRESETS[raw.size] : undefined;
  const s: Obj = { ...preset, ...raw };
  if (raw.printScale !== undefined && raw.printSize === undefined) delete s.printSize;
  const sz = pageSize(s, bag, page.path);
  const color = (s.color as "mono" | "color") ?? "mono";
  const dpi = typeof s.dpi === "number" ? s.dpi : sz.unit === "px" ? 96 : color === "mono" ? 600 : 350;
  const unitsName = (s.units as UnitContext["units"]) ?? (sz.unit === "px" ? "px" : "mm");
  let trimW = sz.unit === "px" ? (sz.w * 25.4) / dpi : sz.w;
  const trimH = sz.unit === "px" ? (sz.h * 25.4) / dpi : sz.h;
  const singleW = trimW;
  if (page.type === "spread") trimW *= 2;
  const k = Math.min(singleW, trimH) / 182;
  let printScale = typeof s.printScale === "number" ? s.printScale : 1;
  if (s.printSize !== undefined) {
    const printed = pageSize({ size: s.printSize, orientation: s.orientation, units: unitsName }, bag, [...page.path, "printSize"]);
    printScale = (printed.unit === "px" ? printed.w * 25.4 / dpi : printed.w) / singleW;
  }
  if (raw.printScale !== undefined && raw.printSize !== undefined) bag.error("SCHEMA_VALUE", "printScale and printSize are mutually exclusive", { path: page.path });
  if (!(printScale > 0 && printScale <= 1)) {
    bag.error("SCHEMA_VALUE", "resolved printScale must be greater than 0 and at most 1", { path: page.path });
    printScale = 1;
  }
  const units: UnitContext = { units: unitsName, dpi, k, printScale };
  const bleed = s.bleed !== undefined ? toMm(s.bleed as string, units) : sz.unit === "px" ? 0 : 3;
  const trim: Rect = { x: 0, y: 0, w: trimW, h: trimH };
  const bleedBox: Rect = { x: -bleed, y: -bleed, w: trimW + 2 * bleed, h: trimH + 2 * bleed };
  const safeInset = isObj(s.safeArea) ? toMm((s.safeArea as Obj).inset as string, units) : sz.unit === "px" ? 0 : 5;
  const safe: Rect = { x: safeInset, y: safeInset, w: trimW - 2 * safeInset, h: trimH - 2 * safeInset };
  const binding = (book.binding as string) ?? "right";
  const rtl = ((book.readingDirection as string) ?? (binding === "right" ? "rtl" : "ltr")) === "rtl";
  const firstSide = (book.firstPageSide as string) ?? (binding === "right" ? "left" : "right");
  const sideOf = (i: number) => ((i % 2 === 1) === (firstSide === "left") ? "left" : "right");
  const side = page.type === "spread" ? "spread" : sideOf(physicalIndex);
  if (page.type === "spread") {
    // the spread's first page in reading order must sit on the binding's leading side (spec 4.15)
    const want = rtl ? "right" : "left";
    if (sideOf(physicalIndex) !== want) bag.warn("LAYOUT_SPREAD_PARITY", `spread ${page.id} starts on a ${sideOf(physicalIndex)} page; it should start on a ${want} page`, { path: page.path, pageId: page.id });
  }
  // base frame
  let baseFrame: Rect;
  let bf = s.baseFrame;
  if (raw.baseFrame === undefined && s.orientation === "landscape" && isObj(bf)) {
    const original = pageSize({ ...s, orientation: undefined }, bag, page.path);
    if (original.w < original.h) {
      bf = {
        ...bf,
        ...(Array.isArray(bf.size) ? { size: [bf.size[1], bf.size[0]] } : {}),
        ...(Array.isArray(bf.offset) ? { offset: [bf.offset[1], bf.offset[0]] } : {}),
        ...(isObj(bf.margins) ? { margins: { top: bf.margins.inner, bottom: bf.margins.outer, inner: bf.margins.top, outer: bf.margins.bottom } } : {}),
      };
    }
  }
  const pctx = (base: number): UnitContext => ({ ...units, base });
  if (bf === "trim") baseFrame = { ...trim };
  else if (isObj(bf) && isObj(bf.margins)) {
    const m = bf.margins as Obj;
    const top = toMm(m.top as string, pctx(trimH));
    const bottom = toMm(m.bottom as string, pctx(trimH));
    const inner = toMm(m.inner as string, pctx(singleW));
    const outer = toMm(m.outer as string, pctx(singleW));
    // left page: inner (binding) on the right; right page: inner on the left
    const left = side === "left" ? outer : side === "right" ? inner : outer;
    const right = side === "left" ? inner : side === "right" ? outer : outer;
    baseFrame = { x: left, y: top, w: trimW - left - right, h: trimH - top - bottom };
  } else {
    // px pages (screens): an even margin of 4 % of the short side
    const pxMargin = 0.04 * Math.min(singleW, trimH);
    let bw = sz.unit === "px" ? singleW - 2 * pxMargin : singleW * (150 / 182);
    let bh = sz.unit === "px" ? trimH - 2 * pxMargin : trimH * (220 / 257);
    if (isObj(bf) && Array.isArray(bf.size)) {
      bw = toMm((bf.size as string[])[0], pctx(singleW));
      bh = toMm((bf.size as string[])[1], pctx(trimH));
    }
    if (page.type === "spread") bw = trimW - (singleW - bw);
    let ox = 0;
    let oy = 0;
    if (isObj(bf) && Array.isArray(bf.offset)) {
      ox = toMm((bf.offset as string[])[0], units);
      oy = toMm((bf.offset as string[])[1], units);
    }
    baseFrame = { x: (trimW - bw) / 2 + ox, y: (trimH - bh) / 2 + oy, w: bw, h: bh };
  }
  if (baseFrame.x < safe.x - 0.01 || baseFrame.y < safe.y - 0.01 || baseFrame.x + baseFrame.w > safe.x + safe.w + 0.01 || baseFrame.y + baseFrame.h > safe.y + safe.h + 0.01) {
    if (sz.unit !== "px") bag.warn("PAGE_BASEFRAME_OUTSIDE_SAFE", "base frame extends outside the safe area", { path: [...page.path, "baseFrame"], pageId: page.id });
  }
  const physical = page.type === "spread" ? [physicalIndex, physicalIndex + 1] : [physicalIndex];
  const foldMargin = page.type !== "spread" || sz.unit === "px" ? 0 : s.foldMargin !== undefined ? toMm(s.foldMargin as string, units) : 10;
  return { id: page.id, index: page.index, type: page.type, trimW, trimH, bleed, trim, bleedBox, baseFrame, safe, foldMargin, units, side, physical, rtl, color, dpi, k, printScale };
}

// ---- polygon clipping with half planes -----------------------------------------

/** keep part of convex polygon on the left side of directed line a->b (cross >= 0 in y-down = visual right?) */
function clipHalf(poly: Vec[], a: Vec, b: Vec, keepPositive: boolean): Vec[] {
  const side = (p: Vec) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p) * (keepPositive ? 1 : -1);
    const sq = side(q) * (keepPositive ? 1 : -1);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return dedupe(out);
}

function dedupe(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l.x - p.x, l.y - p.y) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
  return out;
}

/** split polygon by line a->b with gutter g; returns [positiveSide, negativeSide] */
function splitPoly(poly: Vec[], a: Vec, b: Vec, g: number): [Vec[], Vec[]] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  // normal pointing to positive side: side(p) = dx*(py-ay) - dy*(px-ax) > 0 for p = a + n*(..)
  const nx = -dy / l;
  const ny = dx / l;
  const off = g / 2;
  const a1 = { x: a.x + nx * off, y: a.y + ny * off };
  const b1 = { x: b.x + nx * off, y: b.y + ny * off };
  const a2 = { x: a.x - nx * off, y: a.y - ny * off };
  const b2 = { x: b.x - nx * off, y: b.y - ny * off };
  return [clipHalf(poly, a1, b1, true), clipHalf(poly, a2, b2, false)];
}

interface Leaf {
  poly: Vec[];
  bind?: string;
  overlay?: boolean;
}

function rectPoly(r: Rect): Vec[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

function distribute(total: number, sizes: (number | string)[], gaps: number, u: UnitContext): number[] {
  const avail = total - gaps;
  let fixed = 0;
  let ratioSum = 0;
  const vals = sizes.map((s) => {
    if (typeof s === "number") {
      ratioSum += s;
      return { r: s };
    }
    const q = parseLength(s);
    if (q && q.unit !== "") {
      const mm = quantityToMm(q, { ...u, base: total });
      fixed += mm;
      return { a: mm };
    }
    const n = Number(s) || 1;
    ratioSum += n;
    return { r: n };
  });
  const rest = Math.max(0, avail - fixed);
  return vals.map((v) => ("a" in v ? v.a! : ((v.r ?? 1) / (ratioSum || 1)) * rest));
}

export function layoutPanels(page: RPage, geom: PageGeom, bag: DiagnosticBag): PanelGeom[] {
  const u = geom.units;
  const L = (isObj(page.layout) ? page.layout : page.layout === "free" ? { free: true } : {}) as Obj;
  // in a split tree, `gutter` on a node belongs to that node only; the page gutter applies elsewhere
  const gutterSpec = L.split ? page.settings.gutter : (L.gutter ?? page.settings.gutter);
  let gCol = 2.5 * geom.k;
  let gRow = 5 * geom.k;
  if (gutterSpec !== undefined) {
    if (isObj(gutterSpec)) {
      if (gutterSpec.col !== undefined) gCol = toMm(gutterSpec.col as string, u);
      if (gutterSpec.row !== undefined) gRow = toMm(gutterSpec.row as string, u);
    } else gCol = gRow = toMm(gutterSpec as string, u);
  }
  let area = geom.baseFrame;
  if (L.area === "trim") area = geom.trim;
  else if (L.area === "bleed") area = geom.bleedBox;
  else if (Array.isArray(L.area)) {
    const r = L.area as string[];
    area = { x: toMm(r[0], { ...u, base: geom.trimW }), y: toMm(r[1], { ...u, base: geom.trimH }), w: toMm(r[2], { ...u, base: geom.trimW }), h: toMm(r[3], { ...u, base: geom.trimH }) };
  }
  const rtl = geom.rtl;
  const panels = page.panels;
  const overlays = panels.filter((p) => p.props.overlay === true);
  const slotPanels = panels.filter((p) => p.props.overlay !== true);

  let leaves: Leaf[] = [];
  const allFree = slotPanels.length > 0 && slotPanels.every((p) => p.props.box || p.props.polygon);
  const someFree = slotPanels.some((p) => p.props.box || p.props.polygon);
  let mode: "rows" | "split" | "free" | "single" = "single";
  let layoutObj = L;
  if (typeof L.template === "string") layoutObj = expandTemplate(L.template, (L.params ?? {}) as Obj, page, bag, geom, area, L.area === undefined, gCol);
  if (layoutObj.__edgeArea && L.area === undefined) area = geom.trim;
  if (Array.isArray(layoutObj.rows)) mode = "rows";
  else if (layoutObj.split) mode = "split";
  else if (page.layout === "free" || L.free || allFree) mode = "free";
  else if (someFree) {
    bag.error("LAYOUT_FREE_MIXED", "some panels have box/polygon but layout is not free", { path: page.path, pageId: page.id });
  }

  if (mode === "rows") {
    const rows = layoutObj.rows as Obj[];
    const heights = distribute(area.h, rows.map((r) => (r.height as number | string) ?? 1), gRow * (rows.length - 1), u);
    let remaining = rectPoly(area);
    let y = area.y;
    const W = area.w + 400;
    for (let i = 0; i < rows.length; i++) {
      let rowPoly: Vec[];
      if (i < rows.length - 1) {
        const yb = y + heights[i] + gRow / 2;
        const sl = rows[i].slant !== undefined ? toMm(rows[i].slant as string, u) : 0;
        const a = { x: area.x - 200, y: yb - (sl * (W / area.w)) / 2 };
        const b = { x: area.x + area.w + 200, y: yb + (sl * (W / area.w)) / 2 };
        // positive side of a->b (left->right line): side>0 for points below (y-down)
        const [below, above] = splitPoly(remaining, a, b, gRow);
        rowPoly = above;
        remaining = below;
        y = yb + gRow / 2;
      } else rowPoly = remaining;
      const cols = (rows[i].cols as number[]) ?? [1];
      const gc = isObj(rows[i].gutter) && (rows[i].gutter as Obj).col !== undefined ? toMm((rows[i].gutter as Obj).col as string, u) : gCol;
      const rowLeaves = splitCols(rowPoly, cols, (rows[i].colSlant as string[]) ?? [], gc, rtl, u, area);
      if (rows[i].__title) for (const lf of rowLeaves) lf.bind = `${page.id}-title`;
      leaves.push(...rowLeaves);
    }
  } else if (mode === "split") {
    leaves = splitTree(layoutObj, rectPoly(area), gCol, gRow, rtl, u);
  } else if (mode === "free") {
    leaves = slotPanels.map((p) => ({ poly: freePoly(p, geom, area, u) }));
    // free panels that overlap (overlays are meant to)
    for (let i = 0; i < leaves.length; i++)
      for (let j = i + 1; j < leaves.length; j++) {
        const ring = (q: Vec[]) => [[...q.map((v) => [v.x, v.y] as [number, number]), [q[0].x, q[0].y] as [number, number]]];
        try {
          const ov = polygonClipping.intersection(ring(leaves[i].poly), ring(leaves[j].poly));
          const a = ov.reduce((acc, pl) => acc + Math.abs(polygonArea(pl[0].map(([x, y]) => ({ x, y })))), 0);
          if (a > 1) bag.warn("LAYOUT_PANELS_OVERLAP", `panels ${slotPanels[i].id} and ${slotPanels[j].id} overlap`, { path: slotPanels[j].path, pageId: page.id });
        } catch {
          /* ignore */
        }
      }
  } else {
    leaves = [{ poly: rectPoly(area) }];
    if (slotPanels.length > 1) bag.error("LAYOUT_TOO_MANY_PANELS", `${slotPanels.length} panels but layout has 1 slot`, { path: page.path, pageId: page.id });
  }

  if (Array.isArray(layoutObj.__insets)) {
    leaves.push(...(layoutObj.__insets as Rect[]).map((r) => ({ poly: rectPoly(r), overlay: true })));
  }
  // assign panels to leaves
  const out: PanelGeom[] = [];
  const used = new Set<RPanel>();
  const byId = new Map(slotPanels.map((p) => [p.id, p]));
  const assigned: (RPanel | null)[] = leaves.map((lf) => {
    if (lf.bind) {
      const p = byId.get(lf.bind);
      if (!p) bag.error("REF_NOT_FOUND", `layout binds unknown panel "${lf.bind}"`, { path: page.path });
      else used.add(p);
      return p ?? null;
    }
    return null;
  });
  let qi = 0;
  const queue = mode === "free" ? slotPanels : slotPanels.filter((p) => !used.has(p));
  for (let i = 0; i < leaves.length; i++) {
    if (assigned[i]) continue;
    if (mode === "free") {
      assigned[i] = slotPanels[i];
      continue;
    }
    assigned[i] = queue[qi++] ?? null;
  }
  if (mode !== "free" && mode !== "single" && qi < queue.length) bag.error("LAYOUT_TOO_MANY_PANELS", `${slotPanels.length} panels for ${leaves.length} layout slots`, { path: page.path, pageId: page.id });
  leaves.forEach((lf, i) => {
    let p = assigned[i];
    if (!p) {
      bag.warn("LAYOUT_EMPTY_SLOT", `layout slot ${i + 1} has no panel`, { path: page.path, pageId: page.id });
      p = { id: `${page.id}-slot${i + 1}`, index: -1, props: { border: { width: "0.5bmm", color: "black", pen: { preset: "kabura-pen" }, style: "solid", ruler: true }, background: "paper" }, elements: [], path: page.path, seed: i };
    }
    if (lf.overlay || (layoutObj.__autoBleed && p.props.bleed === undefined)) {
      const box = boundsOf(lf.poly);
      const edges = { top: [box.y, geom.trim.y], bottom: [box.y + box.h, geom.trimH], left: [box.x, geom.trim.x], right: [box.x + box.w, geom.trimW] };
      const bleed = Object.entries(edges).filter(([, [edge, trim]]) => Math.abs(edge - trim) < 0.01).map(([side]) => side);
      p = { ...p, props: { ...p.props, ...(lf.overlay ? { overlay: true } : { bleed }) } };
    }
    out.push(makePanelGeom(p, lf.poly, geom, area, bag, i));
  });
  for (const ov of overlays) out.push(makePanelGeom(ov, freePoly(ov, geom, area, u), geom, area, bag, out.length));

  // reading order
  const ordered = layoutObj.__insets ? out : readingOrder(out, mode, rtl);
  ordered.forEach((pg, i) => (pg.order = i + 1));
  const explicit = out.filter((p) => typeof p.panel.props.order === "number");
  if (explicit.length) {
    const seen = new Set<number>();
    for (const e of explicit) {
      const o = e.panel.props.order as number;
      if (seen.has(o)) bag.error("LAYOUT_ORDER_DUPLICATE", `duplicate panel order ${o}`, { path: e.panel.path });
      seen.add(o);
    }
    const rest = ordered.filter((p) => !explicit.includes(p));
    const slots: PanelGeom[] = new Array(out.length);
    for (const e of explicit) slots[(e.panel.props.order as number) - 1] = e;
    let r = 0;
    for (let i = 0; i < slots.length; i++) if (!slots[i]) slots[i] = rest[r++];
    slots.forEach((p, i) => p && (p.order = i + 1));
  }
  return out;
}

function splitCols(rowPoly: Vec[], cols: number[], colSlant: string[], g: number, rtl: boolean, u: UnitContext, area: Rect): Leaf[] {
  const bb = boundsOf(rowPoly);
  const x0 = area.x;
  const w = area.w;
  const widths = distribute(w, cols, g * (cols.length - 1), u);
  const leaves: Leaf[] = [];
  let remaining = rowPoly;
  // boundaries in reading order
  let acc = 0;
  for (let i = 0; i < cols.length - 1; i++) {
    acc += widths[i] + (i > 0 ? g : 0);
    const pos = acc + g / 2; // distance from reading start
    const xb = rtl ? x0 + w - pos : x0 + pos;
    const sl = colSlant[i] !== undefined ? toMm(colSlant[i], u) : 0;
    const top = { x: xb - sl / 2, y: bb.y };
    const bot = { x: xb + sl / 2, y: bb.y + bb.h };
    const ext = 200;
    const dy = bot.y - top.y || 1;
    const a = { x: top.x - ((bot.x - top.x) / dy) * ext, y: top.y - ext };
    const b = { x: bot.x + ((bot.x - top.x) / dy) * ext, y: bot.y + ext };
    // line a->b pointing down: positive side = left (x smaller) in y-down? side(p)= dx*(py-ay)-dy*(px-ax); dy>0 => points with smaller x positive
    const [leftSide, rightSide] = splitPoly(remaining, a, b, g);
    if (rtl) {
      leaves.push({ poly: rightSide });
      remaining = leftSide;
    } else {
      leaves.push({ poly: leftSide });
      remaining = rightSide;
    }
    acc += 0;
  }
  leaves.push({ poly: remaining });
  return leaves;
}

function splitTree(node: Obj, poly: Vec[], gCol: number, gRow: number, rtl: boolean, u: UnitContext): Leaf[] {
  if (node === ("panel" as unknown)) return [{ poly }];
  if (isObj(node) && typeof node.panel === "string") return [{ poly, bind: node.panel as string }];
  if (!isObj(node) || !node.split) return [{ poly }];
  const children = (node.children as Obj[]) ?? [];
  const n = children.length;
  const bb = boundsOf(poly);
  const isRows = node.split === "rows";
  const g = node.gutter !== undefined ? toMm(node.gutter as string, u) : isRows ? gRow : gCol;
  const total = isRows ? bb.h : bb.w;
  const sizes = distribute(total, (node.sizes as (number | string)[]) ?? children.map(() => 1), g * (n - 1), u);
  const slants = (node.slant as string[]) ?? [];
  const leaves: Leaf[] = [];
  let remaining = poly;
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += sizes[i] + (i > 0 ? g : 0);
    const pos = acc + g / 2;
    const sl = slants[i] !== undefined ? toMm(slants[i], u) : 0;
    if (isRows) {
      const yb = bb.y + pos;
      const W = bb.w + 400;
      const a = { x: bb.x - 200, y: yb - (sl * (W / bb.w)) / 2 };
      const b = { x: bb.x + bb.w + 200, y: yb + (sl * (W / bb.w)) / 2 };
      const [below, above] = splitPoly(remaining, a, b, g);
      leaves.push(...splitTree(children[i], above, gCol, gRow, rtl, u));
      remaining = below;
    } else {
      const xb = rtl ? bb.x + bb.w - pos : bb.x + pos;
      const top = { x: xb - sl / 2, y: bb.y };
      const bot = { x: xb + sl / 2, y: bb.y + bb.h };
      const ext = 200;
      const dy = bot.y - top.y || 1;
      const a = { x: top.x - ((bot.x - top.x) / dy) * ext, y: top.y - ext };
      const b = { x: bot.x + ((bot.x - top.x) / dy) * ext, y: bot.y + ext };
      const [leftSide, rightSide] = splitPoly(remaining, a, b, g);
      if (rtl) {
        leaves.push(...splitTree(children[i], rightSide, gCol, gRow, rtl, u));
        remaining = leftSide;
      } else {
        leaves.push(...splitTree(children[i], leftSide, gCol, gRow, rtl, u));
        remaining = rightSide;
      }
    }
  }
  leaves.push(...splitTree(children[n - 1], remaining, gCol, gRow, rtl, u));
  return leaves;
}

function freePoly(p: RPanel, geom: PageGeom, area: Rect, u: UnitContext): Vec[] {
  const coordsPage = p.props.coords === "page";
  const base = coordsPage ? geom.trim : area;
  const cx = (v: string | number) => base.x + toMm(v as string, { ...u, base: base.w });
  const cy = (v: string | number) => base.y + toMm(v as string, { ...u, base: base.h });
  if (Array.isArray(p.props.box)) {
    const b = p.props.box as (string | number)[];
    const x = cx(b[0]);
    const y = cy(b[1]);
    const w = toMm(b[2] as string, { ...u, base: base.w });
    const h = toMm(b[3] as string, { ...u, base: base.h });
    return rectPoly({ x, y, w, h });
  }
  if (Array.isArray(p.props.polygon)) return (p.props.polygon as (string | number)[][]).map((q) => ({ x: cx(q[0]), y: cy(q[1]) }));
  return rectPoly(area);
}

function makePanelGeom(p: RPanel, poly0: Vec[], geom: PageGeom, area: Rect, bag: DiagnosticBag, idx: number): PanelGeom {
  let poly = poly0.slice();
  if (polygonArea(poly) < 0) poly.reverse();
  const bb0 = boundsOf(poly);
  // slivers: too small, or too thin for its size (area against the bounding box)
  const areaP = Math.abs(polygonArea(poly));
  if (poly.length < 3 || bb0.w < 5 * geom.k || bb0.h < 5 * geom.k || areaP < 25 * geom.k * geom.k || areaP < 0.12 * bb0.w * bb0.h) bag.error("LAYOUT_DEGENERATE_PANEL", `panel ${p.id} is too small or degenerate`, { path: p.path });
  // edge sides
  const eps = 0.01;
  const sideOfEdge = (a: Vec, b: Vec): string | null => {
    if (Math.abs(a.y - area.y) < eps && Math.abs(b.y - area.y) < eps) return "top";
    if (Math.abs(a.y - (area.y + area.h)) < eps && Math.abs(b.y - (area.y + area.h)) < eps) return "bottom";
    if (Math.abs(a.x - area.x) < eps && Math.abs(b.x - area.x) < eps) return "left";
    if (Math.abs(a.x - (area.x + area.w)) < eps && Math.abs(b.x - (area.x + area.w)) < eps) return "right";
    return null;
  };
  const edgeSides = poly.map((a, i) => sideOfEdge(a, poly[(i + 1) % poly.length]));
  const bleedReq = Array.isArray(p.props.bleed) ? (p.props.bleed as string[]) : [];
  const bled: string[] = [];
  for (const s of bleedReq) {
    if (!edgeSides.includes(s)) {
      // `bleed: all` (all four sides) quietly bleeds only the sides on the edge
      if (bleedReq.length >= 4) continue;
      bag.warn("LAYOUT_BLEED_NOT_ON_EDGE", `panel ${p.id}: side "${s}" is not on the layout edge`, { path: [...p.path, "bleed"] });
      continue;
    }
    bled.push(s);
  }
  if (bled.length) {
    const bb = geom.bleedBox;
    const target: Record<string, number> = { top: bb.y, bottom: bb.y + bb.h, left: bb.x, right: bb.x + bb.w };
    for (const s of bled) {
      const n = poly.length;
      const np = poly.map((v) => ({ ...v }));
      for (let i = 0; i < n; i++) {
        const inPrev = edgeSides[(i - 1 + n) % n] === s;
        const inNext = edgeSides[i] === s;
        if (!inPrev && !inNext) continue;
        // neighbor along the non-side edge
        const nb = inPrev && !inNext ? poly[(i + 1) % n] : !inPrev && inNext ? poly[(i - 1 + n) % n] : null;
        const v = poly[i];
        if (s === "top" || s === "bottom") {
          const ty = target[s];
          if (nb && Math.abs(nb.y - v.y) > 1e-9) {
            const t = (ty - v.y) / (nb.y - v.y);
            np[i] = { x: v.x + (nb.x - v.x) * t, y: ty };
          } else np[i] = { x: v.x, y: ty };
        } else {
          const tx = target[s];
          if (nb && Math.abs(nb.x - v.x) > 1e-9) {
            const t = (tx - v.x) / (nb.x - v.x);
            np[i] = { x: tx, y: v.y + (nb.y - v.y) * t };
          } else np[i] = { x: tx, y: v.y };
        }
      }
      poly = np;
    }
  }
  if (bled.length) {
    const bb = geom.bleedBox;
    poly = clipHalf(poly, { x: bb.x, y: bb.y }, { x: bb.x + bb.w, y: bb.y }, true);
    poly = clipHalf(poly, { x: bb.x + bb.w, y: bb.y }, { x: bb.x + bb.w, y: bb.y + bb.h }, true);
    poly = clipHalf(poly, { x: bb.x + bb.w, y: bb.y + bb.h }, { x: bb.x, y: bb.y + bb.h }, true);
    poly = clipHalf(poly, { x: bb.x, y: bb.y + bb.h }, { x: bb.x, y: bb.y }, true);
  }
  const fullBox = boundsOf(poly);
  const box = rectIntersect(fullBox, geom.trim) ?? fullBox;
  return { panel: p, polygon: poly, bledSides: bled, box, fullBox, order: idx + 1, edgeSides };
}

function readingOrder(panels: PanelGeom[], mode: string, rtl: boolean): PanelGeom[] {
  const base = panels.filter((p) => p.panel.props.overlay !== true);
  const ovs = panels.filter((p) => p.panel.props.overlay === true);
  let ordered: PanelGeom[];
  if (mode === "rows" || mode === "split") ordered = base.slice();
  else ordered = xyCut(base, rtl);
  for (const o of ovs) {
    const c = { x: o.fullBox.x + o.fullBox.w / 2, y: o.fullBox.y + o.fullBox.h / 2 };
    let host = ordered.findIndex((p) => c.x >= p.fullBox.x && c.x <= p.fullBox.x + p.fullBox.w && c.y >= p.fullBox.y && c.y <= p.fullBox.y + p.fullBox.h);
    if (host < 0) host = ordered.length - 1;
    ordered.splice(host + 1, 0, o);
  }
  return ordered;
}

function xyCut(ps: PanelGeom[], rtl: boolean): PanelGeom[] {
  return xyCutOrder(ps, (p) => p.fullBox, rtl);
}

/** recursive XY-cut reading order of boxes (spec 4.11, 3.) — also used for balloons */
export function xyCutOrder<T>(ps: T[], boxOf: (t: T) => Rect, rtl: boolean): T[] {
  if (ps.length <= 1) return ps.slice();
  const tryCut = (horizontal: boolean): T[][] | null => {
    const iv = ps.map((p) => { const r = boxOf(p); return (horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]) as [number, number]; }).sort((a, b) => a[0] - b[0]);
    const cuts: number[] = [];
    let end = iv[0][1];
    for (let i = 1; i < iv.length; i++) {
      if (iv[i][0] >= end + 1) cuts.push((end + iv[i][0]) / 2);
      end = Math.max(end, iv[i][1]);
    }
    if (!cuts.length) return null;
    const groups: T[][] = Array.from({ length: cuts.length + 1 }, () => []);
    for (const p of ps) {
      const r = boxOf(p);
      const c = horizontal ? r.y + r.h / 2 : r.x + r.w / 2;
      let gi = 0;
      while (gi < cuts.length && c > cuts[gi]) gi++;
      groups[gi].push(p);
    }
    return groups;
  };
  const h = tryCut(true);
  if (h) return h.flatMap((g) => xyCutOrder(g, boxOf, rtl));
  const v = tryCut(false);
  if (v) return (rtl ? v.reverse() : v).flatMap((g) => xyCutOrder(g, boxOf, rtl));
  return ps.slice().sort((p, q) => {
    const a = boxOf(p);
    const b = boxOf(q);
    if (Math.abs(a.y - b.y) > 2) return a.y - b.y;
    return rtl ? b.x + b.w - (a.x + a.w) : a.x - b.x;
  });
}

function expandTemplate(name: string, params: Obj, page: RPage, bag: DiagnosticBag, geom: PageGeom, initialArea: Rect, defaultArea: boolean, gCol: number): Obj {
  const dynamic = ["impact-diagonal", "cascade", "zoom-in", "splash-with-insets", "vertical-strip", "spread-hero"].includes(name);
  const edge = ["impact-diagonal", "splash-with-insets", "vertical-strip", "spread-hero"].includes(name);
  const area = edge && params.bleed !== false && defaultArea ? geom.trim : initialArea;
  const rng = new Rng(deriveSeed(Number(params.seed ?? page.seed), page.id, name));
  const number = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(params[key] ?? fallback);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
  };
  const count = (n: unknown, fallback: number) => Math.min(12, Math.max(1, Math.round(Number(n) || fallback)));
  const counts = (fallback: number[]) => Array.isArray(params.counts) && params.counts.length ? params.counts.slice(0, 4).map((n) => count(n, 1)) : fallback;
  const cols = (n: number) => Array.from({ length: n }, () => 1);
  const angle = (fallback: number, span: number) => {
    const explicit = Number(params.angle);
    let degrees = (params.angle !== undefined && Number.isFinite(explicit) ? explicit : fallback) + rng.range(-0.4, 0.4);
    if (name === "impact-diagonal" && params.angle === undefined) degrees = Math.min(20, Math.max(8, degrees));
    return `${Math.tan(degrees * Math.PI / 180) * span}mm`;
  };
  const wrap = (layout: Obj): Obj => ({ ...layout, __edgeArea: edge && params.bleed !== false, __autoBleed: edge && params.bleed !== false });
  if (dynamic) {
    const ratio = number("ratio", name === "zoom-in" ? 0.65 : name === "spread-hero" ? 0.55 : 0.5, 0.15, 0.85);
    switch (name) {
      case "impact-diagonal":
        return wrap(params.direction === "cols"
          ? { rows: [{ cols: [ratio, 1 - ratio], colSlant: [angle(12, area.h)] }] }
          : { rows: [{ cols: [1], height: ratio, slant: angle(12, area.w) }, { cols: [1], height: 1 - ratio }] });
      case "cascade": {
        const cs = counts([1, 2, 1]);
        return wrap({ rows: cs.map((c, i) => ({ cols: cols(c), height: Array.isArray(params.heights) ? params.heights[i] ?? 1 : 1, slant: `${(i % 2 ? -1 : 1) * parseFloat(angle(6, area.w))}mm` })) });
      }
      case "zoom-in":
        return wrap({ rows: [{ cols: cols(count(params.count, 3)), height: 1 - ratio, slant: angle(0, area.w) }, { cols: [1], height: ratio }] });
      case "vertical-strip": {
        const n = count(params.count, 3);
        const widths = Array.isArray(params.ratios) && params.ratios.length === n ? params.ratios.map((v) => Math.max(0.1, Number(v) || 1)) : cols(n);
        return wrap({ rows: [{ cols: widths, colSlant: Array.from({ length: n - 1 }, () => angle(2, area.h)) }] });
      }
      case "spread-hero": {
        const cs = counts([2, 2]);
        const tier = (n: number): Obj => {
          if (page.type !== "spread") return { split: "cols", children: cols(n).map(() => "panel") };
          const left = Math.max(0, Math.min(area.w, geom.trimW / 2 - area.x));
          const right = area.w - left;
          if (left === 0 || right === 0) return { split: "cols", children: cols(2 * n).map(() => "panel") };
          const gutter = Math.min(gCol, left, right);
          const sizes = [left - gutter / 2, right - gutter / 2];
          return { split: "cols", gutter: `${gutter}mm`, sizes: geom.rtl ? sizes.reverse() : sizes, children: [0, 1].map(() => ({ split: "cols", children: cols(n).map(() => "panel") })) };
        };
        return wrap({ split: "rows", sizes: [(1 - ratio) / 2, ratio, (1 - ratio) / 2], slant: [angle(0, area.w), angle(0, area.w)], children: [tier(cs[0]), "panel", tier(cs[1] ?? cs[0])] });
      }
      case "splash-with-insets": {
        const n = Math.min(3, count(params.count, 2));
        const order = geom.rtl ? ["top-right", "top-left", "bottom-right", "bottom-left"] : ["top-left", "top-right", "bottom-left", "bottom-right"];
        const requested = Array.isArray(params.corners) ? params.corners : geom.rtl ? ["top-right", "bottom-left"] : ["top-left", "bottom-right"];
        const corners = order.filter((c) => requested.includes(c));
        for (const c of order) if (!corners.includes(c)) corners.push(c);
        const size = number("size", 0.3, 0.1, 0.45);
        const inset = 5 * geom.k + rng.range(0, 0.5) * geom.k;
        return wrap({ rows: [{ cols: [1] }], __insets: corners.slice(0, n).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((c) => ({ x: c.endsWith("right") ? area.x + area.w * (1 - size) - inset : area.x + inset, y: c.startsWith("bottom") ? area.y + area.h * (1 - size) - inset : area.y + inset, w: area.w * size, h: area.h * size })) });
      }
    }
  }
  switch (name) {
    case "single":
      return {};
    case "grid": {
      const cols = Number(params.cols ?? 2);
      const rows = Number(params.rows ?? 2);
      return { rows: Array.from({ length: rows }, () => ({ cols: Array.from({ length: cols }, () => 1) })) };
    }
    case "tiers": {
      const counts = (params.counts as number[]) ?? [1, 2, 2];
      return { rows: counts.map((c) => ({ cols: Array.from({ length: c }, () => 1) })) };
    }
    case "yonkoma": {
      const count = Number(params.count ?? 4);
      const tflag = params.title === "false" ? false : !!params.title;
      if (Number(params.columns ?? 1) === 2) {
        // two strips side by side, read in the book's direction; the title spans both
        const strip = { split: "rows", children: Array.from({ length: count }, () => "panel") };
        const body = { split: "cols", gutter: params.columnGap ?? "8bmm", children: [strip, strip] };
        return tflag ? { split: "rows", sizes: [Number(params.titleHeight ?? 0.32), count], children: [{ panel: `${page.id}-title` }, body] } : body;
      }
      const rows: Obj[] = Array.from({ length: count }, () => ({ cols: [1], height: 1 }));
      if (tflag) rows.unshift({ cols: [1], height: params.titleHeight ?? 0.32, __title: true });
      return { rows, __yonkomaTitle: tflag };
    }
    case "hero-top": {
      const ratio = Number(params.ratio ?? 0.5);
      const below = (params.below as number[]) ?? [1, 1];
      return { rows: [{ cols: [1], height: ratio }, { cols: below, height: 1 - ratio }] };
    }
    case "hero-bottom": {
      const ratio = Number(params.ratio ?? 0.5);
      const above = (params.above as number[]) ?? [1, 1];
      return { rows: [{ cols: above, height: 1 - ratio }, { cols: [1], height: ratio }] };
    }
    default: {
      const tpl = activePlugins()?.templates.get(name);
      if (tpl) {
        try {
          return tpl(params);
        } catch (e) {
          bag.error("PLUGIN_ERROR", `layout template "${name}": ${(e as Error).message}`, { path: [...page.path, "layout", "template"] });
          return {};
        }
      }
      bag.error("SCHEMA_ENUM", `unknown layout template "${name}"`, { path: [...page.path, "layout", "template"] });
      return {};
    }
  }
}
