import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/api.js";

const input = (spread = false) => ({ yaml: `mangacli: 1
page: { size: B5, color: mono }
pages:
  - id: probe
    type: ${spread ? "spread" : "page"}
    panels: []
` });
const svgText = (data: Uint8Array) => Buffer.from(data).toString("utf8");

describe("SVG print output", () => {
  it("uses the marks canvas and shared corner and center marks on an empty page", async () => {
    const r = await render(input(), { profile: "print-mono", crop: "marks", format: ["png", "svg"], dpi: 25.4 });
    const svg = svgText(r.pages.find((p) => p.format === "svg")!.data);
    expect(svg).toContain('width="208mm" height="283mm" viewBox="-10 -10 208 283"');
    expect(svg).toContain('clip-path="url(#artwork-bleed)"');
    const marks = svg.split('data-type="crop-marks"')[1];
    expect(marks.match(/<path /g)).toHaveLength(24);
    expect(marks).toContain('d="M0 3L-9 3"');
    expect(marks).toContain('d="M94 0L94 -9"');
    const png = r.pages.find((p) => p.format === "png")!;
    expect([png.width, png.height]).toEqual([208, 283]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "SVG_MONO_APPROXIMATION", severity: "warning", message: expect.stringContaining("PNG/PDF") }));
  });

  it.each(["marks", "bleed", "trim"] as const)("splits spread files with %s, also for SVG-only output", async (crop) => {
    const outDir = mkdtempSync(join(tmpdir(), "mangacli-svg-"));
    try {
      const r = await render(input(true), { profile: "print-mono", crop, format: ["png", "svg"], dpi: 25.4, outDir });
      const files = readdirSync(outDir);
      expect(files.filter((f) => f.endsWith(".svg"))).toHaveLength(2);
      expect(files.filter((f) => f.endsWith(".png"))).toHaveLength(2);
      const svgs = r.pages.filter((p) => p.format === "svg");
      const width = crop === "marks" ? 208 : crop === "bleed" ? 188 : 182;
      const height = crop === "marks" ? 283 : crop === "bleed" ? 263 : 257;
      for (const svg of svgs) {
        expect(svgText(svg.data)).toContain(`width="${width}mm" height="${height}mm"`);
        const png = r.pages.find((p) => p.format === "png" && p.side === svg.side)!;
        expect([svg.width, svg.height]).toEqual([png.width, png.height]);
        const x = svg.side === "left" ? (crop === "marks" ? -10 : crop === "trim" ? 3 : 0) : crop === "marks" ? 172 : crop === "trim" ? 185 : 182;
        expect(svgText(svg.data)).toContain(`viewBox="${x} ${crop === "marks" ? -10 : crop === "trim" ? 3 : 0} ${width} ${height}"`);
      }
      const only = await render(input(true), { profile: "print-mono", crop, format: "svg", dpi: 25.4 });
      expect(only.pages.map((p) => [p.side, svgText(p.data)])).toEqual(svgs.map((p) => [p.side, svgText(p.data)]));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("does not warn for gray SVG or mono raster output", async () => {
    for (const options of [{ profile: "print-gray", format: "svg" }, { profile: "print-mono", format: "png" }] as const) {
      const r = await render(input(), { ...options, dpi: 25.4 });
      expect(r.diagnostics.some((d) => d.code === "SVG_MONO_APPROXIMATION")).toBe(false);
    }
  });

  it("allows the SVG warning to be promoted to an error", async () => {
    const r = await render(input(), { profile: "print-mono", format: "svg", diagnostics: { SVG_MONO_APPROXIMATION: "error" }, throwOnError: false });
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "SVG_MONO_APPROXIMATION", severity: "error" }));
    expect(r.pages).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it.each([1, 2])("rejects a %i-page error override before writing files", async (count) => {
    const outDir = mkdtempSync(join(tmpdir(), "mangacli-svg-error-"));
    try {
      const doc = input();
      if (count === 2) doc.yaml += "  - { id: second, panels: [] }\n";
      await expect(render(doc, {
        profile: "print-mono",
        format: ["png", "svg"],
        dpi: 25.4,
        outDir,
        diagnostics: { SVG_MONO_APPROXIMATION: "error" },
      })).rejects.toMatchObject({ code: "SVG_MONO_APPROXIMATION" });
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("still writes a later valid page after a pixel-limit failure", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "mangacli-svg-recovery-"));
    try {
      const r = await render({ yaml: `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0 }
pages:
  - { id: too-large, panels: [] }
  - { id: valid, size: [10mm, 10mm], panels: [] }
` }, {
        profile: "print-mono",
        format: ["png", "svg"],
        crop: "trim",
        dpi: 25.4,
        limits: { maxOutputPixels: 500 },
        throwOnError: false,
        failFast: false,
        outDir,
      });
      expect(r.failures.map((f) => f.pageId)).toEqual(["too-large"]);
      expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "OUTPUT_TOO_LARGE", severity: "error" }));
      expect(r.pages.map((p) => [p.id, p.format])).toEqual([["valid", "png"], ["valid", "svg"]]);
      expect(readdirSync(outDir)).toHaveLength(2);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
