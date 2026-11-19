import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { load, render } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { resolveDocument } from "../src/model/resolve.js";
import type { Rect } from "../src/geom/vec.js";
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
      expect(Math.min(Math.abs(box.x + box.w - face.x), Math.abs(box.x - face.x - face.w))).toBeLessThan(10);
      expect(box.y).toBeLessThan(face.y + face.h + 10);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(100);
    }
    expect(overlap(aside, aside2)).toBe(0);
  });

  it("draws a short line only when requested, including print-mono", async () => {
    for (const tail of [false, true]) {
      const r = await render(input(`          - { aside: ボソッ, who: taro, id: aside${tail ? ", tail: { kind: line }" : ""} }`), { profile: "print-mono", format: "svg", keepLists: true });
      expect(r.diagnostics.filter(d => d.severity === "error")).toEqual([]);
      const nodes = flatten(r.lists![0].root.children).filter(n => n.tag?.elementId === "aside");
      expect(nodes.some(n => n.tag?.role === "ink")).toBe(tail);
      expect(nodes.some(n => n.tag?.role === "text")).toBe(true);
    }
  });

  it("handles empty and unattached asides and reports unknown speakers", async () => {
    const empty = await render(input('          - { aside: "", id: empty }\n          - { aside: 独り言, id: alone }'), { profile: "preview", layoutOnly: true });
    expect(empty.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const bad = await render(input("          - { aside: 小声, who: missing }"), { layoutOnly: true, throwOnError: false });
    expect(bad.diagnostics.some(d => d.code === "REF_NOT_FOUND")).toBe(true);
  });
});
