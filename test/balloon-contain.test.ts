import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import type { BalloonPlan } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import type { Vec } from "../src/geom/vec.js";
import { boundsOf } from "../src/geom/vec.js";
import { flattenPath } from "../src/geom/path.js";
import { bodyPolygon, containBalloon, containsBalloon, polygonFits, warnBalloonInGutter } from "../src/render/balloon-contain.js";
import type { Node } from "../src/render/ir.js";

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
