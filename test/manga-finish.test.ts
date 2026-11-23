import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";
import { applyFilters, mangaOutputFilters, mangaTempScale, parseFilter } from "../src/render/filters.js";
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

  it("tones a whole accepted beta shape rather than only its deep core", async () => {
    const out = await applyFilters(sourcePixels(), [mangaFilter], 0.05);
    // betaMinSize is 20 px here and the black rectangle starts at x=5. With only
    // the opened deep core toned, x=12–13 is still solid black; whole-shape
    // replacement leaves only the thinner ink rim black and uses tone there.
    let paper = false;
    for (let y = 30; y <= 50; y++) for (const x of [12, 13]) if (out.data[(y * out.width + x) * 4] === 255) paper = true;
    expect(paper).toBe(true);
  });

  it("keeps large beta solid black inside keepBeta regions and rects", async () => {
    const context = { sourceRect: { x: 0, y: 0, w: 120, h: 80 }, regions: { hair: [5, 10, 35, 60] as [number, number, number, number] } };
    for (const keepBeta of [["hair"], [[5, 10, 35, 60]]]) {
      const out = await applyFilters(sourcePixels(), [{ ...mangaFilter, opts: { ...mangaOpts, keepBeta } }], 0.05, context);
      for (let y = 20; y <= 50; y++) for (let x = 10; x <= 30; x++) expect(out.data[(y * out.width + x) * 4]).toBe(0);
    }
  });

  it("lowers the effective lpi instead of producing unresolvable dots at low output resolution", () => {
    const filter: ImageFilter = { name: "manga", args: [], opts: { lpi: 60 } };
    const adapted = mangaOutputFilters([filter], 25.4 / 96);
    expect(adapted[0]).not.toBe(filter);
    expect(adapted[0].opts?.lpi).toBeCloseTo((25.4 / (25.4 / 96)) / 4, 6);
    expect(filter.opts?.lpi).toBe(60);
    expect(mangaOutputFilters([filter], 0.01)[0]).toBe(filter);
    expect(mangaOutputFilters([filter], 25.4 / 360)[0]).toBe(filter);
    const outputMm = 25.4 / 600;
    const output = mangaOutputFilters([{ ...filter, opts: { lpi: 150 } }], outputMm);
    expect(output[0].opts?.lpi).toBe(150);
    const constrained = mangaOutputFilters(output, outputMm / 0.5);
    expect(constrained[0].opts?.lpi).toBeCloseTo(150 / 2, 6);
  });

  it("caps the temporary manga image within the shared pixel budget", () => {
    expect(mangaTempScale(1000, 1000, 2, 200_000_000)).toBe(2);
    const scale = mangaTempScale(1000, 1000, 10, 200_000_000);
    expect(scale).toBeCloseTo(2.5, 6);
    expect(1000 * 1000 * scale * scale).toBeLessThanOrEqual(6_250_000);
    expect(mangaTempScale(1000, 1000, 100, Number.MAX_SAFE_INTEGER)).toBeCloseTo(4, 6);
  });

  it("classifies beta by thickness rather than image-edge contact", async () => {
    const opts = { betaMinSize: 1, tones: [0.2], lpi: 30, seed: 9 };
    const filter: ImageFilter = { name: "manga", args: [], opts };
    const interior = await applyFilters(sourcePixels(), [filter], 0.05);
    let paper = false;
    for (let y = 30; y <= 50; y++) for (let x = 15; x <= 30; x++) if (interior.data[(y * interior.width + x) * 4] === 255) paper = true;
    expect(paper).toBe(true);

    const edged = sourcePixels();
    for (let y = 0; y <= 9; y++) for (let x = 5; x <= 39; x++) {
      const i = (y * edged.width + x) * 4;
      edged.data[i] = edged.data[i + 1] = edged.data[i + 2] = 0;
    }
    const touching = await applyFilters(edged, [filter], 0.05);
    paper = false;
    for (let y = 30; y <= 50; y++) for (let x = 15; x <= 30; x++) if (touching.data[(y * touching.width + x) * 4] === 255) paper = true;
    expect(paper).toBe(true);
  });

  it("keeps thin-connected hair-like black masses solid", async () => {
    const px = sourcePixels();
    for (let i = 0; i < px.data.length; i += 4) px.data[i] = px.data[i + 1] = px.data[i + 2] = 255;
    const black = (x: number, y: number) => {
      const j = (y * px.width + x) * 4;
      px.data[j] = px.data[j + 1] = px.data[j + 2] = 0;
    };
    for (let y = 0; y < 4; y++) for (let x = 20; x < 100; x++) black(x, y);
    for (const cx of [22, 38, 54, 70, 86]) for (let y = 4; y < 34; y++) for (let dx = -1; dx <= 1; dx++) black(cx + dx, y);
    const out = await applyFilters(px, [{ name: "manga", args: [], opts: { betaMinSize: 1, tones: [0.2], lpi: 30, seed: 9 } }], 0.05);
    for (const cx of [22, 38, 54, 70, 86]) for (const y of [2, 12, 24]) expect(out.data[(y * out.width + cx) * 4]).toBe(0);
  });

  it("keeps thin strokes attached to a toned beta mass fully black", async () => {
    const px = sourcePixels();
    for (let y = 30; y <= 32; y++) for (let x = 40; x < 90; x++) {
      const i = (y * px.width + x) * 4;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = 0;
    }
    const out = await applyFilters(px, [{ name: "manga", args: [], opts: { betaMinSize: 1, tones: [0.2], lpi: 30, seed: 9 } }], 0.05);
    for (let x = 45; x < 88; x++) expect(out.data[(31 * out.width + x) * 4]).toBe(0);
  });

  it("keeps a smooth dark-to-light ramp out of solid black", async () => {
    const width = 180;
    const height = 60;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = Math.round((x / (width - 1)) * 255);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    const out = await applyFilters({ data, width, height }, [{ name: "manga", args: [], opts: { betaMinSize: 10, lpi: 30, seed: 9 } }], 0.05);
    const blackFraction = (x0: number, x1: number) => {
      let black = 0;
      let count = 0;
      for (let y = 10; y < 50; y++) for (let x = x0; x <= x1; x++) {
        if (out.data[(y * width + x) * 4] === 0) black++;
        count++;
      }
      return black / count;
    };
    expect(blackFraction(7, 12)).toBeGreaterThan(0.95);
    const ramp = blackFraction(42, 48);
    expect(ramp).toBeGreaterThan(0.4);
    expect(ramp).toBeLessThan(0.9);
  });

  it("keeps light paper and skin-tone shading free of dots by default", async () => {
    const width = 20;
    const height = 20;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 224;
      data[i * 4 + 3] = 255;
    }
    const out = await applyFilters({ data, width, height }, [{ name: "manga", args: [] }], 0.05);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });

  it.each([225, 252])("clears light-grey highlights against a bright field of %i without lifting midtones", async (field) => {
    const px = sourcePixels();
    const shades = [field, 208, 128, 0];
    for (let i = 0; i < px.data.length; i += 4) {
      const x = (i / 4) % px.width;
      const shade = shades[x < 60 ? 0 : x < 85 ? 1 : x < 110 ? 2 : 3];
      px.data[i] = px.data[i + 1] = px.data[i + 2] = shade;
    }
    const filter: ImageFilter = { name: "manga", args: [], opts: { lpi: 60 } };
    const auto = await applyFilters(px, [filter], 0.08);
    const fixed = await applyFilters(px, [{ ...filter, opts: { ...filter.opts, paper: 0.15 } }], 0.08);
    const shadesAt = (out: typeof auto, start: number, end: number) => new Set(Array.from({ length: (end - start) * 60 }, (_, i) => {
      const x = start + i % (end - start);
      const y = 10 + Math.floor(i / (end - start));
      return out.data[(y * out.width + x) * 4];
    }));
    expect(shadesAt(auto, 64, 81)).toEqual(new Set([255]));
    expect(shadesAt(fixed, 64, 81)).toEqual(new Set([0, 255]));
    expect(shadesAt(auto, 90, 105)).toEqual(new Set([0, 255]));
    expect(shadesAt(auto, 114, 118)).toEqual(new Set([0]));
  });

  it("keeps a dark image's white cutoff when it only has a small highlight", async () => {
    const px = sourcePixels();
    for (let i = 0; i < px.data.length; i += 4) {
      const x = (i / 4) % px.width;
      const shade = x < 90 ? 100 : x < 110 ? 208 : 255;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = shade;
    }
    const f: ImageFilter = { name: "manga", args: [], opts: { lpi: 60 } };
    const auto = await applyFilters(px, [f], 0.08);
    const fixed = await applyFilters(px, [{ ...f, opts: { ...f.opts, paper: 0.15 } }], 0.08);
    expect(auto.data).toEqual(fixed.data);
  });

  it("screens a soft background edge without an ink rim but keeps a hard edge inked", async () => {
    const px = sourcePixels();
    for (let i = 0; i < px.data.length; i += 4) {
      const x = (i / 4) % px.width;
      const y = Math.floor(i / 4 / px.width);
      const shade = x < 65 ? Math.min(255, Math.max(0, (y - 20) * 12)) : y < 27 ? 0 : 255;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = shade;
    }
    const out = await applyFilters(px, [{ name: "manga", args: [], opts: { lpi: 60 } }], 0.08);
    const row = (y: number, start: number, end: number) => [...out.data.slice((y * out.width + start) * 4, (y * out.width + end) * 4)].filter((_, i) => i % 4 === 0);
    expect(new Set(row(26, 5, 55))).toEqual(new Set([0, 255]));
    expect(new Set(row(26, 75, 115))).toEqual(new Set([0]));
    expect(new Set(row(65, 5, 115))).toEqual(new Set([255]));
  });

  it("preserves the full quarter-millimetre rim of a hard black-to-white background edge", async () => {
    const px = sourcePixels();
    for (let i = 0; i < px.data.length; i += 4) {
      const shade = i < px.width * 40 * 4 ? 0 : 255;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = shade;
    }
    const out = await applyFilters(px, [{ name: "manga", args: [], opts: { lpi: 60 } }], 0.05);
    const rimStart = 35 * px.width;
    const rimEnd = 40 * px.width;
    const ink = out.data.filter((_, i) => i % 4 === 0);
    expect(ink.slice(rimStart, rimEnd).every((v) => v === 0)).toBe(true);
    expect(ink.slice(30 * px.width, rimStart)).toContain(255);
    expect(ink.slice(rimEnd).every((v) => v === 255)).toBe(true);
  });

  it("makes non-zero grain visibly roughen existing ink edges", async () => {
    const base = { ...mangaOpts, cut: 0, grain: 0 };
    const zero = await applyFilters(sourcePixels(), [{ ...mangaFilter, opts: base }], 0.05);
    const rough = await applyFilters(sourcePixels(), [{ ...mangaFilter, opts: { ...base, grain: 1 } }], 0.05);
    let changed = 0;
    for (let i = 0; i < zero.data.length; i += 4) if (zero.data[i] !== rough.data[i]) changed++;
    expect(changed).toBeGreaterThan(0);
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
