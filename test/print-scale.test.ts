import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer, render, validate } from "../src/api.js";
import { parseLength, toMm } from "../src/core/units.js";
import { parsePaint } from "../src/model/values.js";
import { Document, Length } from "../src/schema/schema.js";
import type { PluginPageSize } from "../src/plugin.js";

const units = { units: "mm" as const, dpi: 600, k: 1, printScale: 0.8 };
const input = (page = "", layers = "") => ({ yaml: `mangacli: 1\npage: { ${page} }\npages:\n  - panels:\n      - layers: ${layers || "[]"}\n` });

describe("print-basis units", () => {
  it("converts physical, pixel, relative and bare lengths", () => {
    for (const length of ["14Q", "0.3mm", "72pt", "600px", "2em", "50%", "10"]) {
      const ctx = { ...units, em: 4, base: 20 };
      expect(toMm(`${length}@print`, ctx)).toBeCloseTo(toMm(length, ctx) / 0.8);
      expect(Length.safeParse(`${length}@print`).success).toBe(true);
    }
    expect(toMm("14Q@print", { ...units, printScale: undefined })).toBe(3.5);
    expect(parseLength("@print")).toBeNull();
    expect(parseLength("14Q@print@print")).toBeNull();
    expect(Length.safeParse("bad@print").success).toBe(false);
  });
  it("converts tone lpi in object and paint shorthand without scaling manuscript lpi", () => {
    const ctx = { u: units, box: { x: 0, y: 0, w: 100, h: 100 }, seed: 1 };
    for (const paint of [{ tone: { density: 0.2, lpi: "85@print" } }, "tone(20%, 85lpi@print)"]) {
      const p = parsePaint(paint, ctx);
      expect(p?.type).toBe("tone");
      if (p?.type === "tone") expect(p.tone.lpi).toBe(68);
    }
    const p = parsePaint("tone(20%, 85lpi)", ctx);
    if (p?.type === "tone") expect(p.tone.lpi).toBe(85);
  });
  it("validates print-basis tone numbers", async () => {
    for (const lpi of ["0@print", "-85@print", "bad@print", "201@print"]) {
      expect((await validate(input("", `[{type: fill, paint: {tone: {density: 0.2, lpi: "${lpi}"}}}]`))).ok).toBe(false);
    }
    expect((await validate(input("printScale: 0.8", '[{type: fill, paint: {tone: {density: 0.2, lpi: "85@print"}}}]'))).ok).toBe(true);
  });
});

describe("print geometry", () => {
  it("orients unresolved preset frame dimensions before resolving percentages", async () => {
    const pageSizes: Record<string, PluginPageSize> = {
      relative: { width: 100, height: 150, baseFrame: { size: ["80%", "80%"] } },
      offset: { width: 100, height: 150, baseFrame: { size: ["70%", "80%"], offset: ["2mm", "3mm"] } },
      margins: { width: 100, height: 150, baseFrame: { margins: { top: "10%", bottom: "20%", inner: "30%", outer: "40%" } } },
    };
    for (const [size, frame] of [
      ["relative", { x: 15, y: 10, w: 120, h: 80 }],
      ["offset", { x: 18, y: 17, w: 120, h: 70 }],
      ["margins", { x: 30, y: 30, w: 105, h: 30 }],
    ] as const) {
      const r = await validate(input(`size: ${size}, orientation: landscape`), { plugins: [{ name: "frames", pageSizes }] });
      expect(r.layout[0].geom).toMatchObject({ trimW: 150, trimH: 100, baseFrame: frame });
      expect(r.diagnostics.filter((d) => d.code === "PAGE_BASEFRAME_OUTSIDE_SAFE")).toEqual([]);
    }
  });

  it("orients preset base frames and print sizes without rotating explicit frames", async () => {
    const r = await validate(input("size: manga-b4, orientation: landscape"));
    expect(r.layout[0].geom).toMatchObject({ trimW: 310, trimH: 220, baseFrame: { x: 20, y: 20, w: 270, h: 180 } });
    expect(r.layout[0].geom.printScale).toBeCloseTo(257 / 310);
    expect(r.diagnostics.filter((d) => d.code === "PAGE_BASEFRAME_OUTSIDE_SAFE")).toEqual([]);
    const explicit = await validate(input("size: manga-b4, orientation: landscape, baseFrame: {size: [200mm, 150mm]}"));
    expect(explicit.layout[0].geom.baseFrame).toMatchObject({ w: 200, h: 150 });
  });
  it("lets page-level print settings replace the other inherited setting", async () => {
    for (const [inherited, specific, scale] of [["printSize: B5", "printScale: 0.5", 0.5], ["printScale: 0.5", "printSize: B5", 182 / 220]] as const) {
      const r = await validate({ yaml: `mangacli: 1\npage: { size: manga-b4, ${inherited} }\npages:\n  - ${specific}\n    panels: [{}]\n` });
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(r.layout[0].geom.printScale).toBeCloseTo(scale);
    }
  });
  it("defaults to identity and resolves manga-b4 geometry", async () => {
    const plain = await validate(input());
    expect(plain.layout[0].geom.printScale).toBe(1);
    const r = await validate(input("size: manga-b4"));
    expect(r.ok).toBe(true);
    expect(r.layout[0].geom).toMatchObject({ trimW: 220, trimH: 310, bleed: 5, baseFrame: { x: 20, y: 20, w: 180, h: 270 } });
    expect(r.layout[0].geom.printScale).toBeCloseTo(182 / 220);
  });
  it("resolves explicit scales, oriented print sizes and print font sizes", async () => {
    const a = await validate(input("size: manga-b4, printScale: 0.8", '[{text: Test, fontSize: "14Q@print"}]'));
    expect(a.ok).toBe(true);
    expect(a.layout[0].text[0].fontSize).toBeCloseTo(3.5 / 0.8);
    const b = await validate(input("size: A4, orientation: landscape, printSize: B5"));
    expect(b.layout[0].geom.printScale).toBeCloseTo(257 / 297);
    const c = await validate(input("size: [200mm, 300mm], printSize: [160mm, 240mm]"));
    expect(c.layout[0].geom.printScale).toBeCloseTo(0.8);
  });
  it("rejects conflicting, invalid and enlarging print settings", async () => {
    for (const page of ["printScale: 0", "printScale: 1.1", "printScale: 0.8, printSize: B5", "size: B5, printSize: A4", "printSize: nonexistent"]) {
      expect((await validate(input(page))).ok, page).toBe(false);
    }
    expect(Document.safeParse({ mangacli: 1, page: { printScale: -1 }, pages: [{}] }).success).toBe(false);
  });
  it("allows config and plugin preset overrides and explicit document overrides", async () => {
    const pageSizes: Record<string, PluginPageSize> = { "manga-b4": { width: 200, height: 300, bleed: "4mm", baseFrame: { size: ["170mm", "260mm"] }, printSize: "A5", dpi: 300 } };
    const config = { pageSizes };
    const r = await validate(input("size: manga-b4, bleed: 2mm"), { config });
    expect(r.ok).toBe(true);
    expect(r.layout[0].geom).toMatchObject({ trimW: 200, trimH: 300, bleed: 2, dpi: 300, baseFrame: { w: 170, h: 260 } });
    expect(r.layout[0].geom.printScale).toBeCloseTo(148 / 200);
    const p = await validate(input("size: manga-b4"), { plugins: [{ name: "custom", override: true, pageSizes: config.pageSizes }] });
    expect(p.layout[0].geom.trimW).toBe(200);
  });
});

async function inkBox(data: Buffer, region: { left: number; top: number; width: number; height: number }) {
  const { data: pixels, info } = await sharp(data).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (pixels[i] < 128 && pixels[i + 1] < 128 && pixels[i + 2] < 128) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  expect(x1).toBeGreaterThanOrEqual(0);
  return [x0 + region.left, y0 + region.top, x1 + region.left, y1 + region.top];
}

describe("print export", () => {
  it("keeps raster crop-mark length, width and margin in output millimeters", async () => {
    const doc = input("size: [100mm, 150mm], bleed: 4mm, printScale: 0.5");
    const options = { profile: "preview", dpi: 254, crop: "marks" as const, config: { output: { marks: { length: 9, width: 0.4, margin: 12 } } } };
    const a = (await render(doc, options)).pages[0];
    const b = (await render(doc, { ...options, output: "print" })).pages[0];
    expect(b.width).toBe(780);
    expect(b.height).toBe(1030);
    const manuscriptMark = await inkBox(Buffer.from(a.data), { left: 0, top: 150, width: 120, height: 20 });
    const printMark = await inkBox(Buffer.from(b.data), { left: 0, top: 130, width: 120, height: 20 });
    expect(printMark[2] - printMark[0]).toBe(manuscriptMark[2] - manuscriptMark[0]);
    expect(printMark[3] - printMark[1]).toBe(manuscriptMark[3] - manuscriptMark[1]);
    const fitted = await render(doc, { output: "print", profile: "preview", crop: "marks", width: 740 });
    expect(fitted.pages[0].width).toBe(740);
    expect(fitted.pages[0].height).toBe(990);
    expect(fitted.pages[0].dpi).toBeCloseTo(254);
  });
  it("keeps PDF mark margins physical while scaling trim and bleed", async () => {
    const doc = input("size: [100mm, 150mm], bleed: 4mm, printScale: 0.5");
    const r = await render(doc, { output: "print", profile: "print-gray", dpi: 254, crop: "marks", format: "pdf" });
    const pdf = Buffer.from(r.pages[0].data).toString("latin1");
    const box = pdf.match(/\/MediaBox \[([^\]]+)\] \/TrimBox \[([^\]]+)\] \/BleedBox \[([^\]]+)\]/)!;
    const media = box[1].split(" ").map(Number), bleed = box[3].split(" ").map(Number);
    expect((media[2] - media[0]) * 25.4 / 72).toBeCloseTo(74, 1);
    expect((bleed[0] - media[0]) * 25.4 / 72).toBeCloseTo(10, 1);
  });
  it("exports SVG crop marks with physical dimensions outside scaled artwork", async () => {
    const doc = input("size: [100mm, 150mm], bleed: 4mm, printScale: 0.5");
    const r = await render(doc, { output: "print", profile: "preview", crop: "marks", format: "svg" });
    const svg = Buffer.from(r.pages[0].data).toString();
    expect(svg).toContain('width="74mm" height="99mm"');
    expect(svg).toContain('viewBox="-20 -20 148 198"');
    expect(svg).toContain('stroke-width="0.2"');
    expect(svg).toContain("M0 4L-18 4");
  });
  it.each(["trim", "bleed", "marks"] as const)("preserves scaled PDF trim boxes with %s crop", async (crop) => {
    const doc = { yaml: "mangacli: 1\npage: { size: [100mm, 150mm], bleed: 4mm, printScale: 0.5 }\npages:\n  - type: spread\n    panels: [{}]\n" };
    for (const spread of ["split", "joined"] as const) {
      const result = await render(doc, { output: "print", profile: "print-gray", format: "pdf", dpi: 254, crop, spread });
      const pdf = Buffer.from(result.pages[0].data).toString("latin1");
      const boxes = [...pdf.matchAll(/\/TrimBox \[([^\]]+)\] \/BleedBox \[([^\]]+)\]/g)];
      expect(boxes).toHaveLength(spread === "split" ? 2 : 1);
      for (const box of boxes) {
        const trim = box[1].split(" ").map(Number);
        const bleed = box[2].split(" ").map(Number);
        const mm = 25.4 / 72;
        expect((trim[2] - trim[0]) * mm).toBeCloseTo(spread === "split" ? 50 : 100, 1);
        expect((trim[3] - trim[1]) * mm).toBeCloseTo(75, 1);
        expect((trim[0] - bleed[0]) * mm).toBeCloseTo(crop === "trim" ? 0 : 2, 1);
      }
    }
  });
  it("matches downscaled manuscript frame and text ink within 0.1mm", async () => {
    const yaml = `mangacli: 1
page: { size: manga-b4 }
pages:
  - panels:
      - border: { width: 0.5mm@print, ruler: true }
        layers:
          - { text: PRINT, id: label, fontSize: 24Q@print, at: [50%, 50%], outline: [] }
`;
    const D = 300;
    const renderer = createRenderer({ profile: "preview", dpi: D, crop: "trim" });
    const manuscript = await renderer.render({ yaml });
    const printed = await renderer.render({ yaml }, { output: "print" });
    const m = manuscript.pages[0], p = printed.pages[0];
    const s = manuscript.layout[0].geom.printScale;
    expect(p.width).toBe(Math.round(220 * s * D / 25.4));
    expect(p.height).toBe(Math.round(310 * s * D / 25.4));
    expect(p.dpi).toBe(D);
    expect((await sharp(p.data).metadata()).density).toBe(D);
    const down = await sharp(m.data).resize(p.width, p.height, { fit: "fill" }).png().toBuffer();
    const ppmm = D / 25.4;
    const region = (x: number, y: number, w: number, h: number) => ({ left: Math.round(x * s * ppmm), top: Math.round(y * s * ppmm), width: Math.round(w * s * ppmm), height: Math.round(h * s * ppmm) });
    for (const roi of [region(15, 15, 190, 280), region(65, 100, 90, 110)]) {
      const a = await inkBox(down, roi), b = await inkBox(Buffer.from(p.data), roi);
      for (let i = 0; i < 4; i++) expect(Math.abs(a[i] - b[i]) / ppmm).toBeLessThanOrEqual(0.1);
    }
    renderer.dispose();
  });
  it("supports explicit output pixels, SVG physical sizes and unchanged default export", async () => {
    const doc = input("size: [100mm, 150mm], printScale: 0.8, bleed: 0");
    const a = await render(doc, { profile: "preview", output: "print", width: 400 });
    expect(a.pages[0].width).toBe(400);
    const b = await render(doc, { profile: "preview", output: "print", format: "svg" });
    expect(Buffer.from(b.pages[0].data).toString()).toContain('width="80mm" height="120mm"');
    const r = createRenderer({ profile: "preview" });
    const c = await r.render(doc), d = await r.render(doc, { output: "manuscript" });
    expect(Buffer.from(c.pages[0].data)).toEqual(Buffer.from(d.pages[0].data));
    r.dispose();
  });
});
