import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";
import { flattenPath, polygonArea } from "../src/geom/path.js";
import type { Node, PathNode } from "../src/render/ir.js";

const renderer = createRenderer({ profile: "preview" });
const paths = (node: Node): PathNode[] => node.kind === "group" ? node.children.flatMap(paths) :
  node.kind === "path" && node.tag?.elementType === "balloon" ? [node] : [];
const fills = (nodes: PathNode[]) => nodes.filter(n => n.tag?.role === "fill");
const lettering = (nodes: PathNode[], id: string) => nodes.filter(n => n.tag?.role === "text" && n.tag.elementId === id);
const area = (node: PathNode) => flattenPath(node.path).reduce((total, path) => total + Math.abs(polygonArea(path.pts)), 0);

async function scene(at: number, connect = "", extra = "", obstacle?: "monologue" | "mouth" | "ellipse-corner") {
  const withMouth = obstacle === "mouth" || obstacle === "ellipse-corner";
  const ellipse = obstacle === "ellipse-corner";
  const sceneRenderer = withMouth ? createRenderer({ profile: "preview", assets: {
    face: await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toBuffer(),
  } }) : renderer;
  const layer = obstacle === "monologue" ? "- {balloon: Word, id: obstacle, as: monologue, at: [48mm, 28mm]}" :
    withMouth ? `- {image: face, at: [${ellipse ? "41mm, 36mm" : "48mm, 28mm"}], anchor: center, size: [8mm, 8mm]}` : "";
  const result = await sceneRenderer.render({ yaml: `mangacli: 1
meta: {lang: en}
page: {size: [120mm, 80mm], bleed: 0mm}
book: {readingDirection: ltr}
${withMouth ? "assets: {face: {src: face.png, character: speaker, anchors: {mouth: [16, 16]}}}" : ""}
pages:
  - panels:
      - layers:
          - {balloon: A, id: first, at: [28mm, 28mm], size: [20mm, 20mm], shape: {kind: ${ellipse ? "ellipse" : "rect"}}, hand: clean, halo: none, tail: none}
          - {balloon: B, id: second, at: [${at}mm, 28mm], size: [20mm, 20mm], shape: {kind: ${ellipse ? "ellipse" : "rect"}}, hand: clean, halo: none, tail: none${connect}${extra}}
          ${layer}
` }, { layoutOnly: true, keepLists: true });
  expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  return { nodes: paths(result.lists![0].root), diagnostics: result.diagnostics.filter(d => d.code === "BALLOON_CONNECT_DISJOINT") };
}

describe("balloon connections", () => {
  it.each([[75, "{to: first}"], [47, "{to: first, style: overlap}"], [60, "[{to: first}]"]])(
    "moves a weakly overlapping or disjoint balloon at %s mm into one outline", async (at, connect) => {
      const separate = await scene(at);
      const merged = await scene(at, `, connect: ${connect}`);
      expect(merged.diagnostics).toEqual([]);
      const [a, b] = fills(separate.nodes).map(area);
      expect(fills(merged.nodes)).toHaveLength(1);
      const share = (a + b - area(fills(merged.nodes)[0])) / Math.min(a, b);
      expect(share).toBeGreaterThanOrEqual(0.15);
      expect(share).toBeLessThanOrEqual(0.25);
      expect(lettering(merged.nodes, "first")).toEqual(lettering(separate.nodes, "first"));
      expect(lettering(merged.nodes, "second")).toHaveLength(1);
      expect(lettering(merged.nodes, "second")).not.toEqual(lettering(separate.nodes, "second"));
    },
  );

  it("keeps the lettering in place when the bodies already overlap enough", async () => {
    const separate = await scene(42);
    const merged = await scene(42, ", connect: {to: first}");
    expect(fills(merged.nodes)).toHaveLength(1);
    expect(lettering(merged.nodes, "second")).toEqual(lettering(separate.nodes, "second"));
  });

  it("draws a frame-attached balloon separately with an info diagnostic", async () => {
    const separate = await scene(75, "", ", attach: right");
    const result = await scene(75, ", connect: {to: first}", ", attach: right");
    expect(result.nodes).toEqual(separate.nodes);
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "info", elementId: "second" })]);
  });

  it.each(["monologue", "mouth"] as const)("does not move the second balloon over a %s", async obstacle => {
    const separate = await scene(75, "", "", obstacle);
    const result = await scene(75, ", connect: {to: first}", "", obstacle);
    expect(fills(result.nodes)).toHaveLength(2);
    expect(result.nodes).toEqual(separate.nodes);
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "info", elementId: "second" })]);
  });

  it("does not move an ellipse over a mouth already inside its bounding box", async () => {
    const separate = await scene(47, "", "", "ellipse-corner");
    const result = await scene(47, ", connect: {to: first}", "", "ellipse-corner");
    expect(fills(result.nodes)).toHaveLength(2);
    expect(result.nodes).toEqual(separate.nodes);
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "info", elementId: "second" })]);
  });

  it("draws a connector line only when explicitly requested", async () => {
    const separate = await scene(75);
    const result = await scene(75, ", connect: {to: first, style: line}");
    for (const id of ["first", "second"]) expect(fills(result.nodes).find(n => n.tag!.elementId === id)).toEqual(fills(separate.nodes).find(n => n.tag!.elementId === id));
    expect(result.nodes.filter(n => n.tag?.role === "ink")).toHaveLength(separate.nodes.filter(n => n.tag?.role === "ink").length + 1);
    expect(result.diagnostics).toEqual([]);
  });

  it("retains the explicit neck style without repositioning either balloon", async () => {
    const separate = await scene(75);
    const result = await scene(75, ", connect: {to: first, style: neck}");
    expect(fills(result.nodes)).toHaveLength(1);
    for (const id of ["first", "second"]) expect(lettering(result.nodes, id)).toEqual(lettering(separate.nodes, id));
  });
});
