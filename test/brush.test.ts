import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenPath, polyPath } from "../src/geom/path.js";
import { brushGlyph, detectBrushTerminals } from "../src/text/brush.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const rectangle = [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 1.5, y: 10 }, { x: 0, y: 10 }];
const path = polyPath(rectangle, true);
const widthAt = (pts: typeof rectangle, y: number) => {
  const xs = pts.flatMap((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return (a.y > y) !== (b.y > y) ? [a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)] : [];
  });
  return Math.max(...xs) - Math.min(...xs);
};

describe("brush pressure", () => {
  it.each([{ pts: rectangle }, { pts: [...rectangle].reverse() }])("detects the entry and exit of a rectangle stroke regardless of winding", ({ pts }) => {
    const terminals = detectBrushTerminals(pts, 10);
    expect(terminals).toHaveLength(2);
    expect(terminals.find(t => t.kind === "exit")!.direction.y).toBe(1);
    expect(terminals.find(t => t.kind === "entry")!.direction.y).toBe(-1);
    expect(terminals.map(t => t.width)).toEqual([1.5, 1.5]);
  });
  it("extends a sharp tail and narrows the final quarter without thinning the middle", () => {
    const pts = flattenPath(brushGlyph(path, 10, 42, { entry: 0, wobble: 0 }), 0.001)[0].pts;
    const tip = Math.max(...pts.map(p => p.y));
    expect(tip).toBeGreaterThan(10.45);
    expect(widthAt(pts, tip - 0.03)).toBeLessThan(0.15);
    expect(widthAt(pts, 9.7)).toBeLessThan(0.75);
    expect(widthAt(pts, 5)).toBeCloseTo(1.5);
  });
  it("widens and angles a pressed entry", () => {
    const pts = flattenPath(brushGlyph(path, 10, 42, { taper: 0, wobble: 0 }), 0.001)[0].pts;
    expect(Math.min(...pts.map(p => p.x))).toBeLessThan(-0.09);
    expect(Math.max(...pts.map(p => p.x))).toBeGreaterThan(1.59);
    expect(Math.min(...pts.map(p => p.y))).toBeLessThan(-0.1);
  });
  it("is seeded and repeatable", () => {
    expect(brushGlyph(path, 10, 42)).toEqual(brushGlyph(path, 10, 42));
    expect(brushGlyph(path, 10, 42)).not.toEqual(brushGlyph(path, 10, 43));
  });
  it("does not mistake a narrow counter for a stroke terminal", () => {
    const outer = polyPath([{ x: -2, y: -2 }, { x: 4, y: -2 }, { x: 4, y: 12 }, { x: -2, y: 12 }], true);
    const counter = polyPath([...rectangle].reverse(), true);
    const contours = flattenPath(brushGlyph([...outer, ...counter], 10, 42, { wobble: 0 }), 0.001);
    expect(contours).toHaveLength(2);
    expect(Math.min(...contours[1].pts.map(p => p.y))).toBe(0);
    expect(Math.max(...contours[1].pts.map(p => p.y))).toBe(10);
  });
  it("leaves disabled, empty and zero-size paths unchanged", () => {
    expect(brushGlyph(path, 10, 42, false)).toBe(path);
    expect(brushGlyph(path, 10, 42, { taper: 0, entry: 0, wobble: 0 })).toBe(path);
    expect(brushGlyph([], 10, 42)).toEqual([]);
    expect(brushGlyph(path, 0, 42)).toBe(path);
  });
  it("uses Black 900 as the Japanese SFX skeleton and finds real kana terminals", async () => {
    const catalog = JSON.parse(readFileSync(new URL("../catalog/fonts.json", import.meta.url), "utf8"));
    expect(catalog.sets["manga-basic"].sfx.font).toBe("zen-kaku-gothic-new@900");
    expect(catalog.fonts.some((f: { id: string; weight: number }) => f.id === "zen-kaku-gothic-new" && f.weight === 900)).toBe(true);
    const fonts = new FontRegistry(new Map(), "manga-basic", [], {});
    await fonts.prepare("sfx", "ン");
    const layout = layoutText("ン", defaultTextStyle({ font: "sfx", fontSize: 10 }), fonts);
    expect(layout.fonts).toContain("Zen Kaku Gothic New 900");
    const terminals = flattenPath(layout.glyphs[0].path, 0.02).flatMap(c => detectBrushTerminals(c.pts, 10));
    expect(terminals.some(t => t.kind === "exit")).toBe(true);
    expect(brushGlyph(layout.glyphs[0].path, 10, 42)).not.toEqual(layout.glyphs[0].path);
  });
});
