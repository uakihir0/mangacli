import polygonClipping from "polygon-clipping";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createRenderer, validate } from "../src/api.js";
import { Rng } from "../src/core/random.js";
import { polygonArea } from "../src/geom/path.js";
import { type Vec, cross, len, sub } from "../src/geom/vec.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
import * as shape from "../src/ink/shape.js";
import type { Node, PathNode } from "../src/render/ir.js";
import { BODY_GENERATORS, type BodyGeom } from "../src/shapes/balloon.js";

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
  it("gives the electronic tail two straight-sided bends before the tip", async () => {
    const balloon = 'balloon: "電話", id: b, as: electronic, hand: clean, at: [40mm, 35mm], size: [24mm, 24mm]';
    const body = await outline(`{${balloon}, tail: none}`);
    const { pts } = await outline(`{${balloon}, tail: { direction: 0deg, length: 11mm }}`);
    const bodyEdge = tip(body.pts).x;
    const tailCorners = pts.filter((p, i) => {
      if (p.x <= bodyEdge + 0.5) return false;
      const a = sub(p, pts[(i + pts.length - 1) % pts.length]);
      const b = sub(pts[(i + 1) % pts.length], p);
      return Math.abs(cross(a, b)) > 0.1 * len(a) * len(b);
    });
    // Two bends on each edge, meeting at a single tip.
    expect(tailCorners).toHaveLength(5);
  });

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
      expect(tip - a).toBeGreaterThanOrEqual(12);
      expect(pts.length - tip).toBeGreaterThanOrEqual(12);
      const retained = original.filter((p) => pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-8));
      expect(retained.length / original.length).toBeGreaterThan(0.9);
    }
    const inked = (await r.displayList({ yaml: reviewYaml, filename: "/v/review.yaml" }, 1)).root;
    expect(paths(inked, (n) => n.tag?.elementId === "c" && n.tag.role === "fill").length).toBeGreaterThan(0);
  });

  it("honors an explicit shout root width instead of the automatic cap", async () => {
    const { pts } = await outline(`{ balloon: "待てっ！", id: b, as: shout, hand: clean, size: [19mm, 30mm], at: [40mm, 35mm], tail: { direction: 130deg, width: 8mm } }`);
    const { pts: body } = await outline(`{ balloon: "待てっ！", id: b, as: shout, hand: clean, size: [19mm, 30mm], at: [40mm, 35mm], tail: none }`);
    const { a } = tailEdges(pts);
    const shortSide = Math.min(Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x)), Math.max(...body.map((p) => p.y)) - Math.min(...body.map((p) => p.y)));
    expect(Math.hypot(pts[a].x - pts[0].x, pts[a].y - pts[0].y)).toBeGreaterThan(shortSide / 6);
  });
  it("clamps an ordinary automatic wedge to the thin default width", async () => {
    const { pts } = await outline(`{ balloon: "おはよう", id: b, hand: clean, size: [30mm, 24mm], at: [40mm, 35mm], tail: { direction: 0deg, length: 10mm, curl: false, bend: 0, sideCurve: 0 } }`);
    const { a } = tailEdges(pts);
    const width = Math.hypot(pts[a].x - pts[0].x, pts[a].y - pts[0].y);
    expect(width).toBeCloseTo((1.3 * 80) / 182, 5);
  });
  it.each(["say", "whisper"])("clamps a direction-only automatic %s wedge by maxLength", async as => {
    const balloon = `balloon: "おはよう", id: b, as: ${as}, hand: clean, size: [24mm, 24mm], at: [40mm, 35mm], shape: { kind: ellipse, irregularity: 0, tilt: 0deg }`;
    const tail = "direction: 0deg, bend: 0";
    const uncapped = await outline(`{ ${balloon}, tail: { ${tail} } }`);
    const capped = await outline(`{ ${balloon}, tail: { ${tail}, maxLength: 1mm } }`);
    const reach = (out: { pts: Vec[]; origin: Vec }) => tip(out.pts).x - rightOf(out.pts, out.origin.x + 40);
    expect(reach(uncapped)).toBeGreaterThan(1.4);
    expect(reach(uncapped) - reach(capped)).toBeGreaterThan(0.45);
    expect(reach(uncapped) - reach(capped)).toBeLessThan(0.65);
  });
  it.each(["say", "whisper"])("applies widthScale to the thinner automatic %s width", async as => {
    const balloon = `balloon: "おはよう", id: b, as: ${as}, hand: clean, size: [30mm, 24mm], at: [40mm, 35mm], shape: { kind: ellipse, irregularity: 0, tilt: 0deg }`;
    const tail = "direction: 0deg, length: 10mm, curl: false, bend: 0, sideCurve: 0, widthScale: 1.5";
    const automatic = await outline(`{ ${balloon}, tail: { ${tail} } }`);
    const explicit = await outline(`{ ${balloon}, tail: { ${tail}, width: ${(1.3 * 80) / 182}mm } }`);
    const ring = (pts: Vec[]) => [[pts.map((p) => [p.x, p.y] as [number, number])]];
    let difference = 0;
    for (const polygon of polygonClipping.xor(ring(automatic.pts), ring(explicit.pts))) for (const [i, points] of polygon.entries()) difference += (i ? -1 : 1) * Math.abs(polygonArea(points.map(([x, y]) => ({ x, y }))));
    expect(Math.abs(difference)).toBeLessThan(1e-6);
  });
  it.each(["say", "whisper", "electronic", "shout", "scream"])("preserves explicit %s widths and their scaling", async as => {
    const balloon = `balloon: "おはよう", id: b, as: ${as}, hand: clean, size: [30mm, 24mm], at: [40mm, 35mm]`;
    const tail = "direction: 0deg, length: 10mm, curl: false, bend: 0, sideCurve: 0";
    const scaled = await outline(`{ ${balloon}, tail: { ${tail}, width: 3mm, widthScale: 2 } }`);
    const explicit = await outline(`{ ${balloon}, tail: { ${tail}, width: 6mm, widthScale: 1 } }`);
    expect(scaled.pts).toEqual(explicit.pts);
  });
  it("inks point corners at full line weight through the tail tip", () => {
    const ink = inkShape({ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false, corners: [{ index: 1, kind: "point" }] }, {
      line: { width: 0.3, pen: PEN_PRESETS["g-pen"], style: "solid" },
      hand: { ...HAND_PRESETS.clean, taper: 1 },
      rng: new Rng(42),
    });
    expect(widthAt(ink.inks[0].pts, 9.8, 0)).toBeGreaterThanOrEqual(0.29);
  });
  it.each(["solid", "dashed"] as const)("tapers %s tail tip ink below 0.1 bmm even without hand taper", style => {
    const ink = inkShape({ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }], closed: true, corners: [{ index: 0, kind: "concave" }, { index: 1, kind: "point" }, { index: 2, kind: "concave" }] }, {
      line: { width: 0.3, pen: PEN_PRESETS.marker, style },
      hand: HAND_PRESETS.clean,
      rng: new Rng(42),
      pointWidth: 0,
    });
    const nearTip = ink.inks.flatMap(p => p.pts).filter(p => p.x >= 9.99);
    expect(nearTip.length).toBeGreaterThan(0);
    expect(Math.max(...nearTip.map(p => p.y)) - Math.min(...nearTip.map(p => p.y))).toBeLessThanOrEqual(0.1);
  });
  it("preserves the default zigzag length on whisper balloons", async () => {
    const balloon = 'balloon: "", id: b, as: whisper, at: [40mm, 35mm], size: [24mm, 24mm], shape: { kind: ellipse, irregularity: 0 }';
    const tail = "tail: { kind: zigzag, direction: 0deg, bend: 0 }";
    const whisper = await outline(`{ ${balloon}, ${tail} }`);
    const say = await outline(`{ ${balloon.replace("as: whisper", "as: say")}, ${tail} }`);
    const reach = (o: typeof whisper) => tip(o.pts).x - rightOf(o.pts, o.origin.x + 40);
    expect(reach(whisper)).toBeCloseTo(reach(say), 1);
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
  it.each([["shout", 3], ["scream", 5]] as const)("makes the automatic %s wedge one longer spike while honoring explicit tail lengths", async (as, nominal) => {
    const kind = as === "shout" ? "spike" : "burst";
    const balloon = `balloon: "", id: b, as: ${as}, hand: clean, size: [40mm, 40mm], at: [40mm, 35mm], shape: { kind: ${kind}, irregularity: 0, egg: 0 }`;
    const make = BODY_GENERATORS[kind];
    const bodies: BodyGeom[] = [];
    const spy = vi.spyOn(BODY_GENERATORS, kind).mockImplementation((...args) => {
      const body = make(...args);
      bodies.push(body);
      return body;
    });
    try {
      const auto = await outline(`{ ${balloon}, tail: { direction: 0deg } }`);
      const body = bodies.at(-1)!;
      const coreRight = Math.max(...body.spikeCore!.map(q => q.x));
      const centerX = Math.min(...auto.pts.map(q => q.x)) - Math.min(...body.contour.pts.map(q => q.x));
      const depth = nominal * 80 / 182;
      const extension = tip(auto.pts).x - centerX - coreRight;
      expect(extension / depth).toBeGreaterThan(1.75);
      expect(extension / depth).toBeLessThan(2.4);
    } finally {
      spy.mockRestore();
    }
    const short = await outline(`{ ${balloon}, tail: { direction: 0deg, length: 4mm } }`);
    const long = await outline(`{ ${balloon}, tail: { direction: 0deg, length: 7mm } }`);
    expect(tip(long.pts).x - tip(short.pts).x).toBeCloseTo(3, 1);
    const capped = await outline(`{ ${balloon}, tail: { direction: 0deg, maxLength: 0.1mm } }`);
    expect(tip(capped.pts).x).toBeLessThan(tip(long.pts).x);
  });
  it("keeps a speaker tail within the automatic bounds regardless of target distance", async () => {
    const close = await outline(`{ balloon: "おはよう", id: b, size: [24mm, 24mm], at: [40mm, 35mm], tail: { to: [59mm, 35mm], bend: 0 } }`);
    const far = await outline(`{ balloon: "おはよう", id: b, size: [24mm, 24mm], at: [30mm, 35mm], tail: { to: [70mm, 35mm], bend: 0 } }`);
    const reachOf = (out: { pts: Vec[]; origin: Vec }, cx: number) => tip(out.pts).x - rightOf(out.pts, out.origin.x + cx);
    const closeReach = reachOf(close, 40);
    const farReach = reachOf(far, 30);
    expect(Math.abs(closeReach - farReach)).toBeLessThan(0.05);
    for (const reach of [closeReach, farReach]) {
      expect(reach).toBeGreaterThan((2.5 * 80) / 182 - 0.05);
      expect(reach).toBeLessThan((5 * 80) / 182 + 0.05);
    }
    expect(Math.abs(tip(close.pts).y - (close.origin.y + 35))).toBeLessThan(0.3);
    expect(Math.abs(tip(far.pts).y - (far.origin.y + 35))).toBeLessThan(0.3);
  });
  it("defaults curl off while preserving an explicit curl", async () => {
    const data = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "white" } }).png().toBuffer();
    const renderer = createRenderer({ profile: "preview", assets: { art: data } });
    const geometry = async (curl?: boolean) => {
      const doc = {
        mangacli: 1,
        page: { size: ["100mm", "80mm"], bleed: "0mm", baseFrame: "trim" },
        assets: { art: { src: "art.png", character: "taro", anchors: { mouth: [550, 550] }, regions: { face: [200, 400, 300, 200] } } },
        pages: [{ layers: [
          { image: "art", id: "img", at: ["0mm", "0mm"], anchor: "top-left", size: ["100mm", "80mm"], fit: "fill" },
          { balloon: "Hi", id: "b", who: "taro", tail: { bend: 0, ...(curl === undefined ? {} : { curl }) }, at: ["10mm", "20mm"], size: ["24mm", "18mm"], hand: "ruler" },
        ] }],
      };
      const root = (await renderer.displayList(doc, 1)).root;
      const [fill] = paths(root, (n) => n.tag?.elementId === "b" && n.tag.role === "fill");
      return vertices(fill);
    };
    const automatic = await geometry();
    expect(automatic).toEqual(await geometry(false));
    expect(automatic).not.toEqual(await geometry(true));
  });
  it("aims a tail at a speaker below even when its root moves to the side", async () => {
    const { pts, origin } = await outline(`{ balloon: "おはよう", id: b, size: [24mm, 24mm], at: [40mm, 25mm], tail: { to: [46mm, 55mm], length: 8mm, bend: 0 } }`);
    const t = pts.reduce((p, q) => (q.y > p.y ? q : p));
    expect(Math.abs(t.x - (origin.x + 46))).toBeLessThan(2.5);
    expect(t.y - (origin.y + 37)).toBeGreaterThan(2.5);
  });
  it("keeps a tail outside the body when its speaker is right under it", async () => {
    const { pts, origin } = await outline(`{ balloon: "おはよう", id: b, size: [24mm, 24mm], at: [40mm, 25mm], tail: { to: [42mm, 40mm], length: 8mm, bend: 0 } }`);
    const t = pts.reduce((p, q) => (q.y > p.y ? q : p));
    expect(t.y - (origin.y + 37)).toBeGreaterThan(1.5);
  });
  it("honors an explicit length even when it crosses the speaker's face box", async () => {
    const data = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "white" } }).png().toBuffer();
    const renderer = createRenderer({ profile: "preview", assets: { art: data } });
    const doc = {
      mangacli: 1,
      page: { size: ["100mm", "80mm"], bleed: "0mm", baseFrame: "trim" },
      assets: { art: { src: "art.png", character: "taro", anchors: { mouth: [700, 450] }, regions: { face: [520, 300, 300, 200] } } },
      pages: [{ layers: [
        { image: "art", id: "img", at: ["0mm", "0mm"], anchor: "top-left", size: ["100mm", "80mm"], fit: "fill" },
        { balloon: "Hi", id: "b", who: "taro", tail: { length: "30mm", gap: "2mm", allowVertical: true, bend: 0 }, at: ["24mm", "56mm"], size: ["14mm", "12mm"], hand: "ruler" },
      ] }],
    };
    const root = (await renderer.displayList(doc, 1)).root;
    const [fill] = paths(root, (n) => n.tag?.elementId === "b" && n.tag.role === "fill");
    const pts = vertices(fill);
    const t = pts.reduce((p, q) => (q.x - q.y > p.x - p.y ? q : p));
    expect(t.x).toBeGreaterThan(52);
  });
  it("never fails validation on BALLOON_TAIL_SHORT for a distant speaker", async () => {
    const yaml = (to: string) => `mangacli: 1
page: { size: [160mm, 80mm], bleed: 3mm }
pages:
  - panels:
      - layers:
          - { balloon: "おはよう", id: b, size: [24mm, 24mm], at: [30mm, 35mm], tail: { to: [${to}, 35mm] } }
`;
    for (const to of ["150mm", "55mm"]) {
      const result = await validate({ yaml: yaml(to), filename: "/v/tail.yaml" }, { strict: true, diagnostics: { BALLOON_TAIL_SHORT: "error" } });
      expect(result.ok).toBe(true);
      expect(result.diagnostics.map((d) => d.code)).not.toContain("BALLOON_TAIL_SHORT");
    }
  });
  it("extends automatic, capped and explicitly short off-screen tails beyond the frame with an open width", async () => {
    const balloon = 'balloon: "", id: b, as: offscreen, at: [26mm, 24mm], size: [18mm, 14mm], shape: { kind: ellipse, irregularity: 0 }';
    const none = await outline(`{${balloon}, tail: none}`);
    const auto = await outline(`{${balloon}, tail: { offscreen: left, bend: 0 }}`);
    const capped = await outline(`{${balloon}, tail: { offscreen: left, bend: 0, maxLength: 3mm }}`);
    const short = await outline(`{${balloon}, tail: { offscreen: left, bend: 0, length: 3.8mm }}`);
    const left = (pts: Vec[]) => Math.min(...pts.map((p) => p.x));
    expect(left(none.pts)).toBeGreaterThan(none.origin.x);
    for (const result of [short, auto, capped]) {
      expect(left(result.pts)).toBeLessThan(result.origin.x);
      expect(widthAt(result.pts, result.origin.x, 24 + result.origin.y)).toBeGreaterThan(0.15);
    }
    const near = await outline(`{${balloon.replace("26mm", "12mm")}, tail: { offscreen: left, bend: 0 }}`);
    expect(left(near.pts)).toBeLessThan(near.origin.x);
  });
  it.each(["0deg", "270deg"])("keeps off-panel tails finite when root %s cannot advance toward the frame", async (root) => {
    for (const length of ["", ", length: 5mm"]) {
      const yaml = `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm }
pages:
  - panels:
      - layers:
          - { balloon: "", id: b, at: [50%, 50%], size: [20mm, 20mm], shape: { kind: ellipse, irregularity: 0 }, tail: { offscreen: bottom, root: ${root}, bend: 0${length} } }
`;
      const result = await r.render({ filename: "/v/offscreen-root.yaml", yaml }, { layoutOnly: true, keepLists: true });
      expect(result.diagnostics.some(d => d.severity === "error" || d.code === "BALLOON_OFFSCREEN_LENGTH_IGNORED")).toBe(false);
      const [fill] = paths(result.lists![0].root, n => n.tag?.elementId === "b" && n.tag.role === "fill");
      const points = vertices(fill);
      expect(points.length).toBeGreaterThan(0);
      expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
      expect(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))).toBeLessThan(40);
      expect(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))).toBeLessThan(40);
    }
  });
  it.each(["top", "right", "bottom", "left"])("warns only for short explicit off-panel lengths toward %s", async (side) => {
    const codes = async (tail: string, from = `from: ${side},`) => {
      const result = await r.render({ filename: "/v/offscreen-length.yaml", yaml: `mangacli: 1
page: { size: [160mm, 100mm], bleed: 0mm }
pages:
  - panels:
      - layers:
          - { balloon: "", id: b, ${from} at: [50%, 50%], size: [18mm, 14mm], tail: ${tail} }
` }, { layoutOnly: true });
      return result.diagnostics.map(d => d.code);
    };
    expect(await codes("{ length: 1mm }")).toContain("BALLOON_OFFSCREEN_LENGTH_IGNORED");
    expect(await codes(`{ offscreen: ${side}, length: 1mm }`, "")).toContain("BALLOON_OFFSCREEN_LENGTH_IGNORED");
    expect(await codes("{}")).not.toContain("BALLOON_OFFSCREEN_LENGTH_IGNORED");
    expect(await codes("{ length: 200mm }")).not.toContain("BALLOON_OFFSCREEN_LENGTH_IGNORED");
    expect(await codes("none")).not.toContain("BALLOON_OFFSCREEN_LENGTH_IGNORED");
    expect(await codes("{ length: 1mm }", "")).not.toContain("BALLOON_OFFSCREEN_LENGTH_IGNORED");
  });
});
