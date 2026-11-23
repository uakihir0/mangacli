import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { polygonArea } from "../src/geom/path.js";
import { computePageGeom, layoutPanels } from "../src/layout/page.js";
import { resolveDocument } from "../src/model/resolve.js";
import { bodyPolygon, containBalloon, polygonFits } from "../src/render/balloon-contain.js";
import type { BalloonPlan } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";

const settings = { size: ["100mm", "100mm"], baseFrame: "trim", bleed: "3mm", gutter: "4mm" };
function layout(props: Record<string, unknown>[] = [{ dominant: true }, {}], spec: unknown = { rows: [{}, {}] }) {
  const bag = new DiagnosticBag();
  const doc = resolveDocument({ mangacli: 1, page: settings, pages: [{ layout: spec, panels: props }] }, bag);
  const geom = computePageGeom(doc.pages[0], 1, {}, bag);
  return { panels: layoutPanels(doc.pages[0], geom, bag), bag, geom };
}

describe("dominant panels", () => {
  it("automatically bleeds only layout edges and honors both overrides", () => {
    const automatic = layout();
    expect(automatic.panels[0].bledSides.sort()).toEqual(["left", "right", "top"]);
    expect(automatic.bag.items.some((d) => d.code === "LAYOUT_BLEED_NOT_ON_EDGE")).toBe(false);
    expect(layout([{ dominant: { bleed: ["top"] } }, {}]).panels[0].bledSides).toEqual(["top"]);
    expect(layout([{ dominant: { bleed: "all" }, bleed: false }, {}]).panels[0].bledSides).toEqual([]);
    expect(layout([{ dominant: { bleed: false } }, {}]).panels[0].bledSides).toEqual([]);
  });
  it.each([0, 10])("moves an interior edge along its normal and preserves the gap (slant %s)", (slant) => {
    const spec = { rows: [{ slant: `${slant}mm` }, {}] };
    const before = layout([{ bleed: false }, {}], spec);
    const after = layout([{ dominant: { overlap: "8mm", bleed: false } }, {}], spec);
    const a = before.panels[0].polygon.find((_, i) => before.panels[0].edgeSides[i] === null)!;
    const i = before.panels[0].polygon.indexOf(a);
    const b = before.panels[0].polygon[(i + 1) % before.panels[0].polygon.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const distance = (p: { x: number; y: number }) => ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len;
    expect(Math.max(...after.panels[0].polygon.map(distance))).toBeCloseTo(8);
    expect(Math.min(...after.panels[1].polygon.map(distance))).toBeCloseTo(12);
    expect(after.bag.hasErrors).toBe(false);
  });
  it.each([
    { rows: [{}, {}] },
    { split: { line: [["0%", "20%"], ["100%", "75%"]] }, children: ["panel", "panel"] },
    "free",
  ])("preserves original reading order for %j", (spec) => {
    const props = spec === "free" ? [{ box: ["0mm", "0mm", "100mm", "48mm"] }, { box: ["0mm", "52mm", "100mm", "48mm"] }] : [{}, {}];
    const before = layout(props, spec);
    const after = layout([{ ...props[0], dominant: { overlap: "8mm" } }, props[1]], spec);
    expect(after.panels.map((p) => p.order)).toEqual(before.panels.map((p) => p.order));
    expect(layout([{ ...props[0], dominant: { overlap: "8mm" }, order: 2 }, { ...props[1], order: 1 }], spec).panels.map((p) => p.order)).toEqual([2, 1]);
  });
  it("warns for multiple dominants, but not an empty page", () => {
    expect(layout([{ dominant: true }, { dominant: true }]).bag.items.map((d) => d.code)).toContain("LAYOUT_DOMINANT_MULTIPLE");
    expect(layout([{}, {}]).bag.items.map((d) => d.code)).not.toContain("LAYOUT_DOMINANT_MULTIPLE");
  });
  it("reports a neighbour consumed by overlap", () => {
    expect(layout([{ dominant: { overlap: "100mm" } }, {}]).bag.items.map((d) => d.code)).toContain("LAYOUT_DEGENERATE_PANEL");
  });
  it("does not clip a distant panel behind the immediate neighbour", () => {
    const spec = { rows: [{}, {}, {}] };
    const before = layout([{}, {}, {}], spec);
    const after = layout([{ dominant: { overlap: "8mm", bleed: false } }, {}, {}], spec);
    expect(after.panels[2].polygon).toEqual(before.panels[2].polygon);
  });
  it("allows concave neighbours and keeps the largest piece after splitting", () => {
    const concave = layout([{ box: ["40mm", "0mm", "20mm", "40mm"], dominant: { overlap: "8mm", bleed: false } }, { box: ["0mm", "44mm", "100mm", "56mm"] }], "free");
    expect(concave.panels[1].polygon.length).toBeGreaterThan(4);
    expect(concave.bag.hasErrors).toBe(false);
    const split = layout([{ box: ["40mm", "0mm", "20mm", "70mm"], dominant: { overlap: "26mm", bleed: false } }, { box: ["0mm", "74mm", "100mm", "26mm"] }], "free");
    expect(split.bag.items.map((d) => d.code)).toContain("LAYOUT_DOMINANT_SPLIT");
    expect(split.panels[1].fullBox.w).toBeCloseTo(10);
  });
  it("expands a column slant while staying within unbled layout edges", () => {
    const spec = { rows: [{ cols: [1, 1], colSlant: ["10mm"] }] };
    const before = layout([{}, {}], spec);
    const after = layout([{ dominant: { overlap: "8mm", bleed: false } }, {}], spec);
    expect(Math.abs(polygonArea(after.panels[0].polygon))).toBeGreaterThan(Math.abs(polygonArea(before.panels[0].polygon)));
    for (const p of after.panels[0].polygon) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  });
  it("keeps a balloon body in a clipped neighbour", () => {
    const { panels, bag, geom } = layout([{ dominant: { overlap: "12mm", bleed: false } }, {}], { rows: [{ slant: "12mm" }, {}] });
    const poly = panels[1].polygon;
    expect(Math.abs(polygonArea(poly))).toBeGreaterThan(0);
    const body = [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }];
    const plan = { el: { id: "b", type: "balloon", props: {}, path: [] }, props: { contain: "panel", clip: "panel" }, body: { contour: { pts: body } }, outer: { x: -5, y: -5, w: 10, h: 10 }, center: { x: 50, y: 50 }, text: { plain: "", width: 0, height: 0, fontSize: 4, lines: [] }, textOffset: { x: 0, y: 0 }, innerCenter: { x: 0, y: 0 } } as unknown as BalloonPlan;
    const ctx = { panel: panels[1], panelPoly: poly, bag, u: geom.units } as ElemCtx;
    plan.el.props = plan.props;
    containBalloon(plan, ctx, () => null);
    expect(polygonFits(bodyPolygon(plan), poly, 0.3)).toBe(true);
  });
  it("renders a flashback neighbour beside a dominant diagonal panel", async () => {
    const result = await render({ mangacli: 1, page: settings, pages: [{ layout: { split: { line: [["0%", "20%"], ["100%", "75%"]] }, children: ["panel", "panel"] }, panels: [{ dominant: { overlap: "8mm" } }, { mood: "flashback" }] }] }, { profile: "preview", format: "png", width: 300 });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.pages[0].data.length).toBeGreaterThan(0);
  });
});
