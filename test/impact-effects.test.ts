import { describe, expect, it } from "vitest";
import { createRenderer, validate } from "../src/api.js";
import type { Node } from "../src/render/ir.js";

const renderer = createRenderer({ profile: "print-mono" });
const input = (kind: string, seed = 42, extra = "") => ({ yaml: `mangacli: 1
pages:
  - panels:
      - layers:
          - { effect: ${kind}, center: [50%, 50%], seed: ${seed}, ${extra} }
`, filename: "/v/effects.yaml" });
const leaves = (n: Node): Node[] => n.kind === "group" ? n.children.flatMap(leaves) : [n];

describe.each([ ["lightning", "bolts", 1], ["crack", "count", 2], ["dust", "puffs", 2], ["smoke", "density", 0.1] ] as const)("%s", (kind, param, value) => {
  it("renders without diagnostics, with independent ink and planes", async () => {
    expect((await validate(input(kind))).diagnostics).toEqual([]);
    const nodes = leaves((await renderer.displayList(input(kind), 1)).root).filter(n => n.tag?.elementType === "effect");
    expect(nodes.some(n => n.tag?.role === "ink")).toBe(true);
    expect(nodes.some(n => n.tag?.role === "fill")).toBe(true);
  });
  it("is reproducible and varies with seed and parameters", async () => {
    const a = await renderer.displayList(input(kind), 1);
    expect(await renderer.displayList(input(kind), 1)).toEqual(a);
    expect(await renderer.displayList(input(kind, 43), 1)).not.toEqual(a);
    expect(await renderer.displayList(input(kind, 42, `${param}: ${value}`), 1)).not.toEqual(a);
  });
  it("supports empty output", async () => {
    const empty = kind === "dust" ? "puffs: 0, debris: 0" : `${param}: 0`;
    const list = await renderer.displayList(input(kind, 42, `${empty}, background: none`), 1);
    expect(leaves(list.root).filter(n => n.tag?.elementType === "effect")).toEqual([]);
  });
  it("rejects invalid parameters", async () => {
    const invalid = kind === "crack" ? "branching: 2" : kind === "smoke" ? "origin: false" : `${param}: -1`;
    expect((await validate(input(kind, 42, invalid))).diagnostics.some(d => d.severity === "error")).toBe(true);
  });
});
