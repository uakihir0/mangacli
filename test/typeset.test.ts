import { describe, expect, it } from "vitest";
import * as hb from "harfbuzzjs";
import { type FontDef, FontRegistry } from "../src/fonts/registry.js";
import { type PathData, flattenPath, pathFromJson } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";
import { noEnd, noStart } from "../src/text/linebreak.js";
import { parseMarkup } from "../src/text/markup.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const ink = (path: PathData) => boundsOf(flattenPath(path, 0.01).flatMap((p) => p.pts));
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

const normalizedOutline = (path: PathData) => {
  const points = path.flatMap((c) => {
    const out = [];
    for (let i = 1; i + 1 < c.length; i += 2) out.push({ x: Number(c[i]), y: Number(c[i + 1]) });
    return out;
  });
  const bounds = boundsOf(points);
  return points.map((p) => [Number(((p.x - bounds.x) / bounds.w).toFixed(5)), Number(((p.y - bounds.y) / bounds.h).toFixed(5))]);
};

describe("typesetting", () => {
  it("uses oikomi rather than leaving a single-character column", async () => {
    expect(await lines("ダメ！", { maxChars: 2 })).toEqual(["ダメ！"]);
  });
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
  it.each(["noto-sans-jp", "dela-gothic-one"])("compresses scaled nonokagi exactly once with %s", async (id) => {
    const fonts = new FontRegistry(new Map([["test", { kind: "catalog", id }]]), "none", [], {});
    await fonts.prepare("test", "〝ヤ〟あ");
    for (const scale of [1, 1.5, 2]) {
      const style = { ...defaultTextStyle({ font: "test", fontSize: 10 }), glyphScale: [1, scale] as [number, number], wrap: "none" as const };
      const halfEm = 5 * scale;
      for (const quote of "〝〟") {
        const single = layoutText(quote, style, fonts);
        expect(single.lines[0].length).toBeCloseTo(halfEm);
        expect(single.glyphs[0].cy).toBeCloseTo(halfEm / 2);
        const ink = boundsOf(flattenPath(single.glyphs[0].path).flatMap((p) => p.pts));
        expect(ink.y).toBeGreaterThanOrEqual(0);
        expect(ink.y + ink.h).toBeLessThanOrEqual(single.lines[0].rect.h);
        expect(layoutText(quote, { ...style, punctCompress: false }, fonts).lines[0].length).toBeCloseTo(2 * halfEm);
      }
      const result = layoutText("〝ヤ〟あ", style, fonts);
      expect(result.lines[0].length).toBeCloseTo(6 * halfEm);
      expect(result.glyphs.map((g) => g.cy)).toEqual([0.5, 2, 3.5, 5].map((n) => n * halfEm));
      const wrapped = layoutText("〝ヤ〟あ", { ...style, wrap: "char", maxExtent: 4 * halfEm }, fonts);
      expect(wrapped.lines.map((l) => l.text)).toEqual(["〝ヤ〟", "あ"]);
      expect(wrapped.lines.map((l) => l.length)).toEqual([4 * halfEm, 2 * halfEm]);
    }
  });
  it.each(["noto-sans-jp", "dela-gothic-one"])("sets vertical nonokagi in half-em cells with %s", async (id) => {
    const fonts = new FontRegistry(new Map([["test", { kind: "catalog", id }]]), "none", [], {});
    await fonts.prepare("test", "〝ヤバい〟って言った「」");
    const style = { ...defaultTextStyle({ font: "test", fontSize: 10 }), wrap: "none" as const };
    for (const quote of "〝〟") {
      expect(layoutText(quote, style, fonts).lines[0].length).toBeCloseTo(5);
      expect(layoutText(quote, { ...style, punctCompress: false }, fonts).lines[0].length).toBeCloseTo(10);
      expect(layoutText(quote, { ...style, writing: "horizontal" }, fonts)).toEqual(layoutText(quote, { ...style, writing: "horizontal", punctCompress: false }, fonts));
    }
    for (const bracket of "「」") expect(layoutText(bracket, style, fonts).lines[0].length).toBeCloseTo(10);
    const tight = layoutText("〝ヤバい〟って言った", style, fonts);
    const full = layoutText("〝ヤバい〟って言った", { ...style, punctCompress: false }, fonts);
    expect(tight.missing).toEqual([]);
    expect(full.lines[0].length - tight.lines[0].length).toBeCloseTo(10);
    const ink = tight.glyphs.map((g) => boundsOf(flattenPath(g.path).flatMap((p) => p.pts)));
    for (const i of [0, 3, 4]) {
      const gap = ink[i + 1].y - ink[i].y - ink[i].h;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(5);
    }
    expect(ink[0].x).toBeGreaterThanOrEqual(5);
    expect(ink[0].y + ink[0].h).toBeLessThanOrEqual(5);
    expect(ink[4].x + ink[4].w).toBeLessThanOrEqual(5);
    expect(ink[4].y).toBeGreaterThanOrEqual(35);
    expect(ink[4].y + ink[4].h).toBeLessThanOrEqual(40);
    expect(layoutText("〝〟〝〟", style, fonts).lines[0].length).toBeCloseTo(20);
    const wrapped = layoutText("〝ヤバい〟", { ...style, wrap: "char", maxExtent: 40 }, fonts);
    expect(wrapped.lines.map((l) => l.text)).toEqual(["〝ヤバい〟"]);
    expect(layoutText("", style, fonts).glyphs).toEqual([]);
  });
  it("detects active vertical forms when OpenType features change on the same font", async () => {
    const fonts = new FontRegistry(new Map([["test", { kind: "catalog", id: "noto-sans-jp" }]]), "none", [], {});
    await fonts.prepare("test", "〟");
    const font = fonts.pick("test", 0x301f)!.font;
    for (const enabled of [true, false, true, false]) {
      const features = { vert: enabled, vrt2: enabled };
      const glyphs = [hb.Direction.LTR, hb.Direction.TTB].map((dir) => {
        const buf = new hb.Buffer();
        buf.addText("〟");
        buf.guessSegmentProperties();
        buf.setDirection(dir);
        const active = dir === hb.Direction.TTB && enabled;
        hb.shape(font.font, buf, [new hb.Feature("vert", Number(active)), new hb.Feature("vrt2", Number(active))]);
        return buf.getGlyphInfos()[0].codepoint;
      });
      expect(glyphs[0] !== glyphs[1]).toBe(enabled);
      const result = layoutText("〟", { ...defaultTextStyle({ font: "test", fontSize: 10 }), features }, fonts);
      const expected = pathFromJson(font.font.glyphToJson(glyphs[1]), [enabled ? 1 : -1, 0, 0, -1, 0, 0]);
      expect(normalizedOutline(result.glyphs[0].path)).toEqual(normalizedOutline(expected));
    }
  });
  it.each([-0.2, 0.2])("preserves composite font baselineShift %s for nonokagi", async (baselineShift) => {
    const fonts = new FontRegistry(new Map<string, FontDef>([
      ["base", { kind: "catalog", id: "noto-sans-jp" }],
      ["plain", { kind: "compose", items: [{ font: "base", scale: 0.8 }] }],
      ["shifted", { kind: "compose", items: [{ font: "base", scale: 0.8, baselineShift }] }],
    ]), "none", [], {});
    await fonts.prepare("plain", "〝ヤ〟");
    await fonts.prepare("shifted", "〝ヤ〟");
    const layouts = ["plain", "shifted"].map((font) => layoutText("〝ヤ〟", defaultTextStyle({ font, fontSize: 10 }), fonts));
    const ink = layouts.map((l) => l.glyphs.map((g) => boundsOf(flattenPath(g.path).flatMap((p) => p.pts))));
    expect(ink[0]).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(ink[1][i].x - ink[0][i].x).toBeCloseTo(baselineShift * 8);
      expect(ink[1][i].y).toBeCloseTo(ink[0][i].y);
    }
  });
  it.each([
    ["noto-sans-jp", true],
    ["dela-gothic-one", false],
  ] as const)("anchors nonokagi ink to the correct em corners with %s", async (id, hasVerticalForms) => {
    const fonts = new FontRegistry(new Map([["test", { kind: "catalog", id }]]), "none", [], {});
    await fonts.prepare("test", "〝ヤバい〟隣");
    const style = { ...defaultTextStyle({ font: "test", fontSize: 10 }), wrap: "none" as const };
    const result = layoutText("“ヤバい”\n隣", style, fonts);
    expect(result.missing).toEqual([]);
    const rect = (unit: number) => boundsOf(result.glyphs.filter((g) => g.unit === unit).flatMap((g) => flattenPath(g.path).flatMap((p) => p.pts)));
    const opening = rect(0), closing = rect(4), neighbour = rect(6);
    const column = result.lines[0].rect;
    expect(opening.x).toBeGreaterThanOrEqual(column.x + 5);
    expect(opening.x + opening.w).toBeLessThanOrEqual(column.x + 10);
    expect(opening.y).toBeGreaterThanOrEqual(0);
    expect(opening.y + opening.h).toBeLessThanOrEqual(5);
    expect(Math.abs(opening.y - neighbour.y)).toBeLessThan(1);
    expect(closing.x).toBeGreaterThanOrEqual(column.x);
    expect(closing.x + closing.w).toBeLessThanOrEqual(column.x + 5);
    expect(closing.y).toBeGreaterThanOrEqual(35);
    expect(closing.y + closing.h).toBeLessThanOrEqual(40);
    const font = fonts.pick("test", 0x301d)!.font;
    for (const ch of "〝〟") {
      const gids = [hb.Direction.LTR, hb.Direction.TTB].map((dir) => {
        const buf = new hb.Buffer();
        buf.addText(ch);
        buf.guessSegmentProperties();
        buf.setDirection(dir);
        hb.shape(font.font, buf);
        return buf.getGlyphInfos()[0].codepoint;
      });
      expect(gids[0] !== gids[1]).toBe(hasVerticalForms);
      const mirror = ch === "〟" && !hasVerticalForms ? -1 : 1;
      const expected = pathFromJson(font.font.glyphToJson(gids[1]), [mirror, 0, 0, -1, 0, 0]);
      const actual = result.glyphs.find((g) => g.unit === (ch === "〝" ? 0 : 4))!.path;
      expect(normalizedOutline(actual)).toEqual(normalizedOutline(expected));
    }
    expect(layoutText("", style, fonts).glyphs).toEqual([]);
    expect(layoutText("“<foo>”", style, fonts).errors[0]?.code).toBe("TEXT_UNKNOWN_TAG");
  });
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
