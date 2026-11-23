import { describe, expect, it, vi } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon, renderBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { pointInPolygon, rayPolygon } from "../src/geom/path.js";
import { type Vec, boundsOf, cross, dist, rot, sub } from "../src/geom/vec.js";
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

function outlineIntersects(pts: Vec[]): boolean {
  const orient = (a: Vec, b: Vec, p: Vec) => cross(sub(b, a), sub(p, a));
  return pts.some((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return pts.slice(i + 2).some((c, j) => {
      const d = pts[(i + j + 3) % pts.length];
      return orient(a, b, c) * orient(a, b, d) < -1e-14 && orient(c, d, a) * orient(c, d, b) < -1e-14;
    });
  });
}

function expectOutwardTail(outline: shape.ShapeContour, body: Vec[]) {
  const { pts, corners } = outline;
  const roots = corners?.filter(c => c.kind === "concave").map(c => c.index) ?? [];
  expect(roots).toHaveLength(2);
  expect(corners?.filter(c => c.kind === "point")).toHaveLength(1);
  expect(pts.slice(Math.max(...roots) + 1).some(p => pointInPolygon(p, body))).toBe(false);
  expect(outlineIntersects(pts)).toBe(false);
}

describe("physical spike tail fitting", () => {
  it("falls back to an outward tail instead of a notch for a short bent burst tail", async () => {
    const { plan, ctx } = await setup();
    plan.body = BODY_GENERATORS.burst(120, 24, { kind: "burst", irregularity: 0, egg: 0, tilt: 0 }, 42);
    const body = plan.body.contour.pts;
    plan.outer = boundsOf(body);
    plan.props.tail = { kind: "wedge", direction: "80deg", allowVertical: true, bend: -0.7, length: "0.3mm" };
    const ink = vi.spyOn(shape, "inkShape");
    try {
      renderBalloon(plan, ctx);
      expectOutwardTail(ink.mock.calls[0][0], body);
      expect(ctx.bag.items.some(d => d.code === "BALLOON_TAIL_NO_CLEAR_BASE")).toBe(true);
    } finally {
      ink.mockRestore();
    }
  });
  it("warns when an explicitly short burst tail would end inside a neighbouring spike", async () => {
    const { plan, ctx } = await setup();
    plan.body = BODY_GENERATORS.burst(120, 24, { kind: "burst", irregularity: 0, egg: 0, tilt: 0 }, 42);
    const body = plan.body.contour.pts;
    plan.outer = boundsOf(body);
    const dir = rot({ x: 1, y: 0 }, Math.PI / 6);
    const hit = rayPolygon({ x: 0, y: 0 }, dir, body)!;
    expect(pointInPolygon({ x: dir.x * (hit.t + 0.3), y: dir.y * (hit.t + 0.3) }, body)).toBe(true);
    plan.props.tail = { kind: "wedge", direction: "30deg", allowVertical: true, length: "0.3mm" };
    const ink = vi.spyOn(shape, "inkShape");
    try {
      renderBalloon(plan, ctx);
      expectOutwardTail(ink.mock.calls[0][0], body);
      expect(ctx.bag.items).toContainEqual(expect.objectContaining({ code: "BALLOON_TAIL_NO_CLEAR_BASE", severity: "warning" }));
    } finally {
      ink.mockRestore();
    }
  });

  it.each([[15, true], [90, false]] as const)("keeps a bent burst tail at %i° from crossing the outline", async (angle, fallback) => {
    const { plan, ctx } = await setup();
    plan.body = BODY_GENERATORS.burst(120, 24, { kind: "burst", irregularity: 0, egg: 0, tilt: 0 }, 42);
    plan.outer = boundsOf(plan.body.contour.pts);
    plan.props.tail = { kind: "wedge", direction: `${angle}deg`, allowVertical: true, bend: 0.7 };
    const ink = vi.spyOn(shape, "inkShape");
    try {
      renderBalloon(plan, ctx);
      expectOutwardTail(ink.mock.calls[0][0], plan.body.contour.pts);
      expect(ctx.bag.items.some(d => d.code === "BALLOON_TAIL_NO_CLEAR_BASE")).toBe(fallback);
    } finally {
      ink.mockRestore();
    }
  });
  it.each(["spike", "burst"] as const)("preserves a simple %s outline with a tail on a wide balloon", async (kind) => {
    const { plan, ctx } = await setup();
    plan.params.kind = kind;
    plan.body = BODY_GENERATORS[kind](120, 24, { kind, irregularity: 0, egg: 0, tilt: 0 }, 42);
    plan.outer = boundsOf(plan.body.contour.pts);
    expect(outlineIntersects(plan.body.contour.pts)).toBe(false);
    const ink = vi.spyOn(shape, "inkShape");
    try {
      for (const angle of [15, 35, 60, 90, 130, 165]) {
        plan.props.tail = { kind: "wedge", direction: `${angle}deg`, allowVertical: true };
        ink.mockClear();
        renderBalloon(plan, ctx);
        const { pts, corners } = ink.mock.calls[0][0];
        expect(corners?.filter(c => c.kind === "point"), `${angle}°`).toHaveLength(1);
        expect(outlineIntersects(pts), `${angle}°`).toBe(false);
      }
    } finally {
      ink.mockRestore();
    }
  });
  it.each([90, -90])("measures the core and contour in the same frame for a %s degree rotation", async (degrees) => {
    const { plan, ctx } = await setup(80, 30);
    plan.props.rotate = `${degrees}deg`;
    plan.props.tail = { kind: "wedge", direction: "0deg", bend: 0, sideCurve: 0, maxLength: "20mm" };
    const contour = renderBalloon(plan, ctx).contour;
    const coreRight = Math.max(...plan.body.spikeCore!.map(q => rot(q, degrees * Math.PI / 180).x));
    const extension = Math.max(...contour.map(q => q.x)) - coreRight;
    expect(extension).toBeCloseTo(plan.body.spikeLength! * 2.25, 1);
  });
  it.each(["spike", "burst"] as const)("aims one longer, narrow %s tail without moving the other tips", async (kind) => {
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
      expect(dist(roots[0], roots[1])).toBeLessThanOrEqual(1.3 * ctx.u.k);
      expect(dist(roots[0], roots[1])).toBeGreaterThan(1.29 * ctx.u.k);
      expect(dist(roots[0], roots[1])).toBeLessThan(baseWidth);
      expect(valleys.every(valley => pts.some(p => dist(p, valley) < 1e-8))).toBe(true);
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
    const ink = vi.spyOn(shape, "inkShape");
    try {
      renderBalloon(plan, ctx);
      const { pts, corners } = ink.mock.calls[0][0];
      const tip = pts[corners!.find(c => c.kind === "point")!.index];
      const reach = tip.x * dir.x + tip.y * dir.y - radius;
      expect(reach).toBeLessThanOrEqual((target === "face" ? 6.5 : 6) + 1e-6);
    } finally {
      ink.mockRestore();
    }
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
