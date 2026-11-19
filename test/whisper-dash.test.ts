import { afterEach, describe, expect, it, vi } from "vitest";
import { Rng } from "../src/core/random.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
import * as stroke from "../src/ink/stroke.js";

afterEach(() => vi.restoreAllMocks());

describe("dashed tail outlines", () => {
  it.each([[100, 100], [1.6, 100], [100, 1]])("inks pointed contours even with oversized dashes %j", (on, off) => {
    const result = inkShape({ pts: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }], closed: true, corners: [{ index: 1, kind: "point" }] }, {
      hand: HAND_PRESETS.clean, rng: new Rng(1),
      line: { width: 0.2, pen: PEN_PRESETS.marker, style: "dashed", dash: [on, off] },
    });
    expect(result.inks.length).toBeGreaterThan(0);
    expect(result.inks.every((ink) => ink.pts.every((p) => Number.isFinite(p.x + p.y)))).toBe(true);
  });
  it.each([1, 42, 9876])("keeps body width and spacing through a full-width tip (seed %i)", (seed) => {
    const spy = vi.spyOn(stroke, "strokeOutline");
    const tip = { x: 16, y: 5 };
    const result = inkShape({ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, tip, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true, corners: [{ index: 2, kind: "point" }] }, {
      hand: HAND_PRESETS.clean, rng: new Rng(seed), ruler: true,
      line: { width: 0.2, pen: PEN_PRESETS.marker, style: "dashed", dash: [1.6, 1] },
    });
    expect(result.inks.length).toBeGreaterThan(10);
    const calls = spy.mock.calls;
    expect(calls.every(([, options]) => options.width === 0.2)).toBe(true);
    expect(calls[0][0].at(-1)).toEqual(tip);
    expect(calls[1][0][0]).toEqual(tip);
    expect(calls[0][1].taperOutLen).toBe(0);
    expect(calls[1][1].taperInLen).toBe(0);
    const length = (pts: readonly { x: number; y: number }[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
    expect(length(calls[0][0]) + length(calls[1][0])).toBeCloseTo(1.6, 5);
    for (let i = 2; i < calls.length - 1; i++) {
      expect(length(calls[i][0])).toBeCloseTo(1.6, 1);
      const a = calls[i - 1][0].at(-1)!;
      const b = calls[i][0][0];
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      expect(gap).toBeLessThanOrEqual(1 + 1e-8);
      expect(gap).toBeGreaterThan(0.7);
    }
  });

  it("leaves empty ink for disabled outlines", () => {
    expect(inkShape({ pts: [{ x: 0, y: 0 }], closed: false }, { hand: HAND_PRESETS.clean, rng: new Rng(1) }).inks).toEqual([]);
  });
});
