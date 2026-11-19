// SVG backend (spec 10.4.4): the display list as vector paths, mm units.
import sharp from "sharp";
import type { RGBA } from "../core/color.js";
import type { PathData } from "../geom/path.js";
import type { Matrix } from "../geom/vec.js";
import type { AssetRegistry } from "./assets.js";
import { applyFilters } from "./filters.js";
import type { DisplayList, GroupNode, ImageNode, Node, Paint, PathNode, ToneSpec } from "./ir.js";
import { cropMarkLines } from "./marks.js";

export interface SvgOptions {
  outputScale?: number;
  marks?: { margin?: number; length?: number; width?: number };
  crop: "trim" | "bleed" | "marks";
  assets: AssetRegistry;
  /** resolution of embedded images */
  imageDpi?: number;
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

const matrix = (m: Matrix) => `matrix(${m.map(n).join(" ")})`;

export async function renderSvg(list: DisplayList, o: SvgOptions): Promise<string> {
  const defs: string[] = [];
  let uid = 0;
  const id = (p: string) => `${p}${++uid}`;
  const bleed = -list.boxes.bleed.x;
  const margin = o.crop === "marks" ? o.marks?.margin ?? 10 : 0;
  const box = o.crop === "trim" ? { x: bleed, y: bleed, w: list.boxes.trim.w, h: list.boxes.trim.h } : { x: -margin, y: -margin, w: list.size.width + 2 * margin, h: list.size.height + 2 * margin };

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
      parts.push(`<path d="${dd}" fill="none" stroke="${rgb(sc)}" stroke-width="${n(p.stroke.width)}" stroke-linejoin="${p.stroke.join}" stroke-linecap="round"/>`);
    }
    if (p.paint) parts.push(`<path d="${dd}" ${fillOf(p.paint)}${p.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}${tagAttr(p.tag)}/>`);
    return parts.join("");
  };

  const image = async (im: ImageNode): Promise<string> => {
    const dpi = o.imageDpi ?? 200;
    const w = Math.max(1, Math.min(im.sourceRect.w, Math.round((im.dest.w / 25.4) * dpi)));
    const h = Math.max(1, Math.min(im.sourceRect.h, Math.round((im.dest.h / 25.4) * dpi)));
    const px0 = await o.assets.pixels(im.assetKey, w, h, im.sourceRect);
    if (!px0) return "";
    const px = im.filters.length ? await applyFilters(px0, im.filters, im.dest.w / px0.width) : px0;
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

  let body = await node(list.root);
  let marks = "";
  if (o.crop === "marks") {
    const clip = id("marks-clip");
    defs.push(`<clipPath id="${clip}"><rect x="0" y="0" width="${n(list.size.width)}" height="${n(list.size.height)}"/></clipPath>`);
    body = `<g clip-path="url(#${clip})">${body}</g>`;
    const lines = cropMarkLines({ x: bleed, y: bleed, w: list.boxes.trim.w, h: list.boxes.trim.h }, bleed, o.marks?.length ?? 9);
    const path = lines.map(([x0, y0, x1, y1]) => `M${n(x0)} ${n(y0)}L${n(x1)} ${n(y1)}`).join("");
    marks = `<path d="${path}" fill="none" stroke="#000000" stroke-width="${n(o.marks?.width ?? 0.1)}" stroke-linecap="butt"/>`;
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(box.w * (o.outputScale ?? 1))}mm" height="${n(box.h * (o.outputScale ?? 1))}mm" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" data-page="${esc(list.page.id)}">`,
    `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="#ffffff"/>`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    body,
    ...(marks ? [marks] : []),
    `</svg>`,
    "",
  ].join("\n");
}
