import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderer } from "../src/api.js";
import { Rng } from "../src/core/random.js";
import { pointInPolygon } from "../src/geom/path.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
import * as stroke from "../src/ink/stroke.js";
import * as shape from "../src/ink/shape.js";

afterEach(() => vi.restoreAllMocks());

describe("dashed tail outlines", () => {
  it.each([1, 42, 9876])("closes smooth contours with a full seam gap (seed %i)", (seed) => {
    const spy = vi.spyOn(stroke, "strokeOutline");
    inkShape({ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], closed: true, smooth: true }, {
      hand: HAND_PRESETS.clean, rng: new Rng(seed), ruler: true,
      line: { width: 0.13, pen: PEN_PRESETS.marker, style: "dashed", dash: [0.52, 0.325] },
    });
    const arc = (p: { x: number; y: number }) => p.y === 0 ? p.x : p.x === 10 ? 10 + p.y : p.y === 10 ? 30 - p.x : 40 - p.y;
    const intervals = spy.mock.calls.map(([pts]) => [arc(pts[0]), arc(pts.at(-1)!)]);
    intervals.forEach(([a, b], i) => {
      expect(b - a).toBeGreaterThan(0.4);
      expect(b - a).toBeLessThan(0.65);
      const gap = intervals[(i + 1) % intervals.length][0] + (i === intervals.length - 1 ? 40 : 0) - b;
      expect(gap).toBeGreaterThan(0.25);
      expect(gap).toBeLessThan(0.41);
    });
  });

  it.each(["ellipse", "rect", "cloud"])("uses fine proportional balloon dashes for %s", async (kind) => {
    const spy = vi.spyOn(shape, "inkShape");
    const renderer = createRenderer({ profile: "web" });
    for (const width of [0.2, 0.4]) {
      await renderer.displayList({ yaml: `mangacli: 1
pages:
  - panels:
      - layers:
          - balloon: quiet
            shape: { kind: ${kind} }
            stroke: { style: dashed, width: ${width}mm }
            tail: { kind: none }
`, filename: "/v/dashes.yaml" }, 1);
      const line = spy.mock.calls.filter(([, o]) => o.line?.style === "dashed").at(-1)![1].line!;
      expect(line.width).toBeCloseTo(width * 0.65);
      expect(line.dash![0]).toBeCloseTo(line.width * 4);
      expect(line.dash![1]).toBeCloseTo(line.width * 2.5);
    }
  });

  it("leaves degenerate dashed contours empty", () => {
    expect(inkShape({ pts: [{ x: 0, y: 0 }], closed: true }, {
      hand: HAND_PRESETS.clean, rng: new Rng(1),
      line: { width: 0.2, pen: PEN_PRESETS.marker, style: "dashed" },
    }).inks).toEqual([]);
  });

  it("preserves explicitly configured balloon dash lengths", async () => {
    const spy = vi.spyOn(shape, "inkShape");
    await createRenderer({ profile: "web" }).displayList({ yaml: `mangacli: 1
pages:
  - panels:
      - layers:
          - balloon: quiet
            stroke: { style: dashed, width: 0.2mm, dash: [1mm, 0.5mm] }
            tail: { kind: none }
`, filename: "/v/dashes.yaml" }, 1);
    const line = spy.mock.calls.filter(([, o]) => o.line?.style === "dashed").at(-1)![1].line!;
    expect(line.width).toBeCloseTo(0.13);
    expect(line.dash).toEqual([1, 0.5]);
  });
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
    const contour = [tip, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }];
    const result = inkShape({ pts: contour, closed: true, corners: [{ index: 0, kind: "point" }] }, {
      hand: HAND_PRESETS.clean, rng: new Rng(seed), ruler: true,
      line: { width: 0.2, pen: PEN_PRESETS.marker, style: "dashed", dash: [1.6, 1] },
    });
    expect(result.inks.length).toBeGreaterThan(10);
    const calls = spy.mock.calls;
    expect(calls.every(([, options]) => options.width === 0.2)).toBe(true);
    expect(calls[0][0][0]).toEqual(tip);
    expect(calls[1][0][0]).toEqual(tip);
    expect(calls[0][1].taperInLen).toBe(0);
    expect(calls[1][1].taperInLen).toBe(0);
    const length = (pts: readonly { x: number; y: number }[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
    for (const y of [4.8, 5.2]) {
      expect(result.inks.some((ink) => pointInPolygon({ x: 15.76, y }, ink.pts))).toBe(true);
    }
    const arcAt = (p: { x: number; y: number }) => {
      let best = Infinity, position = 0, offset = 0;
      for (let i = 0; i < contour.length; i++) {
        const a = contour[i], b = contour[(i + 1) % contour.length];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len ** 2));
        const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        if (distance < best) { best = distance; position = offset + t * len; }
        offset += len;
      }
      return position;
    };
    const total = length([...contour, tip]);
    const intervals = calls.map(([pts], i) => {
      const a = arcAt(pts[0]), b = arcAt(pts.at(-1)!);
      return i % 2 === 0 ? [b, a === 0 ? total : a] : [a, b];
    }).sort((a, b) => a[0] - b[0]);
    intervals.forEach(([a, b], i) => {
      expect(b - a).toBeGreaterThan(1.4);
      expect(b - a).toBeLessThan(1.8);
      const next = intervals[(i + 1) % intervals.length][0] + (i === intervals.length - 1 ? total : 0);
      expect(next - b).toBeLessThanOrEqual(1.3);
      expect(next - b).toBeGreaterThanOrEqual(-1e-8);
    });
  });

  it("leaves empty ink for disabled outlines", () => {
    expect(inkShape({ pts: [{ x: 0, y: 0 }], closed: false }, { hand: HAND_PRESETS.clean, rng: new Rng(1) }).inks).toEqual([]);
  });
});
