import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { render, validate } from "../src/api.js";

const scene = (props: string, background = "black") => ({
  yaml: `mangacli: 1
page: { size: [100mm, 60mm], bleed: 0, baseFrame: trim, safeArea: { inset: 0 } }
pages:
  - panels:
      - background: ${background}
        layers:
          - { effect: beam, ${props} }
`,
});

const straight = "from: [10mm, 30mm], to: [80mm, 30mm], width: [6mm, 20mm]";
const volley = "path: [[10mm, 30mm], [40mm, 29mm], [80mm, 30mm]], width: 5mm, count: 3, spread: 36deg";

async function raster(props: string, background?: string) {
  const r = await render(scene(props, background), { profile: "print-mono" });
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.pages[0].data!;
}

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return {
    pixel: (x: number, y: number) => data[Math.floor(y * info.height / 60) * info.width + Math.floor(x * info.width / 100)],
    data,
  };
}

describe("beam effect", () => {
  it.each([["single widening beam", straight], ["three-shot path volley", volley]])(
    "reproduces a %s with the same seed",
    async (_name, props) => {
      const first = await raster(props + ", seed: 42");
      expect(await raster(props + ", seed: 42")).toEqual(first);
      expect(await raster(props + ", seed: 43")).not.toEqual(first);
    },
  );

  it("keeps a white core separated from a screened outer band in print-mono", async () => {
    const { data, pixel } = await pixels(await raster(straight + ", edge: tone, jitter: 0, charge: false, impact: false"));
    expect(new Set(data)).toEqual(new Set([0, 255]));
    // The inner white region widens downrange, and the tone is outside it.
    expect(pixel(25, 33)).toBe(0);
    expect(pixel(65, 33)).toBe(255);
    expect(pixel(65, 41)).toBe(0);
    let core = 0;
    let edge = 0;
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 30; j++) {
        core += pixel(64 + i / 24, 30 + j / 24) / 255;
        edge += pixel(64 + i / 24, 36 + j / 24) / 255;
      }
    }
    expect(core / 1800).toBe(1);
    expect(edge / 1800).toBeGreaterThan(0.25);
    expect(edge / 1800).toBeLessThan(0.85);
  });

  it("fans out three white cores and adds the shared charge and endpoint impacts", async () => {
    const { pixel } = await pixels(await raster(volley + ", seed: 42, jitter: 0"));
    for (const y of [12, 29.5, 47.5]) expect(pixel(65, y)).toBe(255);
    for (const y of [22, 39]) expect(pixel(65, y)).toBe(0);
    const toggled = await pixels(await raster(volley + ", seed: 42, jitter: 0, charge: false, impact: false"));
    for (const [x, y] of [[8, 30], [81, 30], [77, 8.5], [77, 51.5]]) {
      expect(pixel(x, y)).toBe(255);
      expect(toggled.pixel(x, y)).toBe(0);
    }
  });

  it("clears the filled beam edge as well as the core", async () => {
    const props = "from: [10mm, 30mm], to: [80mm, 30mm], width: 12mm, jitter: 0, edge: tone";
    const { pixel } = await pixels(await raster(props + ", clear: { rect: [45mm, 20mm, 10mm, 20mm] }", "white"));
    expect(pixel(40, 35.8)).toBe(0);
    expect(pixel(50, 35.8)).toBe(255);
  });

  it.each([
    ["from: [0, 0]", "to"],
    [straight + ", path: [[0, 0], [1, 1]]", "path"],
    ["path: [[0, 0], [0, 0]]", "path"],
    [volley + ", edge: wrong", "edge"],
  ])("reports invalid beam inputs: %s", async (props, field) => {
    const r = await validate(scene(props));
    expect(r.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_TYPE", path: ["pages", 0, "panels", 0, "layers", 0, field] }),
    ]));
  });
});
