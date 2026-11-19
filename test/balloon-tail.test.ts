import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
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
  it("preserves the default zigzag length on whisper balloons", async () => {
    const balloon = 'balloon: "", id: b, as: whisper, at: [40mm, 35mm], size: [24mm, 24mm], shape: { kind: ellipse, irregularity: 0 }';
    const auto = await outline(`{ ${balloon}, tail: { kind: zigzag, direction: 0deg, bend: 0 } }`);
    const explicit = await outline(`{ ${balloon}, tail: { kind: zigzag, direction: 0deg, bend: 0, length: 11bmm } }`);
    expect(auto.pts).toEqual(explicit.pts);
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
