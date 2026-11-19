import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createRenderer } from "../src/api.js";
import { parseFilter, applyFilters } from "../src/render/filters.js";
import { phraseBoundaries } from "../src/text/linebreak.js";

const r = createRenderer({ profile: "preview" });
const y = (s: string) => ({ yaml: s, filename: join(import.meta.dirname, "..", "docs", "examples", "feat.yaml") });
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
  it("keeps auxiliaries with their verbs", () => {
    const b = phraseBoundaries("教室には誰もいない");
    expect(b.has(7)).toBe(false);
  });
});
