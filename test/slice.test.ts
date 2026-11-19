import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type RenderOptions, createRenderer, render, validate } from "../src/api.js";
import type { Node } from "../src/render/ir.js";

function scene(layers: string, panel = "box: [5mm, 5mm, 28mm, 22mm]\n        background: black") {
  return {
    yaml: `mangacli: 1
book: { pageNumbers: { enabled: false } }
page: { size: [40mm, 40mm], bleed: 0, baseFrame: trim, background: black, safeArea: { inset: 0 } }
pages:
  - panels:
      - id: p1-art
        ${panel}
        layers:
${layers.split("\n").map((s) => "          " + s).join("\n")}
`,
  };
}

async function pixels(input: ReturnType<typeof scene>, options: RenderOptions) {
  const { pages, diagnostics } = await render(input, options);
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const image = sharp(pages[0].data);
  const { data, info } = await image.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / 40;
  return {
    image, data,
    at: (x: number, y: number) => data[(Math.floor(y * scale) * info.width + Math.floor(x * scale)) * info.channels],
  };
}

describe("slice", () => {
  it("moves a panel and its contents into three pieces with continuous 1-bit white cuts", async () => {
    const input = scene(`- { draw: line, points: [[15mm, 0], [15mm, 100%]], stroke: { color: white, width: 0.55mm }, ruler: true }
- id: slashes
  effect: slice
  width: 0.8mm
  cuts:
    - { from: [0, 5mm], to: [28mm, 12mm], shift: 4.123105626mm }
    - { from: [0, 11mm], to: [28mm, 18mm], shift: 4.123105626mm }`);
    const { image, data, at } = await pixels(input, { profile: "print-mono", format: "tiff" });
    expect((await image.metadata()).bitsPerSample).toBe(1);
    expect(new Set(data)).toEqual(new Set([0, 255]));
    // The vertical stroke follows the original, once-shifted and twice-shifted pieces.
    for (const [x, y] of [[20, 9], [19, 21], [18, 30]]) {
      expect(at(x, y)).toBe(255);
      expect(at(x + 1, y)).toBe(0);
      expect(at(x - 1, y)).toBe(0);
    }
    // The page and panel are both black: only a painted flash can pass these samples.
    for (let x = 5.5; x <= 32.5; x += 0.1) {
      expect(at(x, 10 + (x - 5) * 0.25 - 0.4)).toBe(255);
      expect(at(x - 1, 20 + (x - 5) * 0.25 - 0.4)).toBe(255);
    }
  });

  it("cuts only the targeted image at its existing layer and clips the flash to its rotated footprint", async () => {
    const input = scene(`- { effect: slice, target: figure, width: 1mm, cuts: [{ from: [20mm, 0], to: [20mm, 100%], shift: 3mm }] }
- { image: picture, id: figure, size: [16mm, 12mm], rotate: 90deg }
- { draw: rect, at: [20.5mm, 21mm], size: [2mm, 2mm], fill: "#404040", stroke: none }`, "background: \"#808080\"");
    const picture = await sharp({ create: { width: 80, height: 160, channels: 3, background: "black" } }).png().toBuffer();
    const { at } = await pixels(input, { profile: "preview", dpi: 254, assets: { picture } });
    expect(at(12, 19)).toBe(0);
    expect(at(18, 19)).toBe(128); // opened gap in the image, not a displaced panel
    expect(at(20.5, 19)).toBe(255);
    expect(at(20.5, 21)).toBe(64); // the next authored layer still covers the target
    expect(at(22, 19)).toBe(0);
    expect(at(20.5, 15)).toBe(128); // no flash in the padded part of the image box
  });

  it.each(["panel", "image"])("moves an overlay panel's knockout with its fragments over a black %s", async (underlay) => {
    const hasPageArt = underlay === "image";
    const art = await sharp({ create: { width: 400, height: 400, channels: 3, background: "black" } }).png().toBuffer();
    const { at } = await pixels({ yaml: `mangacli: 1
book: { pageNumbers: { enabled: false } }
page: { size: [40mm, 40mm], bleed: 0, baseFrame: trim }
assets:
  art: { src: art.png, kind: background }
pages:
  - ${hasPageArt ? "background: { image: art }" : "id: test"}
    gutterFill: none
    panels:
      - background: ${hasPageArt ? "none" : "black"}
        border: none
      - overlay: true
        z: 1
        box: [10mm, 8mm, 14mm, 14mm]
        background: ${hasPageArt ? "none" : "black"}
        border: none
        knockout: 2mm
        layers:
          - { effect: slice, cuts: [{ from: left, to: right, shift: 5mm }] }
` }, { profile: "preview", dpi: 254, assets: { art } });
    expect(at(9, 11)).toBe(255);
    expect(at(9, 17)).toBe(0);
    expect(at(9, 25)).toBe(255);
    expect(at(11, 25)).toBe(0);
  });

  it("uses four translated vector clips for crossing cuts and ignores coincident and missing lines", async () => {
    const input = scene(`- effect: slice
  cuts:
    - { from: left, to: right, shift: 2mm }
    - { from: top, to: bottom, shift: 3mm }
    - { from: right, to: left, shift: 5mm }
    - { from: top-left, to: top-right, shift: 5mm }`);
    const renderer = createRenderer();
    try {
      const list = await renderer.displayList(input, 1);
      const offsets: number[][] = [];
      const walk = (n: Node) => {
        if (n.kind !== "group") return;
        if (n.clip && n.transform && n.children.some((c) => c.tag?.elementId === "p1-art")) offsets.push(n.transform.slice(4));
        n.children.forEach(walk);
      };
      walk(list.root);
      expect(offsets).toEqual([[0, 0], [-3, 0], [0, 2], [-3, 2]]);
    } finally {
      renderer.dispose();
    }
  });

  it.each([
    ["{ effect: slice, cuts: [] }", ["cuts"], "SCHEMA_TYPE"],
    ["{ effect: slice, cuts: [{ from: center, to: center }] }", ["cuts", 0, "to"], "SCHEMA_TYPE"],
    ["{ effect: slice, cuts: [{ from: absent.anchor, to: right }] }", ["cuts", 0, "from"], "REF_NOT_FOUND"],
    ["{ effect: slice, cuts: [{ from: left, to: right, shift: -2mm }] }", ["cuts", 0, "shift"], "SCHEMA_TYPE"],
    ["{ effect: slice, cuts: [{ from: left, to: right }], width: 0 }", ["width"], "SCHEMA_TYPE"],
    ["{ effect: slice, cuts: [{ from: left, to: right }], target: absent }", ["target"], "REF_NOT_FOUND"],
  ])("reports slice validation errors: %s", async (layer, path, code) => {
    const result = await validate(scene("- " + layer));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: "error", code, path: ["pages", 0, "panels", 0, "layers", 0, ...path],
    }));
  });
});
