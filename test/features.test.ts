 import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { flattenPath, polygonArea } from "../src/geom/path.js";
import { parseFilter, applyFilters } from "../src/render/filters.js";
import type { Node } from "../src/render/ir.js";
import { phraseBoundaries } from "../src/text/linebreak.js";

const r = createRenderer({ profile: "preview" });
 const y = (s: string) => ({ yaml: s, filename: fileURLToPath(new URL("../docs/examples/feat.yaml", import.meta.url)) });
const page = (layers: string) => `mangacli: 1\npage: { size: [80mm, 60mm], bleed: 0, baseFrame: trim }\npages:\n  - panels:\n      - layers:\n${layers}`;

describe("features", () => {
  it("validates documented forms without errors", async () => {
    const docs = [
      "          - { type: fill, region: { subtract: [{ rect: [0, 0, 50%, 50%] }, { ellipse: [25%, 25%, 10%, 10%] }], feather: 1mm }, paint: tone(30%) }\n",
      "          - { image: assets/taro/normal.png, filters: [invert, \"levels(0.1, 0.9)\", { halftone: { lpi: 40 } }], shadow: { offset: [1mm, 1mm] } }\n",
      "          - { type: draw, kind: rect, size: [20mm, 10mm], radius: 2mm, rotate: 10deg }\n          - { type: draw, kind: path, d: \"M0 0 C10 10 20 0 30 10\" }\n",
      "          - { balloon: ひし形, shape: { kind: polygon, points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] }, rotate: 10deg, minSize: [20mm, 20mm] }\n",
      "          - { sfx: ドドド, path: { kind: arc, angle: 40deg }, distort: { perspective: [0.8, 1.2], bulge: 0.3 }, chars: [{ index: 1, color: red }] }\n",
      "          - { text: \"<b>太字</b><color=red>赤</color><em mark=dot>点</em><scale x=0.7>長体</scale><shake>震え</shake>\", ruby: { position: left }, features: { palt: true } }\n",
      "          - { type: scatter, count: 5, items: [{ mark: sparkle }, { type: draw, kind: ellipse, size: [2mm, 2mm] }], orient: radial }\n",
      "          - { effect: hatching, pattern: kakeami, gradient: { from: 1, to: 0 } }\n          - { effect: vignette, shape: rect, screen: spatter }\n",
    ];
    for (const d of docs) {
      const v = await r.validate(y(page(d)));
      expect(v.diagnostics.filter((x) => x.severity === "error"), d).toEqual([]);
    }
  });
  it("parses and applies filters", async () => {
    expect(parseFilter("levels(0.1, 0.9)")).toEqual({ name: "levels", args: [0.1, 0.9] });
    const px = { data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1 };
    const out = await applyFilters(px, [parseFilter("invert")!], 0.1);
    expect(Array.from(out.data.slice(0, 3))).toEqual([245, 235, 225]);
  });
  it("renders an em-scaled white fuchi behind SFX ink, unless disabled", async () => {
    const list = await r.displayList(y(page(
      "          - { id: dash, sfx: ダッ, at: [30%, 50%], fontSize: 10mm }\n" +
      "          - { id: hit, sfx: ドン, at: [70%, 50%], fontSize: 10mm, outline: none }\n",
    )), 1);
    const paths = (node: Node): Extract<Node, { kind: "path" }>[] =>
      node.kind === "group" ? node.children.flatMap(paths) : node.kind === "path" ? [node] : [];
    const dash = paths(list.root).filter((n) => n.tag?.elementId === "dash");
    expect(dash[0].stroke).toMatchObject({ width: 2.6, paint: { type: "solid", color: { r: 1, g: 1, b: 1 } } });
    expect(dash[1].paint).toMatchObject({ type: "solid", color: { r: 0, g: 0, b: 0 } });
    const hit = paths(list.root).filter((n) => n.tag?.elementId === "hit");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((n) => !n.stroke)).toBe(true);
  });
  it("aims a longer wedge at its speaker and keeps a thought trail detached", async () => {
    const list = await r.displayList(y(page(
      "          - { id: speech, balloon: 見て, at: [20mm, 18mm], size: [20mm, 18mm], tail: { to: [20mm, 45mm] } }\n" +
      "          - { id: thought, balloon: 思う, as: think, at: [58mm, 18mm], size: [20mm, 18mm], tail: { to: [58mm, 45mm] } }\n",
    ).replace("[80mm, 60mm]", "B5")), 1);
    const fills = (node: Node, id: string): number[][] => {
      if (node.kind === "group") return node.children.flatMap((child) => fills(child, id));
      if (node.kind !== "path" || !node.paint || node.tag?.elementId !== id || node.tag.role !== "fill") return [];
      return flattenPath(node.path).map(({ pts }) => [
        Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)), pts.reduce((a, b) => a.y > b.y ? a : b).x,
      ]);
    };
    const [[, tipY, tipX]] = fills(list.root, "speech");
    expect(tipY).toBeGreaterThan(39);
    expect(tipY).toBeLessThan(45);
    expect(tipX).toBeCloseTo(20, 0);
    const trail = fills(list.root, "thought").sort(([a], [b]) => a - b);
    expect(trail).toHaveLength(4);
    for (let i = 1; i < trail.length; i++) expect(trail[i][0]).toBeGreaterThan(trail[i - 1][1]);
    expect(trail[3][1] - trail[3][0]).toBeLessThan(trail[1][1] - trail[1][0]);
  });
  it("keeps auxiliaries with their verbs", () => {
    const b = phraseBoundaries("教室には誰もいない");
    expect(b.has(7)).toBe(false);
  });
  it("draws longer strokes for the heavier focus rays", async () => {
    const list = await r.displayList(y(page(
      "          - { id: rays, effect: focus-lines, center: [40mm, 30mm], inner: [12mm, 12mm], innerJitter: 1, count: 96, thickness: [0.1mm, 0.6mm], spikes: { ratio: 0 }, hand: clean, taper: none }\n",
    )), 1);
    const collect = (n: Node): { width: number; reach: number }[] => {
      if (n.kind === "group") return n.children.flatMap(collect);
      if (n.kind !== "path" || n.tag?.elementId !== "rays") return [];
      return flattenPath(n.path).map(({ pts }) => {
        const radii = pts.map(({ x, y }) => Math.hypot(x - 40, y - 30));
        const reach = Math.min(...radii);
        return { reach, width: Math.abs(polygonArea(pts)) / (Math.max(...radii) - reach) };
      });
    };
    const rays = collect(list.root).sort((a, b) => a.width - b.width);
    const meanReach = (subset: typeof rays) => subset.reduce((sum, ray) => sum + ray.reach, 0) / subset.length;
    expect(rays.length).toBeGreaterThanOrEqual(96);
    expect(meanReach(rays.slice(-24))).toBeLessThan(meanReach(rays.slice(0, 24)) - 2);
  });
});
