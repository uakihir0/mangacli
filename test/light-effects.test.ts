import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type RenderOptions, render, validate } from "../src/api.js";

const scene = (layers: string, background = "black") => ({
  yaml: `mangacli: 1
page: { size: [40mm, 32mm], bleed: 0, baseFrame: trim, safeArea: { inset: 0 } }
assets: { cutout: { src: cutout.png } }
pages:
  - panels:
      - background: ${background}
        layers:
${layers.split("\n").map((l) => "          - " + l).join("\n")}
`,
});

async function raster(yaml: ReturnType<typeof scene>, options: RenderOptions = {}) {
  const { pages, diagnostics } = await render(yaml, { profile: "preview", dpi: 254, colorMode: "color", ...options });
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const { data, info } = await sharp(pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / 40;
  const pixel = (x: number, y: number) => data[(Math.floor(y * scale) * info.width + Math.floor(x * scale)) * info.channels];
  return { pixel, data, scale };
}

async function cutout() {
  const rgba = Buffer.alloc(80 * 80 * 4);
  for (let y = 15; y < 65; y++) for (let x = 8; x < 40; x++) rgba[(y * 80 + x) * 4 + 3] = 255;
  return sharp(rgba, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
}

describe("light effects", () => {
  it("glows around the placed alpha, not the image box, without tinting the subject above it", async () => {
    const yaml = scene(`{ effect: glow, target: hero, blur: 1.6mm, color: "#ff8800" }
{ image: cutout, id: hero, size: [16mm, 16mm], at: [20mm, 16mm], flip: x }`);
    const { pixel } = await raster(yaml, { assets: { cutout: await cutout() } });
    expect(pixel(16, 16)).toBeLessThan(5); // transparent side of image box
    expect(pixel(19.5, 16)).toBeGreaterThan(70); // halo next to the cutout
    expect(pixel(24, 16)).toBe(0); // black cutout layered above halo
    expect(pixel(27, 16)).toBeGreaterThan(70); // halo beyond other edge
    expect(pixel(35, 16)).toBe(0);
  });

  it("screens glow as binary white dots that thin out from the edge", async () => {
    const { data, pixel, scale } = await raster(scene(
      "{ effect: glow, target: { rect: [15mm, 10mm, 10mm, 12mm] }, blur: 2mm }",
    ), { profile: "print-mono", colorMode: "mono", dpi: 600 });
    expect(new Set(data)).toEqual(new Set([0, 255]));
    const coverage = (x: number) => {
      let white = 0;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 96; j++)
        if (pixel(x + i / scale, 13 + j / scale) === 255) white++;
      return white / (16 * 96);
    };
    expect(coverage(14)).toBeGreaterThan(0.2);
    expect(coverage(14)).toBeLessThan(0.65);
    expect(coverage(12)).toBeLessThan(coverage(14) / 2);
    expect(coverage(6)).toBe(0);
  });

  it("accepts a named region as the glow target", async () => {
    const { pixel } = await raster(scene("{ effect: glow, target: trim, blur: 2mm }"));
    expect(pixel(20, 16)).toBe(255);
    expect(pixel(1, 16)).toBeLessThan(200);
  });

  it("radiates from an image anchor with the requested count and clips bands to the region", async () => {
    const yaml = scene(`{ effect: light-rays, center: hero.face, count: 4, angle: 0deg, spread: 0.36, region: { rect: [7mm, 4mm, 26mm, 24mm] } }
{ image: cutout, id: hero, size: [2mm, 2mm], at: [19mm, 15mm], anchors: { face: [40, 40] } }`);
    const { pixel } = await raster(yaml, { assets: { cutout: await cutout() } });
    for (const [x, y] of [[29, 15], [9, 15], [19, 6], [19, 24]]) expect(pixel(x, y)).toBeGreaterThan(130);
    for (const [x, y] of [[25, 21], [13, 21], [25, 9], [13, 9], [35, 15]]) expect(pixel(x, y)).toBe(0);
  });

  it("renders a ray wider than a half-turn without lighting its angular gap", async () => {
    const { pixel } = await raster(scene("{ effect: light-rays, count: 1, spread: 0.75 }"));
    for (const [x, y] of [[30, 16], [19, 6], [19, 26], [14, 6], [14, 26]]) expect(pixel(x, y)).toBeGreaterThan(100);
    expect(pixel(10, 16)).toBe(0);
  });

  it("lights the whole clipped region when ray bands fill a full turn", async () => {
    const { pixel } = await raster(scene(
      "{ effect: light-rays, center: [30mm, 16mm], count: 1, spread: 1, region: { rect: [7mm, 4mm, 26mm, 24mm] } }",
    ));
    for (const [x, y] of [[8, 5], [8, 27], [32, 5], [32, 27]]) expect(pixel(x, y)).toBeGreaterThan(65);
    expect(pixel(5, 16)).toBe(0);
  });

  it("lights the cone and landing pool while shading artwork outside them", async () => {
    const layer = "{ effect: spotlight, source: [12mm, 0], target: [20mm, 24mm], width: 14mm";
    const { pixel } = await raster(scene(layer + ", shade: 0.75 }", '"#808080"'));
    expect(pixel(15, 10)).toBeGreaterThan(150);
    expect(pixel(20, 24)).toBeGreaterThan(235);
    expect(pixel(20, 26)).toBeGreaterThan(170);
    expect(pixel(34, 12)).toBeLessThan(35);
    const noShade = await raster(scene(layer + ", shade: 0 }", '"#808080"'));
    expect(noShade.pixel(34, 12)).toBe(128);
  });

  it("exports the alpha glow as an SVG filter and the other lights as gradients", async () => {
    const yaml = scene(`{ effect: glow, target: hero, blur: 2mm }
{ effect: light-rays, center: [50%, 50%] }
{ effect: spotlight }
{ image: cutout, id: hero, size: [16mm, 16mm], at: [20mm, 16mm] }`);
    const { pages } = await render(yaml, { format: "svg", colorMode: "color", assets: { cutout: await cutout() } });
    const svg = Buffer.from(pages[0].data).toString();
    expect(svg).toContain('<feGaussianBlur in="SourceAlpha" stdDeviation="2"');
    expect(svg).toContain('<feComposite in2="blur" operator="in"');
    expect(svg.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(svg).toContain("<radialGradient");
    expect(svg).toContain("<linearGradient");
  });

  it.each([
    ["{ effect: glow, target: absent }", "target", "REF_NOT_FOUND"],
    ["{ effect: glow, target: { rect: [0, 0, 10mm, 10mm] }, blur: -1mm }", "blur", "SCHEMA_TYPE"],
    ["{ effect: light-rays, count: 1.5 }", "count", "SCHEMA_TYPE"],
    ["{ effect: light-rays, count: 800, density: 2 }", "density", "SCHEMA_TYPE"],
    ["{ effect: light-rays, center: unknown.anchor }", "center", "REF_NOT_FOUND"],
    ["{ effect: spotlight, source: center, target: center }", "target", "SCHEMA_TYPE"],
    ["{ effect: spotlight, shade: 1.1 }", "shade", "SCHEMA_TYPE"],
  ])("reports invalid input: %s", async (layer, key, code) => {
    const { diagnostics } = await validate(scene(layer));
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      severity: "error", code, path: ["pages", 0, "panels", 0, "layers", 0, key],
    })]));
  });
});
