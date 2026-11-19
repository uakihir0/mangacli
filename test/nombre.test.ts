import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import { flattenPath } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import type { PathNode } from "../src/render/ir.js";
import type { DocumentInput } from "../src/schema/schema.js";

type PageNumbers = NonNullable<NonNullable<DocumentInput["book"]>["pageNumbers"]>;
const blank = { type: "blank" } as const;

async function numbers(
  pageNumbers: PageNumbers,
  pages: DocumentInput["pages"] = [blank],
  book: DocumentInput["book"] = { binding: "left" },
) {
  const { lists } = await render(
    { mangacli: 1, book: { ...book, pageNumbers }, page: { size: ["80mm", "60mm"] }, pages },
    { profile: "print-mono", keepLists: true, layoutOnly: true },
  );
  return lists!.map((list) => {
    const nodes: PathNode[] = [];
    for (const group of list.root.children) {
      if (group.kind !== "group") continue;
      for (const node of group.children) {
        if (node.kind === "path" && node.tag?.elementType === "nombre") nodes.push(node);
      }
    }
    return nodes;
  });
}

const bounds = (node: PathNode) => boundsOf(flattenPath(node.path).flatMap(({ pts }) => pts));

describe("printed page numbers", () => {
  it.each([
    ["bottom-outer", 67, 50.5, 13, 50.5],
    ["bottom-center", 40, 50.5, 40, 50.5],
    ["bottom-inner", 13, 50.5, 67, 50.5],
    ["top-outer", 67, 9, 13, 9],
    ["top-center", 40, 9, 40, 9],
    ["outer-middle", 76.5, 30, 3.5, 30],
  ] as const)("positions %s on facing pages", async (position, rightX, rightY, leftX, leftY) => {
    const [[right], [left]] = await numbers({ position, format: "1" }, [blank, blank]);
    for (const [node, x, y] of [[right, rightX, rightY], [left, leftX, leftY]] as const) {
      const box = bounds(node);
      expect(Math.abs(box.x + box.w / 2 - x)).toBeLessThan(1);
      expect(Math.abs(box.y + box.h / 2 - y)).toBeLessThan(1);
    }
  });

  it("centers outer-middle between trim and the frame unless a margin is explicit", async () => {
    const page = { ...blank, size: "B5", baseFrame: { margins: { top: "10mm", bottom: "10mm", inner: "10mm", outer: "20mm" } } };
    const position = "outer-middle";
    const [[centered]] = await numbers({ position, writing: "vertical", format: "P{n}" }, [page]);
    const [[custom]] = await numbers({ position, writing: "vertical", format: "P{n}", margin: ["8mm", "5mm"] }, [page]);
    const [[noGutter]] = await numbers({ position, writing: "vertical", format: "P{n}" }, [{ ...page, baseFrame: "trim" }]);
    const c = bounds(centered);
    expect(Math.abs(c.x + c.w / 2 - (182 - 10))).toBeLessThan(0.5);
    expect(c.x - (182 - 20)).toBeGreaterThan(5);
    expect(Math.abs(182 - (bounds(custom).x + bounds(custom).w) - 5)).toBeLessThan(0.5);
    expect(Math.abs(182 - (bounds(noGutter).x + bounds(noGutter).w) - 12)).toBeLessThan(0.5);
  });

  it("uses vertical writing for the formatted number", async () => {
    const position = "outer-middle";
    const [[vertical]] = await numbers({ position, writing: "vertical", format: "P{n}" });
    const [[horizontal]] = await numbers({ position, format: "P{n}" });
    const [[literal]] = await numbers({ position, writing: "vertical", format: "P1" });
    const v = bounds(vertical);
    const h = bounds(horizontal);
    expect(vertical.path).toEqual(literal.path);
    expect(v.h).toBeGreaterThan(v.w);
    expect(h.w).toBeGreaterThan(h.h);
    expect(Math.abs(v.y + v.h / 2 - 30)).toBeLessThan(0.5);
  });

  it.each(["left", "right"] as const)("formats both halves of a %s-bound spread in reading order", async (binding) => {
    const [[first, second]] = await numbers(
      { start: 19, position: "outer-middle", writing: "vertical", format: "P{n}/{n}" },
      [{ type: "spread", panels: [{}] }],
      { binding, firstPageSide: binding },
    );
    for (const [node, n, side] of [[first, 19, binding], [second, 20, binding === "left" ? "right" : "left"]] as const) {
      const [[literal]] = await numbers(
        { position: "outer-middle", writing: "vertical", format: `P${n}/${n}` },
        [blank],
        { firstPageSide: side },
      );
      const offset = side === "right" ? 80 : 0;
      const a = bounds(node);
      const b = bounds(literal);
      expect(node.path).toHaveLength(literal.path.length);
      expect(a.x).toBeCloseTo(b.x + offset);
      expect(a.y).toBeCloseTo(b.y);
      expect(a.w).toBeCloseTo(b.w);
      expect(a.h).toBeCloseTo(b.h);
    }
  });

  it("auto-hides only when the configured position overlaps a bleeding panel", async () => {
    const pages: DocumentInput["pages"] = [{
      layout: { free: true, area: "trim" },
      panels: [{ box: ["60mm", "20mm", "20mm", "20mm"], bleed: ["right"] }],
    }];
    const settings = { position: "outer-middle", writing: "vertical", format: "P{n}" } as const;
    const [[automatic]] = await numbers(settings, pages);
    const [[explicit]] = await numbers({ ...settings, hidden: true }, pages);
    const [[visible]] = await numbers({ ...settings, autoHide: false }, pages);
    const [[bottom]] = await numbers({ ...settings, position: "bottom-outer" }, pages);
    expect(automatic).toEqual(explicit);
    expect(bounds(explicit).x).toBeLessThan(3);
    expect(bounds(explicit).y).toBeGreaterThan(53);
    expect(bounds(visible).x).toBeGreaterThan(60);
    expect(bounds(bottom).x).toBeGreaterThan(60);
  });
});
