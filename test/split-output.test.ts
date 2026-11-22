import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";
import type { DocumentInput } from "../src/schema/schema.js";
import { RasterBackend } from "../src/render/raster.js";
import { monoWorkingBytes } from "../src/render/mono.js";

const document = (binding: "left" | "right"): DocumentInput => ({
  mangacli: 1,
  page: { size: ["12mm", "15mm"], bleed: "1mm" },
  book: { binding },
  pages: [{ id: "spread", type: "spread", panels: [{ bleed: "all", background: { tone: { density: "35%", lpi: 60, angle: "45deg" } } }] }],
});

describe("split output limits and viewports", () => {
  it.each(["screen", "dither"] as const)("preserves %s images and filters across the fold", async (images) => {
    const raw = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 17) % 256;
    const art = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    const doc = { yaml: `mangacli: 1
page: { size: [12mm, 15mm], bleed: 1mm }
output: { mono: { images: ${images} } }
pages:
  - type: spread
    layers:
      - { image: art, size: [24mm, 15mm], at: [0mm, 0mm], anchor: top-left, fit: fill, filters: [invert], shadow: { offset: [1mm, 1mm] } }
` };
    const opts = { profile: "print-mono", dpi: 100, crop: "trim", spread: "split", format: "png", assets: { art } } as const;
    const calls = vi.spyOn(RasterBackend.prototype, "render");
    const renderMono = RasterBackend.prototype.renderMono;
    const bands = vi.spyOn(RasterBackend.prototype, "renderMono").mockImplementation(function (this: RasterBackend, list, viewport) {
      return renderMono.call(this, list, viewport, viewport.width * 7);
    });
    let direct;
    try {
      direct = await render(doc, opts);
      expect(calls.mock.calls.length).toBeGreaterThan(2);
      expect(calls.mock.calls.every(([, viewport]) => viewport !== undefined)).toBe(true);
    } finally {
      calls.mockRestore();
      bands.mockRestore();
    }
    const sliced = await render(doc, { ...opts, plugins: [{ name: "reference", hooks: { afterRender: (r) => r } }] });
    for (const [i, page] of direct.pages.entries()) {
      const actual = await sharp(page.data).greyscale().raw().toBuffer();
      const expected = await sharp(sliced.pages[i].data).greyscale().raw().toBuffer();
      const diffs = [...actual.keys()].filter((j) => actual[j] !== expected[j]);
      expect(diffs.length, `${page.side}: ${diffs.slice(0, 8).map((j) => `${j % page.width},${Math.floor(j / page.width)}`).join("; ")}`).toBe(0);
      expect(Buffer.from(page.data).equals(Buffer.from(sliced.pages[i].data))).toBe(true);
    }
  });
  it("preserves curved glyph rasterization across a full-size fold", async () => {
    const doc = { yaml: `mangacli: 1
page: { size: B5, bleed: 3mm }
book: { binding: right }
pages:
  - type: spread
    layers:
      - { sfx: CRASH, fontSize: 12mm, writing: horizontal, at: [185mm, 90mm], anchor: center }
      - { text: CRASH, fontSize: 12mm, writing: horizontal, at: [185mm, 130mm], anchor: center }
` };
    const options = { profile: "print-mono", dpi: 600, crop: "bleed", spread: "split", format: "png" } as const;
    const direct = await render(doc, options);
    const sliced = await render(doc, { ...options, plugins: [{ name: "joined-reference", hooks: { afterRender: (r) => r } }] });
    expect(direct.pages.map((p) => p.data)).toEqual(sliced.pages.map((p) => p.data));
  });
  for (const profile of ["print-mono", "print-gray"])
  for (const binding of ["left", "right"] as const)
    for (const crop of ["trim", "bleed", "marks"] as const)
      it(`matches joined + slice: ${profile}, ${binding}, ${crop}`, async () => {
        const formats = profile === "print-mono" ? ["png", "tiff", "pdf", "svg"] as const : ["png", "jpeg", "webp", "avif", "tiff", "pdf", "svg"] as const;
        const options = { profile, dpi: 600, crop, spread: "split", format: formats, finish: false } as const;
        const direct = await render(document(binding), { ...options, format: [...options.format] });
        const sliced = await render(document(binding), { ...options, format: [...options.format], plugins: [{ name: "joined-reference", hooks: { afterRender: (r) => r } }] });
        expect(direct.pages.map(({ side, width, height }) => ({ side, width, height }))).toEqual(sliced.pages.map(({ side, width, height }) => ({ side, width, height })));
        expect(direct.pages.map((p) => p.data)).toEqual(sliced.pages.map((p) => p.data));
      });

  it("tiles large pointwise tones without shifting the logical screen", async () => {
    const doc = document("right");
    doc.page = { size: ["120mm", "150mm"], bleed: "1mm" };
    const options = { profile: "print-mono", dpi: 254, crop: "bleed", spread: "split", format: "png" } as const;
    const direct = await render(doc, options);
    const sliced = await render(doc, { ...options, plugins: [{ name: "joined-reference", hooks: { afterRender: (r) => r } }] });
    expect(direct.pages.map((p) => p.data)).toEqual(sliced.pages.map((p) => p.data));
  });

  it("allows sides that fit when the joined raster does not", async () => {
    const r = await render(document("right"), { profile: "print-gray", dpi: 100, crop: "trim", spread: "split", format: "png", limits: { maxOutputPixels: 3000 } });
    expect(r.pages).toHaveLength(2);
    expect(r.pages.every((p) => p.width * p.height <= 3000)).toBe(true);
  });

  it("preflights every selected page before writing or cleaning", async () => {
    const doc = document("left");
    doc.pages.unshift({ id: "small", type: "blank", size: ["1mm", "1mm"] });
    const dir = mkdtempSync(join(tmpdir(), "mc-preflight-"));
    const phases: string[] = [];
    const r = await render(doc, { profile: "print-gray", dpi: 100, crop: "trim", spread: "split", format: "png", outDir: dir, limits: { maxOutputPixels: 100 }, throwOnError: false, onProgress: (p) => phases.push(p.phase) });
    expect(readdirSync(dir)).toEqual([]);
    expect(phases).not.toContain("layout");
    expect(r.diagnostics.find((d) => d.code === "OUTPUT_TOO_LARGE")?.message).toMatch(/spread\/left: \d+x\d+.*maxOutputPixels \(100\).*highest whole dpi that fits: \d+.*--max-output-pixels/);
  });

  it("does not reject an unselected oversized page", async () => {
    const doc = document("left");
    doc.pages.unshift({ id: "small", type: "blank", size: ["1mm", "1mm"] });
    const r = await render(doc, { profile: "print-mono", dpi: 100, crop: "trim", pages: "small", format: "png", limits: { maxOutputPixels: 100 } });
    expect(r.pages).toHaveLength(1);
  });
  it("budgets packed mono by bytes rather than pixels and preflights all pages", async () => {
    const doc = document("right");
    const opts = { profile: "print-mono", dpi: 100, crop: "trim", spread: "split", format: "png", limits: { maxOutputPixels: 1 } } as const;
    expect((await render(doc, opts)).pages).toHaveLength(2);
    const dir = mkdtempSync(join(tmpdir(), "mc-mono-budget-"));
    const calls = vi.spyOn(RasterBackend.prototype, "render");
    try {
      const failed = await render(doc, { ...opts, outDir: dir, limits: { maxOutputBytes: 100 }, throwOnError: false });
      expect(failed.diagnostics.some((d) => d.code === "OUTPUT_TOO_LARGE" && d.message.includes("--max-output-bytes"))).toBe(true);
      expect(calls).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual([]);
    } finally { calls.mockRestore(); }
    const empty = await render({ mangacli: 1, pages: [{ type: "blank" }] }, { profile: "print-mono", dpi: 25, format: "png" });
    expect(empty.pages).toHaveLength(1);
    expect(monoWorkingBytes(12426 + 946, 17481 + 946)).toBeLessThan(384 * 1024 * 1024);
    const absurd = await render({ mangacli: 1, page: { size: "A3" }, pages: [{ type: "spread" }] }, { profile: "print-mono", dpi: 2400, spread: "joined", format: "pdf", throwOnError: false });
    expect(absurd.diagnostics.some((d) => d.code === "OUTPUT_TOO_LARGE" && d.message.includes("maxOutputBytes"))).toBe(true);
  });
  it("allows full-spread image buffers in print and respects explicit and default limits", async () => {
    const art = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    const doc = { yaml: `mangacli: 1
page: { size: [180mm, 270mm], bleed: 0 }
pages:
  - id: spread
    type: spread
    layers:
      - { image: art, size: [360mm, 270mm], at: [0mm, 0mm], anchor: top-left, fit: fill, filters: [invert] }
` };
    const opts = { profile: "print-mono", crop: "trim", format: "png", assets: { art }, throwOnError: false } as const;
    const raster = vi.spyOn(RasterBackend.prototype, "renderMono").mockImplementation(async (_, { width, height }) => ({
      width, height, data: new Uint8ClampedArray(0), packed: new Uint8Array(Math.ceil(width / 8) * height),
    }));
    try {
      const config = { limits: { maxOutputBytes: 384 * 1024 * 1024 } };
      const overridden = await render(doc, { ...opts, config });
      expect(overridden.diagnostics).toContainEqual(expect.objectContaining({
        code: "OUTPUT_TOO_LARGE", message: expect.stringMatching(/including node buffers.*\(402653184\).*--max-output-bytes/),
      }));
      const overCap = await render(doc, { ...opts, dpi: 720 });
      expect(overCap.diagnostics).toContainEqual(expect.objectContaining({
        code: "OUTPUT_TOO_LARGE", message: expect.stringMatching(/including node buffers.*\(4294967296\).*--max-output-bytes/),
      }));
      expect(raster).not.toHaveBeenCalled();
      const normal = await render(doc, opts);
      expect(normal.failures).toEqual([]);
      expect(normal.pages).toHaveLength(2);
    } finally { raster.mockRestore(); }
  });
  it("allows a full-page image at the print-mono default dpi without raising non-print or explicit limits", async () => {
    const art = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    const doc = { yaml: `mangacli: 1
page: { size: A4 }
pages:
  - id: ordinary
    layers:
      - { image: art, size: [210mm, 297mm], at: [0mm, 0mm], anchor: top-left, fit: fill, filters: [invert] }
` };
    const opts = { profile: "print-mono", assets: { art }, throwOnError: false } as const;
    const raster = vi.spyOn(RasterBackend.prototype, "renderMono").mockImplementation(async (_, { width, height }) => ({
      width, height, data: new Uint8ClampedArray(0), packed: new Uint8Array(Math.ceil(width / 8) * height),
    }));
    try {
      const diagnostic = expect.objectContaining({
        code: "OUTPUT_TOO_LARGE", message: expect.stringMatching(/including node buffers.*\(402653184\).*--max-output-bytes/),
      });
      const explicit = await render(doc, { ...opts, limits: { maxOutputBytes: 384 * 1024 * 1024 } });
      expect(explicit.diagnostics).toContainEqual(diagnostic);
      const web = await render(doc, { ...opts, profile: "web", colorMode: "mono", dpi: 600 });
      expect(web.diagnostics).toContainEqual(diagnostic);
      expect(raster).not.toHaveBeenCalled();
      const normal = await render(doc, opts);
      expect(normal.failures).toEqual([]);
      expect(normal.pages).toHaveLength(1);
      expect(normal.pages[0].dpi).toBe(600);
    } finally { raster.mockRestore(); }
  });
  it("includes image working buffers in the mono preflight", async () => {
    const art = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    const doc = { yaml: `mangacli: 1
page: { size: [12mm, 15mm], bleed: 0 }
pages:
  - type: spread
    layers:
      - { image: art, size: [24mm, 15mm], at: [0mm, 0mm], anchor: top-left, filters: [invert] }
` };
    const calls = vi.spyOn(RasterBackend.prototype, "render");
    try {
      const r = await render(doc, { profile: "print-mono", dpi: 100, format: "png", assets: { art }, limits: { maxOutputBytes: monoWorkingBytes(47, 59) + 1000 }, throwOnError: false });
      expect(r.diagnostics.some((d) => d.message.includes("including node buffers"))).toBe(true);
      expect(calls).not.toHaveBeenCalled();
      expect(r.files).toEqual([]);
    } finally { calls.mockRestore(); }
  });
  it.each(["trim", "bleed", "marks"] as const)("tiny bands preserve tones, glyphs and marks: %s", async (crop) => {
    const doc = document("right");
    doc.pages[0].layers = [{ text: "CURVE", fontSize: "3mm", writing: "horizontal", at: ["12mm", "7mm"], anchor: "center" }];
    const opts = { profile: "print-mono", dpi: 100, crop, spread: "split", format: ["png", "tiff", "pdf"] } as const;
    const original = RasterBackend.prototype.renderMono;
    const bands = vi.spyOn(RasterBackend.prototype, "renderMono").mockImplementation(function (this: RasterBackend, list, viewport) {
      return original.call(this, list, viewport, viewport.width * 5);
    });
    let banded;
    try { banded = await render(doc, { ...opts, format: [...opts.format] }); }
    finally { bands.mockRestore(); }
    const single = await render(doc, { ...opts, format: [...opts.format], plugins: [{ name: "single", hooks: { afterRender: (r) => r } }] });
    expect(banded.pages.map((p) => p.data)).toEqual(single.pages.map((p) => p.data));
  });
});
