import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render, validate } from "../src/api.js";
import { flattenPath } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import type { Node, PathNode } from "../src/render/ir.js";
import type { DocumentInput } from "../src/schema/schema.js";

const text = "編集部からのお知らせ";
const book = { binding: "right", pageNumbers: { enabled: false }, signature: false } as const;
const page = { size: ["80mm", "100mm"], baseFrame: { margins: { top: 10, bottom: 10, inner: 12, outer: 18 } } } satisfies DocumentInput["page"];
const doc = (pages: DocumentInput["pages"]): DocumentInput => ({ mangacli: 1, book, page, pages });
const hashira = (node: Node): PathNode[] => node.kind === "group" ? node.children.flatMap(hashira) : node.kind === "path" && node.tag?.elementType === "hashira" ? [node] : [];
const bounds = (node: PathNode) => boundsOf(flattenPath(node.path, 0.02).flatMap(({ pts }) => pts));

describe("hashira", () => {
  it("places vertical text in the safe outer gutter of facing pages only when requested", async () => {
    const r = await render(doc([{ panels: [{}], hashira: text }, { panels: [{}], hashira: text }, { panels: [{}] }]), { profile: "web", layoutOnly: true, keepLists: true });
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const [[left], [right], absent] = r.lists!.map((list) => hashira(list.root));
    expect(absent).toEqual([]);
    for (const [node, center] of [[left, 11.5], [right, 68.5]] as const) {
      const box = bounds(node);
      expect(box.h).toBeGreaterThan(box.w * 5);
      expect(box.x + box.w / 2).toBeCloseTo(center);
      expect(box.y + box.h / 2).toBeCloseTo(50);
      expect(node.tag).toMatchObject({ role: "furniture", separation: "furniture" });
    }
  });

  it.each(["right", "left"] as const)("uses the leading outer edge once on a %s-bound spread", async (binding) => {
    const input = doc([{ type: "spread", panels: [{}], hashira: text }]);
    input.book = { ...book, binding, firstPageSide: binding };
    const r = await render(input, { layoutOnly: true, keepLists: true });
    const nodes = hashira(r.lists![0].root);
    expect(nodes).toHaveLength(1);
    const box = bounds(nodes[0]);
    expect(box.x + box.w / 2).toBeCloseTo(binding === "right" ? 148.5 : 11.5);
  });

  it("honors localized text, print-basis size, color and alignment", async () => {
    const print = { text: { ja: "A", en: "SIDE" }, font: "ui", fontSize: "8Q@print", align: "bottom", color: "red" } as const;
    const input = doc([{ type: "blank", printScale: 0.5, hashira: print }, {
      type: "blank", hashira: { ...print, text: "SIDE", fontSize: "4mm", align: "top" },
    }]);
    const r = await render(input, { lang: "en", layoutOnly: true, keepLists: true });
    const [[bottom], [top]] = r.lists!.map((list) => hashira(list.root));
    const a = bounds(bottom), b = bounds(top);
    expect(a.h).toBeCloseTo(b.h);
    expect(a.w).toBeCloseTo(b.w);
    expect(a.y + a.h).toBeCloseTo(95);
    expect(b.y).toBeCloseTo(5);
    expect(bottom.paint).toEqual({ type: "solid", color: { r: 1, g: 0, b: 0, a: 1 } });
  });

  it("reports unusable gutter dimensions instead of drawing unsafe type", async () => {
    const r = await render(doc([
      { id: "narrow", type: "blank", baseFrame: "trim", hashira: text },
      { id: "long", type: "blank", hashira: text.repeat(10) },
    ]), { layoutOnly: true, keepLists: true });
    expect(r.lists!.map((list) => hashira(list.root))).toEqual([[], []]);
    expect(r.diagnostics.filter((d) => d.code === "HASHIRA_NO_SPACE")).toMatchObject([
      { severity: "warning", pageId: "narrow", path: ["pages", 0, "hashira"] },
      { severity: "warning", pageId: "long", path: ["pages", 1, "hashira"] },
    ]);
  });

  it.each([text, { text: { ja: "柱", en: "Side copy" } }])("applies the text limit to hashira: %j", async (copy) => {
    const result = await validate(doc([{ panels: [{}], hashira: copy }]), { limits: { maxTextLength: 5 } });
    expect(result.ok).toBe(false);
    expect(result.layout).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SECURITY_LIMIT_EXCEEDED", path: ["pages", 0, "hashira"] }));
  });

  it("warns when a visible bleeding panel covers the gutter", async () => {
    const panel = { id: "art", box: [0, 10, 60, 80], bleed: ["left"] } satisfies NonNullable<DocumentInput["pages"][number]["panels"]>[number];
    const r = await render(doc([{ hashira: text, layout: { free: true, area: "trim" }, panels: [panel] }]), { layoutOnly: true, keepLists: true });
    expect(hashira(r.lists![0].root)).toHaveLength(1);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "HASHIRA_PANEL_OVERLAP", message: "hashira overlaps panel art" }));
  });

  it.each([[0, "SCHEMA_RANGE"], ["2em", "UNIT_INVALID"]] as const)("rejects invalid font size %s at the hashira field", async (fontSize, code) => {
    const result = await validate(doc([{ panels: [{}], hashira: { text, fontSize } }]));
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, path: ["pages", 0, "hashira", "fontSize"] }));
  });

  it("prints the YAML shorthand as one-bit ink in the gutter", async () => {
    const yaml = `mangacli: 1
book: { pageNumbers: { enabled: false }, signature: false }
page:
  size: [80mm, 100mm]
  baseFrame: { margins: { top: 10, bottom: 10, inner: 12, outer: 18 } }
pages:
  - type: blank
    hashira: ${text}
`;
    const r = await render({ yaml }, { profile: "print-mono", format: "png", crop: "trim", dpi: 254 });
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const png = Buffer.from(r.pages[0].data);
    expect(png[24]).toBe(1);
    const pixels = await sharp(png).extract({ left: 100, top: 300, width: 30, height: 400 }).raw().toBuffer();
    expect(pixels.some((value) => value === 0)).toBe(true);
  });
});
