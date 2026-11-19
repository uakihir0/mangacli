import { describe, expect, it } from "vitest";
import { pointInPolygon } from "../src/geom/path.js";
import { BODY_GENERATORS, type ShapeParams } from "../src/shapes/balloon.js";

const params: ShapeParams = {
  kind: "wavy", irregularity: 0, tilt: 0, squareness: 0, egg: 0,
  waves: 12, amplitude: 0.5, waveform: "irregular",
};
const shape = (seed: number) => BODY_GENERATORS.wavy(40, 40, params, seed);
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

describe("irregular balloon waves", () => {
  it("varies crest spacing and wave depth without changing the number of waves", () => {
    const pts = shape(42).contour.pts;
    const offsets = pts.map(({ x, y }) => Math.hypot(x, y) - 20);
    const crests: number[] = [];
    const troughs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = offsets[(i + pts.length - 1) % pts.length];
      const next = offsets[(i + 1) % pts.length];
      if (offsets[i] > prev && offsets[i] > next) crests.push(i);
      if (offsets[i] < prev && offsets[i] < next) troughs.push(i);
    }
    expect(crests).toHaveLength(params.waves as number);
    expect(troughs).toHaveLength(crests.length);
    const angles = crests.map(i => (Math.atan2(pts[i].y, pts[i].x) + 2 * Math.PI) % (2 * Math.PI));
    const pitches = angles.map((angle, i) => (angles[(i + 1) % angles.length] - angle + 2 * Math.PI) % (2 * Math.PI));
    expect(spread(pitches)).toBeGreaterThan(0.15);
    expect(spread(crests.map(i => offsets[i]))).toBeGreaterThan(0.15);
    expect(spread(troughs.map(i => offsets[i]))).toBeGreaterThan(0.15);
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(0.65);
  });

  it("is seeded and stays smooth across the closing seam", () => {
    const { pts, closed, smooth } = shape(42).contour;
    expect(closed).toBe(true);
    expect(smooth).toBe(true);
    expect(shape(42).contour.pts).toEqual(pts);
    expect(shape(43).contour.pts).not.toEqual(pts);
    const last = pts[pts.length - 1];
    const incoming = Math.atan2(pts[0].y - last.y, pts[0].x - last.x);
    const outgoing = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    expect(Math.abs(incoming - outgoing)).toBeLessThan(0.3);
  });

  it("preserves a text-safe interior when an oversized wave is requested on a narrow balloon", () => {
    const { contour, inner } = BODY_GENERATORS.wavy(6, 25, { ...params, amplitude: 9, tilt: 0.2 }, 42);
    expect(pointInPolygon({ x: 0, y: 0 }, inner)).toBe(true);
    expect(inner.every(p => pointInPolygon(p, contour.pts))).toBe(true);
  });
});
