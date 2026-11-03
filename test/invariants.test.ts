import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { makeToneSampler } from "../src/render/screen.js";
import type { Node } from "../src/render/ir.js";

const r = createRenderer({ profile: "preview" });
const y = (s: string) => ({ yaml: s, filename: "/v/inv.yaml" });
const doc = (second: string) => `mangacli: 1
page: { size: [120mm, 80mm], bleed: 3mm }
pages:
  - layout: { rows: [{ cols: [1, 1], slant: 3mm }, { cols: [1] }] }
    panels:
      - layers:
          - { effect: focus-lines }
          - { balloon: こんにちは, id: a }
          - { balloon: ${second}, id: b, at: [30%, 70%] }
      - layers: [{ effect: speed-lines }, { mark: sparkle }]
      - layers: [{ sfx: ドン }, { text: その時, place: top-right }]
`;

function byElement(n: Node, out = new Map<string, string>()): Map<string, string> {
  const walk = (x: Node) => {
    if (x.kind === "group") x.children.forEach(walk);
    const id = x.tag?.elementId;
    if (id && x.kind !== "group") out.set(id, (out.get(id) ?? "") + JSON.stringify(x));
  };
  walk(n);
  return out;
}

describe("invariants (spec 14.2.2)", () => {
  it("display lists contain no NaN or infinity", async () => {
    const list = await r.displayList(y(doc("さようなら")), 1);
    const bad: string[] = [];
    JSON.stringify(list, (k, v) => {
      if (typeof v === "number" && !Number.isFinite(v)) bad.push(k);
      return v;
    });
    expect(bad).toEqual([]);
  });
  it("changing one element leaves the others unchanged", async () => {
    const a = byElement((await r.displayList(y(doc("さようなら")), 1)).root);
    const b = byElement((await r.displayList(y(doc("またね")), 1)).root);
    for (const id of ["a", "p1-k2-effect1", "p1-k3-sfx1"]) {
      expect(a.get(id), id).toBeDefined();
      expect(b.get(id), id).toBe(a.get(id));
    }
    expect(b.get("b")).not.toBe(a.get("b"));
  });
  it("tone area coverage matches the density within ±1.5 %", () => {
    const mmPerPx = 25.4 / 600;
    const target = { mmPerPx, toMm: (x: number, yy: number) => [x * mmPerPx, yy * mmPerPx] as [number, number] };
    for (const angle of [0, Math.PI / 4, 0.3]) {
      for (const d of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const s = makeToneSampler({ density: d, lpi: 60, angle, dot: "round", grain: 0.08, invert: false, offset: [0, 0], seed: 1 }, target as never);
        let on = 0;
        const N = 400;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) on += s(i, j) > 0.5 ? 1 : 0;
        expect(Math.abs(on / (N * N) - d), `d=${d} angle=${angle}`).toBeLessThan(0.015);
      }
    }
  });
});
