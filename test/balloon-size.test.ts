import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { pointInPolygon } from "../src/geom/path.js";
import { BUILTIN_DEFAULTS } from "../src/model/defaults.js";

const fonts = new FontRegistry(new Map() as never, "manga-basic", [], {});
async function plan(text: string, writing = "vertical", props = {}) {
  await fonts.prepare("dialogue", text);
  const ctx = {
    u: { units: "mm", dpi: 96, k: 1 },
    coordsBox: { x: 0, y: 0, w: 182, h: 257 },
    bag: new DiagnosticBag(), fonts, lang: "ja", defaultLang: "ja", draft: false,
  } as ElemCtx;
  return planBalloon({ id: "test", type: "balloon", path: [], seed: 42,
    props: { ...BUILTIN_DEFAULTS.balloon, text, writing, fontSize: "4mm", ...props } }, ctx);
}

describe("balloon text extent sizing", () => {
  it.each(["vertical", "horizontal"])("caps short %s balloon clearance and follows the text aspect", async (writing) => {
    for (const text of ["え", "えっ", "あいう"]) {
      const p = await plan(text, writing);
      const x = p.innerCenter.x;
      const y = p.innerCenter.y;
      const gaps = [x - p.text.width / 2 - p.outer.x, p.outer.x + p.outer.w - x - p.text.width / 2,
        y - p.text.height / 2 - p.outer.y, p.outer.y + p.outer.h - y - p.text.height / 2];
      for (const gap of gaps) {
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(0.8 * 4);
      }
      if (text.length > 1) expect(writing === "vertical" ? p.outer.h / p.outer.w : p.outer.w / p.outer.h).toBeGreaterThan(1.2);
    }
  });
  it.each(["vertical", "horizontal"])("keeps long %s text inside the contour", async (writing) => {
    const p = await plan("これは長い台詞です。\n文字が全部入ります。", writing);
    for (const line of p.text.lines) {
      const r = line.rect;
      for (const x of [r.x, r.x + r.w]) for (const y of [r.y, r.y + r.h]) {
        expect(pointInPolygon({ x: x - p.text.width / 2 + p.innerCenter.x, y: y - p.text.height / 2 + p.innerCenter.y }, p.body.inner)).toBe(true);
      }
    }
    expect(p.fontScaleApplied).toBe(1);
  });
  it("keeps an empty balloon finite and text-derived", async () => {
    const p = await plan("");
    expect(p.outer.w).toBeGreaterThan(0);
    expect(p.outer.h).toBeGreaterThan(0);
    expect(Number.isFinite(p.outer.w + p.outer.h)).toBe(true);
  });
  it("honors an explicit minimum size", async () => {
    const p = await plan("え", "vertical", { minSize: ["20mm", "22mm"] });
    expect(p.outer.w).toBeGreaterThanOrEqual(19.99);
    expect(p.outer.h).toBeGreaterThanOrEqual(21.99);
  });
});
