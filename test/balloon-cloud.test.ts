import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { Rng } from "../src/core/random.js";
import { distToPolyline, flattenPath, pointInPolygon } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
import { BODY_GENERATORS } from "../src/shapes/balloon.js";
import type { Node, PathNode } from "../src/render/ir.js";

const cloud = (seed: number, lobeSize?: [number, number]) => BODY_GENERATORS.cloud(40, 40, {
  kind: "cloud", irregularity: 0, tilt: 0, egg: 0, lobeSize,
}, seed);

describe("hand-drawn clouds", () => {
  it("separates neighbouring lobe sizes, including the closing pair", () => {
    for (const seed of [1, 42, 987]) {
      const { pts, corners } = cloud(seed).contour;
      const angles = corners!.map(c => Math.atan2(pts[c.index].y, pts[c.index].x));
      const sizes = angles.map((a, i) => (angles[(i + 1) % angles.length] - a + 2 * Math.PI) % (2 * Math.PI));
      for (let i = 0; i < sizes.length; i++) {
        const a = sizes[i], b = sizes[(i + 1) % sizes.length];
        expect(Math.abs(a - b) / Math.max(a, b)).toBeGreaterThanOrEqual(0.199);
      }
      expect(corners!.every(c => c.kind === "concave")).toBe(true);
      expect(cloud(seed).contour.pts).toEqual(pts);
    }
  });

  it("handles an explicit uniform size range without endless redraws", () => {
    expect(cloud(42, [1, 1]).contour.pts.length).toBeGreaterThan(10);
    expect(cloud(42).contour.pts).not.toEqual(cloud(43).contour.pts);
  });

  it("produces at least a 2:1 measured stroke width ratio, but not for clean", () => {
    for (const seed of [1, 42, 987]) {
      const contour = cloud(seed).contour;
      for (const preset of ["ink", "clean"]) {
        const inks = inkShape(contour, {
          line: { width: 0.2, style: "solid", pen: { ...PEN_PRESETS["maru-pen"], cap: "flat", inkPool: 0, curvature: 0, pull: 0 } },
          hand: { ...HAND_PRESETS[preset], tremorAmp: 0, wobbleAmp: 0 }, rng: new Rng(seed),
        }).inks;
        const widths = inks.flatMap(({ pts }) => {
          const n = pts.length / 2;
          return pts.slice(0, n).map((p, i) => Math.hypot(p.x - pts[pts.length - 1 - i].x, p.y - pts[pts.length - 1 - i].y));
        });
        const ratio = Math.max(...widths) / Math.min(...widths);
        if (preset === "clean") expect(ratio).toBeCloseTo(1, 8);
        else {
          console.log(`cloud seed ${seed}: measured max/min width = ${ratio.toFixed(3)}`);
          expect(ratio).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe("thought bubble tails", () => {
  const fills = (node: Node): PathNode[] => node.kind === "group" ? node.children.flatMap(fills)
    : node.kind === "path" && node.tag?.elementId === "thought" && node.tag.role === "fill" && node.paint ? [node] : [];

  it.each(["clean", "ink"])("keeps three round bubbles detached on a short tail (%s)", async hand => {
    const r = createRenderer({ profile: "preview" });
    const scene = (tail: string) => r.displayList({ yaml: `mangacli: 1
page: { size: [160mm, 100mm] }
pages:
  - layers:
      - id: thought
        balloon: 考えごと
        as: think
        hand: ${hand}
        at: [40mm, 35mm]
        tail: ${tail}
`, filename: "/v/cloud.yaml" }, 1);
    const [body, ...bubbles] = fills((await scene("{ to: [100mm, 35mm], maxLength: 4.5mm }")).root);
    expect(body.path).toEqual(fills((await scene("none")).root)[0].path);
    expect(bubbles).toHaveLength(3);
    let previous = flattenPath(body.path, 0.01)[0].pts;
    let previousWidth = Infinity;
    for (const bubble of bubbles) {
      const points = flattenPath(bubble.path, 0.01)[0].pts;
      const bounds = boundsOf(points);
      expect(bounds.w).toBeCloseTo(bounds.h, 2);
      expect(bounds.w).toBeLessThan(previousWidth);
      expect(bounds.x + bounds.w / 2).toBeGreaterThan(boundsOf(previous).x + boundsOf(previous).w / 2);
      expect(points.every(p => !pointInPolygon(p, previous) && distToPolyline(p, previous, true) > 0.25)).toBe(true);
      previous = points;
      previousWidth = bounds.w;
    }
  });

  it.each([undefined, 0.5])("preserves explicit count and bubbleSize with shrink %s", async shrink => {
    const r = createRenderer({ profile: "preview" });
    const result = await r.displayList({ yaml: `mangacli: 1
page: { size: [160mm, 100mm] }
pages:
  - panels:
      - layers:
          - id: thought
            balloon: 考えごと
            as: think
            at: [50%, 30%]
            tail: { kind: bubbles, count: 4, bubbleSize: 5mm, length: 30mm, direction: 90deg${shrink === undefined ? "" : `, shrink: ${shrink}`} }
`, filename: "/v/cloud.yaml" }, 1);
    const bubbles = fills(result.root).slice(1);
    expect(bubbles).toHaveLength(4);
    const diameters = bubbles.map(b => {
      const pts = flattenPath(b.path, 0.05).flatMap(p => p.pts);
      return Math.max(...pts.flatMap(a => pts.map(b => Math.hypot(a.x - b.x, a.y - b.y))));
    });
    expect(diameters[0]).toBeCloseTo(5, 0);
    const expected = shrink === undefined ? [1, 0.6, 0.35, 0.22] : [1, 0.5, 0.25, 0.125];
    for (let i = 0; i < expected.length; i++) expect(diameters[i] / diameters[0]).toBeCloseTo(expected[i], 1);
  });
});
