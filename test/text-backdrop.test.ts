import sharp from "sharp";
import { expect, it } from "vitest";
import { render, validate } from "../src/api.js";

const input = (backdrop?: string) => ({ yaml: `mangacli: 1
meta: {lang: en}
page: {size: [55mm, 45mm], bleed: 0mm, background: black}
pages:
  - type: blank
    layers:
      - text: O
        at: [50%, 50%]
        writing: horizontal
        fontSize: 8mm
        outline: none
        ${backdrop ? `backdrop: ${backdrop}` : ""}
` });

const effect = "{color: white, padding: 3mm, feather: 3mm, opacity: 0.8}";

it("validates backdrop lengths and opacity in text shorthand", async () => {
  expect((await validate(input("{color: white, feather: 3bmm, padding: 1.5bmm, opacity: 0.9}"))).ok).toBe(true);
  for (const invalid of ["{padding: -1mm}", "{padding: -1}", "{feather: 1deg}", "{opacity: 1.1}", "{width: 3mm}"]) {
    expect((await validate(input(invalid))).ok, invalid).toBe(false);
  }
});

it("draws the glyph-shaped fill with soft edges behind sharp text, including in SVG", async () => {
  const options = { profile: "web", dpi: 127, crop: "trim" } as const;
  const before = await render(input(), { ...options, format: "png" });
  const after = await render(input(effect), { ...options, format: ["png", "svg"] });
  const off = await render(input(effect.replace("0.8", "0")), { ...options, format: "png" });
  expect(await sharp(off.pages[0].data).raw().toBuffer()).toEqual(await sharp(before.pages[0].data).raw().toBuffer());
  const { data, info } = await sharp(after.pages.find(p => p.format === "png")!.data).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  expect(data[0]).toBe(0);
  expect(data.some(v => v > 185 && v <= 206)).toBe(true);
  expect(new Set(data.filter(v => v > 15 && v < 170)).size).toBeGreaterThan(30);
  expect(data.filter((v, i) => v === 0 && data[i - info.width * 6] > 100 && data[i + info.width * 6] > 100).length).toBeGreaterThan(0);

  const svg = Buffer.from(after.pages.find(p => p.format === "svg")!.data).toString();
  expect(svg).toContain('<feGaussianBlur stdDeviation="1.5"/>');
  expect(svg).toContain('opacity="0.8" filter="url(#backdrop');
  expect(svg).toContain('stroke="#ffffff" stroke-width="6"');
  expect(svg.lastIndexOf('fill="#000000" data-id')).toBeGreaterThan(svg.indexOf('stroke="#ffffff"'));
});

it("screens translucent white onto black in print-mono without producing gray pixels", async () => {
  const options = { profile: "print-mono", format: "png", dpi: 254, crop: "trim" } as const;
  const soft = await render(input(effect), options);
  const hard = await render(input(effect.replace("feather: 3mm", "feather: 0mm")), options);
  const channel = (data: Uint8Array) => sharp(data).extractChannel(0).raw().toBuffer();
  const [softPixels, hardPixels] = await Promise.all([channel(soft.pages[0].data), channel(hard.pages[0].data)]);
  expect(new Set(softPixels)).toEqual(new Set([0, 255]));
  expect(softPixels.filter((v, i) => v === 255 && hardPixels[i] === 0).length).toBeGreaterThan(100);
  expect(softPixels.filter((v, i) => v === 0 && hardPixels[i] === 255).length).toBeGreaterThan(100);
});
