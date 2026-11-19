import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";

const renderer = createRenderer({ profile: "preview" });
const input = (type: "spread" | "page", background = "white") => ({ yaml: `mangacli: 1
page: { size: [80mm, 60mm], bleed: 3mm, background: ${background} }
pages:
  - type: ${type}
    panels: []
`, filename: "/v/spread-marks.yaml" });

describe("split spread crop marks", () => {
  it("keeps physical marks on both split pages when printing reduced artwork", async () => {
    const reduced = (type: "spread" | "page") => ({ yaml: input(type).yaml.replace("bleed: 3mm", "bleed: 3mm, printScale: 0.5") });
    const options = { format: "png", crop: "marks", dpi: 254, colorMode: "gray", output: "print" } as const;
    const single = await renderer.render(reduced("page"), options);
    const expected = await sharp(single.pages[0]!.data).ensureAlpha().raw().toBuffer();
    const result = await renderer.render(reduced("spread"), { ...options, spread: "split" });
    expect(result.pages).toHaveLength(2);
    for (const page of result.pages) {
      expect([page.width, page.height]).toEqual([630, 530]);
      const actual = await sharp(page.data).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < page.height; y++) for (let x = 0; x < page.width; x++) {
        if (x >= 100 && x < 530 && y >= 100 && y < 430) continue;
        const i = (y * page.width + x) * 4;
        expect(actual.subarray(i, i + 4).equals(expected.subarray(i, i + 4))).toBe(true);
      }
    }
  });

  it.each(["gray", "mono"] as const)("matches the full single-page mark set in %s output", async (colorMode) => {
    const single = await renderer.render(input("page"), { format: "png", crop: "marks", dpi: 254, colorMode });
    const expected = await sharp(single.pages[0]!.data).ensureAlpha().raw().toBuffer();
    const result = await renderer.render(input("spread"), { format: "png", crop: "marks", spread: "split", dpi: 254, colorMode });
    expect(result.pages).toHaveLength(2);
    for (const page of result.pages) {
      const { data, info } = await sharp(page.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([page.width, page.height]).toEqual([1060, 860]);
      expect([page.width, page.height]).toEqual([single.pages[0]!.width, single.pages[0]!.height]);
      const actual = await sharp(page.data).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < page.height; y++) for (let x = 0; x < page.width; x++) {
        if (x >= 100 && x < 960 && y >= 100 && y < 760) continue;
        const i = (y * page.width + x) * 4;
        if (actual[i] !== expected[i]) throw new Error(`mark margin differs at ${x},${y}`);
      }
      const ink = (x0: number, y0: number, w: number, h: number) => {
        let count = 0;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          if (data[(y * info.width + x) * info.channels] < 128) count++;
        }
        return count;
      };
      const centerX = 530;
      for (const y of [55, info.height - 55]) {
        for (const dx of [-40, 0, 40]) expect(ink(centerX + dx - 1, y - 1, 2, 2)).toBeGreaterThan(0);
        for (const dy of [-40, 40]) expect(ink(centerX - 1, y + dy - 1, 2, 2)).toBeGreaterThan(0);
      }
      for (const x of [55, 1005]) {
        for (const dy of [-40, 0, 40]) expect(ink(x - 1, 430 + dy - 1, 2, 2)).toBeGreaterThan(0);
        for (const dx of [-40, 40]) expect(ink(x + dx - 1, 429, 2, 2)).toBeGreaterThan(0);
      }
      for (const [x, dx] of [[100, -1], [130, -1], [930, 1], [960, 1]] as const) {
        for (const [y, dy] of [[100, -1], [130, -1], [730, 1], [760, 1]] as const) {
          expect(ink(x + dx * 45 - 1, y - 1, 2, 2)).toBeGreaterThan(0);
          expect(ink(x - 1, y + dy * 45 - 1, 2, 2)).toBeGreaterThan(0);
        }
      }
      const outerX = page.side === "left" ? 90 : info.width - 140;
      expect(ink(outerX, 0, 50, 100)).toBeGreaterThan(0);
    }
  });

  it("preserves bleed artwork past the fold and keeps the added margins clear", async () => {
    const result = await renderer.render(input("spread", "black"), { format: "png", crop: "marks", spread: "split", dpi: 254, colorMode: "gray" });
    const bleed = await renderer.render(input("spread", "black"), { format: "png", crop: "bleed", spread: "split", dpi: 254, colorMode: "gray" });
    for (const page of result.pages) {
      const data = await sharp(page.data).ensureAlpha().raw().toBuffer();
      const artwork = await sharp(page.data).extract({ left: 100, top: 100, width: 860, height: 660 }).ensureAlpha().raw().toBuffer();
      const original = await sharp(bleed.pages.find((p) => p.side === page.side)!.data).ensureAlpha().raw().toBuffer();
      expect(artwork.equals(original)).toBe(true);
      expect(data[(200 * page.width + (page.side === "left" ? 1050 : 10)) * 4]).toBe(255);
    }
  });

  it("uses full-page marked rasters and trim boxes in split PDF output", async () => {
    const result = await renderer.render(input("spread"), { format: "pdf", crop: "marks", spread: "split", dpi: 254, colorMode: "gray" });
    const pdf = Buffer.from(result.pages[0]!.data).toString("latin1");
    expect(pdf.match(/\/TrimBox \[36\.85 36\.85 263\.622 206\.929\]/g)).toHaveLength(2);
  });

  it.each(["mono", "gray"] as const)("preserves debug overlay pixels in %s artwork when adding marks", async (colorMode) => {
    const options = { format: "png", spread: "split", dpi: 254, colorMode, debug: true } as const;
    const marked = await renderer.render(input("spread"), { ...options, crop: "marks" });
    const bleed = await renderer.render(input("spread"), { ...options, crop: "bleed" });
    for (const page of marked.pages) {
      const artwork = await sharp(page.data).extract({ left: 100, top: 100, width: 860, height: 660 }).ensureAlpha().raw().toBuffer();
      const original = await sharp(bleed.pages.find((p) => p.side === page.side)!.data).ensureAlpha().raw().toBuffer();
      expect(artwork.equals(original)).toBe(true);
      expect(original.some((v, i) => i % 4 === 0 && v !== original[i + 1])).toBe(true);
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
