import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRenderer } from "../src/api.js";
import { Rng } from "../src/core/random.js";
import type { Vec } from "../src/geom/vec.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
import * as shape from "../src/ink/shape.js";
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

const reviewYaml = `mangacli: 1
page: { size: [120mm, 180mm], bleed: 0mm }
pages:
  - layout: { template: grid, params: { cols: 1, rows: 3 } }
    panels:
      - layers:
          - { balloon: "あっ！", id: a, as: shout, size: [19mm, 30mm], at: [60mm, 28mm], tail: { to: [110mm, 48mm] } }
      - layers:
          - { balloon: "待てっ！", id: b, as: shout, size: [19mm, 30mm], at: [60mm, 28mm], tail: { to: [20mm, 78mm] } }
      - layers:
          - { balloon: "父ちゃん！", id: c, as: shout, size: [19mm, 34mm], at: [60mm, 28mm], tail: { to: [10mm, 20mm], width: 4mm } }
`;

function tailEdges(pts: Vec[]): { a: number; tip: number } {
  const straight = (i: number) => {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    return Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < 1e-8;
  };
  let tip = pts.length - 1;
  while (straight(tip)) tip--;
  let a = tip - 1;
  while (straight(a)) a--;
  return { a, tip };
}

describe("balloon tails", () => {
  it("keeps one corner per vertex when shout roots meet existing valleys", async () => {
    const spy = vi.spyOn(shape, "inkShape");
    try {
      await r.displayList({ yaml: reviewYaml.replaceAll("as: shout,", "as: shout, hand: clean, shape: { kind: spike, count: 80 },"), filename: "/v/review.yaml" }, 1);
      const contours = spy.mock.calls.map(([contour]) => contour).filter((contour) => contour.corners?.some((c) => c.kind === "point"));
      expect(contours).toHaveLength(3);
      for (const contour of contours) {
        const indices = contour.corners!.map((c) => c.index);
        expect(new Set(indices).size).toBe(indices.length);
        expect(contour.corners!.filter((c) => c.kind === "concave")).toHaveLength(2);
      }
    } finally {
      spy.mockRestore();
    }
  });
  it("joins the review shouts with straight edges and keeps the neighboring spikes", async () => {
    const cleanYaml = reviewYaml.replaceAll("as: shout,", "as: shout, hand: clean,");
    const root = (await r.displayList({ yaml: cleanYaml, filename: "/v/review.yaml" }, 1)).root;
    const body = (await r.displayList({ yaml: cleanYaml.replaceAll(/tail: \{[^}]+\}/g, "tail: { kind: none }"), filename: "/v/review.yaml" }, 1)).root;
    for (const id of ["a", "b"]) {
      const pts = vertices(paths(root, (n) => n.tag?.elementId === id && n.tag.role === "fill")[0]);
      const original = vertices(paths(body, (n) => n.tag?.elementId === id && n.tag.role === "fill")[0]);
      const { a, tip } = tailEdges(pts);
      expect(tip - a).toBeGreaterThan(12);
      expect(pts.length - tip).toBeGreaterThan(12);
      const shortSide = Math.min(Math.max(...original.map((p) => p.x)) - Math.min(...original.map((p) => p.x)), Math.max(...original.map((p) => p.y)) - Math.min(...original.map((p) => p.y)));
      expect(Math.hypot(pts[a].x - pts[0].x, pts[a].y - pts[0].y)).toBeLessThanOrEqual(shortSide / 6 + 1e-8);
      const retained = original.filter((p) => pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-8));
      expect(retained.length / original.length).toBeGreaterThan(0.9);
    }
    const inked = (await r.displayList({ yaml: reviewYaml, filename: "/v/review.yaml" }, 1)).root;
    const father = paths(inked, (n) => n.tag?.elementId === "c" && n.tag.role === "fill")[0];
    const rounded = father.path.map((c) => c.map((v) => typeof v === "number" ? Math.round(v * 1000) / 1000 : v));
    expect(createHash("sha256").update(JSON.stringify(rounded)).digest("hex")).toBe("0b108bb626414c3f2a026e85c0d40f15dbdbfdf1eeda4ae913311803efdfea68");
  });

  it("honors an explicit shout root width instead of the automatic cap", async () => {
    const { pts } = await outline(`{ balloon: "待てっ！", id: b, as: shout, hand: clean, size: [19mm, 30mm], at: [40mm, 35mm], tail: { direction: 130deg, width: 8mm } }`);
    const { pts: body } = await outline(`{ balloon: "待てっ！", id: b, as: shout, hand: clean, size: [19mm, 30mm], at: [40mm, 35mm], tail: none }`);
    const { a } = tailEdges(pts);
    const shortSide = Math.min(Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x)), Math.max(...body.map((p) => p.y)) - Math.min(...body.map((p) => p.y)));
    expect(Math.hypot(pts[a].x - pts[0].x, pts[a].y - pts[0].y)).toBeGreaterThan(shortSide / 6);
  });
  it("uses a sixth of the short side for an ordinary automatic wedge", async () => {
    const { pts } = await outline(`{ balloon: "おはよう", id: b, hand: clean, size: [30mm, 24mm], at: [40mm, 35mm], tail: { direction: 0deg, length: 10mm, curl: false, bend: 0, sideCurve: 0 } }`);
    const { a } = tailEdges(pts);
    const width = Math.hypot(pts[a].x - pts[0].x, pts[a].y - pts[0].y);
    expect(width).toBeGreaterThan(3.7);
    expect(width).toBeLessThan(4.2);
  });
  it("inks point corners at full line weight through the tail tip", () => {
    const ink = inkShape({ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false, corners: [{ index: 1, kind: "point" }] }, {
      line: { width: 0.3, pen: PEN_PRESETS["g-pen"], style: "solid" },
      hand: { ...HAND_PRESETS.clean, taper: 1 },
      rng: new Rng(42),
    });
    expect(widthAt(ink.inks[0].pts, 9.8, 0)).toBeGreaterThanOrEqual(0.29);
  });
  const shout = `{ balloon: "父ちゃん！", id: b, as: shout, at: [40mm, 35mm], tail: { to: [125mm, 35mm] } }`;
  it("keeps a shout tail aimed far away to a moderate length", async () => {
    const { pts, origin } = await outline(shout);
    expect(tip(pts).x - rightOf(pts, origin.x + 40)).toBeLessThan(4.2);
  });
  it("keeps a thin shout tail visibly triangular", async () => {
    const { pts } = await outline(shout);
    const t = tip(pts);
    expect(widthAt(pts, t.x - 3, t.y)).toBeGreaterThan(0.4);
  });
  it("stops a tail aimed at a bare point halfway, out of the speaker's face", async () => {
    const { pts, origin } = await outline(`{ balloon: "おはよう", id: b, size: [24mm, 24mm], at: [40mm, 35mm], tail: { to: [59mm, 35mm] } }`);
    const target = origin.x + 59;
    expect(target - tip(pts).x).toBeGreaterThan(0.4 * (target - rightOf(pts, origin.x + 40)));
  });
});
