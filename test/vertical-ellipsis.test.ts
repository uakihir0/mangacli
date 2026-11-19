import { describe, expect, it, vi } from "vitest";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath } from "../src/geom/path.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const reg = new FontRegistry(new Map([
  ["regular", { kind: "catalog" as const, id: "zen-antique", bold: "bold" }],
  ["bold", { kind: "catalog" as const, id: "zen-kaku-gothic-new@700" }],
]), "manga-basic", [], {});

describe("vertical ellipsis", () => {
  it.each(["regular", "bold", "shout"])("centres full-em dot runs in %s regardless of position or weight", async (font) => {
    await reg.prepare(font, "ねえ話そう…‥次");
    await reg.prepare("bold", "ねえ話そう…‥次");
    for (const weight of [undefined, 400, 900]) {
      for (const mark of ["…", "‥"]) {
        for (const text of [mark, `ねえ${mark}\n話そう${mark}`, `<b>本当!?\n東京の\nカフェで\n話そう${mark}\n明日また\n来るね</b>`, `話そう${mark}次`]) {
          const style = defaultTextStyle({ font, fontSize: 10, weight, maxChars: 4 });
          const result = layoutText(text, style, reg);
          const units = Array.from(result.plain);
          const glyphs = result.glyphs.filter((g) => units[g.unit] === mark);
          expect(glyphs.length).toBeGreaterThan(0);
          for (const glyph of glyphs) {
            const dots = flattenPath(glyph.path).map(({ pts }) => ({
              x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
              y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
            }));
            const count = mark === "…" ? 3 : 2;
            expect(dots).toHaveLength(count);
            dots.forEach((dot, i) => {
              expect((dot.x0 + dot.x1) / 2).toBeCloseTo(glyph.cx);
              expect((dot.y0 + dot.y1) / 2 - glyph.cy).toBeCloseTo(10 * (-0.35 + 0.7 * i / (count - 1)));
            });
            expect(dots.at(-1)!.y1 - dots[0].y0).toBeCloseTo(8.4);
          }
        }
      }
    }
  });

  it("does not read potentially broken font outlines", async () => {
    await reg.prepare("bold", "…‥");
    const font = reg.pick("bold", 0x2026)!.font;
    const outline = vi.spyOn(font.font, "glyphToJson").mockImplementation(() => { throw new Error("broken alternate"); });
    try {
      const result = layoutText("…‥", defaultTextStyle({ font: "bold", fontSize: 10 }), reg);
      expect(result.glyphs.map((g) => flattenPath(g.path).length)).toEqual([3, 2]);
      expect(outline).not.toHaveBeenCalled();
    } finally {
      outline.mockRestore();
    }
  });

  it("preserves empty text and markup errors", () => {
    const style = defaultTextStyle({ font: "regular", fontSize: 10 });
    expect(layoutText("", style, reg).glyphs).toEqual([]);
    expect(layoutText("<b>…", style, reg).errors[0]?.code).toBe("TEXT_MARKUP_UNBALANCED");
  });
});
