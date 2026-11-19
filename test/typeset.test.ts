import { describe, expect, it } from "vitest";
import * as hb from "harfbuzzjs";
import { FontRegistry } from "../src/fonts/registry.js";
import { type PathData, flattenPath, pathFromJson } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
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
    expect(closing.y).toBeGreaterThanOrEqual(45);
    expect(closing.y + closing.h).toBeLessThanOrEqual(50);
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
      const normalizedOutline = (path: PathData) => {
        const points = path.flatMap((c) => {
          const out = [];
          for (let i = 1; i + 1 < c.length; i += 2) out.push({ x: Number(c[i]), y: Number(c[i + 1]) });
          return out;
        });
        const bounds = boundsOf(points);
        return points.map((p) => [Number(((p.x - bounds.x) / bounds.w).toFixed(5)), Number(((p.y - bounds.y) / bounds.h).toFixed(5))]);
      };
      const mirror = ch === "〟" && !hasVerticalForms ? -1 : 1;
      const expected = pathFromJson(font.font.glyphToJson(gids[1]), [mirror, 0, 0, -1, 0, 0]);
      const actual = result.glyphs.find((g) => g.unit === (ch === "〝" ? 0 : 4))!.path;
      expect(normalizedOutline(actual)).toEqual(normalizedOutline(expected));
    }
    expect(layoutText("", style, fonts).glyphs).toEqual([]);
    expect(layoutText("“<foo>”", style, fonts).errors[0]?.code).toBe("TEXT_UNKNOWN_TAG");
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
});
