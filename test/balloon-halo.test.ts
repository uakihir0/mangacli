import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRenderer, validate } from "../src/api.js";
import { BLACK, WHITE } from "../src/core/color.js";
import { add, mul, norm, sub } from "../src/geom/vec.js";
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

  it("keeps a thin rim outside the miter apex of a burst balloon", async () => {
    const result = await createRenderer({ profile: "web", dpi: 600 }).render({
      mangacli: 1,
      page: { size: ["45mm", "45mm"], bleed: "0mm", background: "#ff0000" },
      pages: [{ layers: [{ balloon: "", id: "b", as: "scream", shape: { kind: "burst", depth: [0.45, 0.45], count: 18 }, at: ["50%", "50%"], size: ["24mm", "24mm"], hand: "clean", tail: "none", halo: "0.18mm", haloColor: "#00ff00", stroke: { width: "0.7mm" } }] }],
    }, { keepLists: true, colorMode: "color" });
    const ink = paths([result.lists![0].root]).find(n => n.tag?.elementId === "b" && n.tag.role === "ink")!;
    const [, apex, , tip] = ink.path;
    const outer = { x: apex[1] as number, y: apex[2] as number };
    const center = { x: tip[1] as number, y: tip[2] as number };
    const probe = add(outer, mul(norm(sub(outer, center)), 0.08));
    const { data, info } = await sharp(result.pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (Math.floor(y * info.height / 45) * info.width + Math.floor(x * info.width / 45)) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    };
    expect(pixel(1, 1)).toEqual([255, 0, 0]);
    expect(pixel(probe.x, probe.y)).toEqual([0, 255, 0]);
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
