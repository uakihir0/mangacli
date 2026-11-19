import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer, load, resolve } from "../src/api.js";
import { BLACK, WHITE } from "../src/core/color.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { type PathData, flattenPath, polyPath } from "../src/geom/path.js";
import { normalizeDocument } from "../src/load/normalize.js";
import { BUILTIN_STYLES } from "../src/model/defaults.js";
import { resolveDocument } from "../src/model/resolve.js";
import { AssetRegistry } from "../src/render/assets.js";
import { closeAlpha } from "../src/render/edt.js";
import type { DisplayList, Node, PathNode } from "../src/render/ir.js";
import { RasterBackend } from "../src/render/raster.js";
import { renderSvg } from "../src/render/svg.js";

type Obj = Record<string, unknown>;
const renderer = createRenderer({ profile: "preview" });
const yaml = (s: string) => ({ yaml: s, filename: "/v/outline.yaml" });
const paths = (n: Node): PathNode[] => n.kind === "group" ? n.children.flatMap(paths) : n.kind === "path" ? [n] : [];

describe("speech-role defaults", () => {
  it.each([{ extendsStyle: "narration" }, { extendsStyle: ["narration"] }])("resolves builtin-only inheritance %j before user defaults without leaking extends", ({ extendsStyle }) => {
    const monologue = BUILTIN_STYLES.monologue;
    const narration = BUILTIN_STYLES.narration;
    try {
      BUILTIN_STYLES.monologue = { ...monologue, extends: extendsStyle };
      BUILTIN_STYLES.narration = { ...narration, extends: "whisper" };
      const input = { mangacli: 1, pages: [{ panels: [{ layers: [{ balloon: "文", as: "monologue" }] }] }] };
      const inherited = resolve(input).pages[0].panels[0].elements[0].props;
      expect(inherited).toMatchObject({ autoPlace: "flow", fontScale: 0.85, shape: { kind: "none" }, tail: { kind: "none", widthScale: 0.7 } });
      expect(inherited).not.toHaveProperty("extends");
      const overridden = resolve({ ...input,
        defaults: { balloon: { fontScale: 1.25 }, monologue: { textOutline: "2mm white" } },
        styles: { narration: { autoPlace: "none" }, whisper: { fontScale: 9 } },
      }).pages[0].panels[0].elements[0].props;
      expect(overridden).toMatchObject({ autoPlace: "flow", fontScale: 1.25, textOutline: [{ width: "2mm", color: "white" }] });
      expect(overridden).not.toHaveProperty("extends");
    } finally {
      BUILTIN_STYLES.monologue = monologue;
      BUILTIN_STYLES.narration = narration;
    }
  });

  it.each(["config", "document", "include", "locale", "page", "panel", "group"])("applies %s role defaults after built-in speech styles", (level) => {
    const defaults = { monologue: { textOutline: "2mm white" }, narration: { fontSize: "7mm" } };
    const group: Obj = { type: "group", children: [{ balloon: "地の文", as: "monologue" }, { balloon: "説明", as: "narration" }] };
    const panel: Obj = { layers: [group] };
    const page: Obj = { panels: [panel] };
    const doc: Obj = { mangacli: 1, pages: [page] };
    if (level === "document") doc.defaults = defaults;
    if (level === "include") Object.defineProperty(page, "__includeDefaults", { value: defaults });
    if (level === "locale") doc.locales = { ja: { defaults } };
    if (level === "page") page.defaults = defaults;
    if (level === "panel") panel.defaults = defaults;
    if (level === "group") group.defaults = defaults;
    const bag = new DiagnosticBag();
    const resolved = resolveDocument(normalizeDocument(doc, bag), bag, { configDefaults: level === "config" ? defaults : undefined });
    expect(bag.hasErrors).toBe(false);
    const children = resolved.pages[0].panels[0].elements[0].children!;
    expect(children[0].props.textOutline).toEqual([{ width: "2mm", color: "white" }]);
    expect(children[1].props.fontSize).toBe("7mm");
  });

  it("lets general user defaults override the built-in monologue outline", () => {
    const r = resolve({ mangacli: 1, defaults: { balloon: { textOutline: "2mm white" } }, pages: [{ panels: [{ layers: [{ balloon: "地のセリフ", as: "monologue" }] }] }] });
    expect(r.pages[0].panels[0].elements[0].props.textOutline).toEqual([{ width: "2mm", color: "white" }]);
  });

  it("applies each layer's balloon defaults before its role defaults, and preserves explicit styles", () => {
    const base = {
      mangacli: 1,
      defaults: { monologue: { textOutline: "2mm white" } },
      styles: { custom: { textOutline: "4mm white" } },
      pages: [{ defaults: { balloon: { textOutline: "3mm white" }, monologue: { fontSize: "6mm" } }, panels: [{ layers: [
        { balloon: "地の文", as: "monologue" },
        { balloon: "地の文", as: "monologue", style: "custom" },
        { balloon: "地の文", as: "monologue", style: "custom", textOutline: "5mm white" },
      ] }] }],
    };
    const els = resolve(base).pages[0].panels[0].elements;
    expect(els.map((e) => e.props.textOutline)).toEqual([3, 4, 5].map((w) => [{ width: `${w}mm`, color: "white" }]));
    expect(els[0].props.fontSize).toBe("6mm");
    const customAs = resolve({ ...base, styles: { monologue: { textOutline: "6mm white" }, custom: {} } });
    expect(customAs.pages[0].panels[0].elements[0].props.textOutline).toEqual([{ width: "6mm", color: "white" }]);
  });

  it("keeps built-in behavior when user defaults are empty and rejects unknown speech types", () => {
    const input = (as: string) => ({ mangacli: 1, defaults: {}, pages: [{ panels: [{ layers: [{ balloon: "文", as }] }] }] });
    expect(resolve(input("monologue")).pages[0].panels[0].elements[0].props.textOutline).toEqual([{ width: "0.8bmm", color: "white" }]);
    expect(() => resolve(input("missing"))).toThrow(/unknown speech type/);
  });
});

describe("halo", () => {
  it.each(["0.6mm white", { width: "0.6mm", color: "white" }, "0.6mm", 0.6, "none", false])("normalizes %j", (halo) => {
    const project = load({ mangacli: 1, pages: [{ panels: [{ layers: [{ balloon: "文", halo }] }] }] });
    expect(project.bag.hasErrors).toBe(false);
    const normalized = resolve(project).pages[0].panels[0].elements[0].props.halo;
    expect(normalized).toEqual(halo === false || halo === "none" ? halo : { width: typeof halo === "number" ? halo : "0.6mm", ...(typeof halo === "object" || halo === "0.6mm white" ? { color: "white" } : {}) });
  });

  const balloonDoc = (kind: string, halo: unknown = "0.8mm white") => ({
    mangacli: 1,
    page: { size: ["80mm", "60mm"], bleed: 0, baseFrame: "trim" },
    pages: [{ panels: [{ border: "none", background: "black", layers: [{ balloon: "", id: "b", at: ["30mm", "20mm"], size: ["20mm", "14mm"], hand: false, shape: { kind: "ellipse", irregularity: 0 }, fill: "white", stroke: "0.3mm black", halo, tail: { kind, direction: "45deg", length: "18mm", bend: 0, width: "2mm", bubbleSize: "3mm" } }] }] }],
  });

  it.each(["wedge", "zigzag", "bubbles", "line"])("adds halo pixels beyond the %s tail tip, beneath all own ink", async (kind) => {
    const doc = balloonDoc(kind);
    const list = await renderer.displayList(doc, 1);
    const nodes = paths(list.root).filter((p) => p.tag?.elementId === "b");
    const halos = nodes.filter((p) => p.tag?.role === "fill" && p.stroke);
    expect(halos).toHaveLength(kind === "bubbles" ? 4 : kind === "line" ? 2 : 1);
    expect(Math.max(...halos.map((p) => nodes.indexOf(p)))).toBeLessThan(nodes.findIndex((p) => p.tag?.role === "ink"));
    const tip = halos.flatMap((p) => flattenPath(p.path).flatMap((c) => c.pts)).reduce((a, b) => a.x + a.y > b.x + b.y ? a : b);
    const x = Math.round((tip.x + 0.35) * 10);
    const y = Math.round((tip.y + 0.35) * 10);
    const pixel = async (input: unknown) => {
      const result = await renderer.render(input as Parameters<typeof renderer.render>[0], { dpi: 254, crop: "trim", colorMode: "mono" });
      expect(result.failures).toEqual([]);
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      return (await sharp(result.pages[0].data).removeAlpha().greyscale().raw().toBuffer())[y * 800 + x];
    };
    expect(await pixel(doc)).toBe(255);
    expect(await pixel(balloonDoc(kind, false))).toBe(0);
  });

  it("uses fill color by default and honors explicit color and disabling", async () => {
    for (const [halo, expected] of [[undefined, "red"], ["0.6mm blue", "blue"], [false, null], ["none", null], [{ width: 0 }, null]] as const) {
      const doc = balloonDoc("none", halo);
      doc.pages[0].panels[0].layers[0].fill = "red";
      if (halo === undefined) delete (doc.pages[0].panels[0].layers[0] as Obj).halo;
      const nodes = paths((await renderer.displayList(doc, 1)).root).filter((p) => p.tag?.role === "fill" && p.stroke);
      expect(nodes).toHaveLength(expected ? 1 : 0);
      if (expected) expect(nodes[0].stroke!.paint).toEqual({ type: "solid", color: expected === "red" ? { r: 1, g: 0, b: 0, a: 1 } : { r: 0, g: 0, b: 1, a: 1 } });
    }
  });

  it("halos separately connected balloons and their connecting line", async () => {
    const doc = balloonDoc("line");
    const first = doc.pages[0].panels[0].layers[0];
    first.at = ["20mm", "20mm"];
    const second = { ...first, id: "c", at: ["55mm", "20mm"], connect: { to: "b", style: "line" } };
    const input = { ...doc, pages: [{ panels: [{ ...doc.pages[0].panels[0], layers: [first, second] }] }] };
    const nodes = paths((await renderer.displayList(input, 1)).root);
    expect(nodes.filter((p) => p.tag?.role === "fill" && p.stroke)).toHaveLength(5);
    const result = await renderer.render(input, { dpi: 254, crop: "trim", colorMode: "mono" });
    const data = await sharp(result.pages[0].data).greyscale().raw().toBuffer();
    expect(data[205 * 800 + 375]).toBe(255);
    expect(data[200 * 800 + 375]).toBe(0);
  });

  it.each(["white", "bad halo", { width: "-1mm" }, { color: "white" }])("rejects invalid halo %j", (halo) => {
    expect(load(balloonDoc("none", halo)).bag.hasErrors).toBe(true);
  });
});

const assets = new AssetRegistry({}, {}, new DiagnosticBag(), 300, "error");
function listWith(nodes: PathNode[]): DisplayList {
  const box = { x: 0, y: 0, w: 40, h: 30 };
  const background: PathNode = { kind: "path", path: polyPath([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], true), fillRule: "nonzero", paint: { type: "solid", color: BLACK } };
  return { version: 1, page: { id: "p", index: 0 }, size: { width: 40, height: 30 }, boxes: { trim: box, bleed: box, baseFrame: box, safe: box }, background: { type: "solid", color: BLACK }, root: { kind: "group", children: [background, ...nodes] } };
}
async function raster(list: DisplayList) {
  return new RasterBackend({ dpi: 254, crop: "trim", colorMode: "mono", toneRendering: "dots", monoLpi: 60, toneCurve: "linear", assets }).render(list);
}
const strokeNode = (path: PathData, options: Partial<NonNullable<PathNode["stroke"]>> = {}): PathNode => ({ kind: "path", path, fillRule: "nonzero", paint: null, stroke: { width: 0.2, paint: { type: "solid", color: WHITE }, join: "round", ...options } });

describe("text outline rendering", () => {
  it.each(["text", "sfx", "balloon"])("supports adaptive %s outlines in defaults with SVG max-width fallback", async (type) => {
    const key = type === "balloon" ? "textOutline" : "outline";
    const doc = { mangacli: 1, defaults: { [type]: { [key]: "auto" } }, pages: [{ panels: [{ layers: [{ type, text: "A" }] }] }] };
    const list = await renderer.displayList(doc, 1);
    const outline = paths(list.root).find((p) => p.tag?.role === "text" && p.stroke?.auto)!;
    expect(outline.stroke!.auto).toMatchObject({ threshold: 0.4 });
    expect(outline.stroke!.auto!.max).toBeCloseTo(outline.stroke!.auto!.min * 2);
    expect(outline.stroke!.paint).toEqual({ type: "solid", color: WHITE });
    const svg = await renderSvg(list, { crop: "trim", colorMode: "mono", assets });
    expect(svg).toContain(`stroke-width="${+outline.stroke!.width.toFixed(4)}"`);
  });

  it("resolves custom auto bounds, empty text and invalid options cleanly", async () => {
    const doc = (text: string, outline: unknown) => ({ mangacli: 1, pages: [{ panels: [{ layers: [{ text, outline }] }] }] });
    const list = await renderer.displayList(doc("A", { width: "auto", min: "0.2mm", max: "0.9mm", threshold: 0.6 }), 1);
    expect(paths(list.root).find((p) => p.stroke?.auto)?.stroke).toMatchObject({ width: 1.8, auto: { min: 0.2, max: 0.9, threshold: 0.6 } });
    expect(load(doc("A", { width: "auto", min: "0.8bmm", max: "1.6bmm", threshold: 0.4 })).bag.hasErrors).toBe(false);
    expect(paths((await renderer.displayList(doc("", "auto"), 1)).root).some((p) => p.stroke)).toBe(false);
    for (const options of [{ min: "-1mm" }, { threshold: 2 }]) expect(load(doc("A", { width: "auto", ...options })).bag.hasErrors).toBe(true);
    expect((await renderer.validate(doc("A", { width: "auto", min: "2mm", max: "1mm" }))).ok).toBe(false);
    expect(load({ mangacli: 1, pages: [{ layers: [{ image: "unused.png", outline: "auto" }] }] }).bag.hasErrors).toBe(true);
  });

  it("samples the already-drawn bbox, handles the 40% boundary, transforms, isolation and empty backdrops", async () => {
    const path = polyPath([{ x: 10, y: 8 }, { x: 14, y: 8 }, { x: 14, y: 14 }, { x: 10, y: 14 }], true);
    const auto = strokeNode(path, { width: 2, auto: { min: 0.2, max: 1, threshold: 0.4 } });
    const renderCase = async (gray: number, isolated = false, later = false) => {
      const list = listWith([]);
      list.root.children[0] = { ...list.root.children[0] as PathNode, paint: { type: "solid", color: { r: gray, g: gray, b: gray, a: 1 } } };
      const group: Node = { kind: "group", isolate: isolated, transform: [1, 0, 0, 1, 4, 0], children: [auto] };
      if (later) list.root.children.unshift(group);
      else list.root.children.push(group);
      const result = await new RasterBackend({ dpi: 254, crop: "trim", colorMode: "gray", toneRendering: "dots", monoLpi: 60, toneCurve: "linear", assets }).render(list);
      return result.data[(110 * result.width + 133) * 4];
    };
    expect(await renderCase(0)).toBe(255);
    expect(await renderCase(0, true)).toBe(255);
    expect(await renderCase(153 / 255)).toBe(153);
    expect(await renderCase(152 / 255)).toBe(255);
    expect(await renderCase(0, false, true)).toBe(0);
    const empty = listWith([auto]);
    empty.root.children.shift();
    const transparent = await new RasterBackend({ dpi: 254, crop: "trim", colorMode: "mono", toneRendering: "dots", monoLpi: 60, toneCurve: "linear", assets, transparent: true }).render(empty);
    expect(transparent.data[(110 * 400 + 93) * 4 + 3]).toBe(0);
    expect(transparent.data[(110 * 400 + 99) * 4 + 3]).toBe(255);
    expect(auto.stroke!.width).toBe(2);
  });

  it.each(["text", "sfx", "balloon"])("carries %s join, miter limit and fillHoles to both backends", async (type) => {
    const key = type === "balloon" ? "textOutline" : "outline";
    const input = { mangacli: 1, pages: [{ panels: [{ layers: [{ type, text: "A", [key]: { width: "0.5mm", color: "white", join: "miter", miterLimit: 3, fillHoles: "0.4mm" } }] }] }] };
    const list = await renderer.displayList(input, 1);
    const outline = paths(list.root).find((p) => p.tag?.role === "text" && p.stroke)!;
    expect(outline.stroke).toMatchObject({ width: 1, join: "miter", miterLimit: 3, fillHoles: 0.4, paint: { type: "solid", color: WHITE } });
    const svg = await renderSvg(list, { crop: "trim", colorMode: "mono", assets });
    expect(svg).toContain('stroke-linejoin="miter" stroke-miterlimit="3"');
    expect(svg).toContain('operator="dilate" radius="0.2"');
    expect(svg).toContain('operator="erode" radius="0.2"');
  });

  it("bounds acute miters with the default limit of 2 rather than the canvas default", async () => {
    const path: PathData = [["M", 10, 20], ["L", 20, 5], ["L", 22, 20], ["Z"]];
    const top = async (join: "round" | "miter", miterLimit?: number) => {
      const result = await raster(listWith([strokeNode(path, { width: 2, join, miterLimit })]));
      for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) if (result.data[(y * result.width + x) * 4] > 128) return y;
      return result.height;
    };
    const round = await top("round");
    const limited = await top("miter");
    const pointed = await top("miter", 10);
    expect(pointed).toBeLessThan(round);
    expect(limited).toBeGreaterThan(round);
    expect(limited).toBe(await top("miter", 2));
  });

  const rect = (x: number) => polyPath([{ x, y: 8 }, { x: x + 3, y: 8 }, { x: x + 3, y: 14 }, { x, y: 14 }], true);
  it.each(["raster", "svg"])("closes a narrow glyph gap only in its own outline layer (%s)", async (backend) => {
    const path = [...rect(8), ...rect(11.8)];
    const pixel = async (fillHoles: number) => {
      const list = listWith([strokeNode(path, { fillHoles }), { kind: "path", path, fillRule: "nonzero", paint: { type: "solid", color: BLACK } }]);
      if (backend === "raster") {
        const result = await raster(list);
        return [result.data[(110 * 400 + 114) * 4], result.data[(110 * 400 + 95) * 4], result.data[(70 * 400 + 114) * 4]];
      }
      const svg = await renderSvg(list, { crop: "trim", colorMode: "mono", assets });
      const data = await sharp(Buffer.from(svg), { density: 254 }).resize(400, 300).removeAlpha().greyscale().raw().toBuffer();
      return [data[110 * 400 + 114], data[110 * 400 + 95], data[70 * 400 + 114]];
    };
    expect(await pixel(0)).toEqual([0, 0, 0]);
    expect(await pixel(1)).toEqual([255, 0, 0]);
  });

  it("handles empty closing masks and leaves large gaps open", () => {
    expect(closeAlpha(new Uint8Array(), 0, 0, 1)).toEqual(new Uint8Array());
    expect(closeAlpha(new Uint8Array(100), 10, 10, 2).some(Boolean)).toBe(false);
    const mask = new Uint8Array(100);
    mask[22] = 255;
    mask[27] = 255;
    expect(closeAlpha(mask, 10, 10, 0)).toEqual(mask);
    expect(closeAlpha(mask, 10, 10, 1)[24]).toBe(0);
  });

  it.each(["text", "sfx", "balloon"])("handles empty/disabled %s outlines and diagnoses non-solid Paint", async (type) => {
    const key = type === "balloon" ? "textOutline" : "outline";
    const input = (text: string, outline: unknown) => ({ mangacli: 1, pages: [{ panels: [{ layers: [{ type, text, [key]: outline }] }] }] });
    for (const doc of [input("", "0.5mm white"), input("A", "none")]) {
      const list = await renderer.displayList(doc, 1);
      expect(paths(list.root).filter((p) => p.tag?.role === "text" && p.stroke)).toEqual([]);
    }
    const result = await renderer.validate(input("A", { width: "0.5mm", color: { tone: { density: "60%" } } }));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "PAINT_INVALID" && d.message === "text outline color must be solid")).toBe(true);
  });

  it.each([{ miterLimit: 0 }, { fillHoles: "-1mm" }])("rejects invalid outline options %j", (options) => {
    expect(load(yaml(`mangacli: 1\npages:\n  - panels:\n      - layers:\n          - {text: A, outline: ${JSON.stringify({ width: "0.5mm", ...options })}}\n`)).bag.hasErrors).toBe(true);
  });
});
