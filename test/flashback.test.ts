import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { polygonArea } from "../src/geom/path.js";
import { resolveDocument } from "../src/model/resolve.js";
import { Document } from "../src/schema/schema.js";

const settings = { size: ["80mm", "80mm"], bleed: "3mm", baseFrame: { margins: { top: "10mm", bottom: "10mm", inner: "10mm", outer: "10mm" } }, gutter: "6mm" };
const layout = { rows: [{ cols: [1, 1] }, { cols: [1, 1] }] };
const options = { profile: "print-mono", dpi: 254 };

async function sample(input: Record<string, unknown>, dpi = 254) {
  const result = await render(input, { ...options, dpi });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const png = result.pages[0].data;
  const { data, info } = await sharp(png).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { png, layout: result.layout[0], at: (x: number, y: number) => data[Math.round((y + 3) * dpi / 25.4) * info.width + Math.round((x + 3) * dpi / 25.4)] };
}

describe("flashback mood", () => {
  it("preserves page art inside transparent flashback panels", async () => {
    const art = await sharp({ create: { width: 80, height: 80, channels: 3, background: "white" } }).png().toBuffer();
    const result = await render({ mangacli: 1, page: { ...settings, background: { image: "art", fit: "cover" } }, assets: { art: { src: "art.png", kind: "background" } }, pages: [{ layout, panels: [{ mood: "flashback", background: "none" }, {}, {}, {}] }] }, { ...options, assets: { art } });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const { data, info } = await sharp(result.pages[0].data).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y + 3) * 10 * info.width + (x + 3) * 10];
    expect(at(60, 20)).toBe(255);
    expect(at(40, 20)).toBe(0);
    expect(at(60, 0)).toBe(0);
    expect(at(40, 60)).toBe(255);
  });

  it("renders concave free-placed flashback polygons", async () => {
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{ layout: "free", panels: [{ mood: "flashback", coords: "page", polygon: [[10, 10], [60, 10], [60, 20], [20, 20], [20, 60], [60, 60], [60, 70], [10, 70]] }] }] });
    expect(at(64, 15)).toBe(0);
    expect(at(35, 24)).toBe(0);
    expect(at(35, 40)).toBe(255);
    expect(at(-2, -2)).toBe(0);
  });

  it("accepts page defaults, page and panel keys and Paint gutters, rejecting invalid values", () => {
    const doc = { mangacli: 1, page: { mood: "flashback", flashbackBorder: "none", gutterFill: "tone(30%)" }, pages: [{ mood: "flashback", flashbackBorder: "white", gutterFill: "black", panels: [{ mood: "flashback", flashbackBorder: "white" }] }] };
    expect(Document.safeParse(doc).success).toBe(true);
    expect(Document.safeParse({ ...doc, page: { mood: "dream" } }).success).toBe(false);
    expect(Document.safeParse({ ...doc, page: { flashbackBorder: "black" } }).success).toBe(false);
  });

  it("inverts only narration, respecting explicit balloon, style, page and panel values", () => {
    const narration = { type: "balloon", as: "narration", text: "記憶" };
    const doc = resolveDocument({ page: { mood: "flashback", flashbackBorder: "white", background: "paper", gutterFill: "none" }, styles: { custom: { fill: "tone(8%)", color: "black", stroke: { color: "red" } } }, pages: [{ panels: [
      { layers: [narration, { type: "balloon", as: "say", text: "今" }, { ...narration, fill: "paper", color: "black", stroke: { color: "red" } }, { ...narration, style: "custom" }] },
      { flashbackBorder: "none" }, { border: { color: "red", width: "1mm" } },
    ], layers: [narration] }] }, new DiagnosticBag());
    const page = doc.pages[0];
    expect(page.settings).toMatchObject({ background: "paper", gutterFill: "none" });
    expect(page.panels[0].props.border).toMatchObject({ color: "white", width: "0.3mm@print" });
    expect(page.panels[1].props.border).toEqual({ style: "none" });
    expect(page.panels[2].props.border).toMatchObject({ color: "red", width: "1mm", style: "solid" });
    const els = page.panels[0].elements;
    expect(els[0].props).toMatchObject({ fill: "black", color: "white", stroke: { color: "white" } });
    expect(els[1].props.fill).toBe("paper");
    expect(els[2].props).toMatchObject({ fill: "paper", color: "black", stroke: { color: "red" } });
    expect(els[3].props).toMatchObject({ fill: "tone(8%)", color: "black", stroke: { color: "red" } });
    expect(page.layers[0].props.fill).toBe("black");
    const partial = resolveDocument({ pages: [{ panels: [{ mood: "flashback", layers: [narration] }, { layers: [narration] }] }] }, new DiagnosticBag());
    expect(partial.pages[0].panels[0].elements[0].props.fill).toBe("black");
    expect(partial.pages[0].panels[1].elements[0].props.fill).toBe("paper");
  });

  it.each(["element-fill", "element-color", "style", "document", "page", "panel"])("keeps normal narration colors when authored by %s", (source) => {
    const balloon = { type: "balloon", as: "narration", text: "記憶", ...(source === "style" ? { style: "flashback" } : {}), ...(source === "element-fill" ? { fill: "tone(8%)" } : {}), ...(source === "element-color" ? { color: "navy" } : {}) };
    const defaults = { balloon: { fill: "tone(8%)" } };
    const input = {
      styles: { flashback: { fill: "tone(8%)", stroke: { width: "0.4mm", style: "double" } } },
      ...(source === "document" ? { defaults } : {}),
      pages: [{ ...(source === "page" ? { defaults } : {}), panels: [{ ...(source === "panel" ? { defaults } : {}), layers: [balloon] }] }],
    };
    const normal = resolveDocument(input, new DiagnosticBag()).pages[0].panels[0].elements[0].props;
    const flashback = resolveDocument({ ...input, page: { mood: "flashback" } }, new DiagnosticBag()).pages[0].panels[0].elements[0].props;
    for (const key of ["fill", "color", "stroke"]) expect(flashback[key]).toEqual(normal[key]);
    expect(flashback.color).not.toBe("white");
  });

  it("expands slanted edges by the full gutter width", async () => {
    const { at, layout: info } = await sample({ mangacli: 1, page: settings, pages: [{ layout: { rows: [{ cols: [1, 1], colSlant: ["8mm"] }, { cols: [1, 1] }] }, panels: [{ mood: "flashback" }, {}, {}, {}] }] });
    const poly = info.panels[0].polygon;
    const i = poly.findIndex((a, j) => {
      const b = poly[(j + 1) % poly.length];
      return Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1;
    });
    expect(i).toBeGreaterThanOrEqual(0);
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const sign = polygonArea(poly) > 0 ? 1 : -1;
    const nx = sign * (b.y - a.y) / length, ny = sign * (a.x - b.x) / length;
    expect(at((a.x + b.x) / 2 + nx * 5, (a.y + b.y) / 2 + ny * 5)).toBe(0);
    expect(at(40, 60)).toBe(255);
  });

  it("defaults image-background flashback gutters to black, allowing explicit paper", async () => {
    const art = await sharp({ create: { width: 80, height: 80, channels: 3, background: "white" } }).png().toBuffer();
    const input = { mangacli: 1, page: { ...settings, mood: "flashback", background: { image: "art", fit: "cover" } }, assets: { art: { src: "art.png", kind: "background" } }, pages: [{ layout, panels: [{}, {}, {}, {}] }] };
    for (const gutterFill of [undefined, "paper"]) {
      const result = await render({ ...input, page: { ...input.page, ...(gutterFill ? { gutterFill } : {}) } }, { ...options, assets: { art } });
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const { data, info } = await sharp(result.pages[0].data).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
      expect(data[630 * info.width + 430]).toBe(gutterFill ? 255 : 0);
    }
  });

  it("covers the flashback gutters and bleed but leaves normal-to-normal gutters white", async () => {
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{ layout, panels: [{ mood: "flashback" }, {}, {}, {}] }] });
    expect(at(40, 20)).toBe(0);
    expect(at(60, 40)).toBe(0);
    expect(at(40, 60)).toBe(255);
    expect(at(20, 40)).toBe(255);
    expect(at(80, 20)).toBe(0);
    expect(at(60, -2)).toBe(0);
    expect(at(20, -2)).toBe(255);
    expect(at(60, 20)).toBe(255);
  });

  it.each(["none", "white"])("paints page background and gutters black with %s borders at 600dpi", async (flashbackBorder) => {
    const { at, png } = await sample({ mangacli: 1, page: { ...settings, mood: "flashback", flashbackBorder }, pages: [{ layout, panels: [{ background: "black" }, {}, {}, {}] }] }, 600);
    expect((await sharp(png).metadata()).bitsPerSample).toBe(1);
    expect(at(-2, -2)).toBe(0);
    expect(at(40, 60)).toBe(0);
    expect(at(60, 20)).toBe(0);
    const white = Array.from({ length: 31 }, (_, i) => at(70 - 0.6 + i * 0.04, 20)).filter((v) => v === 255).length;
    if (flashbackBorder === "white") expect(white * 0.04).toBeGreaterThanOrEqual(0.1);
    else expect(white).toBe(0);
  });

  it("supports Paint gutters without an image and empty flashback pages", async () => {
    const { at } = await sample({ mangacli: 1, page: { ...settings, gutterFill: "black" }, pages: [{ layout, panels: [{}, {}, {}, {}] }] });
    expect(at(40, 60)).toBe(0);
    expect(at(-2, -2)).toBe(255);
    const empty = await sample({ mangacli: 1, page: { ...settings, mood: "flashback" }, pages: [{}] });
    expect(empty.at(-2, -2)).toBe(0);
  });
});
