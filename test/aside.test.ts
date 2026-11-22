import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { load, render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { resolveDocument } from "../src/model/resolve.js";
import { boundsOf, type Rect } from "../src/geom/vec.js";
import { flattenPath } from "../src/geom/path.js";
import type { Node } from "../src/render/ir.js";

const input = (layers: string, dialogue = "") => ({
  filename: join(import.meta.dirname, "../docs/examples/aside-test.yaml"),
  yaml: `mangacli: 1
page: { size: [100mm, 85mm], bleed: 0, baseFrame: trim }
characters: { taro: {} }
assets:
  taro: { src: ./assets/taro/normal.png, character: taro, anchors: { mouth: [500, 530] }, regions: { face: [280, 140, 440, 480] } }
pages:
  - panels:
      - layers:
          - { image: taro, id: figure, fit: contain, size: [40mm, 60mm], at: [50mm, 45mm], anchor: center }
${layers}
        dialogue: [${dialogue}]
`,
});
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const flatten = (nodes: Node[]): Node[] => nodes.flatMap(n => n.kind === "group" ? flatten(n.children) : [n]);

describe("aside", () => {
  it("wraps auto-sized asides to fit beside a face without shrinking", async () => {
    const doc = {
      filename: input("").filename,
      yaml: `mangacli: 1
page: { size: [100mm, 25mm], bleed: 0, baseFrame: trim }
characters: { taro: {} }
assets:
  taro: { src: ./assets/taro/normal.png, character: taro, anchors: { mouth: [500, 530] }, regions: { face: [300, 120, 400, 540] } }
pages:
  - panels:
      - layers:
          - { image: taro, id: figure, fit: contain }
          - { balloon: そんなこと言われても困るよ, as: aside, id: aside, who: taro, writing: horizontal, fontSize: 5mm, rotate: 0deg, maxSize: [50mm, 70mm] }
`,
    };
    const r = await render(doc, { layoutOnly: true });
    const page = r.layout[0];
    const figure = page.elements.find(e => e.id === "figure")!.bbox;
    const scale = Math.min(figure.w / 1000, figure.h / 1400);
    const face = { x: figure.x + (figure.w - 1000 * scale) / 2 + 300 * scale, y: figure.y + (figure.h - 1400 * scale) / 2 + 120 * scale, w: 400 * scale, h: 540 * scale };
    const aside = page.elements.find(e => e.id === "aside")!.bbox;
    const text = page.text.find(t => t.id === "aside")!;
    expect(text.lines).toEqual(["そんなこと", "言われても困るよ"]);
    expect(text.fontSize).toBe(3.75);
    expect(aside.w).toBeLessThanOrEqual(50);
    expect(overlap(aside, face)).toBe(0);
    expect(Math.min(Math.abs(aside.x + aside.w - face.x), Math.abs(aside.x - face.x - face.w))).toBeLessThan(3);
    expect(r.diagnostics.filter(d => ["BALLOON_NO_SPACE", "TEXT_SHRUNK", "TEXT_OVERFLOW"].includes(d.code))).toEqual([]);
  });
  it("normalizes element and dialogue syntax and resolves handwriting defaults", () => {
    const p = load(input("          - { aside: ボソッ, who: taro, id: aside }", "{ taro: 小声, as: aside }"));
    expect(p.bag.hasErrors).toBe(false);
    const doc = resolveDocument(p.doc, new DiagnosticBag());
    const asides = doc.pages[0].panels[0].elements.filter(e => e.props.as === "aside");
    expect(asides).toHaveLength(2);
    for (const el of asides) {
      expect(el.type).toBe("balloon");
      expect(el.props).toMatchObject({ who: "taro", font: "hand", fontScale: 0.75, lettering: { mode: "hand" }, shape: { kind: "none" }, tail: { kind: "none" }, textOutline: [{ color: "paper" }] });
      expect(Math.abs(parseFloat(String(el.props.rotate)))).toBeLessThanOrEqual(5);
      expect(Math.abs(parseFloat(String(el.props.rotate)))).toBeGreaterThanOrEqual(3);
    }
    expect(resolveDocument(p.doc, new DiagnosticBag())).toEqual(doc);
  });

  it("honors explicit rotation", () => {
    const p = load(input("          - { aside: 小声, who: taro, rotate: 0deg }"));
    expect(resolveDocument(p.doc, new DiagnosticBag()).pages[0].panels[0].elements[1].props.rotate).toBe("0deg");
  });

  it("places asides beside the face after balloons, deterministically", async () => {
    const doc = input("          - { aside: ボソッ, who: taro, id: aside }\n          - { aside: 小声, who: taro, id: aside2 }", "{ taro: まかせて, id: speech }");
    const a = await render(doc, { profile: "preview", layoutOnly: true });
    const b = await render(doc, { profile: "preview", layoutOnly: true });
    expect(a.layout).toEqual(b.layout);
    expect(a.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const elements = a.layout[0].elements;
    const figure = elements.find(e => e.id === "figure")!.bbox;
    const face = { x: figure.x + figure.w * 0.28, y: figure.y + figure.h * 0.1, w: figure.w * 0.44, h: figure.h * 480 / 1400 };
    const aside = elements.find(e => e.id === "aside")!.bbox;
    const aside2 = elements.find(e => e.id === "aside2")!.bbox;
    const speech = elements.find(e => e.id === "speech")!.bbox;
    for (const box of [aside, aside2]) {
      expect(overlap(box, face)).toBe(0);
      expect(overlap(box, speech)).toBe(0);
      expect(Math.min(Math.abs(box.x + box.w - face.x), Math.abs(box.x - face.x - face.w))).toBeLessThan(3);
      expect(box.y).toBeLessThan(face.y + face.h + 10);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(100);
    }
    expect(overlap(aside, aside2)).toBe(0);
  });

  it("draws a short line only when requested, including print-mono", async () => {
    for (const tail of [false, true]) {
      const r = await render(input(`          - { aside: ボソッ, who: taro, id: aside, rotate: 0deg${tail ? ", tail: { kind: line }" : ""} }`), { profile: "print-mono", format: "svg", keepLists: true });
      expect(r.diagnostics.filter(d => d.severity === "error")).toEqual([]);
      const nodes = flatten(r.lists![0].root.children).filter(n => n.tag?.elementId === "aside");
      expect(nodes.some(n => n.tag?.role === "ink")).toBe(tail);
      expect(nodes.some(n => n.tag?.role === "text")).toBe(true);
      const glyph = nodes.find(n => n.kind === "path" && n.tag?.role === "text" && n.paint);
      expect(glyph?.kind === "path" && glyph.stroke?.width).toBeGreaterThan(0);
      if (tail) {
        const line = nodes.find(n => n.kind === "path" && n.tag?.role === "ink");
        expect(line?.kind).toBe("path");
        if (line?.kind === "path" && glyph?.kind === "path") {
          const a = boundsOf(flattenPath(line.path).flatMap(q => q.pts));
          const b = boundsOf(flattenPath(glyph.path).flatMap(q => q.pts));
          const dx = Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w);
          const dy = Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h);
          expect(Math.hypot(dx, dy)).toBeLessThan(0.3);
          expect(Math.hypot(a.w, a.h)).toBeLessThan(2.5);
        }
      }
    }
  });

  it("keeps visible handwriting at about three quarters of dialogue height", async () => {
    const r = await render(input('          - { aside: あ, id: aside, rotate: 0deg, lettering: typeset }\n          - { balloon: あ, id: say }'), { layoutOnly: true, keepLists: true });
    const nodes = flatten(r.lists![0].root.children);
    const height = (id: string) => {
      const n = nodes.find(n => n.kind === "path" && n.tag?.elementId === id && n.tag.role === "text" && n.paint);
      if (n?.kind !== "path") throw new Error("missing glyph path");
      return boundsOf(flattenPath(n.path).flatMap(q => q.pts)).h;
    };
    expect(height("aside") / height("say")).toBeGreaterThanOrEqual(0.7);
    expect(height("aside") / height("say")).toBeLessThanOrEqual(0.78);
  });

  it("keeps the documentation aside clear of the complete head with legible glyphs", async () => {
    const r = await render(join(import.meta.dirname, "../docs/examples/aside.yaml"), { layoutOnly: true, keepLists: true });
    expect(r.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const nodes = flatten(r.lists![0].root.children);
    const glyphBounds = (id: string) => {
      const n = nodes.find(n => n.kind === "path" && n.tag?.elementId === id && n.tag.role === "text" && n.paint);
      if (n?.kind !== "path") throw new Error("missing glyph path");
      return boundsOf(flattenPath(n.path).flatMap(q => q.pts));
    };
    const aside = r.layout[0].elements.find(e => e.id === "p1-k1-balloon1")!.bbox;
    // The 1000 x 1400 asset covers a 100 x 85 mm panel.
    const headLeft = 270 * 100 / 1000;
    const headRight = 735 * 100 / 1000;
    expect(Math.max(headLeft - aside.x - aside.w, aside.x - headRight)).toBeGreaterThan(1);
    const ratio = glyphBounds("p1-k1-balloon1").w / glyphBounds("p1-k1-d1").w;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(0.9);
  });

  it("handles empty and unattached asides and reports unknown speakers", async () => {
    const empty = await render(input('          - { aside: "", id: empty }\n          - { aside: 独り言, id: alone }'), { profile: "preview", layoutOnly: true });
    expect(empty.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const bad = await render(input("          - { aside: 小声, who: missing }"), { layoutOnly: true, throwOnError: false });
    expect(bad.diagnostics.some(d => d.code === "REF_NOT_FOUND")).toBe(true);
  });
});
