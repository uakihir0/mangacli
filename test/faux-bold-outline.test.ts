import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { BLACK, WHITE } from "../src/core/color.js";
import { glyphNodes, glyphOutlineNodes } from "../src/elements/glyphs.js";
import { flattenPath } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import type { Node, PathNode } from "../src/render/ir.js";

const renderer = createRenderer({ profile: "preview" });
const paths = (node: Node): PathNode[] => node.kind === "group" ? node.children.flatMap(paths) : node.kind === "path" && node.tag?.elementId === "letter" ? [node] : [];

describe("faux-bold outlines", () => {
  it.each(["text", "balloon", "sfx"])("keeps a 1mm rim outside plain and bold %s ink", async kind => {
    for (const bold of [false, true]) {
      const list = await renderer.displayList({ filename: "/virtual/outline.yaml", yaml: `mangacli: 1
page: { size: [100mm, 100mm] }
pages:
  - panels: []
    layers:
      - ${kind}: '${bold ? "<b>守</b>" : "守"}'
        id: letter
        font: narration
        fontSize: 20mm
        writing: horizontal
        at: [50%, 50%]
        ${kind === "balloon" ? "textOutline" : "outline"}: 1mm white
` }, 1);
      const nodes = paths(list.root);
      const outline = nodes.find(n => n.tag?.role === "text" && (kind === "sfx"
        ? n.paint?.type === "solid" && n.paint.color.r === WHITE.r
        : n.paint === null && n.stroke?.paint.type === "solid" && n.stroke.paint.color.r === WHITE.r))!;
      const ink = nodes.find(n => n.paint?.type === "solid" && n.paint.color.r === BLACK.r && n.tag?.role === "text")!;
      expect(outline).toBeDefined();
      expect(ink).toBeDefined();
      if (kind !== "sfx") expect(outline.path).toEqual(ink.path);
      // At the rightmost point of a filled glyph, a round stroke extends by
      // exactly half its width. Subtract the black extent from the white one.
      const right = (n: PathNode) => {
        const b = boundsOf(flattenPath(n.path, 0.001).flatMap(c => c.pts));
        return b.x + b.w + (n.stroke?.width ?? 0) / 2;
      };
      expect(right(outline) - right(ink)).toBeCloseTo(1, kind === "sfx" ? 2 : 6);
      if (kind !== "sfx") expect(!!ink.stroke).toBe(bold);
    }
  });

  it("preserves no-outline, empty and real-face runs and widens only faux-bold runs", () => {
    const tag = { elementId: "letter", elementType: "text", role: "text", separation: "text" } as const;
    const glyph = { path: [["M", 0, 0], ["L", 1, 0], ["L", 1, 1], ["Z"]] as PathNode["path"], unit: 0, cx: 0, cy: 0 };
    const paint = { type: "solid", color: BLACK } as const;
    const outline: PathNode = { kind: "path", path: glyph.path, fillRule: "nonzero", paint: null, stroke: { width: 2, paint: { type: "solid", color: WHITE }, join: "round" } };
    const plain = glyphNodes([glyph], p => p, paint, 20, tag);
    expect(glyphOutlineNodes([outline], plain)).toEqual([outline]);
    expect(glyphNodes([], p => p, paint, 20, tag)).toEqual([]);
    const bold = glyphNodes([{ ...glyph, bold: true }], p => p, paint, 20, tag);
    expect(bold[0].stroke?.width).toBe(1);
    expect(glyphOutlineNodes([], bold)).toEqual([]);
    expect(glyphOutlineNodes([outline], [...plain, ...bold]).map(n => n.stroke?.width)).toEqual([2, 3]);
  });
});
