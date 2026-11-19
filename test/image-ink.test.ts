import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";
import { imageInkMask } from "../src/render/image-ink.js";

describe("print image ink preservation", () => {
  it.each([300, 600])("preserves one- through three-pixel lines at %s ppi", (dpi) => {
    const size = 192;
    for (const light of [false, true]) {
      for (const vertical of [false, true]) {
        for (const thickness of [1, 2, 3]) {
          const rgba = new Uint8Array(size * size * 4);
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const cross = vertical ? x : y;
              const along = vertical ? y : x;
              const line = cross >= 40 && cross < 40 + thickness && along >= 16 && along < 176;
              const v = line === light ? 180 : 80;
              rgba.set([v, v, v, 255], (y * size + x) * 4);
            }
          }
          const mask = imageInkMask(rgba, size, size, dpi);
          for (let p = 16; p < 176; p++) {
            for (let q = 40; q < 40 + thickness; q++) {
              const i = vertical ? p * size + q : q * size + p;
              expect(mask[i], `dpi=${dpi}, light=${light}, vertical=${vertical}, thickness=${thickness}, pixel=${i}`).toBe(light ? 2 : 1);
            }
          }
        }
      }
    }
  });

  it.each(["blob", "step", "shading-boundary"])("does not preserve soft %s contours as ridges", (shape) => {
    const width = 192;
    const rgba = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const distance = Math.hypot((x - 96) / 1.3, y - 96);
        const boundary = x - y * 0.5 - 45;
        const v = shape === "blob" ? 70 + 120 * (1 - Math.exp(-distance * distance / 1200))
          : shape === "step" ? 70 + 120 / (1 + Math.exp(-boundary / 2))
          : boundary < -2 ? 70 : boundary <= 0 ? 180 : 130;
        const i = (y * width + x) * 4;
        rgba.fill(v, i, i + 3);
        rgba[i + 3] = 255;
      }
    }
    expect(imageInkMask(rgba, width, width, 324).some(Boolean)).toBe(false);
  });

  it.each([[4096, 32], [32, 4096]])("screens a thin %s by %s image without scanning outside its bounds", (width, height) => {
    const rgba = new Uint8Array(width * height * 4);
    const vertical = height > width;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (vertical ? x : y) === 16 ? 80 : 180;
        rgba.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    const start = performance.now();
    const mask = imageInkMask(rgba, width, height, 324);
    console.info(`${width}x${height} ridge mask: ${Math.round(performance.now() - start)} ms`);
    for (let p = 5; p < 4091; p++) expect(mask[vertical ? p * width + 16 : 16 * width + p]).toBe(1);
  }, 2000);

  it("preserves a line whose luminance changes gradually along its length", () => {
    const width = 192;
    const rgba = new Uint8Array(width * width * 4);
    for (let i = 0; i < width * width; i++) rgba.set([180, 180, 180, 255], i * 4);
    for (let x = 16; x < 176; x++) {
      const v = Math.round(100 + (x - 16) * 25 / 159);
      rgba.set([v, v, v, 255], (40 * width + x) * 4);
    }
    const mask = imageInkMask(rgba, width, width, 324);
    for (let x = 16; x < 176; x++) expect(mask[40 * width + x], `pixel=${x}`).toBe(1);
  });

  it.each([1 / 2, 1 / 3, Math.tan(20 * Math.PI / 180), Math.tan(70 * Math.PI / 180)])("preserves long lines at slope %s", (slope) => {
    const width = 192;
    for (const light of [false, true]) {
      const rgba = new Uint8Array(width * width * 4);
      for (let i = 0; i < width * width; i++) rgba.set(light ? [80, 80, 80, 255] : [180, 180, 180, 255], i * 4);
      const line: number[] = [];
      for (let p = 10; p < 170; p++) {
        const x = slope <= 1 ? p : 10 + Math.round((p - 10) / slope);
        const y = slope <= 1 ? 10 + Math.round((p - 10) * slope) : p;
        const i = y * width + x;
        rgba.set(light ? [180, 180, 180, 255] : [80, 80, 80, 255], i * 4);
        line.push(i);
      }
      const mask = imageInkMask(rgba, width, width, 324);
      for (const i of line) expect(mask[i], `light=${light}, pixel=${i}`).toBe(light ? 2 : 1);
    }
  });

  it.each(["linear", "perceptual"] as const)("does not classify an isoluminant red line as ink (%s)", (toneCurve) => {
    const width = 96;
    const rgba = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rgba.set(y === 40 ? [255, 0, 0, 255] : [127, 127, 127, 255], i);
      }
    }
    expect(imageInkMask(rgba, width, width, 324, toneCurve).some(Boolean)).toBe(false);
  });

  it("rejects noisy and blobby midtone texture", () => {
    const width = 192;
    for (const blobs of [false, true]) {
      const rgba = new Uint8Array(width * width * 4);
      let seed = 17;
      for (let y = 0; y < width; y++) {
        for (let x = 0; x < width; x++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const v = blobs ? 128 + 65 * Math.sin(x / 4) * Math.cos(y / 5) : 60 + seed % 140;
          const i = (y * width + x) * 4;
          rgba.fill(v, i, i + 3);
          rgba[i + 3] = 255;
        }
      }
      const mask = imageInkMask(rgba, width, width, 324);
      expect(mask.filter(Boolean).length / (width * width)).toBeLessThan(0.001);
    }
  });

  it.each([324, 648])("rejects short crack-like squiggles at %s ppi", async (dpi) => {
    for (const light of [false, true]) {
      const rgba = Buffer.alloc(64 * 64 * 4, 255);
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const crack = x >= 20 && x < 32 && y === 25 + Math.round(2 * Math.sin(x));
          const v = crack ? (light ? 180 : 80) : (light ? 80 : 180);
          rgba.fill(v, (y * 64 + x) * 4, (y * 64 + x) * 4 + 3);
        }
      }
      const size = 64 * dpi / 324;
      const pixels = await sharp(rgba, { raw: { width: 64, height: 64, channels: 4 } }).resize(size, size, { kernel: "nearest" }).raw().toBuffer();
      expect(imageInkMask(pixels, size, size, dpi).some(Boolean)).toBe(false);
    }
  });

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
