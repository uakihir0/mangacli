// Page composition: layout all elements and build the display list (spec 4.12).
import { BLACK, WHITE, parseColor } from "../core/color.js";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { Rng } from "../core/random.js";
import { parseAngle, toMm } from "../core/units.js";
import { type ElemCtx, placeCtx, tag } from "../elements/context.js";
import { type BalloonPlan, planBalloon, renderBalloon, renderConnected } from "../elements/balloon.js";
import { renderEffect } from "../elements/effects.js";
import { layoutImage } from "../elements/image.js";
import { inksToNodes } from "../elements/inkir.js";
import { renderMark } from "../elements/marks.js";
import { resolveRegion } from "../elements/region.js";
import { renderSfx, renderText } from "../elements/textel.js";
import { textValue } from "../elements/textstyle.js";
import type { FontRegistry } from "../fonts/registry.js";
import { flattenPath, parseSvgPath, polyPath, smoothPath, transformPath } from "../geom/path.js";
import { type Matrix, type Rect, type Vec, applyMat, boundsOf, invertMat, rectInset, rectIntersect, rectOverlapArea } from "../geom/vec.js";
import { inkLine, inkShape } from "../ink/shape.js";
import type { InkPoly } from "../ink/stroke.js";
import { isObj } from "../load/normalize.js";
import { type PageGeom, type PanelGeom, bookOf, computePageGeom, layoutPanels } from "../layout/page.js";
import { RefRegistry, center, place, resolvePoint, sizeValue } from "../layout/place.js";
import type { RElement, RPage, ResolvedDoc } from "../model/resolve.js";
import { parsePaint, resolveHand, resolvePen, resolveStroke } from "../model/values.js";
import { BODY_GENERATORS } from "../shapes/balloon.js";
import { defaultTextStyle, layoutText } from "../text/layout.js";
import { parseMarkup, plainText } from "../text/markup.js";
import type { AssetRegistry } from "./assets.js";
import type { DisplayList, GroupNode, Node } from "./ir.js";

type Obj = Record<string, unknown>;

export interface ComposeOptions {
  bag: DiagnosticBag;
  fonts: FontRegistry;
  assets: AssetRegistry;
  lang: string;
  defaultLang: string;
  draft: boolean;
  print: boolean;
  /** physical page number (1-based) & nombre */
  physical: number;
  nombre: number | null;
  outputDpi: (geom: PageGeom) => number;
}

export interface PageLayoutInfo {
  geom: PageGeom;
  panels: { id: string; polygon: Vec[]; order: number; box: Rect }[];
  elements: { id: string; type: string; bbox: Rect; panel?: string }[];
  transcript: { panel?: string; id: string; type: string; who?: string; as?: string; text: string }[];
}

interface Item {
  el: RElement;
  nodes: Node[];
  bbox: Rect;
  z: number;
  layer: number; // 0 normal, 1 balloon, 2 text/sfx
  source: number; // 0 panel 1 page
  panelIdx: number;
  listIdx: number;
  free: boolean;
  openClip?: Node["kind"] extends never ? never : import("../geom/path.js").PathData;
  stackUnder?: boolean;
}

function elementTexts(el: RElement, lang: string, def: string): string[] {
  const out: string[] = [];
  if (el.props.text !== undefined) out.push(textValue(el.props.text, lang, def));
  if (el.children) for (const c of el.children) out.push(...elementTexts(c, lang, def));
  return out;
}

async function prepareFonts(page: RPage, o: ComposeOptions) {
  const jobs: [string, string][] = [];
  const add = (el: RElement) => {
    const font = (el.props.font as string) ?? (el.type === "sfx" ? "sfx" : el.type === "text" ? "narration" : "dialogue");
    for (const t of elementTexts(el, o.lang, o.defaultLang)) {
      jobs.push([font, t + "﹅・…"]);
      const fonts = [...t.matchAll(/<font=([^>\s]+)>/g)].map((m) => m[1]);
      for (const f of fonts) jobs.push([f, t]);
      if (isObj(el.props.ruby) && (el.props.ruby as Obj).font) jobs.push([(el.props.ruby as Obj).font as string, t]);
      const bold = o.fonts.boldName(font);
      if (bold && /<b>/.test(t)) jobs.push([bold, t]);
    }
    if (el.children) el.children.forEach(add);
  };
  for (const pn of page.panels) pn.elements.forEach(add);
  page.layers.forEach(add);
  for (const [f, t] of jobs) await o.fonts.prepare(f, t);
  await o.fonts.prepare("ui", "0123456789-");
}

export async function composePage(doc: ResolvedDoc, page: RPage, physicalIndex: number, o: ComposeOptions): Promise<{ list: DisplayList; info: PageLayoutInfo }> {
  const bag = o.bag;
  const book = bookOf(doc.doc);
  const geom = computePageGeom(page, physicalIndex, book, bag);
  const u = geom.units;
  const panels = page.type === "blank" ? [] : layoutPanels(page, geom, bag);
  await prepareFonts(page, o);
  const refs = new RefRegistry((ch) => ((doc.characters[ch]?.anchorPriority as string[]) ?? ["mouth", "face"]));
  const items: Item[] = [];
  const panelNodes: { pg: PanelGeom; clipped: Item[] }[] = [];
  const info: PageLayoutInfo = { geom, panels: panels.map((p) => ({ id: p.panel.id, polygon: p.polygon, order: p.order, box: p.box })), elements: [], transcript: [] };
  const baseCtx = (pg?: PanelGeom): ElemCtx => ({
    u,
    geom,
    refs,
    bag,
    fonts: o.fonts,
    assets: o.assets,
    lang: o.lang,
    defaultLang: o.defaultLang,
    draft: o.draft,
    panel: pg,
    coordsBox: pg ? pg.box : geom.trim,
    panelPoly: pg ? panelShapePoly(pg, geom) : undefined,
    characters: doc.characters,
    outputDpi: o.outputDpi(geom),
  });
  const drawOrder = panels.slice().sort((a, b) => ((a.panel.props.z as number) ?? 0) - ((b.panel.props.z as number) ?? 0) || a.order - b.order);

  // phase A: images (refs)
  const processed = new Map<string, Item>();
  const layoutGroup = async (els: RElement[], ctx: ElemCtx, panelIdx: number, source: number) => {
    for (const [i, el] of els.entries()) {
      // scatter items and marks drawn from assets are loaded up front (rendering is synchronous)
      const preload = async (e: RElement) => {
        if (e.type === "scatter") for (const it of (e.props.items as Obj[]) ?? []) if (typeof it.asset === "string") await ctx.assets.info(it.asset, [...e.path, "items"]);
        if (e.type === "mark" && e.props.kind === "asset" && typeof e.props.asset === "string") await ctx.assets.info(e.props.asset, [...e.path, "asset"]);
        for (const c of e.children ?? []) await preload(c);
      };
      await preload(el);
      if (el.type !== "image") continue;
      const coords = coordsFor(el, ctx, geom);
      const c2 = { ...ctx, coordsBox: coords };
      const defaultBox = ctx.panel ? ctx.panel.fullBox : geom.bleedBox;
      const r = await layoutImage(el, c2, defaultBox);
      processed.set(el.id, mkItem(el, r.nodes, r.bbox, panelIdx, i, source, ctx));
    }
  };
  for (const pg of drawOrder) await layoutGroup(pg.panel.elements, baseCtx(pg), drawOrder.indexOf(pg), 0);
  await layoutGroup(page.layers, baseCtx(), 0, 1);

  // phase B: balloons plans, text, sfx, effects, fills, marks, draw
  const renderOthers = async (els: RElement[], ctx: ElemCtx, panelIdx: number, source: number) => {
    const plans: { plan: BalloonPlan; idx: number }[] = [];
    for (const [i, el] of els.entries()) {
      if (el.type === "image") continue;
      if (el.props.visible === false) continue;
      const c2 = { ...ctx, coordsBox: coordsFor(el, ctx, geom) };
      try {
        switch (el.type) {
          case "balloon":
            plans.push({ plan: planBalloon(el, c2), idx: i });
            break;
          case "text": {
            const r = renderText(el, c2);
            processed.set(el.id, mkItem(el, r.nodes, r.bbox, panelIdx, i, source, ctx));
            refs.add({ id: el.id, type: "text", bbox: r.bbox, anchors: {}, regions: {}, panelId: ctx.panel?.panel.id });
            break;
          }
          case "sfx": {
            const r = renderSfx(el, c2);
            processed.set(el.id, mkItem(el, r.nodes, r.bbox, panelIdx, i, source, ctx));
            refs.add({ id: el.id, type: "sfx", bbox: r.bbox, anchors: {}, regions: {}, panelId: ctx.panel?.panel.id });
            break;
          }
          default:
            break;
        }
      } catch (e) {
        bag.error("RENDER_FAILED", `${el.id}: ${(e as Error).message}`, { path: el.path, elementId: el.id });
      }
    }
    // place balloons
    placeBalloons(plans.map((p) => p.plan), ctx, refs, processed, await silhouettes(refs, ctx));
    const consumed = new Set<string>();
    const byId = new Map(plans.map((x) => [x.plan.el.id, x]));
    for (const { plan, idx } of plans) {
      const cn = plan.props.connect;
      const list = Array.isArray(cn) ? cn : cn ? [cn] : [];
      for (const c of list as Obj[]) {
        const other = byId.get(String(c.to));
        if (!other) {
          bag.error("REF_NOT_FOUND", `connect target "${c.to}" not found in the same panel`, { path: [...plan.el.path, "connect"] });
          continue;
        }
        try {
          const r = renderConnected(other.plan, plan, (c.style as string) ?? "neck", c.width, { ...ctx, coordsBox: coordsFor(plan.el, ctx, geom) });
          processed.set(other.plan.el.id, mkItem(other.plan.el, r.nodes, r.bbox, panelIdx, Math.min(idx, other.idx), source, ctx));
          refs.add({ id: plan.el.id, type: "balloon", bbox: r.bbox, anchors: {}, regions: {}, panelId: ctx.panel?.panel.id, shape: r.contour });
          refs.add({ id: other.plan.el.id, type: "balloon", bbox: r.bbox, anchors: {}, regions: {}, panelId: ctx.panel?.panel.id, shape: r.contour });
          consumed.add(plan.el.id);
          consumed.add(other.plan.el.id);
        } catch (e) {
          bag.error("RENDER_FAILED", `${plan.el.id}: ${(e as Error).message}`, { path: plan.el.path, elementId: plan.el.id });
        }
      }
    }
    for (const { plan, idx } of plans) {
      if (consumed.has(plan.el.id)) continue;
      try {
        const r = renderBalloon(plan, { ...ctx, coordsBox: coordsFor(plan.el, ctx, geom) });
        processed.set(plan.el.id, mkItem(plan.el, r.nodes, r.bbox, panelIdx, idx, source, ctx));
        refs.add({ id: plan.el.id, type: "balloon", bbox: r.bbox, anchors: {}, regions: {}, panelId: ctx.panel?.panel.id, shape: r.contour });
      } catch (e) {
        bag.error("RENDER_FAILED", `${plan.el.id}: ${(e as Error).message}`, { path: plan.el.path, elementId: plan.el.id });
      }
    }
    // effects etc (after refs exist)
    for (const [i, el] of els.entries()) {
      if (["image", "balloon", "text", "sfx"].includes(el.type) || el.props.visible === false) continue;
      const c2 = { ...ctx, coordsBox: coordsFor(el, ctx, geom) };
      try {
        const nodes = renderMisc(el, c2);
        processed.set(el.id, mkItem(el, nodes.nodes, nodes.bbox, panelIdx, i, source, ctx));
      } catch (e) {
        bag.error("RENDER_FAILED", `${el.id}: ${(e as Error).message}`, { path: el.path, elementId: el.id });
      }
    }
  };
  for (const pg of drawOrder) await renderOthers(pg.panel.elements, baseCtx(pg), drawOrder.indexOf(pg), 0);
  await renderOthers(page.layers, baseCtx(), 0, 1);

  // collect items
  for (const pg of drawOrder) {
    const clipped: Item[] = [];
    for (const el of pg.panel.elements) {
      collectTranscript(el, pg.panel.id, info, o);
      const it = processed.get(el.id);
      if (!it) continue;
      if (it.free) {
        if (isObj(el.props.clip)) it.openClip = openClipPath(pg, el.props.clip as Obj, geom, u);
        items.push(it);
      } else {
        clipped.push(it);
        // text cut by the panel clip
        const pb = pg.box;
        const b = it.bbox;
        if ((el.type === "balloon" || el.type === "text") && (b.x < pb.x - 0.3 || b.y < pb.y - 0.3 || b.x + b.w > pb.x + pb.w + 0.3 || b.y + b.h > pb.y + pb.h + 0.3)) bag.warn("TEXT_CLIPPED", `${el.id} is cut by the panel frame`, { path: el.path, elementId: el.id, pageId: page.id });
      }
      info.elements.push({ id: el.id, type: el.type, bbox: it.bbox, panel: pg.panel.id });
    }
    clipped.sort((a, b) => a.z - b.z || a.listIdx - b.listIdx);
    panelNodes.push({ pg, clipped });
  }
  for (const el of page.layers) {
    collectTranscript(el, undefined, info, o);
    const it = processed.get(el.id);
    if (!it) continue;
    it.free = true;
    it.stackUnder = el.props.stack === "under";
    items.push(it);
    info.elements.push({ id: el.id, type: el.type, bbox: it.bbox });
  }

  // build tree
  const root: GroupNode = { kind: "group", children: [] };
  const bgPaint = parsePaint(page.settings.background ?? "paper", { u, box: geom.bleedBox, seed: page.seed, bag, path: [...page.path, "background"] });
  for (const it of items.filter((i) => i.stackUnder)) root.children.push(...it.nodes);
  for (const { pg, clipped } of panelNodes) {
    if (pg.panel.props.visible === false) continue;
    root.children.push(...panelTree(pg, clipped, geom, bgPaint, bag));
  }
  const free = items.filter((i) => !i.stackUnder);
  free.sort((a, b) => a.z - b.z || a.layer - b.layer || a.source - b.source || a.panelIdx - b.panelIdx || (a.layer === 1 && b.layer === 1 ? b.listIdx - a.listIdx : a.listIdx - b.listIdx));
  for (const it of free) {
    if (it.openClip) root.children.push({ kind: "group", clip: it.openClip, children: it.nodes });
    else root.children.push(...it.nodes);
  }
  // page numbers
  if (o.nombre !== null) root.children.push(...nombreNodes(doc, page, geom, o));
  const list: DisplayList = {
    version: 1,
    page: { id: page.id, index: page.index },
    size: { width: geom.bleedBox.w, height: geom.bleedBox.h },
    boxes: { bleed: geom.bleedBox, trim: geom.trim, baseFrame: geom.baseFrame, safe: geom.safe },
    background: bgPaint,
    root: { kind: "group", transform: [1, 0, 0, 1, geom.bleed, geom.bleed], children: [...(bgPaint ? [{ kind: "path" as const, path: polyPath(rectPts(geom.bleedBox), true), fillRule: "nonzero" as const, paint: bgPaint, tag: { elementId: page.id, elementType: "page", role: "background" as const, separation: "background" } }] : []), root] },
  };
  // safe area / fold checks
  checkTextSafety(items.concat(panelNodes.flatMap((p) => p.clipped)), geom, bag, page);
  return { list, info };
}

function rectPts(r: Rect): Vec[] {
  return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
}

function mkItem(el: RElement, nodes: Node[], bbox: Rect, panelIdx: number, listIdx: number, source: number, ctx: ElemCtx): Item {
  const clip = el.props.clip;
  const free = source === 1 || clip === "none" || clip === "trim" || isObj(clip) || (el.type === "balloon" && clip !== "panel" && !isOffscreen(el));
  const layer = el.type === "balloon" ? 1 : el.type === "text" || el.type === "sfx" ? 2 : 0;
  const op = typeof el.props.opacity === "number" && el.type !== "image" && el.type !== "effect" ? el.props.opacity : undefined;
  const blend = el.type !== "image" && typeof el.props.blend === "string" && el.props.blend !== "normal" ? (el.props.blend as GroupNode["blend"]) : undefined;
  let inner = nodes;
  if (el.props.visible === false) inner = [];
  // flip for lettering: mirror about the element's box (spec 5.3.4)
  if ((el.type === "text" || el.type === "sfx") && el.props.flip && inner.length) {
    const fx = el.props.flip === "x" || el.props.flip === "xy" || el.props.flip === true;
    const fy = el.props.flip === "y" || el.props.flip === "xy";
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    inner = [{ kind: "group", transform: [fx ? -1 : 1, 0, 0, fy ? -1 : 1, fx ? 2 * cx : 0, fy ? 2 * cy : 0], children: inner }];
  }
  // mask: show the element only inside a region (spec 5.11); feathered masks fade out
  if (el.props.mask !== undefined && inner.length) {
    const mspec = isObj(el.props.mask) && "region" in (el.props.mask as Obj) ? (el.props.mask as Obj).region : el.props.mask;
    const reg = resolveRegion(mspec, ctx, ctx.panel ? "panel" : "page", [...el.path, "mask"]);
    const fe = isObj(el.props.mask) && (el.props.mask as Obj).feather !== undefined ? toMm((el.props.mask as Obj).feather as string, ctx.u) : reg.feather;
    inner = [fe > 0 ? { kind: "group", softClip: { path: reg.path, fillRule: reg.fillRule, feather: fe }, children: inner } : { kind: "group", clip: reg.path, clipRule: reg.fillRule, children: inner }];
  }
  const wrapped: Node[] = op !== undefined || blend ? [{ kind: "group", opacity: op, blend, children: inner }] : inner;
  return { el, nodes: wrapped, bbox, z: (el.props.z as number) ?? 0, layer, source, panelIdx, listIdx, free };
}

function isOffscreen(el: RElement): boolean {
  const t = el.props.tail;
  return isObj(t) && !!(t as Obj).offscreen;
}

function coordsFor(el: RElement, ctx: ElemCtx, geom: PageGeom): Rect {
  const c = el.props.coords;
  if (c === "page") return geom.trim;
  if (c === "baseFrame") return geom.baseFrame;
  if (c === "panel" || c === undefined) return ctx.panel ? ctx.panel.box : geom.trim;
  if (typeof c === "string") {
    const t = ctx.refs.get(c);
    if (t) return t.bbox;
    ctx.bag.error("REF_NOT_FOUND", `coords reference "${c}" not found`, { path: [...el.path, "coords"] });
  }
  return ctx.panel ? ctx.panel.box : geom.trim;
}

function panelShapePoly(pg: PanelGeom, geom: PageGeom): Vec[] {
  const sh = pg.panel.props.shape as Obj | undefined;
  if (!isObj(sh) || sh.kind === "rect") return pg.polygon;
  const b = pg.fullBox;
  if (sh.kind === "ellipse") {
    const n = 160;
    return Array.from({ length: n }, (_, i) => ({ x: b.x + b.w / 2 + Math.cos((i / n) * Math.PI * 2) * b.w / 2, y: b.y + b.h / 2 + Math.sin((i / n) * Math.PI * 2) * b.h / 2 }));
  }
  if (sh.kind === "rounded") {
    const r = sh.radius !== undefined ? toMm(sh.radius as string, geom.units) : 3 * geom.k;
    const g = BODY_GENERATORS["round-rect"](b.w, b.h, { kind: "round-rect", irregularity: 0, tilt: 0, radius: r }, 1);
    return g.contour.pts.map((p) => ({ x: p.x + b.x + b.w / 2, y: p.y + b.y + b.h / 2 }));
  }
  if (sh.kind === "cloud") {
    const g = BODY_GENERATORS.cloud(b.w * 0.86, b.h * 0.86, { kind: "cloud", irregularity: 0.5, tilt: 0 }, pg.panel.seed);
    return g.contour.pts.map((p) => ({ x: p.x + b.x + b.w / 2, y: p.y + b.y + b.h / 2 }));
  }
  return pg.polygon;
}

function panelTree(pg: PanelGeom, clipped: Item[], geom: PageGeom, pageBg: ReturnType<typeof parsePaint>, bag: DiagnosticBag): Node[] {
  const u = geom.units;
  const p = pg.panel.props;
  const out: Node[] = [];
  const poly = panelShapePoly(pg, geom);
  const isShaped = poly !== pg.polygon;
  if (p.knockout !== undefined) {
    const kw = toMm(p.knockout as string, u);
    const ext = offsetConvex(poly, kw);
    out.push({ kind: "path", path: polyPath(ext, true), fillRule: "nonzero", paint: pageBg ?? { type: "solid", color: WHITE } });
  }
  const bg = parsePaint(p.background ?? "paper", { u, box: pg.fullBox, seed: pg.panel.seed, bag, path: [...pg.panel.path, "background"] });
  const inner: Node[] = [];
  if (bg) inner.push({ kind: "path", path: polyPath(poly, true), fillRule: "nonzero", paint: bg, tag: { elementId: pg.panel.id, elementType: "panel", role: "background", separation: "background" } });
  for (const it of clipped) inner.push(...it.nodes);
  out.push({ kind: "group", clip: isShaped ? smoothPath(poly, true) : polyPath(poly, true), children: inner, tag: { elementId: pg.panel.id, elementType: "panel", role: "art", separation: "art" } });
  out.push(...borderNodes(pg, poly, isShaped, geom, bag));
  return out;
}

function offsetConvex(poly: Vec[], d: number): Vec[] {
  const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
  return poly.map((p) => {
    const v = { x: p.x - c.x, y: p.y - c.y };
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: p.x + (v.x / l) * d * 1.42, y: p.y + (v.y / l) * d * 1.42 };
  });
}

function borderNodes(pg: PanelGeom, poly: Vec[], shaped: boolean, geom: PageGeom, bag: DiagnosticBag): Node[] {
  const u = geom.units;
  const p = pg.panel.props;
  const b0 = (p.border ?? {}) as Obj;
  if (b0.style === "none" && !isObj(b0.sides)) return [];
  const hand0 = resolveHand(p.hand, u);
  const rng = new Rng(pg.panel.seed);
  const t = { elementId: pg.panel.id, elementType: "panel", role: "frame" as const, separation: "frame" };
  const nodes: Node[] = [];
  const resolveB = (b: Obj, path: (string | number)[]) => {
    const hand = isObj(b.hand) ? resolveHand(b.hand, u) : hand0;
    const st = resolveStroke(b, hand, u, bag, path);
    st.pen = { ...st.pen, cap: "flat" };
    return { b, hand, st, style: (b.style as string) ?? "solid" };
  };
  const main = resolveB(b0, [...pg.panel.path, "border"]);
  if (shaped) {
    if (main.style === "none" || main.st.width <= 0) return [];
    const res = inkShape({ pts: poly, closed: true, smooth: true }, { line: main.st, hand: main.hand, rng, ruler: false });
    return inksToNodes(res.inks, main.st.color, t);
  }
  const n = pg.polygon.length;
  // interior direction for each edge (inner lines of double borders, blur bands)
  const cx = pg.polygon.reduce((a, q) => a + q.x, 0) / n;
  const cy = pg.polygon.reduce((a, q) => a + q.y, 0) / n;
  const sideName = (d: Vec, nrm: Vec) => (Math.abs(d.x) >= Math.abs(d.y) ? (nrm.y > 0 ? "top" : "bottom") : nrm.x > 0 ? "left" : "right");
  const L = (v: unknown, fb: string) => toMm((v as string) ?? fb, u);
  for (let i = 0; i < n; i++) {
    const a = pg.polygon[i];
    const c = pg.polygon[(i + 1) % n];
    // skip edges lying on bled sides (outside trim)
    if (isBledEdge(a, c, geom, pg)) continue;
    const d = { x: c.x - a.x, y: c.y - a.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const dir = { x: d.x / l, y: d.y / l };
    let nrm = { x: -dir.y, y: dir.x };
    if (nrm.x * (cx - a.x) + nrm.y * (cy - a.y) < 0) nrm = { x: -nrm.x, y: -nrm.y };
    // per-side overrides (spec 4.9 sides)
    const sides = isObj(b0.sides) ? (b0.sides as Obj) : {};
    const sv = sides[sideName(dir, nrm)];
    const E = sv === undefined ? main : sv === "none" ? null : resolveB({ ...b0, ...(isObj(sv) ? sv : {}), sides: undefined }, [...pg.panel.path, "border", "sides"]);
    if (!E || E.style === "none" || E.st.width <= 0) continue;
    const { st, hand, b } = E;
    const ruler = b.ruler !== false;
    const join = (b.join as string) ?? "clean";
    let e0 = st.width / 2;
    let e1 = st.width / 2;
    if (join === "overshoot") {
      e0 += rng.range(hand.overshoot[0], hand.overshoot[1]);
      e1 += rng.range(hand.overshoot[0], hand.overshoot[1]);
    } else if (join === "gap") {
      e0 = -rng.range(hand.gap[0], hand.gap[1]);
      e1 = -rng.range(hand.gap[0], hand.gap[1]);
    }
    const p0 = { x: a.x - dir.x * e0, y: a.y - dir.y * e0 };
    const p1 = { x: c.x + dir.x * e1, y: c.y + dir.y * e1 };
    const line = (q0: Vec, q1: Vec, w: number, key: string, rul = ruler) => inkLine([q0, q1], { width: w, pen: st.pen, style: "solid" }, hand, rng.fork(key), { ruler: rul, taperIn: false, taperOut: false, resolution: 0.5, inkPool: false, noPull: true });
    const inks: InkPoly[] = [];
    if (E.style === "dashed") {
      const dash = Array.isArray(b.dash) ? (b.dash as unknown[]) : [];
      const on = L(dash[0], `${3 * geom.k}mm`);
      const off = L(dash[1], `${1.5 * geom.k}mm`);
      const total = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const k = Math.max(1, Math.round((total + off) / (on + off)));
      const step = (total + off) / k;
      for (let j = 0; j < k; j++) {
        const s0 = j * step;
        const s1 = Math.min(total, s0 + step - off);
        inks.push(...line({ x: p0.x + dir.x * s0, y: p0.y + dir.y * s0 }, { x: p0.x + dir.x * s1, y: p0.y + dir.y * s1 }, st.width, `d${i}-${j}`));
      }
    } else if (E.style === "wavy") {
      const wv = isObj(b.wave) ? (b.wave as Obj) : {};
      const amp = L(wv.amplitude, `${0.8 * geom.k}mm`);
      const wl = L(wv.wavelength, `${8 * geom.k}mm`);
      const total = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const waves = Math.max(1, Math.round(total / wl));
      const pts: Vec[] = [];
      const N = Math.max(8, Math.ceil(total / 0.4));
      for (let j = 0; j <= N; j++) {
        const s1 = (j / N) * total;
        const o = Math.sin((j / N) * waves * Math.PI * 2) * amp;
        pts.push({ x: p0.x + dir.x * s1 + nrm.x * o, y: p0.y + dir.y * s1 + nrm.y * o });
      }
      inks.push(...inkLine(pts, { width: st.width, pen: st.pen, style: "solid" }, hand, rng.fork(`w${i}`), { taperIn: false, taperOut: false, inkPool: false, noPull: true }));
    } else if (E.style === "blur") {
      // fade the panel edge into the ground colour (no line)
      const bl = isObj(b.blur) ? (b.blur as Obj) : {};
      const bw = L(bl.width, `${6 * geom.k}mm`);
      const col = parseColor((bl.color as string) ?? "paper") ?? WHITE;
      const q = [a, c, { x: c.x + nrm.x * bw, y: c.y + nrm.y * bw }, { x: a.x + nrm.x * bw, y: a.y + nrm.y * bw }];
      nodes.push({ kind: "path", path: polyPath(q, true), fillRule: "nonzero", paint: { type: "linear-gradient", x0: a.x, y0: a.y, x1: a.x + nrm.x * bw, y1: a.y + nrm.y * bw, stops: [{ offset: 0, color: col }, { offset: 1, color: { ...col, a: 0 } }] }, tag: t });
      continue;
    } else {
      inks.push(...line(p0, p1, st.width, `b${i}`));
      if (E.style === "double") {
        const db = isObj(b.double) ? (b.double as Obj) : {};
        const gap = L(db.gap, `${0.6 * geom.k}mm`);
        const iw = L(db.inner, `${0.25 * geom.k}mm`);
        const off = st.width / 2 + gap + iw / 2;
        // the inner line runs between the neighbouring edges' inner lines
        const q0 = { x: a.x + nrm.x * off + dir.x * (off - iw / 2), y: a.y + nrm.y * off + dir.y * (off - iw / 2) };
        const q1 = { x: c.x + nrm.x * off - dir.x * (off - iw / 2), y: c.y + nrm.y * off - dir.y * (off - iw / 2) };
        inks.push(...line(q0, q1, iw, `i${i}`));
      }
    }
    nodes.push(...inksToNodes(inks, st.color, t));
  }
  return nodes;
}

function isBledEdge(a: Vec, c: Vec, geom: PageGeom, pg: PanelGeom): boolean {
  const bb = geom.bleedBox;
  const eps = 0.01;
  for (const s of pg.bledSides) {
    if (s === "top" && Math.abs(a.y - bb.y) < eps && Math.abs(c.y - bb.y) < eps) return true;
    if (s === "bottom" && Math.abs(a.y - (bb.y + bb.h)) < eps && Math.abs(c.y - (bb.y + bb.h)) < eps) return true;
    if (s === "left" && Math.abs(a.x - bb.x) < eps && Math.abs(c.x - bb.x) < eps) return true;
    if (s === "right" && Math.abs(a.x - (bb.x + bb.w)) < eps && Math.abs(c.x - (bb.x + bb.w)) < eps) return true;
  }
  return false;
}

function openClipPath(pg: PanelGeom, clip: Obj, geom: PageGeom, u: PageGeom["units"]) {
  const open = new Set((clip.open as string[]) ?? []);
  const bw = toMm(((pg.panel.props.border as Obj)?.width as string) ?? `${0.5 * geom.k}mm`, u);
  const poly = pg.polygon;
  const n = poly.length;
  const lines: { p: Vec; d: Vec }[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const d = { x: b.x - a.x, y: b.y - a.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const nrm = { x: d.y / l, y: -d.x / l }; // outward for CW polygon (y-down)
    const side = nrm.y < -0.7 ? "top" : nrm.y > 0.7 ? "bottom" : nrm.x < -0.7 ? "left" : nrm.x > 0.7 ? "right" : "";
    const off = open.has(side) ? 500 : -bw / 2;
    lines.push({ p: { x: a.x + nrm.x * off, y: a.y + nrm.y * off }, d: { x: d.x / l, y: d.y / l } });
  }
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n];
    const L2 = lines[i];
    const den = L1.d.x * L2.d.y - L1.d.y * L2.d.x;
    if (Math.abs(den) < 1e-9) {
      pts.push(L2.p);
      continue;
    }
    const t = ((L2.p.x - L1.p.x) * L2.d.y - (L2.p.y - L1.p.y) * L2.d.x) / den;
    pts.push({ x: L1.p.x + L1.d.x * t, y: L1.p.y + L1.d.y * t });
  }
  return polyPath(pts, true);
}

// ---- misc elements ---------------------------------------------------------------

function renderMisc(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect } {
  const p = el.props;
  switch (el.type) {
    case "effect": {
      const nodes = renderEffect(el, ctx);
      return { nodes, bbox: ctx.panel?.box ?? ctx.geom.trim };
    }
    case "fill": {
      const reg = resolveRegion(p.region, ctx, ctx.panel ? "panel" : "page", [...el.path, "region"]);
      const paint = parsePaint(p.paint ?? "black", { u: ctx.u, box: reg.bbox, seed: el.seed, bag: ctx.bag, path: [...el.path, "paint"] });
      if (!paint) return { nodes: [], bbox: reg.bbox };
      if (paint.type === "tone" && p.edge === "soft") paint.tone.softEdge = p.edgeWidth !== undefined ? toMm(p.edgeWidth as string, ctx.u) : 3 * ctx.u.k;
      let pathNode: Node = { kind: "path", path: reg.path, fillRule: reg.fillRule, paint, tag: tag(el, paint.type === "tone" ? "tone" : "fill") };
      if (p.edge === "cut") {
        const rng = new Rng(el.seed);
        const polys = reg.polys.map((pl) => inkShape({ pts: pl, closed: true, smooth: true }, { hand: { ...resolveHand(undefined, ctx.u), wobbleAmp: 0.1 * ctx.u.k, wobbleLen: 4 * ctx.u.k }, rng }).fill);
        pathNode = { ...pathNode, path: polys.flatMap((q) => polyPath(q, true)) } as Node;
      }
      // erase: scrape the tone back to paper with lines, areas and scratches (spec 8.13.6)
      if (Array.isArray(p.erase) && p.erase.length) {
        const er: Node[] = [];
        const rng = new Rng(el.seed ^ 0xe7a5);
        const hand = resolveHand(p.hand, ctx.u, ctx.draft);
        const K = { type: "solid" as const, color: BLACK };
        const rangeMm = (v: unknown, a: number, b: number) => (Array.isArray(v) ? [toMm(v[0] as string, ctx.u), toMm((v[1] ?? v[0]) as string, ctx.u)] : v !== undefined ? [toMm(v as string, ctx.u), toMm(v as string, ctx.u)] : [a * ctx.u.k, b * ctx.u.k]);
        const pcE = placeCtx(ctx, el);
        for (const [i, op] of (p.erase as Obj[]).entries()) {
          if (Array.isArray(op.points)) {
            const pts = (op.points as unknown[]).map((q) => resolvePoint(q, pcE)).filter((q): q is Vec => !!q);
            const [w0, w1] = rangeMm(op.width, 0.6, 1.4);
            const taper = (op.taper as string) ?? "both";
            if (pts.length > 1) er.push(...inksToNodes(inkLine(pts, { width: (w0 + w1) / 2, pen: { ...resolvePen(undefined, ctx.u), pressure: 0.5 }, style: "solid" }, hand, rng.fork(`e${i}`), { taperIn: taper !== "none" && taper !== "end", taperOut: taper !== "none" && taper !== "start" }), BLACK, tag(el, "fill")));
          } else if (op.region !== undefined) {
            const r2 = resolveRegion(op.region, ctx, "panel", [...el.path, "erase", i, "region"]);
            const fe2 = op.feather !== undefined ? toMm(op.feather as string, ctx.u) : r2.feather;
            const n2: Node = { kind: "path", path: r2.path, fillRule: r2.fillRule, paint: K, tag: tag(el, "fill") };
            er.push(fe2 > 0 ? { kind: "group", softClip: { path: r2.path, fillRule: r2.fillRule, feather: fe2 }, children: [n2] } : n2);
          } else if (isObj(op.scratches)) {
            const sc = op.scratches as Obj;
            const r2 = resolveRegion(sc.region ?? "panel", ctx, "panel", [...el.path, "erase", i, "scratches"]);
            const count = Number(sc.count ?? 12);
            const [l0, l1] = rangeMm(sc.length, 3, 8);
            const [w0, w1] = rangeMm(sc.width, 0.2, 0.5);
            const ang = parseAngle((sc.angle as string) ?? "30deg");
            for (let k = 0, tries = 0; k < count && tries < count * 20; tries++) {
              const c = { x: r2.bbox.x + rng.next() * r2.bbox.w, y: r2.bbox.y + rng.next() * r2.bbox.h };
              if (!r2.contains(c)) continue;
              k++;
              const L = rng.range(l0, l1);
              const a = ang + rng.range(-0.15, 0.15);
              const d = { x: (Math.cos(a) * L) / 2, y: (Math.sin(a) * L) / 2 };
              er.push(...inksToNodes(inkLine([{ x: c.x - d.x, y: c.y - d.y }, { x: c.x + d.x, y: c.y + d.y }], { width: rng.range(w0, w1), pen: resolvePen(undefined, ctx.u), style: "solid" }, hand, rng.fork(`s${k}`), { taperIn: true, taperOut: true, ruler: true }), BLACK, tag(el, "fill")));
            }
          }
        }
        if (er.length) pathNode = { kind: "group", isolate: true, children: [pathNode, { kind: "group", blend: "destination-out", children: er }], tag: tag(el, "tone") };
      }
      const fe = reg.feather > 0 ? reg.feather : p.edge === "soft" && paint.type !== "tone" ? (p.edgeWidth !== undefined ? toMm(p.edgeWidth as string, ctx.u) : 3 * ctx.u.k) : 0;
      if (fe > 0) pathNode = { kind: "group", softClip: { path: reg.path, fillRule: reg.fillRule, feather: fe }, children: [pathNode], tag: tag(el, "fill") };
      if (reg.alphaOf) {
        const t = ctx.refs.get(reg.alphaOf);
        return { nodes: [{ kind: "group", children: [pathNode], alphaMaskOf: t?.imagePx, tag: tag(el, "tone") } as Node], bbox: reg.bbox };
      }
      return { nodes: [pathNode], bbox: reg.bbox };
    }
    case "mark":
      return renderMark(el, ctx);
    case "draw":
      return renderDraw(el, ctx);
    case "scatter":
      return renderScatter(el, ctx);
    case "group": {
      // a group is a coordinate frame: with `size`, children use its box (0..size) and the
      // group's placement (at / anchor / rotate / scale) moves them all (spec 5.10)
      const pc = placeCtx(ctx, el);
      const sz = Array.isArray(p.size) ? p.size : null;
      const gw = sz ? sizeValue(sz[0], ctx.coordsBox.w, pc) : "auto";
      const gh = sz ? sizeValue(sz[1], ctx.coordsBox.h, pc) : "auto";
      const sized = gw !== "auto" && gh !== "auto";
      const cctx: ElemCtx = sized ? { ...ctx, coordsBox: { x: 0, y: 0, w: gw as number, h: gh as number }, localFrame: true } : ctx;
      const nodes: Node[] = [];
      for (const c of el.children ?? []) {
        const r = c.type === "text" ? renderText(c, cctx) : c.type === "sfx" ? renderSfx(c, cctx) : renderMisc(c, cctx);
        nodes.push(...r.nodes);
      }
      let transform: [number, number, number, number, number, number] | undefined;
      let bbox = ctx.coordsBox;
      if (sized) {
        const pl = place(p, gw as number, gh as number, pc);
        transform = pl.matrix as typeof transform;
        bbox = pl.bbox;
      } else if (p.rotate !== undefined || p.scale !== undefined) {
        const c = p.at !== undefined ? (resolvePoint(p.at, pc) ?? center(ctx.coordsBox)) : center(ctx.coordsBox);
        const pl = place({ ...p, at: undefined, anchor: [0.5, 0.5] }, 0, 0, pc, c);
        transform = pl.matrix as typeof transform;
      }
      return { nodes: [{ kind: "group", transform, children: nodes, tag: tag(el, "fill") }], bbox };
    }
  }
  return { nodes: [], bbox: ctx.coordsBox };
}

function renderDraw(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect } {
  const p = el.props;
  const u = ctx.u;
  const hand = resolveHand(p.hand, u, ctx.draft);
  const st = resolveStroke(p.stroke, hand, u, ctx.bag, [...el.path, "stroke"]);
  const rng = new Rng(el.seed);
  const kind = String(p.kind);
  const pc = { u, coordsBox: ctx.coordsBox, refs: ctx.refs, panelId: ctx.panel?.panel.id, bag: ctx.bag, path: el.path };
  let pts: Vec[] = [];
  let closed = false;
  if (kind === "rect" || kind === "ellipse") {
    const sz = (p.size as unknown[]) ?? ["10mm", "10mm"];
    const w = toMm(sz[0] as string, { ...u, base: ctx.coordsBox.w });
    const h = toMm(sz[1] as string, { ...u, base: ctx.coordsBox.h });
    // local shape in 0..w, 0..h, mapped through the placement (anchor, rotate, scale)
    const pl = place(p, w, h, pc);
    let local: Vec[];
    if (kind === "rect") {
      const rad = p.radius !== undefined ? Math.min(w / 2, h / 2, toMm(p.radius as string, u)) : 0;
      if (rad > 0) {
        local = [];
        const corners = [[w - rad, rad, -Math.PI / 2], [w - rad, h - rad, 0], [rad, h - rad, Math.PI / 2], [rad, rad, Math.PI]] as const;
        for (const [cx, cy, a0] of corners) for (let k = 0; k <= 8; k++) local.push({ x: cx + Math.cos(a0 + (k / 8) * (Math.PI / 2)) * rad, y: cy + Math.sin(a0 + (k / 8) * (Math.PI / 2)) * rad });
      } else local = rectPts({ x: 0, y: 0, w, h });
    } else local = Array.from({ length: 72 }, (_, i) => ({ x: w / 2 + (Math.cos((i / 72) * Math.PI * 2) * w) / 2, y: h / 2 + (Math.sin((i / 72) * Math.PI * 2) * h) / 2 }));
    pts = local.map((q) => applyMat(pl.matrix, q));
    closed = true;
  } else if (kind === "path") {
    const d = typeof p.d === "string" ? p.d : "";
    const flat = flattenPath(transformPath(parseSvgPath(d), [1, 0, 0, 1, ctx.coordsBox.x, ctx.coordsBox.y]), 0.05);
    pts = flat[0]?.pts ?? [];
    closed = flat[0]?.closed ?? false;
  } else {
    const raw = (p.points as unknown[]) ?? [];
    pts = raw.map((q) => (Array.isArray(q) ? { x: ctx.coordsBox.x + toMm(q[0] as string, { ...u, base: ctx.coordsBox.w }), y: ctx.coordsBox.y + toMm(q[1] as string, { ...u, base: ctx.coordsBox.h }) } : (ctx.refs.point(String(q), ctx.panel?.panel.id) ?? { x: 0, y: 0 })));
    closed = kind === "polygon" || p.closed === true;
    if (kind === "curve" && pts.length > 2) {
      const sm: Vec[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        for (let k = 0; k < 10; k++) {
          const t = k / 10;
          const t2 = t * t;
          const t3 = t2 * t;
          sm.push({
            x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
          });
        }
      }
      sm.push(pts[pts.length - 1]);
      pts = sm;
    }
  }
  const nodes: Node[] = [];
  if (pts.length < 2) return { nodes, bbox: ctx.coordsBox };
  const res = inkShape({ pts, closed, smooth: kind === "ellipse" || kind === "curve" }, { line: st, hand, rng, ruler: p.ruler === true, join: "overshoot" });
  const fill = parsePaint(p.fill ?? "none", { u, box: boundsOf(pts), seed: el.seed });
  if (fill && closed) nodes.push({ kind: "path", path: smoothPath(res.fill, true), fillRule: "nonzero", paint: fill, tag: tag(el, "fill") });
  nodes.push(...inksToNodes(res.inks, st.color, tag(el, "ink")));
  if (kind === "arrow" || p.head !== undefined) {
    const head = (typeof p.head === "string" ? { end: p.head } : (p.head ?? { end: "arrow" })) as Obj;
    const size = head.size !== undefined ? toMm(head.size as string, u) : st.width * 10;
    const mk = (tip: Vec, from: Vec, style: string) => {
      if (!style || style === "none") return;
      const d = { x: tip.x - from.x, y: tip.y - from.y };
      const l = Math.hypot(d.x, d.y) || 1;
      const dir = { x: d.x / l, y: d.y / l };
      const nrm = { x: -dir.y, y: dir.x };
      const a = { x: tip.x - dir.x * size + nrm.x * size * 0.5, y: tip.y - dir.y * size + nrm.y * size * 0.5 };
      const b = { x: tip.x - dir.x * size - nrm.x * size * 0.5, y: tip.y - dir.y * size - nrm.y * size * 0.5 };
      if (style === "triangle") nodes.push({ kind: "path", path: polyPath([tip, a, b], true), fillRule: "nonzero", paint: { type: "solid", color: st.color }, tag: tag(el, "ink") });
      else if (style === "dot") nodes.push({ kind: "path", path: polyPath(Array.from({ length: 20 }, (_, i) => ({ x: tip.x + Math.cos((i / 20) * Math.PI * 2) * size * 0.3, y: tip.y + Math.sin((i / 20) * Math.PI * 2) * size * 0.3 })), true), fillRule: "nonzero", paint: { type: "solid", color: st.color }, tag: tag(el, "ink") });
      else if (style === "bar") nodes.push(...inksToNodes(inkLine([{ x: tip.x + nrm.x * size * 0.5, y: tip.y + nrm.y * size * 0.5 }, { x: tip.x - nrm.x * size * 0.5, y: tip.y - nrm.y * size * 0.5 }], st, hand, rng.fork("hbar"), { taperIn: false, taperOut: false }), st.color, tag(el, "ink")));
      else nodes.push(...inksToNodes([...inkLine([a, tip], st, hand, rng.fork("ha"), { taperIn: true, taperOut: false }), ...inkLine([b, tip], st, hand, rng.fork("hb"), { taperIn: true, taperOut: false })], st.color, tag(el, "ink")));
    };
    mk(pts[pts.length - 1], pts[Math.max(0, pts.length - 3)], (head.end as string) ?? "arrow");
    mk(pts[0], pts[Math.min(pts.length - 1, 2)], (head.start as string) ?? "none");
  }
  return { nodes, bbox: boundsOf(pts) };
}

function renderScatter(el: RElement, ctx: ElemCtx): { nodes: Node[]; bbox: Rect } {
  const p = el.props;
  const u = ctx.u;
  const reg = resolveRegion(p.region, ctx, ctx.panel ? "panel" : "page", [...el.path, "region"]);
  const rng = new Rng(el.seed);
  const b = reg.bbox;
  const count = typeof p.count === "number" ? p.count : Math.round(((b.w * b.h) / 1000) * ((p.rate as number) ?? 0.3));
  const avoid = Array.isArray(p.avoid) ? (p.avoid as unknown[]).map((a, i) => resolveRegion(a, ctx, "panel", [...el.path, "avoid", i])) : [];
  const minD = p.minDistance !== undefined ? toMm(p.minDistance as string, u) : 0;
  const items = (p.items as Obj[]) ?? [];
  const weights = items.map((i) => (typeof i.weight === "number" ? i.weight : 1));
  const wsum = weights.reduce((a, c) => a + c, 0) || 1;
  const sc = (Array.isArray(p.itemScale) ? p.itemScale : [0.7, 1.3]) as number[];
  const placed: Vec[] = [];
  const nodes: Node[] = [];
  let tries = 0;
  while (placed.length < count && tries++ < count * 40) {
    const q = { x: b.x + rng.next() * b.w, y: b.y + rng.next() * b.h };
    if (!reg.contains(q) || avoid.some((a) => a.contains(q))) continue;
    if (isObj(p.falloff)) {
      // density from the centre (from) to the edge (to)
      const fo = p.falloff as Obj;
      const c0 = center(b);
      const t = Math.min(1, Math.hypot(q.x - c0.x, q.y - c0.y) / (Math.hypot(b.w, b.h) / 2));
      const dens = Number(fo.from ?? 1) + (Number(fo.to ?? 0) - Number(fo.from ?? 1)) * t;
      if (rng.next() > dens) continue;
    }
    if (minD > 0 && placed.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < minD)) continue;
    placed.push(q);
    let r = rng.next() * wsum;
    let item = items[0];
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        item = items[i];
        break;
      }
    }
    if (!item) break;
    const s = rng.range(sc[0], sc[1]);
    // orientation: random within itemRotate, or along / across the line from the region centre
    const rr = (Array.isArray(p.itemRotate) ? p.itemRotate : ["-20deg", "20deg"]) as string[];
    const jitter = rng.range(parseAngle(rr[0]), parseAngle(rr[1] ?? rr[0]));
    const orient = (p.orient as string) ?? "random";
    const cc = center(b);
    const radial = Math.atan2(q.y - cc.y, q.x - cc.x);
    const ang = orient === "radial" ? radial + Math.PI / 2 + jitter * 0.3 : orient === "tangent" ? radial + Math.PI + jitter * 0.3 : jitter;
    const at = [`${q.x - ctx.coordsBox.x}mm`, `${q.y - ctx.coordsBox.y}mm`];
    const size0 = item.size !== undefined && !Array.isArray(item.size) ? toMm(item.size as string, u) : 4 * u.k;
    const deg = `${(ang * 180) / Math.PI}deg`;
    if (item.mark) {
      const sub: RElement = { id: `${el.id}-s${placed.length}`, type: "mark", path: el.path, seed: rng.nextU32(), props: { stroke: { width: `${0.2 * u.k}mm` }, ...item, kind: item.mark, at, size: `${size0 * s}mm`, rotate: deg } };
      nodes.push(...renderMark(sub, ctx).nodes);
    } else if (typeof item.asset === "string") {
      const info = ctx.assets.get(item.asset);
      if (info && !info.missing) {
        const w = size0 * s * 1.5;
        const h = (w * info.height) / info.width;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        nodes.push({ kind: "image", assetKey: info.key, dest: { x: -w / 2, y: -h / 2, w, h }, sourceRect: { x: 0, y: 0, w: info.width, h: info.height }, transform: [ca, sa, -sa, ca, q.x, q.y], smoothing: "high", lineart: info.kind === "lineart", monoLpi: 60, filters: [], tag: tag(el, "art") });
      }
    } else if (typeof item.type === "string") {
      // an inline element definition placed at the point
      const { weight: _w, ...def } = item;
      const sub: RElement = { id: `${el.id}-s${placed.length}`, type: String(item.type), path: el.path, seed: rng.nextU32(), props: { ...def, at, rotate: def.rotate ?? deg, scale: s } };
      const r = sub.type === "text" ? renderText(sub, ctx) : sub.type === "sfx" ? renderSfx(sub, ctx) : renderMisc(sub, ctx);
      nodes.push(...r.nodes);
    }
  }
  return { nodes: [{ kind: "group", clip: reg.path, children: nodes, tag: tag(el, "ink") }], bbox: b };
}

// ---- balloon placement ------------------------------------------------------------

interface Silhouette {
  inv: Matrix;
  w: number;
  h: number;
  gw: number;
  gh: number;
  alpha: Uint8Array;
}

/** coarse alpha maps of the panel's character art: balloons prefer not to cover the figures */
async function silhouettes(refs: RefRegistry, ctx: ElemCtx): Promise<Silhouette[]> {
  const out: Silhouette[] = [];
  const pid = ctx.panel?.panel.id;
  for (const t of refs.all()) {
    if (t.type !== "image" || !t.imagePx || (pid && t.panelId !== pid) || !t.character) continue;
    const { w, h, matrix, assetKey } = t.imagePx;
    const gh = 64;
    const gw = Math.max(8, Math.round((gh * w) / h));
    const px = await ctx.assets.pixels(assetKey, gw, gh, { x: 0, y: 0, w, h });
    if (!px) continue;
    const alpha = new Uint8Array(px.width * px.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px.data[i * 4 + 3];
    out.push({ inv: invertMat(matrix), w, h, gw: px.width, gh: px.height, alpha });
  }
  return out;
}

function silhouetteCover(r: Rect, sils: Silhouette[]): number {
  let cov = 0;
  for (const s of sils) {
    let hit = 0;
    const N = 5;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const q = applyMat(s.inv, { x: r.x + (r.w * (i + 0.5)) / N, y: r.y + (r.h * (j + 0.5)) / N });
        const gx = Math.floor((q.x / s.w) * s.gw);
        const gy = Math.floor((q.y / s.h) * s.gh);
        if (gx >= 0 && gy >= 0 && gx < s.gw && gy < s.gh && s.alpha[gy * s.gw + gx] > 128) hit++;
      }
    cov += hit / (N * N);
  }
  return Math.min(1, cov);
}

function placeBalloons(plans: BalloonPlan[], ctx: ElemCtx, refs: RefRegistry, processed: Map<string, { bbox: Rect }>, sils: Silhouette[] = []) {
  const u = ctx.u;
  const geom = ctx.geom;
  const rtl = geom.rtl;
  const panelBox = ctx.panel ? ctx.panel.box : geom.baseFrame;
  const obstacles: { r: Rect; w: number; ellipse?: boolean }[] = [];
  for (const it of processed.values()) {
    const el = (it as { el?: RElement }).el;
    if (el && (el.type === "text" || el.type === "sfx") && rectIntersect(it.bbox, panelBox)) obstacles.push({ r: it.bbox, w: 50 });
  }
  const pid = ctx.panel?.panel.id;
  const hard: Rect[] = [];
  for (const t of refs.all()) {
    if (t.type !== "image" || (pid && t.panelId !== pid)) continue;
    // faces are roughly elliptical: the corners of the face box are free space
    for (const [k, rg] of Object.entries(t.regions)) if (k === "face" || k === "avoid") obstacles.push({ r: rg.bbox, w: 60, ellipse: k === "face" });
    if (t.anchors.mouth) hard.push({ x: t.anchors.mouth.x - 2 * u.k, y: t.anchors.mouth.y - 2 * u.k, w: 4 * u.k, h: 4 * u.k });
  }
  const placedRects: Rect[] = [];
  const setCenter = (pl: BalloonPlan, c: Vec) => {
    pl.center = c;
    placedRects.push({ x: c.x + pl.outer.x, y: c.y + pl.outer.y, w: pl.outer.w, h: pl.outer.h });
  };
  // explicit first
  for (const pl of plans) {
    if (!pl.explicit) continue;
    const pc = { u, coordsBox: ctx.coordsBox, refs, panelId: pid, bag: ctx.bag, path: pl.el.path, safeBox: u.units !== "px" ? geom.safe : undefined };
    // rotation is applied around the body centre when drawing, not to the placement box
    const r = place({ ...pl.props, rotate: undefined }, pl.outer.w, pl.outer.h, pc);
    const tl = r.bbox;
    setCenter(pl, { x: tl.x - pl.outer.x, y: tl.y - pl.outer.y });
  }
  const apOf = (pl: BalloonPlan) => (isObj(pl.props.autoPlace) ? (pl.props.autoPlace as Obj) : {});
  const ap0 = plans.map(apOf).find((a) => a.inset !== undefined);
  const inset = ap0 ? toMm(ap0.inset as string, u) : 1.5 * u.k;
  let area = rectInset(panelBox, inset);
  // text must stay inside the safe area even in bled panels
  if (u.units !== "px") area = rectIntersect(area, geom.safe) ?? area;
  let prevS: number | null = null;
  // reading position of a balloon from its top edge: mostly top-to-bottom, then right-to-left (rtl)
  const sOf = (c: Vec, h: number) => {
    const xn = (c.x - area.x) / Math.max(1, area.w);
    const yn = (c.y - h / 2 - area.y) / Math.max(1, area.h);
    return 0.8 * yn + (rtl ? -0.2 : 0.2) * xn;
  };
  // flow cursor
  let flowX = rtl ? area.x + area.w : area.x;
  let flowY = area.y;
  let rowH = 0;
  for (const pl of plans) {
    if (pl.explicit) {
      prevS = sOf({ x: pl.center!.x + pl.outer.x + pl.outer.w / 2, y: pl.center!.y + pl.outer.y + pl.outer.h / 2 }, pl.outer.h);
      continue;
    }
    const mode = isObj(pl.props.autoPlace) ? ((pl.props.autoPlace as Obj).mode as string) ?? "auto" : (pl.props.autoPlace as string) ?? "auto";
    const w = pl.outer.w;
    const h = pl.outer.h;
    if (mode === "flow") {
      if ((rtl ? flowX - w < area.x : flowX + w > area.x + area.w) && rowH > 0) {
        flowX = rtl ? area.x + area.w : area.x;
        flowY += rowH + 1 * u.k;
        rowH = 0;
      }
      const cx = rtl ? flowX - w / 2 : flowX + w / 2;
      const cy = flowY + h / 2;
      setCenter(pl, { x: cx - (pl.outer.x + w / 2), y: cy - (pl.outer.y + h / 2) });
      flowX += rtl ? -(w + 1 * u.k) : w + 1 * u.k;
      rowH = Math.max(rowH, h);
      prevS = sOf({ x: cx, y: cy }, h);
      continue;
    }
    const who = pl.props.who as string | undefined;
    const offSide = isObj(pl.props.tail) ? ((pl.props.tail as Obj).offscreen as string | undefined) : undefined;
    const speaker = who && !offSide ? refs.point(who, pid) : null;
    const step = Math.max(1.5 * u.k, Math.min(area.w, area.h) / 28);
    let best: { c: Vec; cost: number } | null = null;
    const R = (w + h) / 4;
    // cost weights (spec 6.12.2), overridable per balloon with autoPlace.weights
    const W = { order: 120, start: 4, overlap: 50, avoid: 60, figure: 6, speaker: 1.5, tail: 4, top: 1, outside: 30, offscreen: 8, ...((apOf(pl).weights as Record<string, number> | undefined) ?? {}) };
    const threshold = typeof apOf(pl).threshold === "number" ? (apOf(pl).threshold as number) : 25;
    for (let y = area.y + h / 2; y <= area.y + area.h - h / 2 + 0.01 || (area.h < h && y <= area.y + h / 2 + 0.01); y += step) {
      for (let x = area.x + w / 2; x <= area.x + area.w - w / 2 + 0.01 || (area.w < w && x <= area.x + w / 2 + 0.01); x += step) {
        const c = { x, y };
        const rect = { x: x - w / 2, y: y - h / 2, w, h };
        const A = w * h;
        let cost = 0;
        const s = sOf(c, h);
        if (prevS === null) {
          const cornerX = rtl ? area.x + area.w : area.x;
          cost += W.start * Math.hypot((x - cornerX) / area.w, (y - area.y) / area.h);
        } else cost += W.order * Math.max(0, prevS + 0.02 - s);
        for (const pr of placedRects) cost += W.overlap * (rectOverlapArea(rect, pr) / A);
        for (const ob of obstacles) cost += (ob.w === 60 ? W.avoid : ob.w) * (ob.ellipse ? ellipseOverlap(rect, ob.r) : rectOverlapArea(rect, ob.r) / A);
        for (const hr of hard) if (rectOverlapArea(rect, hr) > 0) cost += 1000;
        if (sils.length) cost += W.figure * silhouetteCover(rect, sils);
        if (speaker) {
          const d = Math.hypot(x - speaker.x, y - speaker.y);
          cost += W.speaker * Math.abs(d / R - 1.6);
          // tail path crossing other balloons
          for (const pr of placedRects) if (segRect(c, speaker, pr)) cost += W.tail;
        }
        cost += W.top * ((y - area.y) / Math.max(1, area.h));
        if (offSide) {
          const dEdge = offSide === "right" ? area.x + area.w - (x + w / 2) : offSide === "left" ? x - w / 2 - area.x : offSide === "top" ? y - h / 2 - area.y : area.y + area.h - (y + h / 2);
          cost += W.offscreen * Math.max(0, dEdge) / Math.max(1, offSide === "left" || offSide === "right" ? area.w : area.h);
        }
        const inside = rectIntersect(rect, area);
        cost += W.outside * (1 - (inside ? inside.w * inside.h : 0) / A);
        if (!best || cost < best.cost - 1e-9) best = { c, cost };
      }
    }
    if (!best) best = { c: center(area), cost: 999 };
    if (best.cost > threshold) ctx.bag.warn("BALLOON_NO_SPACE", `no good position for balloon ${pl.el.id}`, { path: pl.el.path, elementId: pl.el.id });
    setCenter(pl, { x: best.c.x - (pl.outer.x + w / 2), y: best.c.y - (pl.outer.y + h / 2) });
    prevS = sOf(best.c, h);
  }
  // reading-order and overlap checks over the final positions
  const rects = plans.filter((pl) => pl.center).map((pl) => ({ pl, r: { x: pl.center!.x + pl.outer.x, y: pl.center!.y + pl.outer.y, w: pl.outer.w, h: pl.outer.h } }));
  for (let i = 1; i < rects.length; i++) {
    const a = rects[i - 1];
    const b = rects[i];
    const sa = sOf({ x: a.r.x + a.r.w / 2, y: a.r.y + a.r.h / 2 }, a.r.h);
    const sb = sOf({ x: b.r.x + b.r.w / 2, y: b.r.y + b.r.h / 2 }, b.r.h);
    if (sb < sa - 0.08) ctx.bag.info("BALLOON_ORDER_MISMATCH", `balloon ${b.pl.el.id} reads before ${a.pl.el.id} by its position`, { path: b.pl.el.path, elementId: b.pl.el.id });
  }
  // a tail running to its speaker through another balloon
  const linked = new Set<string>();
  for (const r0 of rects) {
    const cn = r0.pl.props.connect;
    for (const c of (Array.isArray(cn) ? cn : cn ? [cn] : []) as Obj[]) {
      linked.add(r0.pl.el.id);
      linked.add(String(c.to));
    }
  }
  for (const a of rects) {
    if (linked.has(a.pl.el.id)) continue;
    const who = a.pl.props.who as string | undefined;
    const sp = who ? refs.point(who, pid) : null;
    if (!sp) continue;
    const c0 = { x: a.r.x + a.r.w / 2, y: a.r.y + a.r.h / 2 };
    for (const b of rects) if (b !== a && segRect(c0, sp, b.r)) ctx.bag.warn("BALLOON_TAIL_CROSSES", `the tail of ${a.pl.el.id} crosses ${b.pl.el.id}`, { path: a.pl.el.path, elementId: a.pl.el.id });
  }
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r;
      const b = rects[j].r;
      const ov = rectOverlapArea(a, b);
      // earlier balloons are drawn on top: a large overlap hides the later one's text
      if (ov > 0.2 * Math.min(a.w * a.h, b.w * b.h) && !rects[j].pl.props.connect && !rects[i].pl.props.connect) ctx.bag.warn("BALLOON_TEXT_HIDDEN", `balloon ${rects[j].pl.el.id} is largely covered by ${rects[i].pl.el.id}`, { path: rects[j].pl.el.path, elementId: rects[j].pl.el.id });
    }
}

/** fraction of rect `r` covered by the ellipse inscribed in `e` (sampled) */
function ellipseOverlap(r: Rect, e: Rect): number {
  if (!rectIntersect(r, { x: e.x - e.w * 0.06, y: e.y - e.h * 0.06, w: e.w * 1.12, h: e.h * 1.12 })) return 0;
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  // a little breathing room around the face
  e = { x: cx - e.w * 0.56, y: cy - e.h * 0.56, w: e.w * 1.12, h: e.h * 1.12 };
  const N = 8;
  let hit = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const dx = (r.x + (r.w * (i + 0.5)) / N - cx) / (e.w / 2);
      const dy = (r.y + (r.h * (j + 0.5)) / N - cy) / (e.h / 2);
      if (dx * dx + dy * dy <= 1) hit++;
    }
  return hit / (N * N);
}

function segRect(a: Vec, b: Vec, r: Rect): boolean {
  for (let t = 0.15; t <= 0.85; t += 0.1) {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

// ---- page numbers -----------------------------------------------------------------

function nombreNodes(doc: ResolvedDoc, page: RPage, geom: PageGeom, o: ComposeOptions): Node[] {
  const book = (doc.doc.book ?? {}) as Obj;
  const pn = (book.pageNumbers ?? {}) as Obj;
  if (pn.enabled === false || o.nombre === null) return [];
  const show = (pn.show as string) ?? "print";
  if (show === "never" || (show === "print" && !o.print)) return [];
  if (page.number === false) return [];
  if (Array.isArray(pn.skip) && (pn.skip as string[]).includes(page.id)) return [];
  const u = geom.units;
  const hidden = (isObj(page.number) && (page.number as Obj).hidden === true) || pn.hidden === true;
  const size = hidden ? toMm("5pt", u) : toMm((pn.fontSize as string) ?? "8pt", u);
  const fmt = (pn.format as string) ?? "{n}";
  const margin = (pn.margin as unknown[]) ?? ["8mm", "12mm"];
  const mv = toMm(margin[0] as string, u);
  const mh = hidden ? 1.5 : toMm(margin[1] as string, u);
  const pos = (pn.position as string) ?? "bottom-outer";
  const inner = pos.includes("inner") || hidden;
  const color = parseColor((pn.color as string) ?? "black") ?? BLACK;
  // one number per physical page; a spread carries two (spec 4.15)
  const halves: { n: number; side: "left" | "right"; x0: number; w: number }[] =
    geom.type === "spread"
      ? [
          { n: o.nombre!, side: geom.rtl ? "right" : "left", x0: geom.rtl ? geom.trimW / 2 : 0, w: geom.trimW / 2 },
          { n: o.nombre! + 1, side: geom.rtl ? "left" : "right", x0: geom.rtl ? 0 : geom.trimW / 2, w: geom.trimW / 2 },
        ]
      : [{ n: o.nombre!, side: geom.side === "left" ? "left" : "right", x0: 0, w: geom.trimW }];
  return halves.map((h) => {
    const text = fmt.replace("{n}", String(h.n));
    const tl = layoutText(text, defaultTextStyle({ font: (pn.font as string) ?? "ui", fontSize: size, writing: "horizontal", markup: false, tcy: null }), o.fonts);
    const outerLeft = h.side === "left";
    let x: number;
    if (pos.includes("center")) x = h.x0 + h.w / 2 - tl.width / 2;
    else if ((outerLeft && !inner) || (!outerLeft && inner)) x = h.x0 + mh;
    else x = h.x0 + h.w - mh - tl.width;
    const y = pos.startsWith("top") ? mv : hidden ? geom.trimH - 3 - tl.height : geom.trimH - mv - tl.height;
    return {
      kind: "path" as const,
      stroke: { width: size * 0.25, paint: { type: "solid" as const, color: WHITE }, join: "round" as const },
      path: tl.glyphs.flatMap((g) => g.path.map((c) => (c[0] === "Z" ? c : (c.map((v, i) => (i === 0 ? v : i % 2 === 1 ? (v as number) + x : (v as number) + y)) as typeof c)))),
      fillRule: "nonzero" as const,
      paint: { type: "solid" as const, color },
      tag: { elementId: `${page.id}-nombre`, elementType: "nombre", role: "furniture" as const, separation: "furniture" },
    };
  });
}

function collectTranscript(el: RElement, panel: string | undefined, info: PageLayoutInfo, o: ComposeOptions) {
  if (el.type === "balloon" || el.type === "text" || el.type === "sfx") {
    const raw = textValue(el.props.text, o.lang, o.defaultLang);
    // plain text without markup (ruby, emphasis, tags)
    const text = plainText(parseMarkup(raw, { vertical: false, normalize: { dash: true, ellipsis: true } }));
    info.transcript.push({ panel, id: el.id, type: el.type, who: el.props.who as string | undefined, as: el.props.as as string | undefined, text });
  }
}

function checkTextSafety(items: Item[], geom: PageGeom, bag: DiagnosticBag, page: RPage) {
  if (geom.units.units === "px") return;
  for (const it of items) {
    if (!["balloon", "text"].includes(it.el.type)) continue;
    const b = it.bbox;
    const s = geom.safe;
    if (b.x < s.x - 0.5 || b.y < s.y - 0.5 || b.x + b.w > s.x + s.w + 0.5 || b.y + b.h > s.y + s.h + 0.5) {
      bag.warn("TEXT_OUTSIDE_SAFE_AREA", `${it.el.id} extends outside the safe area`, { path: it.el.path, elementId: it.el.id, pageId: page.id });
    }
    if (geom.type === "spread") {
      const fm = page.settings.foldMargin !== undefined ? toMm(page.settings.foldMargin as string, geom.units) : 10;
      const cx = geom.trimW / 2;
      if (b.x < cx + fm && b.x + b.w > cx - fm) bag.warn("TEXT_NEAR_FOLD", `${it.el.id} is near the spread fold`, { path: it.el.path, elementId: it.el.id });
    }
  }
}

export type { InkPoly };
