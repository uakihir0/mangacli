import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRenderer } from "../src/api.js";
import { splitClearLine } from "../src/elements/effect-clear.js";
import { flattenPath } from "../src/geom/path.js";
import type { Node, PathNode } from "../src/render/ir.js";

const renderer = createRenderer({ profile: "preview" });
const doc = (effect: Record<string, unknown>) => ({
  mangacli: 1,
  page: { size: ["100mm", "60mm"], bleed: "0mm" },
  assets: { art: { src: "art.png", character: "hero" } },
  pages: [{ layers: [
    { image: "art", id: "hero", fit: "fill" },
    { type: "effect", kind: "speed-lines", id: "fx", seed: 42, angle: 0, spacing: "2mm", length: "100%", align: "center", thickness: "0.6mm", taper: "none", hand: { preset: "clean" }, ...effect },
  ] }],
});

async function art(opaque = false, empty = false) {
  const data = Buffer.alloc(200 * 120 * 4, 255);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) {
    const inside = !empty && Math.hypot((x - 100) / 30, (y - 60) / 36) < 1;
    data[(y * 200 + x) * 4 + 3] = opaque || inside ? 255 : 0;
  }
  return sharp(data, { raw: { width: 200, height: 120, channels: 4 } }).png().toBuffer();
}

function ink(node: Node): PathNode[] {
  return node.kind === "group" ? node.children.flatMap(ink) : node.kind === "path" && node.tag?.elementId === "fx" && node.tag.role === "ink" ? [node] : [];
}
async function lines(effect: Record<string, unknown>, image?: Buffer) {
  const list = await renderer.displayList(doc(effect), 1, { assets: { art: image ?? await art() } });
  return ink(list.root).flatMap((n) => flattenPath(n.path).map((p) => p.pts));
}

describe("effect silhouette clears", () => {
  it("splits a crossing and discards tiny or fully cleared fragments", () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(splitClearLine(pts, (p) => p.x > 4 && p.x < 6, 0.1, 1)).toHaveLength(2);
    expect(splitClearLine(pts, () => true, 0.1, 1)).toEqual([]);
    expect(splitClearLine(pts, () => false, 0.1, 1)).toHaveLength(1);
    expect(splitClearLine(pts, (p) => p.x > 0.2, 0.1, 1)).toEqual([]);
  });

  it.each(["speed-lines", "focus-lines", "uni-flash", "rain", "gloom-lines"])("%s keeps ink outside the dilated alpha silhouette", async (kind) => {
    const cleared = await lines({ kind, length: "60mm", inner: ["1mm", "1mm"], count: 180, clearFigures: false, clear: { element: "hero", mode: "alpha", margin: "2mm" } });
    expect(cleared.length).toBeGreaterThan(5);
    for (const poly of cleared) for (const p of poly) {
      // Ellipse radii 15×18mm, expanded by at least the requested 2mm.
      expect(Math.hypot((p.x - 50) / 17, (p.y - 30) / 20), JSON.stringify(p)).toBeGreaterThan(0.99);
    }
  });

  it("speed lines automatically avoid figures and taper at both new cut ends", async () => {
    const cleared = await lines({});
    const raw = await lines({ clearFigures: false });
    expect(cleared.length).toBeGreaterThan(raw.length);
    const cut = cleared.find((poly) => {
      const max = Math.max(...poly.map((p) => p.x));
      return max > 30 && max < 35 && Math.abs(poly[0].y - 30) < 6;
    });
    expect(cut).toBeDefined();
    const max = Math.max(...cut!.map((p) => p.x));
    const widthAt = (x: number) => {
      const ys = cut!.filter((p) => Math.abs(p.x - x) < 0.35).map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(widthAt(max - 0.3)).toBeLessThan(widthAt(max - 3) * 0.65);
    for (const poly of cleared) for (const p of poly) expect(Math.hypot((p.x - 50) / 16, (p.y - 30) / 19)).toBeGreaterThan(0.99);
  });

  it.each(["focus-lines", "speed-lines"])("%s ignores opaque art automatically and warns for an explicit opaque alpha clear", async (kind) => {
    const image = await art(true);
    expect(await lines({ kind }, image)).toEqual(await lines({ kind, clearFigures: false }, image));
    const result = await renderer.validate(doc({ kind, clear: { element: "hero", mode: "alpha" } }), { assets: { art: image } });
    expect(result.diagnostics.some((d) => d.code === "EFFECT_OPAQUE_CLEAR" && d.severity === "warning")).toBe(true);
  });

  it("ignores an empty alpha silhouette", async () => {
    const image = await art(false, true);
    const auto = await lines({}, image);
    const raw = await lines({ clearFigures: false }, image);
    // Sampling changes polygon resolution but not the ink's footprint.
    const bounds = (polys: typeof auto) => polys.map((p) => [Math.min(...p.map((q) => q.x)), Math.max(...p.map((q) => q.x))]);
    expect(bounds(auto)).toEqual(bounds(raw));
  });

  it("combines all regions in a clear list", async () => {
    const polys = await lines({ clearFigures: false, clear: [{ rect: ["10mm", "0mm", "8mm", "60mm"] }, { element: "hero", mode: "alpha", margin: "2mm" }] });
    expect(polys.length).toBeGreaterThan(20);
    for (const poly of polys) for (const p of poly) if (p.y >= 0 && p.y <= 60) expect(p.x < 10 || p.x > 18, JSON.stringify(p)).toBe(true);
  });

  it("followPath bends the local line direction and accepts an SVG guide", async () => {
    for (const followPath of [[["0mm", "45mm"], ["50mm", "15mm"], ["100mm", "45mm"]], { path: "M0 45 Q50 -15 100 45" }]) {
      const curved = await lines({ clearFigures: false, followPath });
      const poly = curved[Math.floor(curved.length / 2)];
      const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(15);
    }
  });

  it("diagnoses an empty motion guide and a missing clear target", async () => {
    const result = await renderer.validate(doc({ followPath: { path: "M0 0" }, clear: { element: "missing", mode: "alpha" } }), { assets: { art: await art() } });
    expect(result.diagnostics.map((d) => d.code)).toContain("EFFECT_PATH_INVALID");
    expect(result.diagnostics.map((d) => d.code)).toContain("REF_NOT_FOUND");
  });
});
