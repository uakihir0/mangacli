// SVG backend (spec 10.4.4): the display list as vector paths, mm units.
import sharp from "sharp";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { type RGBA, linearToSrgb, srgbToLinear } from "../core/color.js";
import type { PathData } from "../geom/path.js";
import type { Matrix } from "../geom/vec.js";
import type { AssetRegistry } from "./assets.js";
import { applyFilters, mangaOutputFilters, mangaResolutionBoost } from "./filters.js";
import type { DisplayList, GroupNode, ImageNode, Node, Paint, PathNode, ToneSpec } from "./ir.js";
import { cropMarkLines } from "./marks.js";

export interface SvgOptions {
  bag?: DiagnosticBag;
  outputScale?: number;
  marks?: { margin?: number; length?: number; width?: number };
  crop: "trim" | "bleed" | "marks";
  splitSide?: "left" | "right";
  assets: AssetRegistry;
  /** resolution of embedded images (the output dpi); line art keeps it up to the source resolution */
  imageDpi?: number;
  /** cap on the embedded resolution of non-line-art images */
  maxImageDpi?: number;
  colorMode: "color" | "gray" | "mono";
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

function d(path: PathData): string {
  let s = "";
  for (const c of path) {
    if (c[0] === "Z") s += "Z";
    else s += c[0] + (c.slice(1) as number[]).map(n).join(" ");
  }
  return s;
}

function gray(c: RGBA, mode: SvgOptions["colorMode"]): RGBA {
  if (mode === "color") return c;
  const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return { r: y, g: y, b: y, a: c.a };
}

function rgb(c: RGBA): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// mono line art: the same 50% threshold as the raster backend, so 1-bit art stays 1-bit
function binarize(src: Uint8Array): Uint8Array {
  const d = Uint8Array.from(src);
  for (let i = 0; i < d.length; i += 4) {
    const lin = 0.2126 * srgbToLinear(d[i] / 255) + 0.7152 * srgbToLinear(d[i + 1] / 255) + 0.0722 * srgbToLinear(d[i + 2] / 255);
    d[i] = d[i + 1] = d[i + 2] = linearToSrgb(lin) < 0.5 ? 0 : 255;
    d[i + 3] = d[i + 3] > 127 ? 255 : 0;
  }
  return d;
}

const matrix = (m: Matrix) => `matrix(${m.map(n).join(" ")})`;

export function svgBox(list: DisplayList, o: Pick<SvgOptions, "crop" | "marks" | "splitSide">) {
  const bleed = -list.boxes.bleed.x;
  const margin = o.crop === "marks" ? o.marks?.margin ?? 10 : 0;
  const box = o.crop === "trim"
    ? { x: bleed, y: bleed, w: list.boxes.trim.w, h: list.boxes.trim.h }
    : { x: -margin, y: -margin, w: list.size.width + 2 * margin, h: list.size.height + 2 * margin };
  if (o.splitSide) {
    const right = box.x + box.w;
    box.w = box.w / 2 + (o.crop === "trim" ? 0 : bleed) + margin;
    if (o.splitSide === "right") box.x = right - box.w;
  }
  return box;
}

export async function renderSvg(list: DisplayList, o: SvgOptions): Promise<string> {
  const defs: string[] = [];
  let uid = 0;
  const id = (p: string) => `${p}${++uid}`;
  const bleed = -list.boxes.bleed.x;
  const box = svgBox(list, o);

  const fillOf = (p: Paint): string => {
    if (p.type === "solid") {
      const c = gray(p.color, o.colorMode);
      return `fill="${rgb(c)}"${c.a < 1 ? ` fill-opacity="${n(c.a)}"` : ""}`;
    }
    if (p.type === "linear-gradient" || p.type === "radial-gradient") {
      const gid = id("g");
      const stops = p.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${rgb(gray(s.color, o.colorMode))}"${s.color.a < 1 ? ` stop-opacity="${n(s.color.a)}"` : ""}/>`).join("");
      defs.push(
        p.type === "linear-gradient"
          ? `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${n(p.x0)}" y1="${n(p.y0)}" x2="${n(p.x1)}" y2="${n(p.y1)}">${stops}</linearGradient>`
          : `<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}">${stops}</radialGradient>`,
      );
      return `fill="url(#${gid})"`;
    }
    return toneFill(p.tone, gray(p.color, o.colorMode));
  };

  // uniform tones become a dot pattern; gradient tones are approximated by a flat gradient of the same density
  const toneFill = (t: ToneSpec, c: RGBA): string => {
    const pid = id("t");
    const cell = 25.4 / Math.max(1, t.lpi);
    const deg = (t.angle * 180) / Math.PI;
    if (t.gradient) {
      const g = t.gradient;
      const mix = (dens: number) => rgb({ r: 1 - dens * (1 - c.r), g: 1 - dens * (1 - c.g), b: 1 - dens * (1 - c.b), a: 1 });
      const stops = g.stops.map(([pos, dens]) => `<stop offset="${n(pos)}" stop-color="${mix(dens)}"/>`).join("");
      defs.push(
        g.type === "radial" && g.center
          ? `<radialGradient id="${pid}" gradientUnits="userSpaceOnUse" cx="${n(g.center.x)}" cy="${n(g.center.y)}" r="${n(g.radius ?? 10)}">${stops}</radialGradient>`
          : `<linearGradient id="${pid}" gradientUnits="userSpaceOnUse" x1="${n(g.p0.x)}" y1="${n(g.p0.y)}" x2="${n(g.p1.x)}" y2="${n(g.p1.y)}">${stops}</linearGradient>`,
      );
      return `fill="url(#${pid})"`;
    }
    const dens = t.invert ? 1 - t.density : t.density;
    const col = rgb(c);
    let body: string;
    if (t.dot === "line") body = `<rect x="0" y="0" width="${n(cell)}" height="${n(cell * dens)}" fill="${col}"/>`;
    else if (dens <= 0.5) body = `<circle cx="${n(cell / 2)}" cy="${n(cell / 2)}" r="${n(cell * Math.sqrt(dens / Math.PI))}" fill="${col}"/>`;
    else {
      // dark tones: white dots on ink
      const r = cell * Math.sqrt((1 - dens) / Math.PI);
      body = `<rect width="${n(cell)}" height="${n(cell)}" fill="${col}"/><circle cx="${n(cell / 2)}" cy="${n(cell / 2)}" r="${n(r)}" fill="#ffffff"/>`;
    }
    defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" width="${n(cell)}" height="${n(cell)}" patternTransform="translate(${n(t.offset[0])} ${n(t.offset[1])}) rotate(${n(deg)})">${body}</pattern>`);
    return `fill="url(#${pid})"`;
  };

  const tagAttr = (t?: { elementId: string; elementType: string }) => (t ? ` data-id="${esc(t.elementId)}" data-type="${esc(t.elementType)}"` : "");

  const path = (p: PathNode): string => {
    const parts: string[] = [];
    const dd = d(p.path);
    if (!dd) return "";
    if (p.stroke) {
      const sc = p.stroke.paint.type === "solid" ? gray(p.stroke.paint.color, o.colorMode) : { r: 0, g: 0, b: 0, a: 1 };
      parts.push(`<path d="${dd}" fill="none" stroke="${rgb(sc)}" stroke-width="${n(p.stroke.width)}" stroke-linejoin="${p.stroke.join}"${p.stroke.miterLimit ? ` stroke-miterlimit="${p.stroke.miterLimit}"` : ""} stroke-linecap="round"/>`);
    }
    if (p.paint) parts.push(`<path d="${dd}" ${fillOf(p.paint)}${p.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}${tagAttr(p.tag)}/>`);
    return parts.join("");
  };

  const image = async (im: ImageNode): Promise<string> => {
    const manga = im.filters.some((f) => f.name === "manga");
    const binary = im.lineart || manga;
    const dpi = binary ? o.imageDpi ?? 200 : Math.min(o.imageDpi ?? 200, o.maxImageDpi ?? Infinity);
    const outputFilters = manga ? mangaOutputFilters(im.filters, 25.4 / dpi) : im.filters;
    const boost = manga ? mangaResolutionBoost(outputFilters, 25.4 / dpi) : 1;
    const baseW = (im.dest.w / 25.4) * dpi;
    const baseH = (im.dest.h / 25.4) * dpi;
    const w = Math.max(1, manga ? Math.round(baseW * boost) : Math.min(im.sourceRect.w, Math.round(baseW)));
    const h = Math.max(1, manga ? Math.round(baseH * boost) : Math.min(im.sourceRect.h, Math.round(baseH)));
    const px0 = await o.assets.pixels(im.assetKey, w, h, im.sourceRect);
    if (!px0) return "";
    const filterImage = { sourceRect: im.sourceRect, regions: o.assets.get(im.assetKey)?.regions };
    const px1 = outputFilters.length ? await applyFilters(px0, outputFilters, im.dest.w / px0.width, filterImage) : px0;
    const px = binary && o.colorMode === "mono" ? { ...px1, data: binarize(px1.data) } : px1;
    let img = sharp(px.data, { raw: { width: px.width, height: px.height, channels: 4 } });
    if (o.colorMode !== "color") img = img.grayscale();
    const png = await img.png().toBuffer();
    const t = im.transform ? ` transform="${matrix(im.transform)}"` : "";
    let filter = "";
    if (im.outline?.length) {
      // silhouette outline: dilate the alpha and flood it, largest first
      const fid = id("o");
      const sc = Math.hypot(im.transform?.[0] ?? 1, im.transform?.[1] ?? 1) || 1;
      const layers = im.outline.map((ol, i) => `<feMorphology in="SourceAlpha" operator="dilate" radius="${n(ol.w / sc)}" result="d${i}"/><feFlood flood-color="${rgb(gray(ol.color, o.colorMode))}"/><feComposite in2="d${i}" operator="in" result="o${i}"/>`).join("");
      const merge = im.outline.map((_, i) => `<feMergeNode in="o${i}"/>`).join("");
      defs.push(`<filter id="${fid}" x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse">${layers}<feMerge>${merge}<feMergeNode in="SourceGraphic"/></feMerge></filter>`);
      filter = ` filter="url(#${fid})"`;
    }
    return `<image${t}${filter} x="${n(im.dest.x)}" y="${n(im.dest.y)}" width="${n(im.dest.w)}" height="${n(im.dest.h)}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString("base64")}"${tagAttr(im.tag)}/>`;
  };

  const group = async (g: GroupNode): Promise<string> => {
    const attrs: string[] = [];
    if (g.filters?.length) {
      const primitives: string[] = [];
      for (const f of g.filters) {
        const a = (i: number, key: string, fallback: number) => Number(f.opts?.[key] ?? f.args[i] ?? fallback);
        const transfer = (attributes: string) => `<feComponentTransfer>${["R", "G", "B"].map((c) => `<feFunc${c} ${attributes}/>`).join("")}</feComponentTransfer>`;
        switch (f.name) {
          case "invert": primitives.push(transfer('type="table" tableValues="1 0"')); break;
          case "grayscale": primitives.push('<feColorMatrix type="saturate" values="0"/>'); break;
          case "brightness": primitives.push(transfer(`type="linear" slope="${n(a(0, "amount", 1))}"`)); break;
          case "contrast": {
            const k = a(0, "amount", 1);
            primitives.push(transfer(`type="linear" slope="${n(k)}" intercept="${n((128 / 255) * (1 - k))}"`)); break;
          }
          case "threshold": {
            const t = a(0, "level", 0.5);
            primitives.push('<feColorMatrix type="saturate" values="0"/>');
            primitives.push(transfer(`type="discrete" tableValues="${Array.from({ length: 256 }, (_, i) => i < t * 255 ? 0 : 1).join(" ")}"`)); break;
          }
          case "levels": {
            const black = a(0, "black", 0), white = a(1, "white", 1), gamma = a(2, "gamma", 1);
            const values = Array.from({ length: 256 }, (_, i) => n(Math.pow(Math.max(0, Math.min(1, (i / 255 - black) / Math.max(1 / 255, white - black))), 1 / gamma)));
            primitives.push(transfer(`type="table" tableValues="${values.join(" ")}"`)); break;
          }
          default: o.bag?.warn("SVG_FILTER_UNSUPPORTED", `SVG skips composite filter ${f.name}`);
        }
      }
      if (primitives.length) {
        const fid = id("post");
        defs.push(`<filter id="${fid}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">${primitives.join("")}</filter>`);
        attrs.push(`filter="url(#${fid})"`);
      }
    }
    if (g.transform) attrs.push(`transform="${matrix(g.transform)}"`);
    if (g.opacity !== undefined && g.opacity < 1) attrs.push(`opacity="${n(g.opacity)}"`);
    if (g.blend && g.blend !== "normal") attrs.push(`style="mix-blend-mode:${g.blend}"`);
    if (g.clip) {
      const cid = id("c");
      defs.push(`<clipPath id="${cid}"><path d="${d(g.clip)}"${g.clipRule === "evenodd" ? ' clip-rule="evenodd"' : ""}/></clipPath>`);
      attrs.push(`clip-path="url(#${cid})"`);
    }
    const inner: string[] = [];
    for (const c of g.children) inner.push(await node(c));
    return `<g${attrs.length ? " " + attrs.join(" ") : ""}${tagAttr(g.tag)}>${inner.join("")}</g>`;
  };

  const node = async (x: Node): Promise<string> => (x.kind === "group" ? group(x) : x.kind === "path" ? path(x) : image(x));

  const body = await node(list.root);
  const marks: string[] = [];
  if (o.crop === "marks") {
    const margin = o.marks?.margin ?? 10;
    const artwork = { x: box.x + margin, w: box.w - 2 * margin };
    defs.push(`<clipPath id="artwork-bleed"><rect x="${n(artwork.x)}" width="${n(artwork.w)}" height="${n(list.size.height)}"/></clipPath>`);
    for (const [x0, y0, x1, y1] of cropMarkLines({ x: artwork.x + bleed, y: bleed, w: artwork.w - 2 * bleed, h: list.boxes.trim.h }, bleed, o.marks?.length ?? 9)) {
      marks.push(`<path d="M${n(x0)} ${n(y0)}L${n(x1)} ${n(y1)}"/>`);
    }
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(box.w * (o.outputScale ?? 1))}mm" height="${n(box.h * (o.outputScale ?? 1))}mm" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" data-page="${esc(list.page.id)}">`,
    `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="#ffffff"/>`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    o.crop === "marks" ? `<g clip-path="url(#artwork-bleed)">${body}</g><g data-type="crop-marks" fill="none" stroke="#000000" stroke-width="${n(o.marks?.width ?? 0.1)}" stroke-linecap="butt">${marks.join("")}</g>` : body,
    `</svg>`,
    "",
  ].join("\n");
}
