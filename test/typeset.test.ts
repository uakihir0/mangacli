import { describe, expect, it } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath, type PathData } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});
const ink = (path: PathData) => boundsOf(flattenPath(path, 0.01).flatMap((p) => p.pts));
const lines = async (t: string, o: Record<string, unknown> = {}) => {
  await reg.prepare("dialogue", t);
  return layoutText(t, { ...defaultTextStyle({ font: "dialogue", fontSize: 10 }), maxChars: 8, wrap: "auto", ...o } as never, reg).lines.map((l) => l.text);
};

describe("typesetting", () => {
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
