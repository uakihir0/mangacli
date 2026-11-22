import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { polygonArea } from "../src/geom/path.js";
import { computePageGeom, layoutPanels } from "../src/layout/page.js";
import { resolveDocument } from "../src/model/resolve.js";
import { createRenderer } from "../src/api.js";

const templates = ["impact-diagonal", "cascade", "zoom-in", "splash-with-insets", "vertical-strip", "spread-hero"];
const numbers = [2, 4, 4, 3, 3, 5];
function splitLayout(layout: Record<string, unknown>, rtl = true, count = 2) {
  const bag = new DiagnosticBag();
  const doc = resolveDocument({ mangacli: 1, page: { size: ["100mm", "80mm"], baseFrame: "trim", bleed: 0, gutter: { row: "4mm", col: "2mm" } }, pages: [{ layout, panels: Array.from({ length: count }, () => ({})) }] }, bag);
  const geom = computePageGeom(doc.pages[0], 1, { readingDirection: rtl ? "rtl" : "ltr" }, bag);
  return { panels: layoutPanels(doc.pages[0], geom, bag), bag };
}

describe("diagonal splits", () => {
  it.each([8, -8])("converts %s degree row and column slants to lengths", (angle) => {
    const mm = (span: number) => `${Math.tan(angle * Math.PI / 180) * span}mm`;
    const pairs = [
      [{ rows: [{ slant: `${angle}deg` }, {}] }, { rows: [{ slant: mm(100) }, {}] }],
      [{ rows: [{ cols: [1, 1], colSlant: [`${angle}deg`] }] }, { rows: [{ cols: [1, 1], colSlant: [mm(80)] }] }],
      ...["rows", "cols"].map((split) => [{ split, slant: [`${angle}deg`], children: ["panel", "panel"] }, { split, slant: [mm(split === "rows" ? 100 : 80)], children: ["panel", "panel"] }]),
    ];
    for (const [a, b] of pairs) expect(splitLayout(a).panels.map((p) => p.polygon)).toEqual(splitLayout(b).panels.map((p) => p.polygon));
  });
  it("cuts corner to side with a perpendicular gutter", () => {
    const { panels, bag } = splitLayout({ split: { line: [["0%", "0%"], ["100%", "70%"]] }, children: ["panel", "panel"] });
    expect(bag.hasErrors).toBe(false);
    expect(panels).toHaveLength(2);
    const distance = (p: { x: number; y: number }) => (100 * p.y - 56 * p.x) / Math.hypot(100, 56);
    expect(Math.max(...panels[0].polygon.map(distance))).toBeCloseTo(-2, 8);
    expect(Math.min(...panels[1].polygon.map(distance))).toBeCloseTo(2, 8);
    expect(panels[0].polygon).toHaveLength(3);
  });
  it.each([true, false])("orders vertical cuts and nested T junctions rtl=%s", (rtl) => {
    const vertical = splitLayout({ split: { line: [["40%", "0%"], ["60%", "100%"]] }, children: ["panel", "panel"] }, rtl);
    expect(vertical.bag.hasErrors).toBe(false);
    expect(vertical.panels[0].box.x > vertical.panels[1].box.x).toBe(rtl);
    const nested = splitLayout({ split: "cols", children: [{ split: { line: [["0%", "0%"], ["100%", "70%"]] }, children: ["panel", "panel"] }, "panel"] }, rtl, 3);
    expect(nested.bag.hasErrors).toBe(false);
    expect(nested.panels).toHaveLength(3);
    expect(nested.panels[0].box.x > nested.panels[2].box.x).toBe(rtl);
  });
  it("uses the slanted parent bounding-box height for nested column angles", () => {
    const root = { split: "rows", slant: ["8deg"], children: ["panel", "panel"] };
    const span = splitLayout(root).panels[0].fullBox.h;
    const nested = (slant: string) => ({ ...root, children: [{ split: "cols", slant: [slant], children: ["panel", "panel"] }, "panel"] });
    const a = splitLayout(nested("-8deg"), true, 3);
    const b = splitLayout(nested(`${Math.tan(-8 * Math.PI / 180) * span}mm`), true, 3);
    expect(a.bag.hasErrors).toBe(false);
    expect(a.panels.map((p) => p.polygon)).toEqual(b.panels.map((p) => p.polygon));
    const row = (slant: string) => ({ rows: [{ slant: "8deg", cols: [1, 1], colSlant: [slant] }, {}] });
    expect(splitLayout(row("-8deg"), true, 3).panels.map((p) => p.polygon)).toEqual(splitLayout(row(`${Math.tan(-8 * Math.PI / 180) * span}mm`), true, 3).panels.map((p) => p.polygon));
  });
  it.each([false, true])("orders sides rather than centroids in a thin slanted parent (reversed=%s)", (reversed) => {
    const line = [["0%", "-15%"], ["100%", "115%"]];
    const { panels, bag } = splitLayout({ split: "rows", sizes: [3, 1, 3], slant: ["60mm", "60mm"], children: ["panel", { split: { line: reversed ? line.toReversed() : line }, children: ["panel", "panel"] }, "panel"] }, true, 4);
    expect(bag.hasErrors).toBe(false);
    const centroidY = (poly: { x: number; y: number }[]) => poly.reduce((sum, a, i) => {
      const b = poly[(i + 1) % poly.length];
      return sum + (a.y + b.y) * (a.x * b.y - b.x * a.y);
    }, 0) / (6 * polygonArea(poly));
    expect(centroidY(panels[1].polygon)).toBeGreaterThan(centroidY(panels[2].polygon));
    const upper = panels[1].polygon;
    const lower = panels[2].polygon;
    expect(Math.max(...upper.map((p) => p.x))).toBeGreaterThan(Math.max(...lower.map((p) => p.x)));
  });
  it("keeps named panel assignments and vertical default gutters", () => {
    const { panels, bag } = splitLayout({ split: { line: [["50%", "100%"], ["50%", "0%"]] }, children: ["panel", "panel"] });
    expect(bag.hasErrors).toBe(false);
    expect(panels[0].box.x - (panels[1].box.x + panels[1].box.w)).toBeCloseTo(2, 8);
    const names = panels.map((p) => p.panel.id).reverse();
    const bound = splitLayout({ split: { line: [["50%", "0%"], ["50%", "100%"]] }, children: names.map((panel) => ({ panel })) });
    expect(bound.bag.hasErrors).toBe(false);
    expect(bound.panels.map((p) => p.panel.id)).toEqual(names);
  });
  it.each([[["0%", "0%"], ["0%", "0%"]], [["0%", "0%"], ["100%", "0%"]], [["0%", "120%"], ["100%", "120%"]]])("rejects a non-cutting line %j without crashing", (a, b) => {
    expect(splitLayout({ split: { line: [a, b] }, children: ["panel", "panel"] }).bag.items.some((d) => d.code === "LAYOUT_DEGENERATE_PANEL")).toBe(true);
  });
  it("validates line arity", async () => {
    const r = await createRenderer().validate({ mangacli: 1, pages: [{ layout: { split: { line: [[0, 0], ["100%", "70%"]] }, children: ["panel"] }, panels: [{}] }] });
    expect(r.ok).toBe(false);
  });
  it("warns once per flat run with SFX or line effects, but not quiet or slanted pages", async () => {
    const renderer = createRenderer({ profile: "preview" });
    for (const kind of ["sfx", "effect", "none", "slant", "blank"]) {
      const pages = Array.from({ length: 3 }, (_, i) => ({
        ...(kind === "blank" && i === 1 ? { type: "blank" } : {}),
        layout: { rows: [{ ...(kind === "slant" && i === 1 ? { slant: "8deg" } : {}) }, {}] },
        panels: [{ layers: i === 0 && kind !== "none" ? [kind === "effect" ? { effect: "speed-lines" } : { sfx: "ドン" }] : [] }, {}],
      }));
      const result = await renderer.validate({ mangacli: 1, pages });
      const warnings = result.diagnostics.filter((d) => d.code === "LAYOUT_MONOTONE");
      expect(warnings).toHaveLength(kind === "sfx" || kind === "effect" ? 1 : 0);
      if (warnings.length) { expect(warnings[0].pageId).toBe(result.layout[0].geom.id); expect(warnings[0].message).toContain("1–3"); }
    }
  });
});
describe("monotone run boundaries", () => {
  it("breaks on curved or panel-less pages and reports separate ranges", async () => {
    const renderer = createRenderer({ profile: "preview" });
    const flat = { panels: [{ shape: "rect", layers: [{ effect: "focus-lines", count: 2 }] }] };
    for (const middle of [{ panels: [] }, { panels: [{ shape: "ellipse" }] }]) {
      const result = await renderer.validate({ mangacli: 1, pages: [flat, flat, flat, middle, flat, flat, flat] });
      expect(result.diagnostics.filter((d) => d.code === "LAYOUT_MONOTONE").map((d) => d.message)).toEqual([
        expect.stringContaining("1–3"), expect.stringContaining("5–7"),
      ]);
    }
  });
});

function compose(name: string, size = "B5", spread = false, params: Record<string, unknown> = {}, rtl = true, panelCount?: number, area?: string[]) {
  const bag = new DiagnosticBag();
  const n = panelCount ?? (name === "spread-hero" && spread ? 9 : numbers[templates.indexOf(name)]);
  const doc = resolveDocument({ mangacli: 1, page: { size }, pages: [{ id: "demo", type: spread ? "spread" : "single", layout: { template: name, params, ...(area ? { area } : {}) }, panels: Array.from({ length: n }, () => ({})) }] }, bag);
  const page = doc.pages[0];
  const geom = computePageGeom(page, 2, { readingDirection: rtl ? "rtl" : "ltr" }, bag);
  return { panels: layoutPanels(page, geom, bag), bag, geom };
}

describe("dynamic panel templates", () => {
  it.each([true, false])("keeps asymmetric spread tiers off the physical fold with rtl=%s", (rtl) => {
    for (const area of [["40mm", "20mm", "300mm", "210mm"], ["10mm", "20mm", "150mm", "210mm"], ["200mm", "20mm", "150mm", "210mm"]]) {
      const { panels, bag, geom } = compose("spread-hero", "B5", true, { counts: [1, 1] }, rtl, 5, area);
      expect(bag.items.filter((d) => d.severity === "error")).toEqual([]);
      expect(panels).toHaveLength(5);
      for (const p of panels.filter((_, i) => i !== 2)) {
        expect(Math.abs(polygonArea(p.polygon))).toBeGreaterThan(10);
        expect(p.polygon.every((v) => v.x <= geom.trimW / 2) || p.polygon.every((v) => v.x >= geom.trimW / 2)).toBe(true);
      }
    }
  });
  it.each([true, false])("orders three selected insets top-to-bottom with rtl=%s", (rtl) => {
    const { panels, bag, geom } = compose("splash-with-insets", "B5", false, { count: 3 }, rtl, 4);
    expect(bag.hasErrors).toBe(false);
    const corners = panels.slice(1).sort((a, b) => a.order - b.order).map((p) =>
      `${p.box.y < geom.trimH / 2 ? "top" : "bottom"}-${p.box.x < geom.trimW / 2 ? "left" : "right"}`);
    expect(corners).toEqual(rtl ? ["top-right", "top-left", "bottom-left"] : ["top-left", "top-right", "bottom-right"]);
  });
  for (const name of templates) for (const [size, spread] of [["B5", false], ["A5", false], ["B5", true]] as const) {
    it(`${name} ${size} spread=${spread}`, () => {
      const { panels, bag, geom } = compose(name, size, spread, { seed: 17 });
      expect(bag.items.filter((d) => d.severity === "error")).toEqual([]);
      expect(panels).toHaveLength(name === "spread-hero" && spread ? 9 : numbers[templates.indexOf(name)]);
      expect(panels.map((p) => p.order)).toEqual(panels.map((_, i) => i + 1));
      for (const p of panels) {
        expect(Math.abs(polygonArea(p.polygon))).toBeGreaterThan(10);
        for (const v of p.polygon) {
          expect(v.x).toBeGreaterThanOrEqual(geom.bleedBox.x - 1e-6);
          expect(v.y).toBeGreaterThanOrEqual(geom.bleedBox.y - 1e-6);
          expect(v.x).toBeLessThanOrEqual(geom.trimW + geom.bleed + 1e-6);
          expect(v.y).toBeLessThanOrEqual(geom.trimH + geom.bleed + 1e-6);
        }
      }
      const base = panels.filter((p) => !p.panel.props.overlay);
      for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) {
        const ring = (k: number) => [[...base[k].polygon, base[k].polygon[0]].map((v) => [v.x, v.y] as [number, number])];
        const overlap = polygonClipping.intersection(ring(i), ring(j));
        expect(overlap.flatMap((p) => p).reduce((sum, r) => sum + Math.abs(polygonArea(r.map(([x, y]) => ({ x, y })))), 0)).toBeLessThan(0.01);
      }
      expect(panels.map((p) => p.polygon)).toEqual(compose(name, size, spread, { seed: 17 }).panels.map((p) => p.polygon));
      expect(panels.map((p) => p.polygon)).not.toEqual(compose(name, size, spread, { seed: 18 }).panels.map((p) => p.polygon));
    });
  }
  it.each(templates)("%s responds to angle/ratio/size and mirrors direction", (name) => {
    const base = compose(name).panels;
    const changed = compose(name, "B5", false, { angle: 10, ratio: 0.7, size: 0.4 }).panels;
    expect(changed.map((p) => p.polygon)).not.toEqual(base.map((p) => p.polygon));
    if (["vertical-strip", "zoom-in", "cascade", "spread-hero"].includes(name)) {
      const ltr = compose(name, "B5", false, {}, false).panels;
      const i = name === "cascade" ? 1 : 0;
      expect(base[i].box.x).toBeGreaterThan(ltr[i].box.x);
    }
  });
  it("supports counts, bleed opt-out and slot diagnostics", () => {
    expect(compose("cascade", "B5", false, { counts: [2, 2, 2] }, true, 6).panels).toHaveLength(6);
    expect(compose("vertical-strip", "B5", false, { bleed: false }).panels.every((p) => p.bledSides.length === 0)).toBe(true);
    expect(compose("impact-diagonal", "B5", false, {}, true, 0).bag.items.some((d) => d.code === "LAYOUT_EMPTY_SLOT")).toBe(true);
    expect(compose("impact-diagonal", "B5", false, {}, true, 3).bag.hasErrors).toBe(true);
  });
  it("bleeds edge panels, preserves inset order and keeps small spread panels off the fold", () => {
    for (const name of ["impact-diagonal", "vertical-strip", "spread-hero", "splash-with-insets"]) {
      expect(compose(name).panels[0].bledSides.length).toBeGreaterThan(0);
    }
    for (const rtl of [true, false]) {
      const ps = compose("splash-with-insets", "B5", false, {}, rtl).panels;
      expect(ps.map((p) => p.order)).toEqual([1, 2, 3]);
      expect(ps[1].panel.props.overlay).toBe(true);
      expect(ps[1].bledSides).toEqual([]);
      expect(rtl ? ps[1].box.x > ps[2].box.x : ps[1].box.x < ps[2].box.x).toBe(true);
    }
    const { panels, geom } = compose("spread-hero", "B5", true);
    for (const p of panels.filter((_, i) => i !== 4)) {
      expect(p.polygon.every((v) => v.x <= geom.trimW / 2) || p.polygon.every((v) => v.x >= geom.trimW / 2)).toBe(true);
    }
  });
  it.each(templates)("%s composes through the public renderer", async (name) => {
    const renderer = createRenderer({ profile: "preview" });
    for (const [size, spread] of [["B5", false], ["A5", false], ["B5", true]] as const) {
      const n = name === "spread-hero" && spread ? 9 : numbers[templates.indexOf(name)];
      const list = await renderer.displayList({ mangacli: 1, page: { size }, pages: [{ ...(spread ? { type: "spread" } : {}), layout: { template: name }, panels: Array.from({ length: n }, () => ({})) }] }, 1);
      expect(list.root.kind).toBe("group");
    }
  });
});
