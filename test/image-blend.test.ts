import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";

describe("image blend precedence", () => {
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
