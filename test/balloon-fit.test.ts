import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath, pointInPolygon } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import { resolveDocument } from "../src/model/resolve.js";
import type { Node, PathNode } from "../src/render/ir.js";

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
    expect(p.base.w / p.base.h).toBeLessThanOrEqual(3.5);
    expect(p.outer.w * p.outer.h).toBeLessThan(p.text.width * p.text.height * 5);
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

  it("preserves an explicit aspect ratio during fallback", async () => {
    const { plan: p } = await plan({ aspect: 1 });
    expect(p.base.w / p.base.h).toBeCloseTo(1);
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

  it.each([["shout", "あああああ"], ["scream", "あああああ"], ["scream", "うわあああっ！！"]])("places %s %s wholly inside a short panel", async (as, text) => {
    const r = await render({ mangacli: 1, seed: 42, page: { size: ["200mm", "80mm"], bleed: 0, baseFrame: "trim" }, pages: [{ panels: [{ id: "short", box: ["10mm", "15mm", "180mm", "35mm"], layers: [{ balloon: text, id: "b", as, writing: "vertical", fontSize: "5mm", tail: { kind: "none" } }] }] }] }, { format: "svg" });
    const b = r.layout[0].elements.find(e => e.id === "b")!.bbox;
    expect(b.x).toBeGreaterThanOrEqual(10);
    expect(b.y).toBeGreaterThanOrEqual(15);
    expect(b.x + b.w).toBeLessThanOrEqual(190);
    expect(b.y + b.h).toBeLessThanOrEqual(50);
    expect(r.diagnostics.some(d => d.code === "BALLOON_TOO_LARGE")).toBe(false);
  });
});

async function flash(props: Record<string, unknown> = {}, slanted = false) {
  const result = await render({
    mangacli: 1, seed: 42, page: { size: ["100mm", "100mm"], bleed: 0, baseFrame: "trim" },
    pages: [{ panels: [{
      id: "reaction-panel",
      ...(slanted ? { polygon: [["10mm", "10mm"], ["78mm", "20mm"], ["62mm", "70mm"], ["10mm", "70mm"]] } : { box: ["10mm", "10mm", "60mm", "60mm"] }),
      layers: [{ balloon: "！！", id: "b", as: "shock", minSize: ["14mm", "14mm"], at: ["50%", "50%"], ...props }],
    }] }],
  }, { layoutOnly: true, keepLists: true });
  const paths = (nodes: Node[]): PathNode[] => nodes.flatMap(n => n.kind === "group" ? paths(n.children) : n.kind === "path" && n.tag?.elementId === "b" ? [n] : []);
  return { nodes: paths(result.lists![0].root.children), panel: result.layout[0].panels[0].polygon };
}

const points = (node: PathNode) => flattenPath(node.path).flatMap(q => q.pts);

describe("lone reaction flash", () => {
  it.each([["！！", "vertical"], ["!?", "horizontal"], ["？", "vertical"], ["<b>⁉</b>", "vertical"]])("sizes %s ink to its core in %s writing", async (balloon, writing) => {
    const { nodes } = await flash({ balloon, writing });
    const text = nodes.find(n => n.tag?.role === "text")!;
    const core = boundsOf(points(nodes.find(n => n.tag?.role === "fill")!));
    const ink = boundsOf(points(text));
    expect(text.stroke?.width).toBeGreaterThan(0);
    expect(Math.max(ink.w / core.w, ink.h / core.h)).toBeCloseTo(0.72, 1);
    expect((ink.x + ink.w / 2) - (core.x + core.w / 2)).toBeCloseTo(0, 1);
    expect((ink.y + ink.h / 2) - (core.y + core.h / 2)).toBeCloseTo(0, 1);
  });

  it("retains explicit sizing and weight and leaves non-reactions alone", async () => {
    const normal = await flash({ fontScale: 1, weight: 400 });
    const original = normal.nodes.find(n => n.tag?.role === "text")!;
    expect(original.stroke).toBeUndefined();
    expect(boundsOf(points(original)).h).toBeLessThan(5);
    for (const props of [{ balloon: "あっ！！" }, { balloon: "……" }, { as: "say" }]) {
      const { nodes } = await flash(props);
      expect(nodes.find(n => n.tag?.role === "text")?.stroke).toBeUndefined();
    }
  });

  it.each([["auto", false], ["panel", true]])("keeps all rays inside clip: %s near a panel corner", async (clip, slanted) => {
    const { nodes, panel } = await flash({ at: ["99%", "2%"], clip }, slanted);
    const rays = points(nodes.find(n => n.tag?.role === "ink")!);
    expect(rays.length).toBeGreaterThan(0);
    expect(rays.every(p => pointInPolygon(p, panel))).toBe(true);
  });

  it("honors an explicit request to put the flash over the frame", async () => {
    const { nodes, panel } = await flash({ at: ["99%", "2%"], clip: "none" });
    const rays = points(nodes.find(n => n.tag?.role === "ink")!);
    expect(rays.some(p => !pointInPolygon(p, panel))).toBe(true);
  });
});
