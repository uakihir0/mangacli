import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { planBalloon } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { pointInPolygon } from "../src/geom/path.js";
import { resolveDocument } from "../src/model/resolve.js";

const fonts = new FontRegistry(new Map() as never, "manga-basic", [], {});
async function plan(text: string, writing = "vertical", props: Record<string, unknown> = {}) {
  const bag = new DiagnosticBag();
  const resolved = resolveDocument({
    seed: 42,
    pages: [{ layers: [{ type: "balloon", id: "test", text, writing, fontSize: "4mm", ...props }] }],
  }, bag);
  const el = resolved.pages[0].layers[0];
  await fonts.prepare(el.props.font as string, text);
  const ctx = {
    u: { units: "mm", dpi: 96, k: 1 },
    coordsBox: { x: 0, y: 0, w: 182, h: 257 },
    bag, fonts, lang: "ja", defaultLang: "ja", draft: false,
  } as ElemCtx;
  return planBalloon(el, ctx);
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
        expect(gap).toBeGreaterThanOrEqual(0.3 * 4);
        expect(gap).toBeLessThanOrEqual(0.8 * 4);
      }
      if (text.length > 1) expect(writing === "vertical" ? p.outer.h / p.outer.w : p.outer.w / p.outer.h).toBeGreaterThan(1.2);
    }
  });
  it.each(["inverted", "shock", "whisper"])("gives compact %s lettering room to breathe", async (style) => {
    const p = await plan(style === "shock" ? "ガーン" : "反転", "vertical", { as: style });
    const em = p.text.fontSize;
    const gaps = [p.innerCenter.x - p.text.width / 2 - p.outer.x,
      p.outer.x + p.outer.w - p.innerCenter.x - p.text.width / 2,
      p.innerCenter.y - p.text.height / 2 - p.outer.y,
      p.outer.y + p.outer.h - p.innerCenter.y - p.text.height / 2];
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(0.3 * em);
      expect(gap).toBeLessThanOrEqual(0.8 * em);
    }
  });
  it("preserves the non-ellipse minimum and compact narration columns", async () => {
    const small = await plan("え", "vertical", { as: "narration" });
    expect(small.outer.w).toBeGreaterThanOrEqual(7.99);
    expect(small.outer.h).toBeGreaterThanOrEqual(7.99);
    const narration = await plan("その日の放課後", "vertical", { as: "narration", maxChars: 4 });
    expect(narration.text.lines.map((line) => line.text)).toEqual(["その日の", "放課後"]);
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
