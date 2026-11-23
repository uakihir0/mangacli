import { describe, expect, it, vi } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon, renderBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { rayPolygon } from "../src/geom/path.js";
import { boundsOf, cross, dist, rot } from "../src/geom/vec.js";
import * as shape from "../src/ink/shape.js";
import { RefRegistry } from "../src/layout/place.js";
import { resolveDocument } from "../src/model/resolve.js";
import { BODY_GENERATORS } from "../src/shapes/balloon.js";

async function setup(w = 40, h = 40) {
  const bag = new DiagnosticBag();
  const el = resolveDocument({ seed: 42, pages: [{ layers: [{ type: "balloon", id: "b", text: "", as: "scream", hand: "clean" }] }] }, bag).pages[0].layers[0];
  const fonts = new FontRegistry(new Map() as never, "manga-basic", [], {});
  await fonts.prepare(el.props.font as string, "");
  const ctx = { u: { units: "mm", dpi: 96, k: 1 }, coordsBox: { x: 0, y: 0, w: 182, h: 257 }, refs: new RefRegistry(() => ["mouth"]), bag, fonts, lang: "ja", defaultLang: "ja", draft: false } as ElemCtx;
  const plan = planBalloon(el, ctx);
  plan.body = BODY_GENERATORS.burst(w, h, { kind: "burst", irregularity: 0, egg: 0, tilt: 0, count: 20 }, 42);
  plan.outer = boundsOf(plan.body.contour.pts);
  plan.center = { x: 0, y: 0 };
  return { plan, ctx };
}

describe("physical spike tail fitting", () => {
  it.each([90, -90])("measures the core and contour in the same frame for a %s degree rotation", async (degrees) => {
    const { plan, ctx } = await setup(80, 30);
    plan.props.rotate = `${degrees}deg`;
    plan.props.tail = { kind: "wedge", direction: "0deg", bend: 0, sideCurve: 0, maxLength: "20mm" };
    const contour = renderBalloon(plan, ctx).contour;
    const coreRight = Math.max(...plan.body.spikeCore!.map(q => rot(q, degrees * Math.PI / 180).x));
    const extension = Math.max(...contour.map(q => q.x)) - coreRight;
    expect(extension).toBeCloseTo(plan.body.spikeLength! * 2.25, 1);
  });
  it.each(["spike", "burst"] as const)("aims one longer and wider %s tail without moving the other tips", async (kind) => {
    const { plan, ctx } = await setup();
    plan.params.kind = kind;
    plan.body = BODY_GENERATORS[kind](40, 40, { kind, irregularity: 0, egg: 0, tilt: 0, count: 20 }, 42);
    const original = plan.body.contour;
    const tips = original.corners!.filter(c => c.kind === "tip").map(c => original.pts[c.index]);
    const valleys = original.corners!.filter(c => c.kind === "valley").map(c => original.pts[c.index]);
    const peak = tips[0];
    const baseWidth = dist(valleys[0], valleys[1]);
    const dir = { x: peak.x / Math.hypot(peak.x, peak.y), y: peak.y / Math.hypot(peak.x, peak.y) };
    const target = { x: dir.x * 60, y: dir.y * 60 };
    plan.props.tail = { kind: "wedge", to: [`${target.x}mm`, `${target.y}mm`], allowVertical: true, bend: 0, sideCurve: 0 };
    const ink = vi.spyOn(shape, "inkShape");
    try {
      renderBalloon(plan, ctx);
      const { corners, pts } = ink.mock.calls[0][0];
      const apex = pts[corners!.find(c => c.kind === "point")!.index];
      const roots = corners!.filter(c => c.kind === "concave").map(c => pts[c.index]);
      expect(cross(dir, apex)).toBeCloseTo(0, 7);
      expect(dist(apex, plan.center!)).toBeGreaterThan(dist(peak, plan.center!) + plan.body.spikeLength! * 0.65);
      expect(tips.slice(1).every(tip => pts.some(p => dist(p, tip) < 1e-8))).toBe(true);
      expect(pts.some(p => dist(p, peak) < 1e-8)).toBe(false);
      expect(roots).toHaveLength(2);
      expect(dist(roots[0], roots[1])).toBeGreaterThan(baseWidth * 1.1);
    } finally {
      ink.mockRestore();
    }
  });
  it.each(["face", "bare point"])("preserves the distance clamp before a nearby %s", async (target) => {
    const { plan, ctx } = await setup();
    const valley = plan.body.contour.corners!.filter(c => c.kind === "valley").map(c => plan.body.contour.pts[c.index]).sort((a, b) => Math.abs(Math.atan2(a.y, a.x)) - Math.abs(Math.atan2(b.y, b.x)))[0];
    const radius = Math.hypot(valley.x, valley.y);
    const dir = { x: valley.x / radius, y: valley.y / radius };
    const distance = target === "face" ? 8.5 : 12;
    const mouth = { x: dir.x * (radius + distance), y: dir.y * (radius + distance) };
    const face = { x: mouth.x - 2, y: mouth.y - 2, w: 4, h: 4 };
    ctx.refs.add({ id: "speaker", type: "image", bbox: face, anchors: { mouth }, regions: target === "face" ? { face: { bbox: face, poly: [] } } : {} });
    plan.props.tail = { kind: "wedge", to: "speaker.mouth", root: `${Math.atan2(dir.y, dir.x)}rad`, gap: "0mm", bend: 0, sideCurve: 0 };
    const contour = renderBalloon(plan, ctx).contour;
    const reach = Math.max(...contour.map(q => q.x * dir.x + q.y * dir.y)) - radius;
    expect(reach).toBeLessThanOrEqual((target === "face" ? 6.5 : 6) + 1e-6);
  });
  it("does not extend into the requested gap when a speaker is against a spike", async () => {
    const { plan, ctx } = await setup();
    const hit = rayPolygon(plan.center!, { x: 1, y: 0 }, plan.body.contour.pts)!;
    plan.props.tail = { kind: "none" };
    const body = renderBalloon(plan, ctx).contour;
    plan.props.tail = { kind: "wedge", to: [`${hit.t + 1}mm`, "0mm"], gap: "2mm", bend: 0, sideCurve: 0 };
    expect(renderBalloon(plan, ctx).contour).toEqual(body);
  });
});
