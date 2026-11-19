import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";

const renderer = createRenderer({ profile: "preview" });
const input = (type: "spread" | "page") => ({ yaml: `mangacli: 1
page: { size: [80mm, 60mm], bleed: 3mm }
pages:
  - type: ${type}
    panels: []
`, filename: "/v/spread-marks.yaml" });

describe("split spread crop marks", () => {
  it.each(["gray", "mono"] as const)("leaves no fold-mark fragments in %s output, retaining outer marks", async (colorMode) => {
    const result = await renderer.render(input("spread"), { format: "png", crop: "marks", spread: "split", dpi: 254, colorMode });
    expect(result.pages).toHaveLength(2);
    for (const page of result.pages) {
      const { data, info } = await sharp(page.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const ink = (x0: number, y0: number, w: number, h: number) => {
        let count = 0;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          if (data[(y * info.width + x) * info.channels] < 128) count++;
        }
        return count;
      };
      const gutterX = page.side === "left" ? info.width - 80 : 0;
      expect(ink(gutterX, 0, 80, 99)).toBe(0);
      expect(ink(gutterX, info.height - 99, 80, 99)).toBe(0);
      const outerX = page.side === "left" ? 90 : info.width - 140;
      expect(ink(outerX, 0, 50, 100)).toBeGreaterThan(0);
    }
  });

  it.each(["spread", "page"] as const)("retains top and bottom center crosses for joined %s pages", async (type) => {
    const result = await renderer.render(input(type), { format: "png", crop: "marks", spread: "joined", dpi: 254, colorMode: "gray" });
    expect(result.pages).toHaveLength(1);
    const { data, info } = await sharp(result.pages[0]!.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const y of [55, info.height - 55]) {
      const x = Math.floor(info.width / 2) + 20;
      expect(data[(y * info.width + x) * info.channels]).toBeLessThan(128);
    }
  });
});
