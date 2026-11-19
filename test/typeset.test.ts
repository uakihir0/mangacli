import { describe, expect, it } from "vitest";
import { resolveTextStyle } from "../src/elements/textstyle.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath } from "../src/geom/path.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

describe("typesetting", () => {
  it("centers uneven vertical speech columns without changing their reading order", async () => {
    const text = "今日は\nいい天気だね";
    await reg.prepare("dialogue", text);
    const u = { units: "mm", dpi: 72, k: 1 } as const;
    const layout = (props: Record<string, unknown>) => layoutText(text, resolveTextStyle(props, u, "ja", true, 1), reg);
    const balloon = layout({});
    const [first, second] = balloon.lines;
    expect(balloon.fontSize).toBe(4);
    expect(balloon.lines.map((line) => line.text)).toEqual(["今日は", "いい天気だね"]);
    expect(first.rect.x).toBeGreaterThan(second.rect.x);
    expect(first.rect.y).toBeGreaterThan(0);
    expect(first.rect.y + first.rect.h / 2).toBeCloseTo(second.rect.y + second.rect.h / 2);
    expect(layout({ align: "start" }).lines[0].rect.y).toBe(0);
    expect(layout({ shape: { kind: "rect" } }).lines[0].rect.y).toBe(0);
    expect(layout({ shape: { kind: "burst" } }).lines[0].rect.y).toBe(0);
    expect(layout({ fontSize: "13bQ" }).fontSize).toBe(3.25);
  });
  it("breaks a long phrase at a word start", async () => {
    expect(await lines("宿題、まだ終わってなくてさ……")).toEqual(["宿題、まだ", "終わって", "なくてさ……"]);
  });
  it("sets doubled punctuation in one vertical cell and corners Japanese stops", async () => {
    const text = "本!?当!!、。";
    await reg.prepare("dialogue", text);
    const style = defaultTextStyle({ font: "dialogue", fontSize: 10 });
    const result = layoutText(text, style, reg);
    expect(result.height).toBeCloseTo(layoutText("本字当字、。", style, reg).height);
    const [comma, period] = result.glyphs.slice(-2);
    for (const glyph of [comma, period]) {
      const pts = flattenPath(glyph.path).flatMap((contour) => contour.pts);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeGreaterThan(glyph.cx + 1.2);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeLessThan(glyph.cy - 1.2);
    }
  });
  it("keeps english words and their punctuation whole", async () => {
    const l = await lines("Unbelievable...", { writing: "horizontal", lang: "en", maxChars: 6 });
    expect(l).toEqual(["Unbelievable..."]);
  });
  it("does not collapse latin dots", async () => {
    await reg.prepare("dialogue", "Yeah... I");
    const L = layoutText("Yeah... I", { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), writing: "horizontal", lang: "en" } as never, reg);
    const xs = L.glyphs.map((g) => g.cx);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
});
