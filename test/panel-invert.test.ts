import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render, validate } from "../src/api.js";

const input = (panel = "", layers = "[]", page = "") => ({ yaml: `mangacli: 1
page: { size: [40mm, 40mm], bleed: 0, baseFrame: trim, color: color }
pages:
  - id: test
    number: false
    ${page || "title: test"}
    panels:
      - border: { style: none }
        id: p1
        ${panel || "note: test"}
        layers: ${layers}
` });
const options = { profile: "web", dpi: 127, crop: "trim" as const };
async function pixels(doc: ReturnType<typeof input>, profile = "web") {
  const r = await render(doc, { ...options, profile });
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return sharp(r.pages[0].data).ensureAlpha().raw().toBuffer();
}
const at = (data: Buffer, x: number, y: number) => Array.from(data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 3));

describe("post-composite filters", () => {
  it("inverts panel paper and ink, preserving balloon pixels by default", async () => {
    const layers = '[{ type: draw, kind: rect, at: [10mm, 10mm], size: [10mm, 10mm], fill: black }, { balloon: X, at: [28mm, 28mm], minSize: [14mm, 14mm], fontSize: 3mm }]';
    const a = await pixels(input("", layers));
    const b = await pixels(input("invert: true", layers));
    expect(at(a, 50, 50)).toEqual([0, 0, 0]);
    expect(at(b, 50, 50)).toEqual([255, 255, 255]);
    expect(at(b, 10, 10)).toEqual([0, 0, 0]);
    expect(at(b, 140, 120)).toEqual(at(a, 140, 120));
    const all = await pixels(input("invert: true\n        exclude: []", layers));
    expect(at(all, 140, 120)).toEqual(at(a, 140, 120).map((v) => 255 - v));
  });
  it("inverts effect and sfx ink including in print-mono", async () => {
    for (const profile of ["web", "print-mono"]) {
      for (const layer of ['{ effect: focus-lines, inner: [20%, 20%], thickness: 1mm }', '{ sfx: ドン, at: [50%, 50%], fontSize: 14mm }']) {
        const a = await pixels(input("", `[${layer}]`), profile);
        const b = await pixels(input("invert: true", `[${layer}]`), profile);
        let ink = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] < 64) { ink++; expect(b[i], `${profile}: ${layer}`).toBeGreaterThan(190); }
        }
        expect(ink).toBeGreaterThan(10);
      }
    }
  });
  it("supports grayscale, threshold, filter ordering, and page-level inversion", async () => {
    expect(at(await pixels(input('background: red\n        filters: [grayscale]')), 50, 50)).toEqual([54, 54, 54]);
    expect(at(await pixels(input('background: red\n        filters: ["threshold(0.5)"]')), 50, 50)).toEqual([0, 0, 0]);
    expect(at(await pixels(input('background: red\n        filters: ["threshold(0.5)"]\n        invert: true')), 50, 50)).toEqual([255, 255, 255]);
    expect(at(await pixels(input("", "[]", "invert: true")), 50, 50)).toEqual([0, 0, 0]);
  });
  it("leaves empty filter lists byte-identical", async () => {
    expect(await pixels(input("invert: false\n        filters: []"))).toEqual(await pixels(input()));
  });
  it("removes page paper recursively for transparent output on inverted pages", async () => {
    const doc = input("background: transparent", '[{ type: draw, kind: rect, at: [20mm, 20mm], size: [10mm, 10mm], fill: black }]', "invert: true");
    for (const output of [{ transparent: true }, { background: "transparent" }]) {
      const r = await render(doc, { ...options, ...output });
      const data = await sharp(r.pages[0].data).ensureAlpha().raw().toBuffer();
      expect(data[(10 * 200 + 10) * 4 + 3]).toBe(0);
      expect(data[(100 * 200 + 100) * 4 + 3]).toBe(255);
      expect(at(data, 100, 100)).toEqual([255, 255, 255]);
    }
  });
  it("replaces output paper in place so page inversion also filters the override", async () => {
    const r = await render(input("background: transparent", "[]", "invert: true"), { ...options, background: "red" });
    const data = await sharp(r.pages[0].data).ensureAlpha().raw().toBuffer();
    expect(at(data, 10, 10)).toEqual([0, 255, 255]);
  });
  it("does not paint transparent pixels or pixels outside the panel clip", async () => {
    const small = await pixels(input("box: [10mm, 10mm, 20mm, 20mm]\n        invert: true"));
    expect(at(small, 20, 20)).toEqual([255, 255, 255]);
    expect(at(small, 100, 100)).toEqual([0, 0, 0]);
    const transparent = await pixels(input("background: transparent\n        invert: true", '[{ type: draw, kind: ellipse, at: [20mm, 20mm], size: [10mm, 10mm], fill: black }]'));
    expect(at(transparent, 10, 10)).toEqual([255, 255, 255]);
    expect(at(transparent, 100, 100)).toEqual([255, 255, 255]);
  });
  it("rejects unknown names and invalid exclusion kinds", async () => {
    for (const doc of [input("filters: [not-a-filter]"), input("", "[]", "filters: [not-a-filter]")]) {
      expect((await validate(doc)).diagnostics.some((d) => d.code === "SCHEMA_ENUM" && d.severity === "error")).toBe(true);
    }
    expect((await validate(input("exclude: [bogus]"))).ok).toBe(false);
  });
  it("emits SVG transfers and warns for unsupported filters; PDF/PSD still render", async () => {
    const svg = await render(input("invert: true\n        filters: [blur]"), { ...options, format: "svg" });
    expect(Buffer.from(svg.pages[0].data).toString()).toContain("feComponentTransfer");
    expect(svg.diagnostics.some((d) => d.code === "SVG_FILTER_UNSUPPORTED")).toBe(true);
    for (const format of ["pdf", "psd"] as const) {
      const r = await render(input("invert: true"), { ...options, format });
      expect(r.pages[0].data.length).toBeGreaterThan(100);
    }
  });
});
