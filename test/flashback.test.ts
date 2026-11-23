import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { pointInPolygon, polygonArea } from "../src/geom/path.js";
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
  it.each(["top", "right", "bottom", "left"])("keeps the gutter black between panels bled to the %s", async (side) => {
    const vertical = side === "top" || side === "bottom";
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{
      layout: { rows: vertical ? [{ cols: [1, 1] }] : [{ cols: [1] }, { cols: [1] }] },
      panels: [{ mood: "flashback", bleed: [side] }, { bleed: [side] }],
    }] });
    for (const distance of [-2, 1, 5, 9, 11]) {
      const x = vertical ? 40 : side === "left" ? distance : 80 - distance;
      const y = vertical ? side === "top" ? distance : 80 - distance : 40;
      expect(at(x, y), `${x},${y}`).toBe(0);
    }
  });

  it("extends inset outer-facing edges to bleed without covering a normal neighbour", async () => {
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{ layout: "free", panels: [
      { mood: "flashback", coords: "page", box: ["20mm", "20mm", "25mm", "40mm"] },
      { coords: "page", box: ["51mm", "20mm", "15mm", "40mm"] },
    ] }] });
    for (const [x, y] of [[-2, 40], [30, -2], [30, 82], [10, 40], [30, 10], [30, 70], [48, 40]]) expect(at(x, y)).toBe(0);
    expect(at(58, 40)).toBe(255);
    expect(at(78, 40)).toBe(255);
  });

  it("cuts P10-like margins at the gutter center beside the normal top panel", async () => {
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{
      layout: { rows: [{ cols: [1, 1] }, { cols: [1] }, { cols: [1] }] },
      panels: [{}, { mood: "flashback" }, { mood: "flashback" }, { mood: "flashback" }],
    }] });
    for (const x of [-2, 5, 20, 40, 60, 75, 82]) for (const y of [75, 82]) expect(at(x, y), `${x},${y}`).toBe(0);
    for (const x of [-2, 5, 20, 39]) expect(at(x, -2)).toBe(0);
    for (const x of [41, 60, 75, 82]) expect(at(x, -2)).toBe(255);
    for (const y of [20, 40, 60]) for (const x of [-2, 5]) expect(at(x, y), `${x},${y}`).toBe(0);
    for (const x of [75, 82]) {
      expect(at(x, 28)).toBe(255);
      expect(at(x, 30)).toBe(0);
      expect(at(x, 60)).toBe(0);
    }
    expect(at(40, 20)).toBe(0);
    expect(at(60, 20)).toBe(255);
    expect(at(20, 20)).toBe(255);
    expect(at(40, 40)).toBe(255);
    expect(at(40, 60)).toBe(255);
  });

  it("keeps P11-like normal-panel side and bottom margins white", async () => {
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{
      layout: { rows: [{ cols: [1] }, { cols: [1, 1] }, { cols: [1] }] },
      panels: [{ mood: "flashback" }, {}, {}, {}],
    }] });
    for (const x of [-2, 5, 75, 82]) {
      for (const y of [-2, 5, 20, 28]) expect(at(x, y), `${x},${y}`).toBe(0);
      for (const y of [30, 40, 60, 75, 82]) expect(at(x, y), `${x},${y}`).toBe(255);
    }
    for (const x of [20, 40, 60]) {
      expect(at(x, -2)).toBe(0);
      expect(at(x, 82)).toBe(255);
    }
    expect(at(40, 29)).toBe(0);
    expect(at(40, 40)).toBe(255);
  });

  it.each(["12mm", "-12mm"])("cuts the outer margin along the dominant gutter centre (%s)", async (slant) => {
    const { at, layout } = await sample({ mangacli: 1, page: settings, pages: [{
      layout: { rows: [{ cols: [1], slant }, { cols: [1, 1] }] },
      panels: [{ dominant: { overlap: "8mm" } }, { mood: "flashback" }, {}],
    }] });
    const dominant = layout.panels[0].polygon;
    const flashback = layout.panels[1].polygon;
    const i = dominant.findIndex((a, j) => {
      const b = dominant[(j + 1) % dominant.length];
      return b.x < a.x && Math.abs(b.y - a.y) > 0.1;
    });
    expect(i).toBeGreaterThanOrEqual(0);
    const a = dominant[i], b = dominant[(i + 1) % dominant.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = (b.y - a.y) / len, ny = (a.x - b.x) / len;
    const gap = Math.min(...flashback.map((p) => (p.x - a.x) * nx + (p.y - a.y) * ny));
    for (const x of [76, 80, 82]) {
      const centreY = a.y + (gap / 2 - (x - a.x) * nx) / ny;
      expect(at(x, centreY + 0.6), `black below gutter centre at ${x}`).toBe(0);
      expect(at(x, centreY - 0.6), `white above gutter centre at ${x}`).toBe(255);
    }
  });

  it.each(["ellipse", "cloud", "rounded"])("paints black up to the rendered %s flashback outline", async (shape) => {
    const { at } = await sample({ mangacli: 1, page: settings, pages: [{ layout, panels: [{ mood: "flashback", shape: { kind: shape, radius: "6mm" } }, {}, {}, {}] }] });
    expect(at(44, 11)).toBe(0);
    expect(at(56, 23)).toBe(255);
  });

  it.each(["12mm", "-12mm"])("preserves underlay inside a normal panel bled across a %s slant", async (slant) => {
    const art = await sharp({ create: { width: 80, height: 80, channels: 3, background: "white" } }).png().toBuffer();
    const result = await render({ mangacli: 1, page: { ...settings, gutterFill: "none", background: { image: "art", fit: "cover", bleed: "all" } }, assets: { art: { src: "art.png", kind: "background" } }, pages: [{ layout: { rows: [{ cols: [1, 1], colSlant: [slant] }] }, panels: [{ mood: "flashback" }, { bleed: ["top"], background: "none", border: "none" }] }] }, { ...options, assets: { art } });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const normal = result.layout[0].panels[1].polygon;
    const { data, info } = await sharp(result.pages[0].data).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    let checked = 0;
    for (let y = -1; y < 10; y++) for (let x = 11; x < 69; x++) {
      if (![[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].every(([dx, dy]) => pointInPolygon({ x: x + dx, y: y + dy }, normal))) continue;
      expect(data[(y + 3) * 10 * info.width + (x + 3) * 10], `underlay at ${x},${y}`).toBe(255);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it.each(["split", "rows", "page"])("covers the full unitless numeric %s gutter", async (source) => {
    const numericLayout = source === "split" ? { split: "cols", gutter: 8, children: ["panel", "panel"] } : { rows: [{ cols: [1, 1], ...(source === "rows" ? { gutter: { col: 8 } } : {}) }] };
    const { at } = await sample({ mangacli: 1, page: { ...settings, ...(source === "page" ? { gutter: 8 } : {}) }, pages: [{ layout: numericLayout, panels: [{ mood: "flashback" }, {}] }] });
    expect(at(37, 30)).toBe(0);
    expect(at(20, 30)).toBe(255);
    expect(at(60, 30)).toBe(255);
  });

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
