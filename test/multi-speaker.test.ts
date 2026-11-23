import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer, validate } from "../src/api.js";
import { RefRegistry, type RefTarget } from "../src/layout/place.js";
import type { Node, PathNode } from "../src/render/ir.js";

function target(): RefTarget {
  return { id: "img", type: "image", bbox: { x: 0, y: 0, w: 100, h: 80 }, anchors: { mouth: { x: 10, y: 40 } }, regions: {}, character: "taro", speakers: {
    hana: { anchors: { mouth: { x: 90, y: 40 } }, regions: { face: { bbox: { x: 80, y: 30, w: 20, h: 20 }, poly: [] } } },
  } };
}

function paths(node: Node): PathNode[] {
  return node.kind === "group" ? node.children.flatMap(paths) : node.kind === "path" ? [node] : [];
}

describe("multi-speaker images", () => {
  it("resolves speakers, explicit anchors and regions with shared panel membership", () => {
    const refs = new RefRegistry(() => ["mouth", "face"]);
    refs.add(target());
    refs.setPanels("img", ["p"]);
    expect(refs.point("taro", "p")).toEqual({ x: 10, y: 40 });
    expect(refs.point("hana", "p")).toEqual({ x: 90, y: 40 });
    expect(refs.point("img.hana", "p")).toEqual({ x: 90, y: 40 });
    expect(refs.point("img.hana.mouth", "p")).toEqual({ x: 90, y: 40 });
    expect(refs.point("img.hana.face", "p")).toEqual({ x: 90, y: 40 });
    expect(refs.point("img.hana.face.top", "p")).toEqual({ x: 90, y: 30 });
    expect(refs.target("img.hana.mouth")?.regions.face.bbox.x).toBe(80);
    expect(refs.character("hana", "other")).toBeUndefined();
    expect(refs.point("img.mouth", "p")).toEqual({ x: 10, y: 40 });
    expect(refs.point("img.top", "p")).toEqual({ x: 50, y: 0 });
    expect(refs.point("img.hana.missing", "p")).toBeNull();
  });

  it("lets a named entry replace the primary speaker and supports empty entries", () => {
    const refs = new RefRegistry(() => ["mouth", "face"]);
    const t = target();
    t.speakers!.taro = { anchors: { mouth: { x: 20, y: 50 } }, regions: {} };
    t.speakers!.empty = { anchors: {}, regions: {} };
    refs.add(t);
    expect(refs.point("taro", undefined)).toEqual({ x: 20, y: 50 });
    expect(refs.character("empty")).toBeDefined();
    expect(refs.point("img.empty", undefined)).not.toBeNull();
  });

  it("preserves flat reference names that also name speakers", () => {
    const refs = new RefRegistry(() => ["face", "mouth"]);
    const t = target();
    t.anchors.hana = { x: 5, y: 6 };
    refs.add(t);
    expect(refs.point("img.hana", undefined)).toEqual({ x: 5, y: 6 });
    expect(refs.target("img.hana")).toBe(t);
    expect(refs.point("hana", undefined)).toEqual({ x: 90, y: 40 });
  });

  it.each([false, true])("aims tails at opposite mouths with legacy primary = %s", async (legacy) => {
    const data = await sharp({ create: { width: 1000, height: 800, channels: 4, background: "white" } }).png().toBuffer();
    const renderer = createRenderer({ profile: "preview", assets: { art: data } });
    const doc = {
      mangacli: 1,
      page: { size: ["100mm", "80mm"], bleed: "0mm", baseFrame: "trim" },
      assets: { art: { src: "art.png", ...(legacy ? { character: "taro", anchors: { mouth: [100, 600] }, regions: { face: [50, 550, 100, 100] } } : {}), characters: {
        ...(legacy ? {} : { taro: { anchors: { mouth: [100, 600] }, regions: { face: [50, 550, 100, 100] } } }),
        hana: { anchors: { mouth: [800, 600] }, regions: { face: [850, 550, 100, 100] } },
      } } },
      pages: [{ layers: [
        { image: "art", id: "img", at: ["0mm", "0mm"], anchor: "top-left", size: ["100mm", "80mm"], fit: "fill", characters: { hana: { anchors: { mouth: [900, 600] } } } },
        ...["taro", "hana", "explicit"].map((who) => ({ balloon: "Hi", id: `speech-${who}`, ...(who === "explicit" ? {} : { who }), tail: { length: "35mm", ...(who === "explicit" ? { to: "img.hana.mouth" } : {}) }, at: ["50mm", "20mm"], size: ["14mm", "12mm"], hand: "ruler" })),
      ] }],
    };
    const result = await renderer.displayList(doc, 1);
    const pts = (id: string) => paths(result.root).filter((p) => p.tag?.elementId === `speech-${id}` && p.tag.role === "fill").flatMap((p) => p.path.filter((c) => c[0] === "M" || c[0] === "L").map((c) => ({ x: c[1] as number, y: c[2] as number })));
    expect(Math.min(...pts("taro").map((p) => p.x))).toBeLessThan(40);
    expect(Math.max(...pts("hana").map((p) => p.x))).toBeGreaterThan(60);
    expect(Math.max(...pts("explicit").map((p) => p.x))).toBeCloseTo(Math.max(...pts("hana").map((p) => p.x)), 0);
  });

  it.each([
    { top: {} },
    { hana: { anchors: { center: [1, 2] } } },
    { hana: { regions: { left: [0, 0, 10, 10] } } },
  ])("rejects reserved names: %j", async (characters) => {
    const result = await validate({ mangacli: 1, assets: { art: { src: "art.png", characters } }, pages: [{ layers: [] }] });
    expect(result.diagnostics.some((d) => d.code === "ID_RESERVED")).toBe(true);
  });

  it("rejects reserved speaker names given through styles", async () => {
    const result = await validate({ mangacli: 1, styles: { duo: { characters: { top: {} } } }, pages: [{ layers: [] }] });
    expect(result.diagnostics.some((d) => d.code === "ID_RESERVED")).toBe(true);
  });

  it("accepts a style or asset named characters", async () => {
    const result = await validate({ mangacli: 1, styles: { characters: { for: "effect", center: [10, 10] } }, assets: { characters: { src: "art.png", anchors: { mouth: [1, 2] } } }, pages: [{ layers: [] }] });
    expect(result.diagnostics.some((d) => d.code === "ID_RESERVED")).toBe(false);
  });
});
