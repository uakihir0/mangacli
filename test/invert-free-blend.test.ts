import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";

async function lineArt() {
  const data = Buffer.alloc(40 * 40 * 4, 255);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const i = (y * 40 + x) * 4;
    if (x < 4 || x >= 36 || y < 4 || y >= 36) data[i + 3] = 0;
    else if (x >= 10 && x < 15) data[i] = data[i + 1] = data[i + 2] = 0;
  }
  return sharp(data, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
}

const document = (panel = "invert: true", image = "") => ({ yaml: `mangacli: 1
page: { size: [60mm, 40mm], bleed: 0, baseFrame: trim, color: color, background: black }
pages:
  - number: false
    panels:
      - box: [10mm, 5mm, 30mm, 30mm]
        border: { style: none }
        ${panel}
        layers:
          - { type: draw, kind: rect, coords: page, at: [25mm, 15mm], size: [30mm, 8mm], fill: black }
          - { image: art, coords: page, at: [35mm, 20mm], size: [30mm, 20mm], fit: fill, clip: none, blend: multiply, ${image || "opacity: 1"} }
` });

const options = { dpi: 254, crop: "trim" as const, format: "png" as const };
const pixel = (data: Buffer, x: number, y: number) => Array.from(data.subarray((y * 600 + x) * 4, (y * 600 + x) * 4 + 4));

describe("filtered free-item blending", () => {
  it.each(["web", "print-mono"])("composites white-paper multiply art inside and outside the panel (%s)", async (profile) => {
    const r = await render(document(), { ...options, profile, assets: { art: await lineArt() } });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const data = await sharp(r.pages[0].data).ensureAlpha().raw().toBuffer();
    expect(pixel(data, 350, 150)).toEqual([255, 255, 255, 255]);
    expect(pixel(data, 290, 250)).toEqual([255, 255, 255, 255]);
    expect(pixel(data, 350, 250)).toEqual([0, 0, 0, 255]);
    expect(pixel(data, 450, 200)).toEqual([255, 255, 255, 255]);
    expect(pixel(data, 490, 200)).toEqual([0, 0, 0, 255]);
    expect(pixel(data, 450, 110)).toEqual([0, 0, 0, 255]);
  });
  it("leaves excluded images unfiltered and does not split unfiltered panels", async () => {
    const assets = { art: await lineArt() };
    const excluded = await render(document("invert: true\n        exclude: [images]"), { ...options, profile: "web", assets });
    const data = await sharp(excluded.pages[0].data).ensureAlpha().raw().toBuffer();
    expect(pixel(data, 450, 200)).toEqual([0, 0, 0, 255]);
    expect(pixel(data, 290, 250)).toEqual([0, 0, 0, 255]);
    const a = await render(document("invert: false"), { ...options, profile: "web", assets, keepLists: true });
    const b = await render(document("filters: []"), { ...options, profile: "web", assets, keepLists: true });
    expect(await sharp(a.pages[0].data).raw().toBuffer()).toEqual(await sharp(b.pages[0].data).raw().toBuffer());
    expect(JSON.stringify(a.lists)).not.toContain('"backdrop":true');
  });
  it("preserves opaque backdrop alpha under partially covered spill pixels", async () => {
    const doc = document("invert: true", "opacity: 0.5");
    doc.yaml = doc.yaml.replace("    panels:", "    layers: [{ type: draw, kind: rect, coords: page, at: [30mm, 20mm], size: [60mm, 40mm], fill: black, stack: under }]\n    panels:");
    const r = await render(doc, { ...options, profile: "web", transparent: true, assets: { art: await lineArt() } });
    const data = await sharp(r.pages[0].data).ensureAlpha().raw().toBuffer();
    const p = pixel(data, 450, 200);
    expect(p[3]).toBe(255);
    expect(p[0]).toBeGreaterThanOrEqual(127);
    expect(p[0]).toBeLessThanOrEqual(128);
    expect(p.slice(0, 3)).toEqual([p[0], p[0], p[0]]);
  });
  it("puts the in-panel image into the SVG composite and reports the spill limitation", async () => {
    const r = await render(document(), { ...options, profile: "web", format: "svg", assets: { art: await lineArt() } });
    expect(r.diagnostics.some((d) => d.code === "SVG_FILTER_BACKDROP_UNSUPPORTED")).toBe(true);
    expect(Buffer.from(r.pages[0].data).toString().match(/<image/g)).toHaveLength(2);
  });
});
