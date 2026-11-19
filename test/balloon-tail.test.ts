import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import sharp from "sharp";
import { pointInPolygon } from "../src/geom/path.js";
import type { Vec } from "../src/geom/vec.js";
import type { Node, PathNode } from "../src/render/ir.js";

const r = createRenderer({ profile: "preview" });

function paths(node: Node, ok: (n: PathNode) => boolean): PathNode[] {
  if (node.kind === "group") return node.children.flatMap((c) => paths(c, ok));
  return node.kind === "path" && ok(node) ? [node] : [];
}

const vertices = (n: PathNode): Vec[] => n.path.filter((c) => c[0] === "M" || c[0] === "L").map((c) => ({ x: c[1] as number, y: c[2] as number }));

/** the balloon outline (body + tail) of element `b`, and the panel's top-left corner on the page */
async function outline(balloon: string): Promise<{ pts: Vec[]; origin: Vec }> {
  const yaml = `mangacli: 1
page: { size: [160mm, 80mm], bleed: 3mm }
pages:
  - panels:
      - layers:
          - ${balloon}
`;
  const root = (await r.displayList({ yaml, filename: "/v/tail.yaml" }, 1)).root;
  const [fill] = paths(root, (n) => n.tag?.elementId === "b" && n.tag.role === "fill");
  const [frame] = paths(root, (n) => n.tag?.role === "frame");
  expect(fill).toBeDefined();
  const f = vertices(frame);
  return { pts: vertices(fill), origin: { x: Math.min(...f.map((p) => p.x)), y: Math.min(...f.map((p) => p.y)) } };
}

/** width of the tail where the outline crosses x = `at`, on the piece nearest the tip's height */
function widthAt(pts: Vec[], at: number, tipY: number): number {
  const ys: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if ((a.x - at) * (b.x - at) < 0) ys.push(a.y + ((at - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  ys.sort((p, q) => p - q);
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i + 1 < ys.length; i += 2) {
    const d = Math.abs((ys[i] + ys[i + 1]) / 2 - tipY);
    if (d < dist) [dist, best] = [d, ys[i + 1] - ys[i]];
  }
  return best;
}

const tip = (pts: Vec[]) => pts.reduce((p, q) => (q.x > p.x ? q : p));

/** the body's right edge in page mm, mirrored from its left edge about the centre `cx` (the tail points right) */
const rightOf = (pts: Vec[], cx: number) => 2 * cx - Math.min(...pts.map((p) => p.x));

describe("balloon tails", () => {
  async function outsideSpeaker(y: number, height = 40, tail = "{ allowVertical: true, curl: false, bend: 0.8 }") {
    const figure = await sharp({ create: { width: 100, height: 160, channels: 3, background: "white" } }).png().toBuffer();
    const yaml = `mangacli: 1
page: { size: [120mm, 180mm], bleed: 0mm }
assets:
  figure: { src: figure.png, character: hero, anchors: { mouth: [50, 140] } }
pages:
  - layers:
      - { image: figure, size: [100mm, 160mm], at: [0mm, 0mm], anchor: top-left, fit: fill, clip: { to: [p] } }
    panels:
      - id: p
        box: [10mm, 10mm, 80mm, ${height}mm]
        layers:
          - { balloon: "", id: b, who: hero, size: [16mm, 12mm], shape: { kind: ellipse, irregularity: 0 }, at: [40mm, ${y}mm], tail: ${tail} }
`;
    const result = await createRenderer({ profile: "preview", assets: { figure } }).displayList({ yaml }, 1);
    const [fill] = paths(result.root, (n) => n.tag?.elementId === "b" && n.tag.role === "fill");
    const frame = paths(result.root, (n) => n.tag?.role === "frame").flatMap(vertices);
    const x0 = Math.min(...frame.map((p) => p.x));
    const x1 = Math.max(...frame.map((p) => p.x));
    const y0 = Math.min(...frame.map((p) => p.y));
    const y1 = Math.max(...frame.map((p) => p.y));
    return { pts: vertices(fill), panel: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
  }

  it("shortens the whole tail inside its panel when its speaker is far below it", async () => {
    const fitted = await outsideSpeaker(30);
    const unbounded = await outsideSpeaker(30, 150);
    const body = await outsideSpeaker(30, 40, "none");
    const bottom = (pts: Vec[]) => Math.max(...pts.map((p) => p.y));
    expect(unbounded.pts.some((p) => !pointInPolygon(p, fitted.panel))).toBe(true);
    expect(fitted.pts.every((p) => pointInPolygon(p, fitted.panel))).toBe(true);
    expect(bottom(fitted.pts)).toBeLessThan(bottom(fitted.panel) - 0.4);
    expect(bottom(fitted.pts)).toBeGreaterThan(bottom(body.pts) + 0.5);
    for (let i = 0; i < fitted.pts.length; i++) {
      const a = fitted.pts[i];
      const b = fitted.pts[(i + 1) % fitted.pts.length];
      expect(pointInPolygon({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, fitted.panel)).toBe(true);
    }
  });

  it("leaves a regular tail unchanged when the whole tail already fits", async () => {
    expect((await outsideSpeaker(16)).pts).toEqual((await outsideSpeaker(16, 150)).pts);
  });

  it("keeps a balloon without a tail unchanged near the panel edge", async () => {
    expect((await outsideSpeaker(30, 40, "none")).pts).toEqual((await outsideSpeaker(30, 150, "none")).pts);
  });

  const shout = `{ balloon: "父ちゃん！", id: b, as: shout, at: [40mm, 35mm], tail: { to: [125mm, 35mm] } }`;
  it("keeps a shout tail aimed far away to a moderate length", async () => {
    const { pts, origin } = await outline(shout);
    expect(tip(pts).x - rightOf(pts, origin.x + 40)).toBeLessThan(4.2);
  });
  it("gives a long shout tail a wide base instead of a thin line", async () => {
    const { pts } = await outline(shout);
    const t = tip(pts);
    expect(widthAt(pts, t.x - 3, t.y)).toBeGreaterThan(0.8);
  });
  it("stops a tail aimed at a bare point halfway, out of the speaker's face", async () => {
    const { pts, origin } = await outline(`{ balloon: "おはよう", id: b, size: [24mm, 24mm], at: [40mm, 35mm], tail: { to: [59mm, 35mm] } }`);
    const target = origin.x + 59;
    expect(target - tip(pts).x).toBeGreaterThan(0.4 * (target - rightOf(pts, origin.x + 40)));
  });
  it("honors explicit off-screen lengths and caps automatic tails before a distant frame", async () => {
    const balloon = 'balloon: "", id: b, as: offscreen, at: [26mm, 24mm], size: [18mm, 14mm], shape: { kind: ellipse, irregularity: 0 }';
    const none = await outline(`{${balloon}, tail: none}`);
    const auto = await outline(`{${balloon}, tail: { offscreen: left, bend: 0 }}`);
    const capped = await outline(`{${balloon}, tail: { offscreen: left, bend: 0, maxLength: 3mm }}`);
    const short = await outline(`{${balloon}, tail: { offscreen: left, bend: 0, length: 3.8mm }}`);
    const left = (pts: Vec[]) => Math.min(...pts.map((p) => p.x));
    expect(left(none.pts) - left(short.pts)).toBeCloseTo(3.8, 1);
    expect(left(short.pts)).toBeGreaterThan(short.origin.x);
    expect(left(none.pts) - left(auto.pts)).toBeGreaterThan(3.8);
    expect(left(none.pts) - left(auto.pts)).toBeLessThan(5);
    expect(left(auto.pts)).toBeGreaterThan(auto.origin.x);
    expect(left(none.pts) - left(capped.pts)).toBeCloseTo(3, 1);
    const near = await outline(`{${balloon.replace("26mm", "12mm")}, tail: { offscreen: left, bend: 0 }}`);
    expect(left(near.pts)).toBeLessThan(near.origin.x);
  });
});
