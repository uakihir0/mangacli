import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { createRenderer } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { flattenPath, polygonArea } from "../src/geom/path.js";
import { resolveDocument } from "../src/model/resolve.js";
import type { Node, PathNode } from "../src/render/ir.js";

const renderer = createRenderer({ profile: "preview" });
function paths(node: Node, id: string): PathNode[] {
  if (node.kind === "group") return node.children.flatMap(n => paths(n, id));
  return node.kind === "path" && node.tag?.elementId === id ? [node] : [];
}
async function scene(tail = "to: [90mm, 35mm]", obstacle = "55mm, 35mm", as = "say", first = false, pageLayer = false) {
  const source = `- { balloon: "", id: source, as: ${as}, hand: clean, size: [20mm, 20mm], at: [40mm, 35mm], tail: { ${tail} } }`;
  const neighbor = `- { balloon: "", id: neighbor, hand: clean, size: [4mm, 4mm], minSize: [0mm, 0mm], padding: 0mm, at: [${obstacle}], tail: none }`;
  const layers = (first ? [neighbor, source] : [source, neighbor]).map(s => `${pageLayer ? "      " : "          "}${s}`).join("\n");
  const yaml = `mangacli: 1
page: { size: [160mm, 80mm], bleed: 0mm }
pages:
  - ${pageLayer ? "layers:" : "panels:\n      - layers:"}
${layers}
`;
  const result = await renderer.render({ yaml, filename: "/v/tail-avoid.yaml" }, { layoutOnly: true, keepLists: true });
  expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  const root = result.lists![0].root;
  return { source: paths(root, "source"), neighbor: paths(root, "neighbor"), warnings: result.diagnostics.filter(d => d.code === "BALLOON_TAIL_CROSSES") };
}
function overlap(source: PathNode[], neighbor: PathNode[]): number {
  const fills = (nodes: PathNode[]) => nodes.filter(n => n.tag?.role === "fill").flatMap(n => flattenPath(n.path).filter(p => p.closed).map(p => [p.pts.map(q => [q.x, q.y] as [number, number])]));
  let area = 0;
  for (const a of fills(source)) for (const b of fills(neighbor)) {
    for (const polygon of polygonClipping.intersection(a, b)) for (const [i, ring] of polygon.entries()) area += (i ? -1 : 1) * Math.abs(polygonArea(ring.map(([x, y]) => ({ x, y }))));
  }
  return area;
}

describe("tail avoidance", () => {
  it.each(["say", "think", "electronic"])("preserves unobstructed %s output byte for byte", async as => {
    const a = await scene(undefined, "100mm, 65mm", as);
    const b = await scene(undefined, "110mm, 65mm", as);
    expect(JSON.stringify(a.source)).toBe(JSON.stringify(b.source));
    expect(a.warnings).toEqual([]);
  });

  it.each([false, true])("reroutes an explicit to without who, including later obstacles (first=%s)", async first => {
    const unobstructed = await scene(undefined, "100mm, 65mm");
    const routed = await scene(undefined, undefined, "say", first);
    expect(overlap(unobstructed.source, routed.neighbor)).toBeGreaterThan(0.1);
    expect(overlap(routed.source, routed.neighbor)).toBeLessThan(1e-6);
    expect(routed.source).not.toEqual(unobstructed.source);
    expect(routed.warnings).toEqual([]);
  });

  it("avoids neighboring bodies with thought bubbles", async () => {
    const original = await scene(undefined, "100mm, 65mm", "think");
    const routed = await scene(undefined, "53mm, 35mm", "think");
    expect(overlap(original.source, routed.neighbor)).toBeGreaterThan(0.1);
    expect(overlap(routed.source, routed.neighbor)).toBeLessThan(1e-6);
    expect(routed.warnings).toEqual([]);
  });

  it("respects explicit root, length and bend and names unavoidable obstacles", async () => {
    const tail = "to: [90mm, 35mm], root: 0deg, length: 8mm, bend: 0, curl: false";
    const original = await scene(tail, "100mm, 65mm");
    const blocked = await scene(tail);
    expect(blocked.source).toEqual(original.source);
    expect(overlap(blocked.source, blocked.neighbor)).toBeGreaterThan(0.1);
    expect(blocked.warnings).toHaveLength(1);
    expect(blocked.warnings[0]).toMatchObject({ elementId: "source", severity: "warning" });
    expect(blocked.warnings[0].message).toContain("neighbor");
  });

  it("can vary the root while preserving an explicit length and bend", async () => {
    const routed = await scene("to: [90mm, 35mm], length: 8mm, bend: 0, curl: false");
    expect(overlap(routed.source, routed.neighbor)).toBeLessThan(1e-6);
    expect(routed.warnings).toEqual([]);
  });

  it("routes balloons in page layers too", async () => {
    const routed = await scene(undefined, undefined, "say", false, true);
    expect(overlap(routed.source, routed.neighbor)).toBeLessThan(1e-6);
    expect(routed.warnings).toEqual([]);
  });

  it("shortens automatic length when the root and bend are fixed", async () => {
    const routed = await scene("to: [90mm, 35mm], root: 0deg, bend: 0, curl: false");
    expect(overlap(routed.source, routed.neighbor)).toBeLessThan(1e-6);
    expect(routed.warnings).toEqual([]);
  });

  it("reports an inside target without producing a crossing warning", async () => {
    const inside = await scene("to: [40mm, 35mm]");
    const none = await scene("kind: none");
    expect(inside.source).toEqual(none.source);
    expect(inside.warnings).toEqual([]);
  });

  it("does not invent tails or warnings for none", async () => {
    const a = await scene("kind: none");
    const b = await scene("kind: none", "100mm, 65mm");
    expect(a.source).toEqual(b.source);
    expect(a.warnings).toEqual([]);
  });

  it("tracks author parameters from defaults and inherited styles without locking builtin bends", () => {
    const resolved = resolveDocument({
      defaults: { balloon: { tail: { length: "8mm" } } },
      styles: { parent: { tail: { root: "0deg" } }, child: { extends: "parent", tail: { bend: 0 } } },
      pages: [{ layers: [{ type: "balloon", style: "child" }, { type: "balloon", as: "shout" }] }],
    }, new DiagnosticBag());
    expect(resolved.pages[0].layers[0].tailExplicit).toEqual({ tail: { root: "0deg", length: "8mm", bend: 0 } });
    expect(resolved.pages[0].layers[1].tailExplicit).toEqual({ tail: { length: "8mm" } });
  });
});
