import { describe, expect, it } from "vitest";
import { createRenderer, validate } from "../src/api.js";
import { BLACK, WHITE } from "../src/core/color.js";
import type { Node, PathNode } from "../src/render/ir.js";

function paths(nodes: Node[]): PathNode[] {
  return nodes.flatMap(n => n.kind === "group" ? paths(n.children) : n.kind === "path" ? [n] : []);
}

async function halo(props: Record<string, unknown> = {}, extra = {}) {
  const list = await createRenderer({ profile: "web" }).displayList({
    mangacli: 1,
    ...extra,
    pages: [{ panels: [{ layers: [{ balloon: "", id: "b", as: "inverted", at: ["50%", "50%"], size: ["30mm", "20mm"], hand: "clean", tail: { direction: "90deg", length: "8mm" }, ...props }] }] }],
  }, 1);
  return paths([list.root]).find(n => n.tag?.elementId === "b" && n.tag.role === "fill" && n.stroke);
}

describe("balloon halo", () => {
  it("gives inverted and explicitly black balloons a white rim around the filled body and tail", async () => {
    const rim = (await halo())!;
    expect(rim.stroke?.paint).toEqual({ type: "solid", color: WHITE });
    expect(rim.stroke?.width).toBeCloseTo(0.85);
    expect(rim.path).toEqual((await halo({ as: "say", fill: "black" }))?.path);
  });

  it("keeps white balloons' fill-colored rim", async () => {
    expect((await halo({ as: "say" }))?.stroke?.paint).toEqual({ type: "solid", color: WHITE });
  });

  it.each(["none", false, 0])("supports halo: %s", async value => {
    expect(await halo({ halo: value })).toBeUndefined();
  });

  it.each(["none", "transparent", "tone(20%)"])("does not add a halo for %s fill", async fill => {
    expect(await halo({ fill })).toBeUndefined();
  });

  it("cascades defaults, styles, and per-balloon overrides", async () => {
    const extra = { defaults: { balloon: { halo: "1mm", haloColor: "black" } }, styles: { rim: { haloColor: "white" } } };
    expect((await halo({}, extra))?.stroke?.paint).toEqual({ type: "solid", color: BLACK });
    expect((await halo({ style: "rim" }, extra))?.stroke?.paint).toEqual({ type: "solid", color: WHITE });
    const own = await halo({ style: "rim", haloColor: "black", halo: "2mm" }, extra);
    expect(own?.stroke?.paint).toEqual({ type: "solid", color: BLACK });
    expect(own?.stroke?.width).toBeCloseTo(4.25);
  });

  it("rejects a non-string halo color", async () => {
    const result = await validate({ mangacli: 1, pages: [{ panels: [{ layers: [{ balloon: "", haloColor: false }] }] }] });
    expect(result.diagnostics.some(d => d.severity === "error")).toBe(true);
  });
});
