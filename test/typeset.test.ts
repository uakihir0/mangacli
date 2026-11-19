import { describe, expect, it } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

describe("typesetting", () => {
  it("prefers phrases to splitting okurigana or starting with n", async () => {
    expect(await lines("ねえ…聞いてる？", { maxChars: 5 })).toEqual(["ねえ…", "聞いてる？"]);
    expect(await lines("さすがにひどいんじゃないですか", { maxChars: 7 })).toEqual(["さすがに", "ひどいんじゃ", "ないですか"]);
  });
  it("falls back to characters only for an overlong word", async () => {
    expect(await lines("カタカナ", { maxChars: 2 })).toEqual(["カタ", "カナ"]);
    expect(await lines("")).toEqual([""]);
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
