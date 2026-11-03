// Image elements (spec 5.5).
import { FILTER_NAMES, parseFilter } from "../render/filters.js";
import { isObj } from "../load/normalize.js";
import { parseColor } from "../core/color.js";
import { toMm } from "../core/units.js";
import { polyPath, smoothPath, transformPath } from "../geom/path.js";
import { defaultTextStyle, layoutText } from "../text/layout.js";
import { type Matrix, type Rect, type Vec, applyMat, matMul, matScale, matTranslate } from "../geom/vec.js";
import { inkShape } from "../ink/shape.js";
import { center, place, sizeValue } from "../layout/place.js";
import type { RElement } from "../model/resolve.js";
import { resolveHand, resolveStroke } from "../model/values.js";
import type { Node } from "../render/ir.js";
import { type ElemCtx, placeCtx, tag } from "./context.js";
import { inksToNodes } from "./inkir.js";
import { Rng } from "../core/random.js";

type Obj = Record<string, unknown>;

export interface ImageOut {
  nodes: Node[];
  bbox: Rect;
}

export async function layoutImage(el: RElement, ctx: ElemCtx, defaultBox: Rect): Promise<ImageOut> {
  const p = el.props;
  const pc = placeCtx(ctx, el);
  const placeholderLabel = typeof p.placeholder === "string" ? p.placeholder : undefined;
  const src = typeof p.src === "string" ? p.src : undefined;
  let info = src ? await ctx.assets.info(src, [...el.path, "src"], !!placeholderLabel) : null;
  if (!src && !placeholderLabel) ctx.bag.error("SCHEMA_REQUIRED", "image needs src or placeholder", { path: el.path });
  const isPlaceholder = !info || info.missing || !!placeholderLabel && !src;
  const iw = info?.width ?? 1000;
  const ih = info?.height ?? 1400;
  const crop = (Array.isArray(p.crop) ? (p.crop as number[]) : info?.crop) ?? [0, 0, iw, ih];
  const cw = crop[2];
  const ch = crop[3];
  const ppi = info?.ppi ?? ctx.u.dpi;
  const natW = (cw / ppi) * 25.4;
  const natH = (ch / ppi) * 25.4;
  const hasSize = Array.isArray(p.size);
  let fit = (p.fit as string) ?? (hasSize ? "contain" : "cover");
  // element box
  let bw: number;
  let bh: number;
  let atDefault: Vec;
  if (!hasSize) {
    bw = defaultBox.w;
    bh = defaultBox.h;
    atDefault = center(defaultBox);
  } else {
    const sz = p.size as unknown[];
    const sw = sizeValue(sz[0], ctx.coordsBox.w, pc);
    const sh = sizeValue(sz[1], ctx.coordsBox.h, pc);
    if (sw === "auto" && sh === "auto") {
      bw = natW;
      bh = natH;
      fit = "fill";
    } else if (sw === "auto") {
      bh = sh as number;
      bw = (bh * cw) / ch;
      fit = "fill";
    } else if (sh === "auto") {
      bw = sw;
      bh = (bw * ch) / cw;
      fit = "fill";
    } else {
      bw = sw;
      bh = sh;
    }
    atDefault = center(ctx.coordsBox);
  }
  const pl = place(p, bw, bh, pc, atDefault);
  // image rect within element box
  const zoom = typeof p.zoom === "number" ? p.zoom : 1;
  let dw = bw;
  let dh = bh;
  let dx = 0;
  let dy = 0;
  if (fit === "cover" || fit === "contain") {
    const s = (fit === "cover" ? Math.max(bw / cw, bh / ch) : Math.min(bw / cw, bh / ch)) * zoom;
    dw = cw * s;
    dh = ch * s;
    let fu = 0.5;
    let fv = 0.5;
    const focus = p.focus;
    if (Array.isArray(focus)) [fu, fv] = focus as [number, number];
    else if (typeof focus === "string" && info) {
      const a = info.anchors[focus];
      const r = info.regions[focus];
      if (a) [fu, fv] = [(a[0] - crop[0]) / cw, (a[1] - crop[1]) / ch];
      else if (r) [fu, fv] = [(r[0] + r[2] / 2 - crop[0]) / cw, (r[1] + r[3] / 2 - crop[1]) / ch];
    }
    dx = bw / 2 - fu * dw;
    dy = bh / 2 - fv * dh;
    if (fit === "cover") {
      dx = Math.min(0, Math.max(bw - dw, dx));
      dy = Math.min(0, Math.max(bh - dh, dy));
    } else {
      dx = (bw - dw) / 2;
      dy = (bh - dh) / 2;
    }
  } else if (fit === "none") {
    dw = natW * zoom;
    dh = natH * zoom;
    dx = (bw - dw) / 2;
    dy = (bh - dh) / 2;
  } else if (fit === "width") {
    dw = bw;
    dh = (bw * ch) / cw;
    dy = (bh - dh) / 2;
  } else if (fit === "height") {
    dh = bh;
    dw = (bh * cw) / ch;
    dx = (bw - dw) / 2;
  }
  const flip = (p.flip as string) ?? "none";
  const flipX = flip === "x" || flip === "xy";
  const flipY = flip === "y" || flip === "xy";
  // image px -> element local -> page
  const pxToLocal: Matrix = matMul(matTranslate(dx, dy), matScale(dw / cw, dh / ch));
  const flipM: Matrix = [flipX ? -1 : 1, 0, 0, flipY ? -1 : 1, flipX ? bw : 0, flipY ? bh : 0];
  const pxToPage = matMul(pl.matrix, matMul(flipM, matMul(pxToLocal, matTranslate(-crop[0], -crop[1]))));
  // refs
  const anchors: Record<string, Vec> = {};
  const regions: Record<string, { poly: Vec[]; bbox: Rect }> = {};
  const extraAnchors = (p.anchors ?? {}) as Record<string, [number, number]>;
  const extraRegions = (p.regions ?? {}) as Record<string, [number, number, number, number]>;
  for (const [k, v] of Object.entries({ ...(info?.anchors ?? {}), ...extraAnchors })) anchors[k] = applyMat(pxToPage, { x: v[0], y: v[1] });
  for (const [k, r] of Object.entries({ ...(info?.regions ?? {}), ...extraRegions })) {
    const poly = [applyMat(pxToPage, { x: r[0], y: r[1] }), applyMat(pxToPage, { x: r[0] + r[2], y: r[1] }), applyMat(pxToPage, { x: r[0] + r[2], y: r[1] + r[3] }), applyMat(pxToPage, { x: r[0], y: r[1] + r[3] })];
    const xs = poly.map((q) => q.x);
    const ys = poly.map((q) => q.y);
    regions[k] = { poly, bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
  }
  // visible image bbox (page) = element box ∩ image rect
  const ic = [applyMat(pl.matrix, { x: Math.max(0, dx), y: Math.max(0, dy) }), applyMat(pl.matrix, { x: Math.min(bw, dx + dw), y: Math.min(bh, dy + dh) })];
  const vis: Rect = { x: Math.min(ic[0].x, ic[1].x), y: Math.min(ic[0].y, ic[1].y), w: Math.abs(ic[1].x - ic[0].x), h: Math.abs(ic[1].y - ic[0].y) };
  ctx.refs.add({ id: el.id, type: "image", bbox: vis, anchors, regions, character: (p.character as string) ?? info?.character, panelId: ctx.panel?.panel.id, imagePx: info && !info.missing ? { matrix: pxToPage, assetKey: info.key, w: iw, h: ih } : undefined }, el.path[el.path.length - 1] as number);

  const nodes: Node[] = [];
  if (isPlaceholder) {
    nodes.push(...(await placeholderNodes(el, ctx, pl.matrix, bw, bh, placeholderLabel ?? src ?? "?")));
    return { nodes, bbox: pl.bbox };
  }
  // resolution check
  const effPpi = (cw / (dw / 25.4));
  const need = info!.kind === "lineart" ? ctx.outputDpi * 0.9 : ctx.outputDpi * 0.5;
  if (effPpi < need * 0.999) ctx.bag.warn("ASSET_LOW_RESOLUTION", `${src}: effective ${Math.round(effPpi)} ppi < ${Math.round(need)} ppi`, { path: el.path, elementId: el.id });
  const blend = (p.blend as string) ?? info!.blend ?? (info!.kind === "lineart" || info!.kind === "texture" ? "multiply" : "normal");
  const img: Node = {
    kind: "image",
    assetKey: info!.key,
    dest: { x: dx, y: dy, w: dw, h: dh },
    sourceRect: { x: crop[0], y: crop[1], w: cw, h: ch },
    transform: matMul(pl.matrix, flipM),
    smoothing: (p.smoothing as "high") ?? "high",
    lineart: info!.kind === "lineart",
    monoLpi: info!.kind === "photo" ? 65 : 60,
    filters: [...(info?.filters ?? []), ...(Array.isArray(p.filters) ? (p.filters as unknown[]) : [])].flatMap((f, i) => {
      const pf = parseFilter(f);
      if (!pf || !FILTER_NAMES.has(pf.name)) {
        ctx.bag.error("SCHEMA_ENUM", `unknown image filter ${JSON.stringify(f)}`, { path: [...el.path, "filters", i] });
        return [];
      }
      return [pf];
    }),
    tag: tag(el, "art"),
  };
  const outline = Array.isArray(p.outline) ? (p.outline as Obj[]) : [];
  const ows = outline.map((o) => ({ w: toMm(o.width as string, ctx.u), color: parseColor((o.color as string) ?? "white") ?? { r: 1, g: 1, b: 1, a: 1 } })).sort((a, b) => b.w - a.w);
  const clipPath = fit === "cover" || dx < 0 || dy < 0 || dx + dw > bw || dy + dh > bh ? polyPath([applyMat(pl.matrix, { x: 0, y: 0 }), applyMat(pl.matrix, { x: bw, y: 0 }), applyMat(pl.matrix, { x: bw, y: bh }), applyMat(pl.matrix, { x: 0, y: bh })], true) : undefined;
  const group: Node = { kind: "group", opacity: typeof p.opacity === "number" ? p.opacity : undefined, blend: blend as "normal", clip: hasSize ? clipPath : undefined, children: [], tag: tag(el, "art") };
  if (ows.length) (img as { outline?: unknown }).outline = ows;
  if (isObj(p.shadow) || p.shadow === true) {
    const sh = (isObj(p.shadow) ? p.shadow : {}) as Obj;
    const off = Array.isArray(sh.offset) ? sh.offset : ["0.5mm", "0.5mm"];
    img.shadow = { dx: toMm(off[0] as string, ctx.u), dy: toMm(off[1] as string, ctx.u), blur: sh.blur !== undefined ? toMm(sh.blur as string, ctx.u) : 0, color: parseColor((sh.color as string) ?? "rgba(0,0,0,0.5)") ?? { r: 0, g: 0, b: 0, a: 0.5 } };
  }
  group.children.push(img);
  nodes.push(group);
  return { nodes, bbox: pl.bbox };
}

async function placeholderNodes(el: RElement, ctx: ElemCtx, m: Matrix, w: number, h: number, label: string): Promise<Node[]> {
  const u = ctx.u;
  const hand = resolveHand({ preset: "sketch" }, u, true);
  const stroke = resolveStroke({ width: `${0.2 * u.k}mm`, pen: { preset: "pencil" } }, hand, u);
  const rng = new Rng(el.seed);
  const corners = [applyMat(m, { x: 0, y: 0 }), applyMat(m, { x: w, y: 0 }), applyMat(m, { x: w, y: h }), applyMat(m, { x: 0, y: h })];
  const nodes: Node[] = [{ kind: "path", path: polyPath(corners, true), fillRule: "nonzero", paint: { type: "solid", color: { r: 0.92, g: 0.92, b: 0.92, a: 1 } }, tag: tag(el, "art") }];
  const box = inkShape({ pts: corners, closed: true, corners: corners.map((_, i) => ({ index: i, kind: "convex" as const })) }, { line: stroke, hand, rng: rng.fork("b"), join: "overshoot" });
  nodes.push(...inksToNodes(box.inks, { r: 0.4, g: 0.4, b: 0.4, a: 1 }, tag(el, "art")));
  const d1 = inkShape({ pts: [corners[0], corners[2]], closed: false, smooth: true }, { line: { ...stroke, width: stroke.width * 0.6 }, hand, rng: rng.fork("d1") });
  const d2 = inkShape({ pts: [corners[1], corners[3]], closed: false, smooth: true }, { line: { ...stroke, width: stroke.width * 0.6 }, hand, rng: rng.fork("d2") });
  nodes.push(...inksToNodes([...d1.inks, ...d2.inks], { r: 0.6, g: 0.6, b: 0.6, a: 1 }, tag(el, "art")));
  await ctx.fonts.prepare("dialogue", label);
  const fs = Math.min(w, h) * 0.08;
  const tl = layoutText(label, defaultTextStyle({ font: "dialogue", fontSize: Math.max(2, Math.min(5 * u.k, fs)), writing: "horizontal", maxExtent: w * 0.85, align: "center" }), ctx.fonts);
  const ox = w / 2 - tl.width / 2;
  const oy = h / 2 - tl.height / 2;
  const tm = matMul(m, matTranslate(ox, oy));
  nodes.push({ kind: "path", path: tl.glyphs.flatMap((g) => transformPath(g.path, tm)), fillRule: "nonzero", paint: { type: "solid", color: { r: 0.35, g: 0.35, b: 0.35, a: 1 } }, tag: tag(el, "art") });
  void smoothPath;
  return nodes;
}
