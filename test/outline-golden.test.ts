import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { BLACK, WHITE } from "../src/core/color.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { polyPath } from "../src/geom/path.js";
import { AssetRegistry } from "../src/render/assets.js";
import { distanceSquared } from "../src/render/edt.js";
import type { DisplayList, Node, PathNode } from "../src/render/ir.js";
import { RasterBackend } from "../src/render/raster.js";
import { backgrounds, outlineFixture, photoLike } from "./fixtures/outline.js";

const dpi = 127;
const assets = new AssetRegistry({}, {}, new DiagnosticBag(), 300, "error");
const renderer = createRenderer({ profile: "print-mono", dpi, crop: "trim", keepLists: true, finish: false });
const paths = (node: Node): PathNode[] => node.kind === "group" ? node.children.flatMap(paths) : node.kind === "path" ? [node] : [];

async function readability(list: DisplayList, pixels: Buffer, width: number, height: number) {
  for (const id of ["fixed", "adaptive", "dakuten", "auto-sfx", "monologue"]) {
    const glyphs = paths(list.root).filter((p) => p.tag?.elementId === id && p.tag.role === "text" && p.paint && !p.stroke).map((p) => ({ ...p, paint: { type: "solid" as const, color: WHITE } }));
    expect(glyphs.length, id).toBeGreaterThan(0);
    const background: PathNode = { kind: "path", path: polyPath([{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 100 }, { x: 0, y: 100 }], true), fillRule: "nonzero", paint: { type: "solid", color: BLACK } };
    const maskList: DisplayList = { ...list, root: { kind: "group", children: [background, ...glyphs] } };
    const mask = await new RasterBackend({ dpi, crop: "trim", colorMode: "mono", toneRendering: "dots", monoLpi: 35, toneCurve: "linear", assets }).render(maskList);
    const inside = new Uint8Array(width * height);
    for (let i = 0; i < inside.length; i++) inside[i] = mask.data[i * 4] === 255 ? 1 : 0;
    const outside = inside.map((v) => 1 - v);
    const toGlyph = distanceSquared(inside, width, height);
    const toArt = distanceSquared(outside, width, height);
    let ring = 0, white = 0, interior = 0, black = 0;
    for (let i = 0; i < inside.length; i++) {
      // Ignore the one-pixel antialias boundary; probe within the minimum white rim.
      if (!inside[i] && toGlyph[i] >= 4 && toGlyph[i] <= 9) { ring++; if (pixels[i] === 255) white++; }
      if (inside[i] && toArt[i] >= 2) { interior++; if (pixels[i] === 0) black++; }
    }
    expect(ring, `${id} ring samples`).toBeGreaterThan(100);
    expect(interior, `${id} interior samples`).toBeGreaterThan(20);
    expect(white / ring, `${id} white ring`).toBeGreaterThanOrEqual(0.95);
    expect(black / interior, `${id} black interior`).toBeGreaterThanOrEqual(0.95);
  }
}

describe("white outline print-mono goldens", () => {
  it.each(backgrounds)("matches %s and keeps glyphs readable in binary output", async (background) => {
    const result = await renderer.render(outlineFixture(background), { assets: { photo: await photoLike() } });
    expect(result.failures).toEqual([]);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const png = Buffer.from(result.pages[0].data);
    expect(png[24]).toBe(1);
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([400, 500, 1]);
    expect(data.every((v) => v === 0 || v === 255)).toBe(true);
    await readability(result.lists![0], data, info.width, info.height);
    const path = fileURLToPath(new URL(`./golden/outline-${background}.png`, import.meta.url));
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, png);
    const baseline = readFileSync(path);
    expect(baseline[24]).toBe(1);
    const expected = await sharp(baseline).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(expected.info).toMatchObject({ width: info.width, height: info.height, channels: 1 });
    let changed = 0;
    for (let i = 0; i < data.length; i++) if (data[i] !== expected.data[i]) changed++;
    expect(changed / data.length, `${background} changed pixel fraction`).toBeLessThanOrEqual(0.005);
  });
});
