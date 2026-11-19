import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenPath, polyPath } from "../src/geom/path.js";
import { brushGlyph, detectBrushTerminals, emboldenGlyph } from "../src/text/brush.js";
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
  it("keeps close dot strokes separate while increasing their absolute weight", () => {
    const dot = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1.6 }, { x: 0, y: 1.6 }];
    const source = [...polyPath(dot, true), ...polyPath(dot.map(p => ({ ...p, x: p.x + 1.1 })), true)];
    const result = flattenPath(emboldenGlyph(source, 10, 0.25), 0.01);
    expect(result).toHaveLength(2);
    const ranges = result.map(c => [Math.min(...c.pts.map(p => p.x)), Math.max(...c.pts.map(p => p.x))]);
    expect(ranges[0][1] - ranges[0][0]).toBeCloseTo(1.5);
    expect(ranges[1][0] - ranges[0][1]).toBeGreaterThanOrEqual(0.19);
  });
  it.each(["impact", "speed"] as const)("preserves both strokes and their principal directions in ン (%s)", async style => {
    const fonts = new FontRegistry(new Map(), "manga-basic", [], {});
    await fonts.prepare("sfx", "ン");
    const source = layoutText("ン", defaultTextStyle({ font: "sfx", fontSize: 10 }), fonts).glyphs[0].path;
    const before = flattenPath(source, 0.01), after = flattenPath(brushGlyph(emboldenGlyph(source, 10, 0.25), 10, 42, { style }), 0.01);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    const angle = (pts: typeof rectangle) => {
      const samples = pts.flatMap((p, i) => {
        const q = pts[(i + 1) % pts.length], n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 0.01));
        return Array.from({ length: n }, (_, j) => ({ x: p.x + (q.x - p.x) * j / n, y: p.y + (q.y - p.y) * j / n }));
      });
      const x = samples.reduce((s, p) => s + p.x, 0) / samples.length, y = samples.reduce((s, p) => s + p.y, 0) / samples.length;
      return Math.atan2(2 * samples.reduce((s, p) => s + (p.x - x) * (p.y - y), 0), samples.reduce((s, p) => s + (p.x - x) ** 2 - (p.y - y) ** 2, 0)) / 2;
    };
    before.forEach((c, i) => {
      const delta = angle(c.pts) - angle(after[i].pts);
      expect(Math.abs(Math.atan2(Math.sin(2 * delta), Math.cos(2 * delta)) / 2)).toBeLessThan(Math.PI / 18);
    });
  });
  it.each([1, 42, 753])("keeps short dot-like strokes convex for seed %s", seed => {
    const dot = polyPath([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1.6 }, { x: 0, y: 1.6 }], true);
    const pts = flattenPath(brushGlyph(dot, 10, seed), 0.001)[0].pts;
    const turns = pts.map((b, i) => {
      const a = pts[(i + pts.length - 1) % pts.length], c = pts[(i + 1) % pts.length];
      return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    }).filter(t => Math.abs(t) > 1e-8);
    expect(turns.every(t => t > 0) || turns.every(t => t < 0)).toBe(true);
    expect(brushGlyph(dot, 10, seed, { taper: 0 })).toEqual(dot);
  });
  it.each([{ pts: rectangle }, { pts: [...rectangle].reverse() }])("detects the entry and exit of a rectangle stroke regardless of winding", ({ pts }) => {
    const terminals = detectBrushTerminals(pts, 10);
    expect(terminals).toHaveLength(2);
    expect(terminals.find(t => t.kind === "exit")!.direction.y).toBe(1);
    expect(terminals.find(t => t.kind === "entry")!.direction.y).toBe(-1);
    expect(terminals.map(t => t.width)).toEqual([1.5, 1.5]);
  });
  it("keeps impact bodies full width through 80% and limits extension to 0.3 stroke widths", () => {
    const pts = flattenPath(brushGlyph(path, 10, 42, { entry: 0, wobble: 0 }), 0.001)[0].pts;
    const tip = Math.max(...pts.map(p => p.y));
    expect(tip).toBeGreaterThan(10.2);
    expect(tip).toBeLessThanOrEqual(10 + 1.5 * 0.3);
    expect(widthAt(pts, tip - 0.03)).toBeLessThan(0.15);
    expect(widthAt(pts, 9.7)).toBeLessThan(0.75);
    expect(widthAt(pts, 5)).toBeCloseTo(1.5);
    for (const y of [1, 3, 5, 7, 8]) expect(widthAt(pts, y)).toBeGreaterThanOrEqual(1.5 * 0.95);
    const speed = flattenPath(brushGlyph(path, 10, 42, { style: "speed", entry: 0, wobble: 0 }), 0.001)[0].pts;
    expect(Math.max(...speed.map(p => p.y))).toBeGreaterThan(tip);
    expect(widthAt(speed, 8.5)).toBeLessThan(widthAt(pts, 8.5));
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
