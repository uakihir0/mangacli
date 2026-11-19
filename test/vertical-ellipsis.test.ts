import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { type PathData, flattenPath } from "../src/geom/path.js";
import type { Node } from "../src/render/ir.js";
import { defaultTextStyle, layoutText } from "../src/text/layout.js";

const reg = new FontRegistry(new Map([
  ["regular", { kind: "catalog" as const, id: "zen-antique", bold: "bold" }],
  ["bold", { kind: "catalog" as const, id: "zen-kaku-gothic-new@700" }],
]), "manga-basic", [], {});

function expectDots(path: PathData, mark: string, em: number) {
  const dots = flattenPath(path, em * 0.001).map(({ pts }) => ({
    x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
  })).sort((a, b) => a.y0 - b.y0);
  expect(dots).toHaveLength(mark === "…" ? 3 : 2);
  const center = (dots[0].x0 + dots[0].x1) / 2;
  for (let i = 0; i < dots.length; i++) {
    expect(Math.abs((dots[i].x0 + dots[i].x1) / 2 - center)).toBeLessThan(em * 0.02);
    if (i) expect(dots[i].y0).toBeGreaterThan(dots[i - 1].y1);
  }
  if (mark === "…") expect(dots.at(-1)!.y1 - dots[0].y0).toBeGreaterThanOrEqual(em * 0.8);
}

describe("vertical ellipsis", () => {
  it.each(["regular", "bold", "dialogue"])("preserves three-dot and two-dot outlines in %s", async (font) => {
    await reg.prepare(font, "ねえ話そう…‥次");
    await reg.prepare("bold", "ねえ話そう…‥次");
    for (const mark of ["…", "‥"]) {
      for (const text of [mark, `ねえ${mark}\n話そう${mark}`, `<b>話そう${mark}</b>`, `話そう${mark}次`]) {
        const result = layoutText(text, defaultTextStyle({ font, fontSize: 10, maxChars: 4 }), reg);
        expect(result.missing).toEqual([]);
        const glyphs = result.glyphs.filter((g) => Array.from(result.plain)[g.unit] === mark);
        expect(glyphs.length).toBeGreaterThan(0);
        for (const glyph of glyphs) {
          expectDots(glyph.path, mark, 10);
          const xs = flattenPath(glyph.path).flatMap(({ pts }) => pts.map((p) => p.x));
          expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - glyph.cx)).toBeLessThan(0.2);
        }
      }
    }
  });

  it.each([false, true])("keeps ellipsis dots in the six-column balloon (bold: %s)", async (bold) => {
    const renderer = createRenderer({ profile: "preview" });
    for (const mark of ["…", "‥"]) {
      const columns = ["本当!?", "東京の", "カフェで", `話そう${mark}`, "明日また", "来るね"];
      const text = columns.join("\n").replace(mark, `<color=red>${mark}</color>`);
      const list = await renderer.displayList({
        mangacli: 1,
        page: { size: "B6" },
        pages: [{ panels: [{ layers: [{ balloon: bold ? `<b>${text}</b>` : text, id: "six-columns", fontSize: "5mm", at: ["50%", "50%"] }] }] }],
      }, 1);
      const paths: PathData[] = [];
      const walk = (node: Node) => {
        if (node.kind === "group") node.children.forEach(walk);
        if (node.kind === "path" && node.tag?.elementId === "six-columns" && node.paint?.type === "solid" && node.paint.color.r === 1 && node.paint.color.g === 0 && node.paint.color.b === 0) paths.push(node.path);
      };
      walk(list.root);
      expect(paths).toHaveLength(1);
      expectDots(paths[0], mark, 5);
      await reg.prepare("dialogue", columns.join(""));
      const layout = layoutText(columns.join("\n"), defaultTextStyle({ font: "dialogue", fontSize: 5 }), reg);
      expect(layout.lines.map((line) => line.text)).toEqual(columns);
    }
  });

  it("preserves empty text and markup errors", () => {
    const style = defaultTextStyle({ font: "regular", fontSize: 10 });
    expect(layoutText("", style, reg).glyphs).toEqual([]);
    expect(layoutText("<b>…", style, reg).errors[0]?.code).toBe("TEXT_MARKUP_UNBALANCED");
  });
});
