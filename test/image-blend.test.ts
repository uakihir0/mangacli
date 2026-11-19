import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";

describe("image blend precedence", () => {
  it("keeps multiply between overlapping scatter items before layer opacity", async () => {
    const asset = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#808080" } }).png().toBuffer();
    const result = await render({ yaml: `mangacli: 1
page: { size: [20mm, 20mm], bleed: 0mm }
book: { pageNumbers: { enabled: false } }
assets:
  art: { src: art.png, kind: lineart }
pages:
  - panels:
      - layers:
          - { type: scatter, count: 2, opacity: 0.5, region: { rect: [20%, 20%, 60%, 60%] }, itemScale: [1, 1], itemRotate: [0deg, 0deg], items: [{ asset: art, size: 4mm }] }
` }, { profile: "print-gray", width: 100, format: "png", assets: { art: asset } });
    const pixels = await sharp(Buffer.from(result.pages[0].data)).extract({ left: 15, top: 15, width: 70, height: 70 }).removeAlpha().raw().toBuffer();
    expect(Math.min(...pixels)).toBeGreaterThanOrEqual(159);
    expect(Math.min(...pixels)).toBeLessThanOrEqual(161);
  });

  it("preserves an item's multiply when scatter blend is normal", async () => {
    const asset = await sharp({ create: { width: 32, height: 32, channels: 4, background: "white" } }).png().toBuffer();
    const result = await render({ yaml: `mangacli: 1
page: { size: [20mm, 20mm], bleed: 0mm }
book: { pageNumbers: { enabled: false } }
assets:
  art: { src: art.png, kind: lineart }
pages:
  - panels:
      - background: ink
        layers:
          - { type: scatter, count: 1, blend: normal, itemScale: [1, 1], itemRotate: [0deg, 0deg], items: [{ asset: art, size: 4mm, blend: multiply }] }
` }, { profile: "print-gray", width: 100, format: "png", assets: { art: asset } });
    const pixels = await sharp(Buffer.from(result.pages[0].data)).extract({ left: 10, top: 10, width: 80, height: 80 }).removeAlpha().raw().toBuffer();
    expect(Math.max(...pixels)).toBe(0);
  });

  it.each(["art", "lineart", "mixed"])("applies scatter opacity once across overlapping %s assets", async (kind) => {
    const asset = await sharp({ create: { width: 32, height: 32, channels: 4, background: "black" } }).png().toBuffer();
    const result = await render({ yaml: `mangacli: 1
page: { size: [20mm, 20mm], bleed: 0mm }
book: { pageNumbers: { enabled: false } }
assets:
  art: { src: art.png, kind: ${kind === "mixed" ? "art" : kind} }
  line: { src: line.png, kind: lineart }
pages:
  - panels:
      - layers:
          - { type: scatter, count: 20, opacity: 0.5, itemScale: [1, 1], itemRotate: [0deg, 0deg], items: [{ asset: art, size: 4mm }${kind === "mixed" ? ", { asset: line, size: 4mm }" : ""}] }
` }, { profile: "print-gray", width: 100, format: ["svg", "png"], assets: { art: asset, line: asset } });
    const svg = Buffer.from(result.pages.find((p) => p.format === "svg")!.data).toString("utf8");
    expect(svg.match(/<image\b/g)).toHaveLength(20);
    expect(svg.match(/opacity="0.5"/g)).toHaveLength(1);
    const pixels = await sharp(Buffer.from(result.pages.find((p) => p.format === "png")!.data)).extract({ left: 10, top: 10, width: 80, height: 80 }).removeAlpha().raw().toBuffer();
    expect(Math.min(...pixels)).toBeGreaterThanOrEqual(127);
    expect(Math.min(...pixels)).toBeLessThanOrEqual(128);
  });

  describe.each(["mark", "scatter"])("%s assets", (type) => {
    describe.each(["print-gray", "print-mono"])("%s", (profile) => {
      it.each([
        [undefined, undefined, "multiply", 0, 1],
        ["normal", undefined, "normal", 255, 1],
        ["screen", undefined, "screen", 255, 1],
        [undefined, "normal", "normal", 255, 1],
        ["normal", "multiply", "normal", 255, 1],
        ["multiply", "normal", "multiply", 0, 1],
        ["multiply", undefined, "multiply", 0, 0.5],
        [undefined, undefined, "multiply", 0, 0.5],
      ] as const)("layer=%s asset=%s uses %s pixel=%s opacity=%s", async (layerBlend, assetBlend, expectedBlend, expectedPixel, opacity) => {
        const asset = await sharp({ create: { width: 32, height: 32, channels: 4, background: "white" } }).png().toBuffer();
        const blend = `, opacity: ${opacity}${layerBlend ? `, blend: ${layerBlend}` : ""}`;
        const layer = type === "mark"
          ? `{ type: mark, kind: asset, asset: art, size: 10mm, at: [50%, 50%]${blend} }`
          : `{ type: scatter, count: 1, itemScale: [1, 1], itemRotate: [0deg, 0deg], items: [{ asset: art, size: 4mm }]${blend} }`;
        const result = await render({ yaml: `mangacli: 1
page: { size: [20mm, 20mm], bleed: 0mm }
book: { pageNumbers: { enabled: false } }
assets:
  art: { src: art.png, kind: lineart${assetBlend ? `, blend: ${assetBlend}` : ""} }
pages:
  - panels:
      - background: ink
        layers:
          - ${layer}
` }, { profile, width: 100, format: ["svg", "png"], assets: { art: asset } });
        const svg = Buffer.from(result.pages.find((p) => p.format === "svg")!.data).toString("utf8");
        expect(svg).toContain("<image");
        const pixel = await sharp(Buffer.from(result.pages.find((p) => p.format === "png")!.data)).extract({ left: 10, top: 10, width: 80, height: 80 }).removeAlpha().raw().toBuffer();
        expect(Math.max(...pixel)).toBe(expectedPixel);
        if (expectedBlend === "normal") expect(svg).not.toContain("mix-blend-mode:");
        else expect(svg).toContain(`mix-blend-mode:${expectedBlend}`);
      });
    });
  });

  it.each([
    ["lineart", undefined, undefined, "multiply", 0],
    ["lineart", "normal", undefined, "normal", 255],
    ["lineart", "screen", undefined, "screen", 255],
    ["lineart", undefined, "normal", "normal", 255],
    ["lineart", "normal", "multiply", "normal", 255],
    ["art", undefined, undefined, "normal", 255],
    ["art", "multiply", undefined, "multiply", 0],
  ] as const)("%s layer=%s asset=%s uses %s", async (kind, layerBlend, assetBlend, expectedBlend, expectedPixel) => {
    const asset = await sharp({ create: { width: 32, height: 32, channels: 4, background: "white" } }).png().toBuffer();
    const yaml = `mangacli: 1
page: { size: [20mm, 20mm], bleed: 0mm, color: mono }
assets:
  art: { src: art.png, kind: ${kind}${assetBlend ? `, blend: ${assetBlend}` : ""} }
pages:
  - panels:
      - background: ink
        layers:
          - { image: art, size: [10mm, 10mm], at: [50%, 50%]${layerBlend ? `, blend: ${layerBlend}` : ""} }
`;
    const result = await render({ yaml }, { profile: "web", width: 100, format: ["svg", "png"], assets: { art: asset } });
    const svg = Buffer.from(result.pages.find((p) => p.format === "svg")!.data).toString("utf8");
    if (expectedBlend === "normal") expect(svg).not.toContain("mix-blend-mode:");
    else expect(svg).toContain(`mix-blend-mode:${expectedBlend}`);
    const png = result.pages.find((p) => p.format === "png")!;
    const pixel = await sharp(Buffer.from(png.data)).extract({ left: 50, top: 50, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect([...pixel]).toEqual([expectedPixel, expectedPixel, expectedPixel]);
  });
});
