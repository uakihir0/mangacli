import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { polygonArea } from "../src/geom/path.js";
import { computePageGeom, layoutPanels } from "../src/layout/page.js";
import { resolveDocument } from "../src/model/resolve.js";
import { createRenderer } from "../src/api.js";

const templates = ["impact-diagonal", "cascade", "zoom-in", "splash-with-insets", "vertical-strip", "spread-hero"];
const numbers = [2, 4, 4, 3, 3, 5];
function compose(name: string, size = "B5", spread = false, params: Record<string, unknown> = {}, rtl = true, panelCount?: number) {
  const bag = new DiagnosticBag();
  const n = panelCount ?? (name === "spread-hero" && spread ? 9 : numbers[templates.indexOf(name)]);
  const doc = resolveDocument({ mangacli: 1, page: { size }, pages: [{ id: "demo", type: spread ? "spread" : "single", layout: { template: name, params }, panels: Array.from({ length: n }, () => ({})) }] }, bag);
  const page = doc.pages[0];
  const geom = computePageGeom(page, 2, { readingDirection: rtl ? "rtl" : "ltr" }, bag);
  return { panels: layoutPanels(page, geom, bag), bag, geom };
}

describe("dynamic panel templates", () => {
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
