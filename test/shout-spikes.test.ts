import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { pointInPolygon } from "../src/geom/path.js";
import { resolveDocument } from "../src/model/resolve.js";
import { BODY_GENERATORS } from "../src/shapes/balloon.js";

describe("shout contours", () => {
  it.each(["spike", "burst"])("gives %s a seeded rhythm of short and accent spikes outside the text core", (kind) => {
    const make = (seed: number) => BODY_GENERATORS[kind](40, 40, { kind, irregularity: 0, egg: 0, tilt: 0, count: 20 }, seed);
    const body = make(42);
    expect(make(42)).toEqual(body);
    expect(make(43).contour.pts).not.toEqual(body.contour.pts);
    const tips = body.contour.corners!.filter((c) => c.kind === "tip").map((c) => body.contour.pts[c.index]);
    const depths = tips.map((q) => Math.hypot(q.x, q.y) - 20);
    const sorted = [...depths].sort((a, b) => a - b);
    expect(sorted.at(-1)!).toBeGreaterThan(sorted[10] * 1.5);
    if (kind === "spike") expect(depths.filter((d) => d > 8)).toHaveLength(4);
    expect(depths.filter((d) => d > 8).length).toBeGreaterThanOrEqual(4);
    const angles = tips.map((q) => Math.atan2(q.y, q.x));
    const gaps = angles.map((a, i) => (angles[(i + 1) % angles.length] - a + Math.PI * 2) % (Math.PI * 2));
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(1.4);
    for (const q of body.inner) expect(pointInPolygon(q, body.contour.pts)).toBe(true);
  });

  it.each(["shout", "scream"])("makes %s heavier than speech while honoring explicit widths, including empty text", (as) => {
    const props = (style: string, stroke?: object) => resolveDocument({ pages: [{ layers: [{ type: "balloon", text: "", as: style, ...(stroke ? { stroke } : {}) }] }] }, new DiagnosticBag()).pages[0].layers[0].props;
    const width = (p: Record<string, unknown>) => Number.parseFloat((p.stroke as { width: string }).width);
    expect(width(props(as))).toBeGreaterThanOrEqual(width(props("say")) * 1.5);
    expect(width(props(as, { width: "0.1mm" }))).toBe(0.1);
  });
});
