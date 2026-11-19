import { describe, expect, it } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";
import { noStart } from "../src/text/linebreak.js";
import { parseMarkup } from "../src/text/markup.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

describe("typesetting", () => {
  it("distinguishes an independent hiragana verb from okurigana", async () => {
    expect(await lines("帰る前おごるよ", { maxChars: 4 })).toEqual(["帰る前", "おごるよ"]);
    expect(await lines("聞いてる？", { maxChars: 5 })).toEqual(["聞いてる？"]);
  });
  it("reserves room for prohibited starts when splitting a long word", async () => {
    const result = await lines("ウルトラマン！", { maxChars: 3 });
    expect(result.join("")).toBe("ウルトラマン！");
    for (const line of result) {
      expect(Array.from(line).length).toBeLessThanOrEqual(3);
      expect(noStart(Array.from(line)[0] ?? "", "strict")).toBe(false);
    }
  });
  it("prefers phrases to splitting okurigana or starting with n", async () => {
    expect(await lines("ねえ…聞いてる？", { maxChars: 5 })).toEqual(["ねえ…", "聞いてる？"]);
    expect(await lines("さすがにひどいんじゃないですか", { maxChars: 7 })).toEqual(["さすがに", "ひどいんじゃ", "ないですか"]);
  });
  it("falls back to characters only for an overlong word", async () => {
    expect(await lines("カタカナ", { maxChars: 2 })).toEqual(["カタ", "カナ"]);
    expect(await lines("")).toEqual([""]);
  });
  it.each([
    ["「えっ」「何？」\nどういうこと。」", 3],
    ["「えっ」「何？」\nどういうこと。」", 8],
    ["そんなことないでしょう。」", 2],
    ["あいうえおかきく。）」』", 4],
    ...Array.from("、。，．）］｝」』】〕〉》〙〗’”｠»),.]}>？！・：々ー").map((ch) => [`あ${ch}${ch}${ch}`, 1] as const),
  ])("keeps prohibited column starts attached: %s", async (text, maxChars) => {
    const result = await lines(text, { maxChars });
    const plain = parseMarkup(text, { vertical: true }).units.flatMap((u) => u.kind === "char" ? [u.ch] : []).join("");
    expect(result.join("").replaceAll("？", "?").replaceAll("！", "!")).toBe(plain.replaceAll("？", "?").replaceAll("！", "!"));
    for (const line of result) expect(noStart(Array.from(line)[0] ?? "", "strict"), line).toBe(false);
  });
  it("handles empty text with a column limit", async () => {
    expect((await lines("", { maxChars: 1 })).join("")).toBe("");
  });
  it("keeps closing chains attached after hanging punctuation", async () => {
    expect(await lines("あ。」』", { maxChars: 1, hanging: true })).toEqual(["あ。」』"]);
  });
  it("allows prohibited starts when kinsoku is disabled", async () => {
    expect(await lines("あ」」", { maxChars: 1, kinsoku: "none", wrap: "char" })).toEqual(["あ", "」", "」"]);
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
