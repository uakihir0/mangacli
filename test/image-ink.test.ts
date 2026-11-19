import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";
import { imageInkMask } from "../src/render/image-ink.js";

describe("print image ink preservation", () => {
  it.each([false, true])("keeps one- and two-pixel lines continuous (light=%s) while screening tones at 324 ppi", async (light) => {
    const width = 324;
    const pixels = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const line = y === 40 || y === 80 || y === 81 || x === 120 || x === y;
        const v = light ? (line ? 160 : y < 160 ? Math.round(40 + x / width * 60) : 100) : (line ? 100 : y < 160 ? Math.round(160 + x / width * 60) : 180);
        pixels.fill(v, (y * width + x) * 3, (y * width + x + 1) * 3);
      }
    }
    const art = await sharp(pixels, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
    const result = await render({ yaml: `mangacli: 1
book: { pageNumbers: { enabled: false } }
page: { size: [25.4mm, 25.4mm], bleed: 0mm }
assets:
  art: { src: art.png, kind: background }
pages:
  - layers:
      - { image: art, at: [0mm, 0mm], anchor: top-left, size: [25.4mm, 25.4mm], fit: fill }
` }, { profile: "print-mono", dpi: 324, crop: "trim", assets: { art } });
    expect(result.failures).toEqual([]);
    const { data, info } = await sharp(result.pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    const at = (x: number, y: number) => data[(y * width + x) * info.channels];
    for (let p = 5; p < width - 5; p++) {
      for (const y of [40, 80, 81]) expect(at(p, y), `horizontal ${p},${y}`).toBe(light ? 255 : 0);
      expect(at(120, p), `vertical ${p}`).toBe(light ? 255 : 0);
      expect(at(p, p), `diagonal ${p}`).toBe(light ? 255 : 0);
    }
    const tones = new Set<number>();
    for (let y = 200; y < 240; y++) for (let x = 20; x < 60; x++) tones.add(at(x, y));
    expect([...tones].sort()).toEqual([0, 255]);
  });

  it("keeps dark shapes solid and thresholds antialiased edges without dot fringes", async () => {
    const width = 324;
    const pixels = Buffer.alloc(width * width * 3, 255);
    for (let y = 40; y < 280; y++) {
      for (let x = 40; x < 280; x++) {
        const distance = Math.min(x - 40, 279 - x, y - 40, 279 - y);
        const v = distance === 0 ? 180 : distance === 1 ? 110 : 80;
        pixels.fill(v, (y * width + x) * 3, (y * width + x + 1) * 3);
      }
    }
    const art = await sharp(pixels, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
    const result = await render({ yaml: `mangacli: 1
book: { pageNumbers: { enabled: false } }
page: { size: [25.4mm, 25.4mm], bleed: 0mm }
assets:
  art: { src: art.png, kind: background }
pages:
  - layers:
      - { image: art, at: [0mm, 0mm], anchor: top-left, size: [25.4mm, 25.4mm], fit: fill }
` }, { profile: "print-mono", dpi: 324, crop: "trim", assets: { art } });
    expect(result.failures).toEqual([]);
    const { data, info } = await sharp(result.pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const inside = x >= 41 && x <= 278 && y >= 41 && y <= 278;
        expect(data[(y * width + x) * info.channels], `${x},${y}`).toBe(inside ? 0 : 255);
      }
    }
  });

  it("does not mistake flat dark tones, smooth gradients or transparent black for ink", () => {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      rgba.fill(80 + i % 32, i * 4, i * 4 + 3);
      rgba[i * 4 + 3] = 255;
    }
    expect(imageInkMask(rgba, 32, 32, 324).some(Boolean)).toBe(false);
    rgba.fill(0);
    expect(imageInkMask(rgba, 32, 32, 324).some(Boolean)).toBe(false);
    expect(imageInkMask(new Uint8Array(), 0, 0, 324)).toHaveLength(0);
  });
});
