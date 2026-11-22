import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { pointInPolygon } from "../src/geom/path.js";
import { resolveDocument } from "../src/model/resolve.js";

const fonts = new FontRegistry(new Map() as never, "manga-basic", [], {});

async function plan(props: Record<string, unknown> = {}, w = 180, h = 35) {
  const bag = new DiagnosticBag();
  const doc = resolveDocument({ seed: 42, pages: [{ layers: [{ type: "balloon", id: "b", as: "scream", text: "あああああ", writing: "vertical", fontSize: "5mm", tail: { kind: "none" }, ...props }] }] }, bag);
  const el = doc.pages[0].layers[0];
  await fonts.prepare(el.props.font as string, el.props.text as string);
  const ctx = { u: { units: "mm", dpi: 600, k: 80 / 182 }, coordsBox: { x: 0, y: 0, w, h }, bag, fonts, lang: "ja", defaultLang: "ja", draft: false } as ElemCtx;
  return { plan: planBalloon(el, ctx), bag };
}

describe("short-panel spiky balloon fallback", () => {
  it.each(["shout", "scream"])("fits %s including spikes without sacrificing the font floor", async (as) => {
    const { plan: p, bag } = await plan({ as });
    expect(p.outer.w).toBeLessThanOrEqual(135.01);
    expect(p.outer.h).toBeLessThanOrEqual(28.01);
    expect(p.fontScaleApplied).toBeGreaterThanOrEqual(0.75);
    expect(p.text.fontSize).toBeGreaterThanOrEqual(5 * (as === "scream" ? 1.5 : 1.4) * 0.75);
    expect(p.params.depth === undefined || Number(p.params.depth) >= 0.14).toBe(true);
    expect(bag.items.some(d => d.code === "BALLOON_TOO_LARGE")).toBe(false);
    for (const line of p.text.lines) {
      const r = line.rect;
      for (const x of [r.x, r.x + r.w]) for (const y of [r.y, r.y + r.h]) {
        expect(pointInPolygon({ x: x - p.text.width / 2 + p.innerCenter.x, y: y - p.text.height / 2 + p.innerCenter.y }, p.body.inner)).toBe(true);
      }
    }
  });

  it("preserves explicit spike depth, even when it cannot fit", async () => {
    const { plan: p, bag } = await plan({ shape: { kind: "burst", depth: 0.9 } }, 20, 10);
    expect(p.params.depth).toBe(0.9);
    expect(bag.items.some(d => d.code === "BALLOON_TOO_LARGE")).toBe(true);
  });

  it("leaves already-fitting, fixed-size and explicit-overflow balloons unchanged", async () => {
    const fitting = await plan({}, 180, 200);
    const original = await plan({ overflow: "grow" }, 180, 200);
    expect(fitting.plan.outer).toEqual(original.plan.outer);
    expect(fitting.plan.body).toEqual(original.plan.body);
    expect(fitting.plan.text).toEqual(original.plan.text);
    for (const props of [{ size: ["40mm", "40mm"] }, { overflow: "grow" }, { overflow: "error" }, { overflow: "clip" }, { overflow: "shrink" }]) {
      const { plan: p } = await plan(props);
      expect(p.params.depth).toBeUndefined();
      expect(p.base.w / p.base.h).toBeLessThanOrEqual(1.8);
    }
  });

  it("handles empty text and diagnoses an impossible text core", async () => {
    const empty = await plan({ text: "" });
    expect(Number.isFinite(empty.plan.outer.w + empty.plan.outer.h)).toBe(true);
    expect(empty.bag.items.some(d => d.code === "BALLOON_TOO_LARGE")).toBe(false);
    const impossible = await plan({}, 5, 5);
    expect(impossible.bag.items.some(d => d.code === "BALLOON_TOO_LARGE")).toBe(true);
  });

  it.each(["shout", "scream"])("places %s wholly inside a short panel", async (as) => {
    const r = await render({ mangacli: 1, seed: 42, page: { size: ["200mm", "80mm"], bleed: 0, baseFrame: "trim" }, pages: [{ panels: [{ id: "short", box: ["10mm", "15mm", "180mm", "35mm"], layers: [{ balloon: "あああああ", id: "b", as, writing: "vertical", fontSize: "5mm", tail: { kind: "none" } }] }] }] }, { format: "svg" });
    const b = r.layout[0].elements.find(e => e.id === "b")!.bbox;
    expect(b.x).toBeGreaterThanOrEqual(10);
    expect(b.y).toBeGreaterThanOrEqual(15);
    expect(b.x + b.w).toBeLessThanOrEqual(190);
    expect(b.y + b.h).toBeLessThanOrEqual(50);
    expect(r.diagnostics.some(d => d.code === "BALLOON_TOO_LARGE")).toBe(false);
  });
});
