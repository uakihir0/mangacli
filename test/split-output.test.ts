import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";
import type { DocumentInput } from "../src/schema/schema.js";
import { RasterBackend } from "../src/render/raster.js";

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
    let direct;
    try {
      direct = await render(doc, opts);
      expect(calls.mock.calls).toHaveLength(2);
      expect(calls.mock.calls.every(([, viewport]) => viewport !== undefined)).toBe(true);
    } finally {
      calls.mockRestore();
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
    const r = await render(document("right"), { profile: "print-mono", dpi: 100, crop: "trim", spread: "split", format: "png", limits: { maxOutputPixels: 3000 } });
    expect(r.pages).toHaveLength(2);
    expect(r.pages.every((p) => p.width * p.height <= 3000)).toBe(true);
  });

  it("preflights every selected page before writing or cleaning", async () => {
    const doc = document("left");
    doc.pages.unshift({ id: "small", type: "blank", size: ["1mm", "1mm"] });
    const dir = mkdtempSync(join(tmpdir(), "mc-preflight-"));
    const phases: string[] = [];
    const r = await render(doc, { profile: "print-mono", dpi: 100, crop: "trim", spread: "split", format: "png", outDir: dir, limits: { maxOutputPixels: 100 }, throwOnError: false, onProgress: (p) => phases.push(p.phase) });
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
});
