import { describe, expect, it } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

describe("typesetting", () => {
  it.each([
    "「えっ」「何？」\nどういうこと。」",
    "“本当”に\n『約束』（仮）\n【重要】",
    "「あ」「い」",
    "『え』『お』",
    "（か）（き）",
    "」『",
  ])("keeps compressed vertical brackets visible: %s", async (text) => {
    await reg.prepare("dialogue", text);
    const style = { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), wrap: "none" as const };
    const layout = layoutText(text, style, reg);
    const full = layoutText(text, { ...style, punctCompress: false }, reg);
    expect(layout.errors).toEqual([]);
    expect(layout.missing).toEqual([]);
    expect(layout.glyphs).toHaveLength(full.glyphs.length);
    const ink = layout.glyphs.map((g) => boundsOf(flattenPath(g.path, 0.01).flatMap((p) => p.pts)));
    const chars = Array.from(text);
    let pairs = 0;
    for (let i = 0; i + 1 < layout.glyphs.length; i++) {
      const a = layout.glyphs[i];
      const b = layout.glyphs[i + 1];
      if (!"」』）".includes(chars[a.unit]) || !"「『（".includes(chars[b.unit])) continue;
      pairs++;
      expect(ink[i].w).toBeGreaterThan(0);
      expect(ink[i + 1].w).toBeGreaterThan(0);
      expect(ink[i + 1].y).toBeGreaterThan(ink[i].y + ink[i].h);
      expect(ink[i + 1].y + ink[i + 1].h - ink[i].y).toBeLessThanOrEqual(10);
      expect((full.glyphs[i + 1].cy - full.glyphs[i].cy) - (b.cy - a.cy)).toBeCloseTo(10);
      if (i + 2 < ink.length && layout.glyphs[i + 2].cx === b.cx) {
        expect(ink[i + 2].y).toBeGreaterThan(ink[i + 1].y + ink[i + 1].h);
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
  it("breaks a long phrase at a word start", async () => {
    expect(await lines("宿題、まだ終わってなくてさ……")).toEqual(["宿題、まだ", "終わって", "なくてさ……"]);
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
