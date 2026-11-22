import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import type { PathData } from "../src/geom/path.js";
import { AssetRegistry } from "../src/render/assets.js";
import type { DisplayList } from "../src/render/ir.js";
import { packBand } from "../src/render/mono.js";
import { RasterBackend } from "../src/render/raster.js";

describe("logical-frame clip antialiasing", () => {
  const rectangle: PathData = [["M", 0.132, 0.137], ["L", 7.867, 0.137], ["L", 7.867, 8199.863], ["L", 0.132, 8199.863], ["Z"]];
  const polygon: PathData = [["M", 0.132, 0.137], ["L", 7.867, 0.937], ["L", 6.867, 8199.863], ["L", 0.132, 8199.863], ["Z"]];
  const curved: PathData = [["M", 0.132, 0.137], ["Q", 7.867, 0.137, 7.867, 8.137], ["L", 7.867, 8199.863], ["L", 0.132, 8199.863], ["Z"]];
  const degenerate: PathData = [["M", 0, 0], ["L", 8, 0], ["L", 0, 0], ["L", 0, 8200], ["Z"]];
  it.each([{ name: "rectangle", path: rectangle }, { name: "polygon", path: polygon }, { name: "curve", path: curved }, { name: "degenerate", path: degenerate }, { name: "empty", path: [] }])("preserves a clipped tone at a tiny band edge ($name)", async ({ path }) => {
    const box = { x: 0, y: 0, w: 8, h: 8200 };
    const list: DisplayList = {
      version: 1, page: { id: "clip", index: 0 }, size: { width: 8, height: 8200 },
      boxes: { trim: box, bleed: box, baseFrame: box, safe: box }, background: null,
      root: { kind: "group", clip: path, children: [{ kind: "path", path, fillRule: "nonzero", paint: { type: "tone", color: { r: 0, g: 0, b: 0, a: 1 }, tone: { density: 1, lpi: 60, angle: 0, dot: "round", grain: 0, invert: false, offset: [0, 0], seed: 1 } } }] },
    };
    const backend = new RasterBackend({ dpi: 25.4, crop: "trim", colorMode: "mono", toneRendering: "dots", monoLpi: 60, toneCurve: "linear", assets: new AssetRegistry({}, {}, new DiagnosticBag(), 300, "error") });
    const full = await backend.render(list);
    const expected = new Uint8Array(17);
    packBand(expected, 8, full.data, 17, 0);
    const progress: [number, number][] = [];
    const banded = await backend.renderMono(list, { x: 0, y: 0, width: 8, height: 17 }, 8 * 5, (done, total) => progress.push([done, total]));
    expect(banded.packed).toEqual(expected);
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
    if (path === rectangle) expect(banded.packed[0] & 1).toBe(0);
  });
});
