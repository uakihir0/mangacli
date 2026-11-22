import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon, type BalloonPlan } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import type { Vec } from "../src/geom/vec.js";
import { boundsOf } from "../src/geom/vec.js";
import { flattenPath } from "../src/geom/path.js";
import { autoEdgeCutFits, bodyPolygon, containBalloon, containsBalloon, polygonFits, warnBalloonInGutter } from "../src/render/balloon-contain.js";
import type { Node } from "../src/render/ir.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { RefRegistry } from "../src/layout/place.js";
import { resolveDocument } from "../src/model/resolve.js";
import { join } from "node:path";

const rect = (x: number, y: number, w: number, h: number): Vec[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function context(poly = rect(0, 0, 50, 50)): ElemCtx {
  return { panel: { panel: { props: { border: { width: "0.5mm" } } } }, panelPoly: poly, u: { units: "mm", dpi: 300, k: 1 }, bag: new DiagnosticBag() } as ElemCtx;
}
function plan(w = 10, h = 10, props: Record<string, unknown> = {}): BalloonPlan {
  const p = { contain: "panel", clip: "auto", ...props };
  return { el: { id: "b", type: "balloon", props: p, path: [] }, props: p, body: { contour: { pts: rect(-w / 2, -h / 2, w, h) } }, outer: { x: -w / 2, y: -h / 2, w, h }, center: { x: 25, y: 25 }, text: { plain: "", width: 0, height: 0, fontSize: 4, lines: [] }, textOffset: { x: 0, y: 0 }, innerCenter: { x: 0, y: 0 } } as unknown as BalloonPlan;
}
function nodes(list: Node[]): Node[] {
  return list.flatMap(n => [n, ...(n.kind === "group" ? nodes(n.children) : [])]);
}

describe("panel balloon containment geometry", () => {
  it("moves to the nearest rectangular inset without changing an already fitting body", () => {
    const p = plan();
    p.center = { x: 2, y: 25 };
    containBalloon(p, context(), () => null);
    expect(p.center).toEqual({ x: 5.55, y: 25 });
    containBalloon(p, context(), () => { throw new Error("unnecessary replan"); });
    expect(p.center).toEqual({ x: 5.55, y: 25 });
  });
  it.each([
    [{ x: 0, y: 0 }, { x: 50, y: 15 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
    [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 50 }, { x: 0, y: 50 }],
  ])("moves bodies inside slanted and concave polygons", (...poly) => {
    const ctx = context(poly);
    const p = plan();
    p.center = { x: 28, y: 22 };
    containBalloon(p, ctx, () => null);
    expect(polygonFits(bodyPolygon(p), poly, 0.54)).toBe(true);
  });
  it("rejects an edge spanning a concave notch even when all vertices are inside", () => {
    const panel = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 50 }, { x: 0, y: 50 }];
    expect(polygonFits(rect(10, 10, 30, 30), panel)).toBe(false);
  });
  it("keeps an explicit edge cut and shifts text inward", () => {
    const p = plan(30, 30, { at: ["0%", "50%"] });
    p.explicit = true;
    p.center = { x: 0, y: 25 };
    Object.assign(p.text, { plain: "hello", width: 4, height: 6 });
    containBalloon(p, context(), () => null);
    expect(p.center).toEqual({ x: 0, y: 25 });
    expect(p.edgeCut).toBe(true);
    expect(p.textOffset.x).toBeGreaterThanOrEqual(5.2);
  });
  it("rewraps before shrinking and honors the font floor", () => {
    const p = plan(80, 80, { minFontScale: 0.8 });
    const attempted: number[] = [];
    containBalloon(p, context(), props => {
      attempted.push(props.fontScale as number);
      const q = plan((props.fontScale as number) <= 0.8 ? 20 : 80, 20);
      return q;
    });
    expect(attempted[0]).toBe(1);
    expect(Math.min(...attempted)).toBe(0.8);
    expect(p.outer.w).toBe(20);
  });
  it("warns if no reflow fits without silently discarding dialogue", () => {
    const ctx = context();
    const p = plan(80, 80);
    p.text.plain = "unabridged dialogue";
    containBalloon(p, ctx, () => null);
    expect(ctx.bag.items.map(d => d.code)).toContain("BALLOON_NO_SPACE");
    expect(p.text.plain).toBe("unabridged dialogue");
  });
  it("preserves a separated position and warns when occupied space leaves no room", () => {
    const ctx = context();
    const p = plan();
    containBalloon(p, ctx, () => null, [{ x: 0, y: 0, w: 10, h: 10 }]);
    expect(p.center).toEqual({ x: 25, y: 25 });
    expect(ctx.bag.items).toEqual([]);
    p.text.plain = "unabridged dialogue";
    containBalloon(p, ctx, () => null, [{ x: 0, y: 0, w: 50, h: 50 }]);
    expect(ctx.bag.items.map(d => d.code)).toContain("BALLOON_NO_SPACE");
    expect(p.text.plain).toBe("unabridged dialogue");
  });
  it.each([{ contain: "none" }, { clip: "none" }, { clip: { to: "panel", open: ["top"] } }, { clip: { to: ["a", "b"] } }, { bridge: true }])("preserves intentional overflow: %j", props => {
    const ctx = context();
    const p = plan(80, 80, props);
    expect(containsBalloon(p.el, ctx)).toBe(false);
    containBalloon(p, ctx, () => { throw new Error("opt-out replanned"); });
    warnBalloonInGutter(p.el, bodyPolygon(p), ctx);
    expect(ctx.bag.items).toEqual([]);
  });
  it("leaves page-level balloons alone", () => {
    const ctx = { ...context(), panel: undefined, panelPoly: undefined };
    expect(containsBalloon(plan().el, ctx)).toBe(false);
  });
  it("warns for uncontained accidental ink, but not panel-clipped ink", () => {
    const ctx = context();
    const p = plan(80, 80, { contain: undefined });
    warnBalloonInGutter(p.el, bodyPolygon(p), ctx);
    expect(ctx.bag.items.map(d => d.code)).toEqual(["BALLOON_IN_GUTTER"]);
    p.el.props.clip = "panel";
    warnBalloonInGutter(p.el, bodyPolygon(p), ctx);
    expect(ctx.bag.items).toHaveLength(1);
  });
});

describe("contained balloon composition", () => {
  const renderer = createRenderer({ profile: "preview", dpi: 72 });
  it.each(["flow", "auto"])("keeps %s balloons separated after slanted-panel containment", async mode => {
    const list = await renderer.displayList({ yaml: `mangacli: 1
page: { size: [120mm, 120mm], bleed: 0mm }
pages:
  - panels:
      - polygon: [[0%, 0%], [100%, 70%], [100%, 100%], [0%, 100%]]
        layers:
${[1, 2, 3, 4].map(i => `          - { id: dialogue-${i}, balloon: 台詞, autoPlace: ${mode}, size: [20mm, 20mm], hand: clean, shape: rect, tail: none }`).join("\n")}
` }, 1);
    const bodies = nodes([list.root]).flatMap(n => n.kind === "path" && n.paint && n.tag?.elementType === "balloon" && n.tag.role === "fill" ? [boundsOf(flattenPath(n.path)[0].pts)] : []);
    expect(bodies).toHaveLength(4);
    for (let i = 0; i < bodies.length; i++) for (const b of bodies.slice(i + 1)) {
      const a = bodies[i];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(0);
    }
  });
  it("preserves reverse balloon order and stacking above page artwork", async () => {
    const list = await renderer.displayList({ yaml: `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm }
pages:
  - panels:
      - layers:
          - { id: first, balloon: 一, at: [50%, 50%], size: [30mm, 30mm], tail: none }
          - { id: second, balloon: 二, at: [55%, 55%], size: [30mm, 30mm], tail: none }
    layers:
      - { id: overlay, effect: focus-lines }
` }, 1);
    const order = nodes([list.root]).flatMap(n => n.tag?.elementId ? [n.tag.elementId] : []);
    expect(order.lastIndexOf("first")).toBeGreaterThan(order.lastIndexOf("second"));
    expect(order.indexOf("second")).toBeGreaterThan(order.lastIndexOf("overlay"));
  });
  it("keeps every automatically placed gallery body whole", async () => {
    const list = await renderer.displayList(join(import.meta.dirname, "fixtures", "balloons.yaml"), 1);
    const panels = nodes([list.root]).filter(n => n.kind === "group" && n.clip);
    let bodies = 0;
    for (const panel of panels) {
      if (panel.kind !== "group" || !panel.clip) continue;
      const polygon = flattenPath(panel.clip)[0].pts;
      for (const n of nodes(panel.children)) {
        if (n.kind !== "path" || n.tag?.elementType !== "balloon" || n.tag.role !== "fill" || !n.paint) continue;
        for (const contour of flattenPath(n.path)) {
          bodies++;
          expect(polygonFits(contour.pts, polygon), n.tag.elementId).toBe(true);
        }
      }
    }
    expect(bodies).toBeGreaterThan(10);
  });
  it("does not paint the neighboring panel, including a tail aimed outside", async () => {
    const result = await renderer.render({ yaml: `mangacli: 1
page: { size: [120mm, 90mm], bleed: 0mm }
pages:
  - layout: { rows: [[1, 1]] }
    panels:
      - id: pn-right
        background: '#dddddd'
        layers:
          - { balloon: テスト, at: [0%, 50%], anchor: center, size: [26mm, 34mm], tail: { to: [-50%, 50%] } }
      - { id: pn-left, background: black }
` }, { keepLists: true });
    const group = nodes([result.lists![0].root]).find(n => n.kind === "group" && n.clip && n.tag?.elementId === "pn-right");
    expect(group?.kind).toBe("group");
    if (group?.kind !== "group" || !group.clip) throw new Error("panel clip missing");
    const box = boundsOf(flattenPath(group.clip)[0].pts);
    const { data, info } = await sharp(result.pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const x = Math.round((box.x - 5) * 72 / 25.4);
    const y = Math.round((box.y + box.h / 2) * 72 / 25.4);
    expect(data[(y * info.width + x) * info.channels]).toBeLessThan(20);
  });
  it.each(["at: [0%, 50%]", "autoPlace: auto", "autoPlace: flow"])("clips body and tails below the frame: %s", async placement => {
    const result = await renderer.render({ yaml: `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm }
pages:
  - panels:
      - polygon: [[0%, 0%], [100%, 20%], [100%, 100%], [0%, 100%]]
        layers:
          - balloon: テスト
            id: b
            ${placement}
            size: [25mm, 30mm]
            tail: { to: [120%, 50%] }
` }, { layoutOnly: true, keepLists: true });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const all = nodes([result.lists![0].root]);
    const clipped = all.filter(n => n.kind === "group" && n.clip && nodes(n.children).some(c => c.tag?.elementId === "b"));
    expect(clipped.length).toBeGreaterThan(0);
    expect(result.diagnostics.some(d => d.code === "BALLOON_IN_GUTTER")).toBe(false);
  });
});

describe("automatic edge-cut eligibility", () => {
  const fonts = new FontRegistry(new Map() as never, "manga-basic", [], {});
  async function candidate(props: Record<string, unknown> = {}, center = { x: 25, y: 7 }) {
    const ctx = { ...context(), fonts, coordsBox: { x: 0, y: 0, w: 50, h: 50 }, refs: new RefRegistry(() => ["mouth"]), lang: "ja", defaultLang: "ja", draft: false } as ElemCtx;
    const doc = resolveDocument({ seed: 42, pages: [{ layers: [{ type: "balloon", id: "b", text: "あ", size: ["20mm", "20mm"], hand: "clean", shape: { kind: "ellipse", irregularity: 0 }, tail: { kind: "none" }, ...props }] }] }, ctx.bag);
    const el = doc.pages[0].layers[0];
    await fonts.prepare(el.props.font as string, "あ");
    const p = planBalloon(el, ctx);
    p.center = center;
    return { p, ctx };
  }
  it("accepts a shallow slice but rejects a deep cut", async () => {
    const { p, ctx } = await candidate();
    expect(autoEdgeCutFits(p, ctx, false)).toBe(true);
    p.center!.y = 4;
    expect(autoEdgeCutFits(p, ctx, false)).toBe(false);
  });
  it.each(["wedge", "bubbles", "line", "zigzag"])("keeps %s tail and root inside", async kind => {
    const inside = await candidate({ tail: { kind, direction: "90deg", length: "5mm" } });
    expect(autoEdgeCutFits(inside.p, inside.ctx, false)).toBe(true);
    const outside = await candidate({ tail: { kind, direction: "-90deg", length: "15mm" } });
    expect(autoEdgeCutFits(outside.p, outside.ctx, false)).toBe(false);
  });
  it("uses stricter corner limits and excludes diamonds", async () => {
    const rounded = await candidate({}, { x: 8.5, y: 8.5 });
    expect(autoEdgeCutFits(rounded.p, rounded.ctx, true)).toBe(true);
    rounded.p.center = { x: 7, y: 7 };
    expect(autoEdgeCutFits(rounded.p, rounded.ctx, true)).toBe(false);
    const diamond = await candidate({ shape: { kind: "polygon", points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] } }, { x: 8.5, y: 8.5 });
    expect(autoEdgeCutFits(diamond.p, diamond.ctx, true)).toBe(false);
  });
  it("rejects insufficient text clearance", async () => {
    const { p, ctx } = await candidate();
    p.textOffset.y = -4;
    expect(autoEdgeCutFits(p, ctx, false)).toBe(false);
  });
});
