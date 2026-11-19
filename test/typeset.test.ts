import { describe, expect, it } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";
import { noEnd, noStart } from "../src/text/linebreak.js";
import { parseMarkup } from "../src/text/markup.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

describe("typesetting", () => {
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
  it("applies nonokagi kinsoku after normalizing vertical quotes", async () => {
    const result = await lines("あ“ヤバい”って言った", { maxChars: 2, wrap: "char" });
    expect(result.join("")).toBe("あ〝ヤバい〟って言った");
    expect(result.length).toBeGreaterThan(1);
    for (const line of result) {
      expect(noStart(Array.from(line)[0] ?? "", "strict"), line).toBe(false);
      expect(noEnd(Array.from(line).at(-1) ?? "", "strict"), line).toBe(false);
    }
  });
  it("shapes normalized quotes like explicit vertical nonokagi", async () => {
    await reg.prepare("dialogue", "“ヤバい”〝〟");
    const style = defaultTextStyle({ font: "dialogue", fontSize: 10 });
    const normalized = layoutText("“ヤバい”", style, reg);
    const explicit = layoutText("〝ヤバい〟", style, reg);
    expect(normalized.missing).toEqual([]);
    expect(normalized.glyphs.length).toBeGreaterThan(0);
    expect(normalized.glyphs).toEqual(explicit.glyphs);
    const horizontal = layoutText("“ヤバい”", { ...style, writing: "horizontal" }, reg);
    expect(horizontal.plain).toBe("“ヤバい”");
    expect(horizontal.glyphs).not.toEqual(normalized.glyphs);
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
