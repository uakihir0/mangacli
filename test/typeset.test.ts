import { describe, expect, it } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath, type PathData } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";
import { noStart } from "../src/text/linebreak.js";
import { parseMarkup } from "../src/text/markup.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const ink = (path: PathData) => boundsOf(flattenPath(path, 0.01).flatMap((p) => p.pts));
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
  it.each([
    ["〜", "食べたい〜、もう〜っ"],
    ["～", "食べたい～、もう～っ"],
  ])("sets %s along the writing direction, even without vert", async (mark, text) => {
    const style = defaultTextStyle({ font: "dialogue", fontSize: 10 });
    await reg.prepare(style.font, text);
    const waves = (overrides: Partial<typeof style> = {}) => {
      const glyphs = layoutText(text, { ...style, ...overrides }, reg).glyphs.filter((g) => text[g.unit] === mark);
      expect(glyphs).toHaveLength(2);
      return glyphs.map(({ path, cx, cy }) => ({ ...ink(path), cx, cy }));
    };
    for (const b of waves()) expect(b.h).toBeGreaterThan(b.w);
    for (const b of waves({ features: { vert: false } })) {
      expect(b.h).toBeGreaterThan(b.w);
      expect(b.x + b.w / 2).toBeCloseTo(b.cx, 1);
      expect(b.y + b.h / 2).toBeCloseTo(b.cy, 1);
    }
    for (const b of waves({ writing: "horizontal" })) expect(b.w).toBeGreaterThan(b.h);
  });
  it.each(["dialogue", "catalog:zen-kaku-gothic-new@700", "sfx", "narration", "hand", "title"])(
    "draws full vertical waves in %s with default OpenType features",
    async (font) => {
      const style = defaultTextStyle({ font, fontSize: 10 });
      for (const text of ["食べたい〜、もう〜っ", "食べたい～、もう～っ"]) {
        await reg.prepare(style.font, text);
        const layout = layoutText(text, style, reg);
        expect(layout.missing).toEqual([]);
        const waves = layout.glyphs.filter(({ unit }) => unit === 4 || unit === 8);
        expect(waves).toHaveLength(2);
        for (const { path, cx } of waves) {
          const { x, w, h } = ink(path);
          expect(h).toBeGreaterThan(2 * w);
          expect(h).toBeGreaterThan(0.7 * style.fontSize);
          expect(x + w / 2).toBeCloseTo(cx, 1);
        }
      }
    },
  );
  it("rotates both wave dashes in vertical ruby with Dela Gothic One", async () => {
    const style = defaultTextStyle({ font: "dialogue", fontSize: 10 });
    await reg.prepare(style.font, "食べたい");
    await reg.prepare("sfx", "〜～");
    const layout = layoutText("<ruby=〜～>食べたい</ruby>", { ...style, ruby: { ...style.ruby, font: "sfx" } }, reg);
    expect(layout.glyphs).toHaveLength(6);
    for (const { path, cx } of layout.glyphs.slice(4)) {
      const { x, w, h } = ink(path);
      expect(h).toBeGreaterThan(2 * w);
      expect(x + w / 2).toBeCloseTo(cx, 1);
    }
  });
});
