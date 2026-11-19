import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { AssetRegistry } from "../src/render/assets.js";
import type { DisplayList, PathNode } from "../src/render/ir.js";
import { RasterBackend } from "../src/render/raster.js";

const renderer = createRenderer({ profile: "print-mono" });
const input = (width: number) => ({ yaml: `mangacli: 1
page: { size: [25.4mm, 25.4mm], bleed: 0mm }
pages:
  - id: test
    layers:
      - { draw: line, id: hairline, points: [[2mm, 5mm], [22mm, 5mm]], ruler: true, stroke: { width: ${width}mm, pen: { minWidth: 0.01mm } } }
` });

function setup(width: number, dx: number, dy: number, slope: number) {
  const bag = new DiagnosticBag();
  const s = 600 / 25.4;
  const path: PathNode["path"] = [["M", (5 + dx) / s, (5 + dy) / s], ["L", (45 + dx) / s, (5 + dy + 40 * slope) / s]];
  const node: PathNode = { kind: "path", path, fillRule: "nonzero", paint: null, stroke: { width, join: "round", paint: { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } } } };
  const box = { x: 0, y: 0, w: 50 / s, h: 50 / s };
  const list: DisplayList = { version: 1, page: { id: "test", index: 0 }, size: { width: box.w, height: box.h }, boxes: { trim: box, bleed: box, baseFrame: box, safe: box }, background: null, root: { kind: "group", children: [node] } };
  const backend = new RasterBackend({ dpi: 600, crop: "trim", colorMode: "mono", toneRendering: "dots", monoLpi: 60, toneCurve: "linear", diagnostics: bag, assets: new AssetRegistry({}, {}, bag, 600, "error") });
  return { backend, list, node, bag };
}

describe("mono hairline protection", () => {
  it("bounds warnings across varying strokes and leaves room for errors", async () => {
    const { backend, list, node, bag } = setup(0.015, 0, 0, 0);
    node.paint = node.stroke!.paint;
    delete node.stroke;
    node.inkStrokes = Array.from({ length: 250 }, (_, i) => ({ path: node.path, width: 0.01 + i / 10000 }));
    node.tag = { elementId: "effect", elementType: "effect", role: "ink", separation: "ink" };
    await backend.render(list);
    expect(bag.items).toHaveLength(1);
    list.root.children = Array.from({ length: 250 }, (_, i) => ({ ...node, tag: { ...node.tag!, elementId: `effect-${i}` } }));
    await backend.render(list);
    expect(bag.items.length).toBeLessThanOrEqual(21);
    bag.error("ASSET_NOT_FOUND", "later missing asset");
    expect(bag.items.at(-1)?.severity).toBe("error");
  });
  it("warns for a 0.015mm user pen at 600 dpi, not for 0.10mm", async () => {
    for (const width of [0.015, 0.10]) {
      const result = await renderer.render(input(width), { format: "png", dpi: 600 });
      const warnings = result.diagnostics.filter((d) => d.code === "RENDER_HAIRLINE_THICKENED" && d.elementId === "hairline");
      expect(warnings).toHaveLength(width === 0.015 ? 1 : 0);
      if (width === 0.015) {
        expect(warnings[0]).toMatchObject({ severity: "warning", elementId: "hairline" });
        expect(warnings[0].message).toMatch(/hairline: requested 0.0150mm at 600 dpi; line thickened/);
        const { data, info } = await sharp(result.pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let x = 80; x < 480; x++) {
          let black = false;
          for (let y = 112; y < 125; y++) if (data[(y * info.width + x) * info.channels] === 0) black = true;
          expect(black, `user line column ${x}`).toBe(true);
        }
      }
    }
  });

  it("keeps axis-aligned and diagonal strokes continuous across subpixel phases", async () => {
    for (const transpose of [false, true]) for (const slope of [0, 0.125, 0.25, 0.5, 0.75, 1]) {
      for (let px = 0; px < 16; px++) for (let py = 0; py < 16; py++) {
        const { backend, list, node } = setup(0.015, px / 16, py / 16, slope);
        if (transpose) node.path = node.path.map((p) => [p[0], p[2], p[1]]) as PathNode["path"];
        // Exercise both native strokes and the centerlines of filled ink outlines.
        if (px % 2) {
          node.paint = node.stroke!.paint;
          node.inkStrokes = [{ path: node.path, width: 0.015 }];
          delete node.stroke;
        }
        const result = await backend.render(list);
        for (let x = 6; x < 45; x++) {
          let black = false;
          for (let y = 0; y < 50; y++) if (result.data[(transpose ? x * 50 + y : y * 50 + x) * 4] === 0) black = true;
          expect(black, `slope=${slope}, phase=${px}/16,${py}/16, x=${x}`).toBe(true);
        }
      }
    }
  });

  it("leaves sufficiently wide ink byte-identical and does not warn on empty output", async () => {
    const { backend, list, node, bag } = setup(0.10, 0.3, 0.7, 0.5);
    const original = await backend.render(list);
    node.inkStrokes = [{ path: node.path, width: 0.10 }];
    expect((await backend.render(list)).data).toEqual(original.data);
    list.root.children = [];
    expect((await backend.render(list)).data.every((v) => v === 255)).toBe(true);
    expect(bag.items).toEqual([]);
  });

  it.each(["gray", "color"] as const)("does not thicken or warn in %s output", async (colorMode) => {
    const result = await renderer.render(input(0.015), { format: "png", dpi: 600, colorMode });
    expect(result.diagnostics.some((d) => d.code === "RENDER_HAIRLINE_THICKENED")).toBe(false);
  });
});
