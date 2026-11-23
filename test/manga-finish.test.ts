import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";
import { applyFilters, parseFilter } from "../src/render/filters.js";
import type { ImageFilter } from "../src/render/ir.js";
import type { Node } from "../src/render/ir.js";

function sourcePixels() {
  const width = 120;
  const height = 80;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  const black = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  };
  black(5, 10, 39, 69); // wider than betaMinSize: large beta
  black(70, 5, 73, 74); // narrow dark stroke
  return { data, width, height };
}

const mangaOpts = { betaMinSize: 1, tones: [0.2], lpi: 30, cut: 0.4, grain: 0.3, seed: 9 };
const mangaFilter: ImageFilter = { name: "manga", args: [], opts: mangaOpts };

describe("manga finish filter", () => {
  it("parses string and object filter forms", () => {
    expect(parseFilter("manga")).toEqual({ name: "manga", args: [] });
    expect(parseFilter({ manga: { tones: [0.1, 0.2, 0.3], lpi: 60 } })).toEqual({ name: "manga", args: [], opts: { tones: [0.1, 0.2, 0.3], lpi: 60 } });
  });

  it("outputs only black and white, tones large beta, and keeps a small dark stroke black", async () => {
    const out = await applyFilters(sourcePixels(), [mangaFilter], 0.05);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i] === 0 || out.data[i] === 255).toBe(true);
    let black = 0;
    let white = 0;
    for (let y = 20; y <= 50; y++) for (let x = 10; x <= 30; x++) {
      const v = out.data[(y * out.width + x) * 4];
      if (v === 0) black++;
      else white++;
    }
    expect(black).toBeGreaterThan(0);
    expect(white).toBeGreaterThan(0);
    for (let y = 20; y <= 50; y++) for (const x of [71, 72]) expect(out.data[(y * out.width + x) * 4]).toBe(0);
  });

  it("keeps large beta solid black inside keepBeta regions and rects", async () => {
    const context = { sourceRect: { x: 0, y: 0, w: 120, h: 80 }, regions: { hair: [5, 10, 35, 60] as [number, number, number, number] } };
    for (const keepBeta of [["hair"], [[5, 10, 35, 60]]]) {
      const out = await applyFilters(sourcePixels(), [{ ...mangaFilter, opts: { ...mangaOpts, keepBeta } }], 0.05, context);
      for (let y = 20; y <= 50; y++) for (let x = 10; x <= 30; x++) expect(out.data[(y * out.width + x) * 4]).toBe(0);
    }
  });

  it("is deterministic for the same input and seed", async () => {
    const a = await applyFilters(sourcePixels(), [mangaFilter], 0.05);
    const b = await applyFilters(sourcePixels(), [mangaFilter], 0.05);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});

function doc(pageFinish = "", assetFinish = "", elementFinish = "", localFinish = "") {
  return `mangacli: 1
page:
  size: [40mm, 40mm]
  bleed: 0
  baseFrame: trim
  color: color
${pageFinish ? `  finish: ${pageFinish}\n` : ""}assets:
  art:
    src: art.png
    filters: [invert]
${assetFinish ? `    finish: ${assetFinish}\n` : ""}pages:
  - number: false
${localFinish ? `    finish: ${localFinish}\n` : ""}    panels:
      - border: { style: none }
        layers:
          - type: image
            src: art
            size: [40mm, 40mm]
            fit: fill
            filters: [grayscale]
${elementFinish ? `            finish: ${elementFinish}\n` : ""}`;
}

function images(node: Node, out: Extract<Node, { kind: "image" }>[] = []) {
  if (node.kind === "image") out.push(node);
  if (node.kind === "group") for (const c of node.children) images(c, out);
  return out;
}

async function filterNames(pageFinish = "", assetFinish = "", elementFinish = "", localFinish = "") {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#888888" } }).png().toBuffer();
  const r = await render({ yaml: doc(pageFinish, assetFinish, elementFinish, localFinish) }, { profile: "preview", layoutOnly: true, keepLists: true, assets: { art: png } });
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return images(r.lists![0].root)[0].filters;
}

describe("finish sugar", () => {
  const obj = (lpi: number) => `{ style: manga, lpi: ${lpi}, tones: [0.2, 0.3, 0.4] }`;

  it("uses page settings and appends manga after asset and element filters", async () => {
    const filters = await filterNames("manga");
    expect(filters.map((f) => f.name)).toEqual(["invert", "grayscale", "manga"]);
  });

  it("accepts finish on an individual page", async () => {
    expect((await filterNames("", "", "", "manga")).map((f) => f.name)).toContain("manga");
  });

  it("resolves precedence as element > asset > page, with none disabling it", async () => {
    expect((await filterNames("manga", "none")).some((f) => f.name === "manga")).toBe(false);
    expect((await filterNames("manga", "manga", "none")).some((f) => f.name === "manga")).toBe(false);
    const asset = await filterNames("none", obj(62));
    expect(asset.find((f) => f.name === "manga")?.opts?.lpi).toBe(62);
    const element = await filterNames("none", "none", obj(63));
    expect(element.find((f) => f.name === "manga")?.opts?.lpi).toBe(63);
  });
});
