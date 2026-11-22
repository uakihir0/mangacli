import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon, renderBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { boundsOf } from "../src/geom/vec.js";
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
});
