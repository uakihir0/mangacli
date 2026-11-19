import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { BLACK } from "../src/core/color.js";
import { flattenPath, pointInPolygon, polyPath, type PathData } from "../src/geom/path.js";
import { cleanClippedBalloonInk } from "../src/render/balloon-clip.js";
import type { PathNode } from "../src/render/ir.js";

function rect(x0: number, y0: number, x1: number, y1: number): PathData {
  return polyPath([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], true);
}

function ink(path: PathData): PathNode {
  return { kind: "path", path, fillRule: "nonzero", paint: { type: "solid", color: BLACK }, tag: { elementId: "balloon", elementType: "balloon", role: "ink", separation: "balloon" } };
}

async function renderCorner(clip: string, background = "white", options: { dpi?: number; width?: number; dx?: number; dy?: number } = {}) {
  const dpi = options.dpi ?? 300;
  const r = createRenderer({ profile: "print-mono", dpi });
  const input = { filename: "/v/corner.yaml", yaml: `mangacli: 1
page: { size: [75mm, 65mm], bleed: 0mm }
pages:
  - panels:
      - border: { width: 0.5mm }
        background: ${background}
        layers:
          - balloon: ""
            id: bubble
            at: [${5.2 + (options.dx ?? 0)}mm, ${5.2 + (options.dy ?? 0)}mm]
            clip: ${clip}
            shape: { kind: ellipse, irregularity: 0, strokes: 1 }
            size: [12mm, 12mm]
            ${options.width === undefined ? "" : `stroke: { width: ${options.width}mm, pen: { minWidth: 0.01mm } }`}
            hand: clean
            tail: none
            halo: none
` };
  const list = await r.displayList(input, 1);
  const result = await r.render(input, { format: "png" });
  const page = result.pages[0];
  if (options.width !== undefined) expect(result.diagnostics.some((d) => d.code === "RENDER_HAIRLINE_THICKENED" && d.elementId === "bubble")).toBe(true);
  const { x, y } = list.boxes.baseFrame;
  const px = (mm: number) => Math.round(mm * dpi / 25.4);
  return async (dx: number, dy: number, w: number, h: number) => {
    const crop = { left: px(x + dx), top: px(y + dy), width: px(w), height: px(h) };
    const raw = await sharp(page.data).extract(crop).greyscale().raw().toBuffer();
    return raw.some((byte) => byte < 128);
  };
}

describe("cut balloon ink", () => {
  const clean = cleanClippedBalloonInk(rect(0, 0, 40, 30));

  it("drops an L-shaped corner fragment across pens without changing longer or uncut ink", () => {
    const clippedX = ink(rect(-1, 0.95, 1.15, 1.15));
    const clippedY = ink(rect(0.95, -1, 1.15, 1.15));
    const long = ink(rect(8, -1, 8.2, 8));
    // A small mark that meets the frame but was not actually cut.
    const dot = ink(rect(5, 0, 5.35, 0.35));
    const fill = { ...long, tag: { ...long.tag!, role: "fill" as const } };
    const text = { ...long, tag: { ...long.tag!, role: "text" as const } };
    const [a, b, c, d, f, t] = clean([clippedX, clippedY, long, dot, fill, text]);
    for (const [mask, original] of [[a, clippedX], [b, clippedY], [c, long], [d, dot]]) {
      expect(mask.kind).toBe("group");
      if (mask.kind !== "group") throw new Error("expected outline clip");
      expect(mask.children[0]).toBe(original);
      const [outer, hole] = flattenPath(mask.clip!);
      expect(pointInPolygon({ x: 1, y: 1 }, hole.pts)).toBe(true);
      expect(pointInPolygon({ x: 8.1, y: 1 }, outer.pts)).toBe(true);
      expect(pointInPolygon({ x: 8.1, y: 1 }, hole.pts)).toBe(false);
      expect(pointInPolygon({ x: 5.2, y: 0.2 }, hole.pts)).toBe(false);
    }
    expect(f).toBe(fill);
    expect(t).toBe(text);
  });

  it("leaves a short cut alone when removing it could nick neighboring ink", () => {
    const nodes = [ink(rect(-1, 1, 1, 1.2)), ink(rect(1.08, 1, 1.28, 10))];
    expect(clean(nodes)).toBe(nodes);
  });

  it.each(["panel", "auto", "{ to: panel, open: [right] }", "none"])("rasterizes an arc with clip: %s", async (clip) => {
    const containsInk = await renderCorner(clip);
    expect(await containsInk(0.39, 0.39, 1.8, 1.8)).toBe(clip === "none");
    expect(await containsInk(10, 4, 1.5, 2)).toBe(true); // long side of the same ellipse
    expect(await containsInk(0, 14, 0.15, 1)).toBe(true); // frame is still solid
  });

  it.each(Array.from({ length: 16 }, (_, i) => [i % 4, Math.floor(i / 4)]))("removes a thickened 600-dpi corner at pixel phase %s,%s", async (x, y) => {
    const options = { dpi: 600, width: 0.015, dx: x * 25.4 / 600 / 4, dy: y * 25.4 / 600 / 4 };
    const clipped = await renderCorner("panel", "white", options);
    const uncut = await renderCorner("none", "white", options);
    expect(await clipped(0.39, 0.39, 1.8, 1.8)).toBe(false);
    expect(await uncut(0.39, 0.39, 1.8, 1.8)).toBe(true);
    expect(await clipped(9, 3, 4, 4)).toBe(true);
    expect(await clipped(0, 14, 0.15, 1)).toBe(true);
  });

  it("closes the isolated corner pocket without blanking nearby dark art", async () => {
    const containsInk = await renderCorner("panel", "black");
    expect(await containsInk(0.39, 0.39, 1.8, 1.8)).toBe(false);
    expect(await containsInk(12, 4, 1.5, 2)).toBe(true);
  });
});
