import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { miterFrameEdges } from "../src/geom/miter.js";
import { cross, norm, sub, type Vec } from "../src/geom/vec.js";
import type { Node, PathNode } from "../src/render/ir.js";

function frames(node: Node): PathNode[] {
  if (node.kind === "group") return node.children.flatMap(frames);
  return node.kind === "path" && node.tag?.role === "frame" ? [node] : [];
}

const rectangle = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 60 }, { x: 20, y: 60 }];
const acute = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 35, y: 60 }];

async function renderFrame(border: string, panel = "") {
  const r = createRenderer({ profile: "print-mono" });
  const yaml = `mangacli: 1
page: { size: [100mm, 80mm], bleed: 3mm }
pages:
  - panels:
      - border: ${border}
        ${panel}
`;
  return frames((await r.displayList({ yaml, filename: "/v/frame.yaml" }, 1)).root);
}

describe("panel frame miters", () => {
  it.each([rectangle, acute])("intersects both offset edges without a bulge or notch (%j)", (...points) => {
    const poly = points as Vec[];
    const widths = poly.map((_, i) => i + 1);
    const edges = miterFrameEdges(poly, widths);
    for (let i = 0; i < poly.length; i++) {
      const j = (i + poly.length - 1) % poly.length;
      for (const [k, sign] of [[0, 1], [3, -1]]) {
        const p = edges[i][k];
        for (const e of [i, j]) {
          const dir = norm(sub(poly[(e + 1) % poly.length], poly[e]));
          expect(cross(dir, sub(p, poly[e]))).toBeCloseTo(sign * widths[e] / 2, 10);
        }
      }
      expect(edges[i][1]).toEqual(edges[(i + 1) % poly.length][0]);
      expect(edges[i][2]).toEqual(edges[(i + 1) % poly.length][3]);
    }
  });

  it("handles empty and collinear input without nonfinite coordinates", () => {
    expect(miterFrameEdges([], [])).toEqual([]);
    const p = [...rectangle.slice(0, 1), { x: 50, y: 20 }, ...rectangle.slice(1)];
    expect(miterFrameEdges(p, p.map(() => 1)).flat().every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))).toBe(true);
  });

  it.each(["overshoot", "gap"])("preserves the %s stroke rendering path", async (join) => {
    const nodes = await renderFrame(`{ width: 1mm, join: ${join} }`);
    expect(nodes).toHaveLength(4);
    expect(nodes.every((n) => n.path.some((c) => c[0] === "C"))).toBe(true);
  });

  it("preserves per-edge widths, colours and hidden sides", async () => {
    const nodes = await renderFrame('{ width: 1mm, sides: { top: { width: 2mm, color: red }, left: none } }');
    expect(nodes).toHaveLength(3);
    expect(nodes[0].paint).toMatchObject({ type: "solid", color: { r: 1, g: 0, b: 0 } });
    expect(Math.abs((nodes[0].path[0][2] ?? 0) - (nodes[0].path[3][2] ?? 0))).toBeCloseTo(2);
    expect(await renderFrame('{ style: none }')).toEqual([]);
  });

  it("omits the frame on bled edges", async () => {
    const nodes = await renderFrame('{ width: 1mm }', 'bleed: [top, left, right]');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].path.map((c) => c[0])).toEqual(["M", "L", "L", "L", "Z"]);
  });

  it.each(["ellipse", "rounded", "cloud"])("preserves the curved %s frame path", async (shape) => {
    const nodes = await renderFrame('{ width: 1mm }', `shape: ${shape}`);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((n) => n.path.some((c) => c[0] === "C"))).toBe(true);
  });

  it.each([rectangle, acute])("emits exact straight miter outlines rather than smoothed stroke ends (%j)", async (...points) => {
    const poly = points as Vec[];
    const r = createRenderer({ profile: "print-mono" });
    const yaml = `mangacli: 1
page: { size: [100mm, 80mm] }
pages:
  - panels:
      - polygon: ${JSON.stringify(poly.map((p) => [`${p.x}mm`, `${p.y}mm`]))}
        border: { width: 1mm }
`;
    const nodes = frames((await r.displayList({ yaml, filename: "/v/frame.yaml" }, 1)).root);
    expect(nodes).toHaveLength(poly.length);
    for (const node of nodes) {
      expect(node.path.map((c) => c[0])).toEqual(["M", "L", "L", "L", "Z"]);
    }
    const expected = miterFrameEdges(poly, poly.map(() => 1));
    // Page coordinates may include bleed translation; edge vectors must be exact.
    for (let i = 0; i < nodes.length; i++) {
      const path = nodes[i].path;
      const origin = path[0];
      for (let j = 1; j < 4; j++) {
        expect((path[j][1] ?? 0) - (origin[1] ?? 0)).toBeCloseTo(expected[i][j].x - expected[i][0].x, 8);
        expect((path[j][2] ?? 0) - (origin[2] ?? 0)).toBeCloseTo(expected[i][j].y - expected[i][0].y, 8);
      }
    }
  });
});
