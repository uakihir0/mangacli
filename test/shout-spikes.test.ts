import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { Rng } from "../src/core/random.js";
import { inksToNodes } from "../src/elements/inkir.js";
import { pointInPolygon, polygonArea } from "../src/geom/path.js";
import { add, cross, dist, dot, mul, norm, sub } from "../src/geom/vec.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
import { strokeOutline } from "../src/ink/stroke.js";
import { resolveDocument } from "../src/model/resolve.js";
import { BODY_GENERATORS, type BodyGeom, type ShapeParams } from "../src/shapes/balloon.js";

const tips = (body: BodyGeom) => body.contour.corners!.filter(c => c.kind === "tip").map(c => body.contour.pts[c.index]);

function spikes(kind: string, w: number, h: number, seed: number, extra: Partial<ShapeParams> = {}) {
  const p = { kind, irregularity: 0, egg: 0, tilt: 0, ...extra };
  const body = BODY_GENERATORS[kind](w, h, p, seed);
  const roots = tips(BODY_GENERATORS[kind](w, h, { ...p, depth: 0 }, seed));
  return { body, roots, depths: tips(body).map((q, i) => dist(q, roots[i])) };
}

function ellipsePoint(w: number, h: number, t: number) {
  const r = (Math.abs(Math.cos(t) / (w / 2)) ** 2.15 + Math.abs(Math.sin(t) / (h / 2)) ** 2.15) ** (-1 / 2.15);
  return { x: Math.cos(t) * r, y: Math.sin(t) * r };
}

describe("shout contours", () => {
  it.each([[40, 60], [14, 100], [100, 14], [14, 16]])("keeps four dominant corner spikes and a rectangular %sx%s text core", (w, h) => {
    const make = (seed: number) => BODY_GENERATORS["spike-rect"](w, h, { kind: "spike-rect", irregularity: 0, tilt: 0 }, seed);
    const body = make(42);
    expect(make(42)).toEqual(body);
    expect(make(43).contour.pts).not.toEqual(body.contour.pts);
    expect(body.inner).toEqual([{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]);
    expect(body.inner.every(p => pointInPolygon(p, body.contour.pts))).toBe(true);
    const { pts, corners } = body.contour;
    const peaks = corners!.filter(c => c.kind === "tip");
    const diagonal = peaks.filter(c => Math.abs(pts[c.index].x) > w / 2 && Math.abs(pts[c.index].y) > h / 2);
    expect(diagonal.map(c => [Math.sign(pts[c.index].x), Math.sign(pts[c.index].y)])).toEqual([[1, -1], [1, 1], [-1, 1], [-1, -1]]);
    const tipAngle = (index: number) => {
      const q = pts[index];
      const a = norm(sub(pts.at(index - 1)!, q));
      const b = norm(sub(pts[(index + 1) % pts.length], q));
      return Math.acos(dot(a, b)) * 180 / Math.PI;
    };
    let maxSideDepth = 0;
    for (const { index } of peaks.filter(c => !diagonal.includes(c))) {
      const q = pts[index];
      const depth = Math.max(Math.abs(q.x) - w / 2, Math.abs(q.y) - h / 2);
      maxSideDepth = Math.max(maxSideDepth, depth);
      expect(depth).toBeGreaterThanOrEqual(4.05);
      expect(depth).toBeLessThanOrEqual(4.95);
      expect(tipAngle(index)).toBeGreaterThan(24);
      expect(tipAngle(index)).toBeLessThan(40);
    }
    for (const { index } of diagonal) {
      const q = pts[index];
      expect(tipAngle(index)).toBeCloseTo(30, 0);
      expect(Math.abs(q.x) - w / 2).toBeCloseTo(Math.abs(q.y) - h / 2);
      expect(Math.hypot(Math.abs(q.x) - w / 2, Math.abs(q.y) - h / 2)).toBeGreaterThanOrEqual(1.5 * maxSideDepth);
    }
    for (const side of ["x", "y"] as const) for (const sign of [-1, 1]) {
      expect(peaks.some(({ index }) => sign * pts[index][side] > (side === "x" ? w : h) / 2 && !diagonal.some(c => c.index === index))).toBe(true);
    }
    if (w === 14 && h === 16) expect(peaks.length).toBeLessThanOrEqual(14);
  });

  it("preserves the ink where an entry pool overlaps a spike flank", () => {
    const inks = strokeOutline([{ x: 0, y: 0 }, { x: 4, y: 0 }], {
      hand: HAND_PRESETS.ink, pen: { ...PEN_PRESETS["g-pen"], inkPool: 1 },
      rng: new Rng(6), width: 0.45, miterEnd: { x: 1, y: 0 },
    });
    expect(inks).toHaveLength(2);
    const overlap = { x: 0.3, y: 0 };
    expect(inks.every(ink => pointInPolygon(overlap, ink.pts))).toBe(true);
    expect(polygonArea(inks[0].pts) * polygonArea(inks[1].pts)).toBeGreaterThan(0);
  });

  it.each(["spike", "burst", "spike-rect"])("keeps both %s flanks at nominal width and miters tips within the miter limit", (kind) => {
    const { body } = spikes(kind, 40, 60, 42);
    const width = 0.45;
    const { inks, fill } = inkShape(body.contour, {
      hand: HAND_PRESETS.ink, rng: new Rng(42), join: "gap",
      line: { width, pen: { ...PEN_PRESETS["g-pen"], inkPool: 0 }, style: "solid" },
    });
    const miters = inks.filter(ink => ink.straight);
    const sides = inks.filter(ink => !ink.straight);
    const n = tips(body).length;
    expect(miters).toHaveLength(n);
    expect(sides).toHaveLength(2 * n);
    for (let i = 0; i < n; i++) {
      const join = miters[i].pts;
      const b = join[0], a = join.at(-2)!, tip = join.at(-1)!;
      const tipIndex = fill.indexOf(tip);
      const incoming = norm(sub(tip, fill[tipIndex - 1]));
      const outgoing = norm(sub(fill[(tipIndex + 1) % fill.length], tip));
      const withinMiterLimit = 1 + dot(incoming, outgoing) >= 0.02;
      expect(join).toHaveLength(withinMiterLimit ? 4 : 3);
      if (withinMiterLimit) {
        const apex = join[1];
        expect(dist(apex, a)).toBeGreaterThan(0);
        expect(dist(apex, add(a, mul(incoming, dist(apex, a))))).toBeCloseTo(0, 8);
        expect(dist(apex, add(b, mul(outgoing, -dist(apex, b))))).toBeCloseTo(0, 8);
      }
      for (const [flank, outside] of [a, b].entries()) {
        const { pts } = sides[2 * i + flank];
        const inside = sub(mul(tip, 2), outside);
        expect(dist(inside, outside)).toBeCloseTo(width, 8);
        expect(pts.some(p => dist(p, outside) < 1e-8)).toBe(true);
        expect(pts.some(p => dist(p, inside) < 1e-8)).toBe(true);
        expect(dist(pts[0], pts.at(-1)!)).toBeLessThan(width * 0.9);
      }
    }
    const [node] = inksToNodes(inks, { r: 0, g: 0, b: 0, a: 1 });
    expect(node.kind === "path" && node.path.slice(0, 5).map(cmd => cmd[0])).toEqual(["M", "L", "L", "L", "Z"]);
  });

  it.each(["spike", "burst"])("gives %s deterministic, uniformly long spikes outside the text core", (kind) => {
    const make = (seed: number) => BODY_GENERATORS[kind](40, 40, { kind, irregularity: 0, egg: 0, tilt: 0, count: 20 }, seed);
    const body = make(42);
    expect(make(42)).toEqual(body);
    expect(make(43).contour.pts).not.toEqual(body.contour.pts);
    for (const q of body.inner) expect(pointInPolygon(q, body.contour.pts)).toBe(true);
    for (const [w, h] of [[20, 30], [40, 60], [80, 120], [120, 40], [40, 120]]) for (const seed of [1, 42, 12345]) {
      const { depths } = spikes(kind, w, h, seed, { irregularity: 0.35, tilt: 0.2 });
      const nominal = kind === "spike" ? 4.5 : 6;
      expect(Math.max(...depths) / Math.min(...depths)).toBeLessThanOrEqual(1.3);
      expect(Math.min(...depths)).toBeGreaterThanOrEqual(nominal * 0.9 - 1e-8);
      expect(Math.max(...depths)).toBeLessThanOrEqual(nominal * 1.1 + 1e-8);
    }
  });

  it.each(["spike", "burst"])("keeps %s lengths in bmm across sizes, and scales pitch with bmm", (kind) => {
    for (const unitScale of [0.5, 1, 2]) {
      for (const [w, h] of [[20, 30], [80, 120]]) {
        const { body, depths } = spikes(kind, w, h, 42, { unitScale });
        const nominal = (kind === "spike" ? 4.5 : 6) * unitScale;
        expect(body.spikeLength).toBeCloseTo(depths.reduce((a, b) => a + b) / depths.length);
        expect(body.spikeLength! / nominal).toBeGreaterThan(0.9);
        expect(body.spikeLength! / nominal).toBeLessThan(1.1);
      }
      const scaled = spikes(kind, 40 * unitScale, 60 * unitScale, 42, { unitScale });
      expect(scaled.depths.length).toBe(spikes(kind, 40, 60, 42).depths.length);
    }
  });

  it.each(["spike", "burst"])("gives default %s straight sides and angles around 30 degrees", (kind) => {
    for (const [w, h] of [[20, 30], [50, 50], [120, 40]]) {
      const { pts, corners } = spikes(kind, w, h, 42).body.contour;
      const angles: number[] = [];
      for (let i = 1; i < corners!.length; i += 2) {
        const a = corners![i - 1].index;
        const t = corners![i].index;
        const b = corners![i + 1]?.index ?? pts.length;
        const left = sub(pts[a], pts[t]);
        const right = sub(pts[b % pts.length], pts[t]);
        for (let j = a + 1; j < t; j++) expect(Math.abs(cross(left, sub(pts[j], pts[t])))).toBeLessThan(1e-8);
        for (let j = t + 1; j < b; j++) expect(Math.abs(cross(right, sub(pts[j], pts[t])))).toBeLessThan(1e-8);
        angles.push(Math.atan2(Math.abs(cross(left, right)), dot(left, right)) * 180 / Math.PI);
      }
      const mean = angles.reduce((a, b) => a + b) / angles.length;
      expect(mean).toBeGreaterThan(25);
      expect(mean).toBeLessThan(35);
    }
  });

  it.each(["spike", "burst"])("spaces %s by arc length, places roots on the core and points along its normals", (kind) => {
    for (const [w, h] of [[120, 40], [40, 120], [40, 40]]) for (const angleJitter of [0, undefined]) {
      const { body, roots } = spikes(kind, w, h, 42, { angleJitter });
      const lengths = [0];
      for (let i = 1; i <= 8192; i++) lengths.push(lengths[i - 1] + dist(ellipsePoint(w, h, (i - 1) / 8192 * Math.PI * 2), ellipsePoint(w, h, i / 8192 * Math.PI * 2)));
      const per = lengths.at(-1)!;
      const positions = roots.map(q => {
        const t = (Math.atan2(q.y, q.x) + Math.PI * 2) % (Math.PI * 2);
        const f = t / (Math.PI * 2) * 8192;
        const i = Math.floor(f);
        return lengths[i] + (lengths[i + 1] - lengths[i]) * (f - i);
      });
      const jitter = angleJitter ?? (kind === "spike" ? 0.15 : 0.2);
      const pitch = per / roots.length;
      for (let i = 0; i < roots.length; i++) {
        const gap = (positions[(i + 1) % roots.length] - positions[i] + per) % per;
        expect(gap).toBeGreaterThan(pitch * (1 - jitter) - 0.02);
        expect(gap).toBeLessThan(pitch * (1 + jitter) + 0.02);
        const t = Math.atan2(roots[i].y, roots[i].x);
        const a = ellipsePoint(w, h, t - 0.0001);
        const b = ellipsePoint(w, h, t + 0.0001);
        const tip = tips(body)[i];
        const dx = tip.x - roots[i].x;
        const dy = tip.y - roots[i].y;
        expect(Math.abs(dx * (b.x - a.x) + dy * (b.y - a.y))).toBeLessThan(1e-7);
        expect(dx * (b.y - a.y) - dy * (b.x - a.x)).toBeGreaterThan(0);
      }
      for (const c of body.contour.corners!.filter(c => c.kind === "valley")) {
        const q = body.contour.pts[c.index];
        expect(dist(q, ellipsePoint(w, h, Math.atan2(q.y, q.x)))).toBeLessThan(1e-8);
      }
    }
  });

  it.each(["spike", "burst"])("preserves explicit %s depth, count and curve controls", (kind) => {
    const fixed = spikes(kind, 40, 60, 42, { depth: [0.2, 0.2], count: 17, curve: 0 });
    expect(fixed.depths).toHaveLength(17);
    for (const d of fixed.depths) expect(d).toBeCloseTo(5);
    const scalar = spikes(kind, 40, 60, 42, { depth: 0.2, count: 17 });
    expect(Math.min(...scalar.depths)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...scalar.depths)).toBeLessThanOrEqual(6);
    const curved = spikes(kind, 40, 60, 42, { depth: [0.2, 0.2], count: 17, curve: 0.7 });
    expect(tips(curved.body)).toEqual(tips(fixed.body));
    expect(curved.body.contour.pts).not.toEqual(fixed.body.contour.pts);
    const zero = spikes(kind, 1, 1, 42, { depth: 0 });
    expect(zero.depths.every(d => d === 0)).toBe(true);
    expect(zero.body.contour.pts.every(q => Number.isFinite(q.x + q.y))).toBe(true);
  });

  it("enables secondary burst spikes only when requested", () => {
    expect(spikes("burst", 60, 60, 42, { secondary: false }).body).toEqual(spikes("burst", 60, 60, 42).body);
    const secondary = spikes("burst", 60, 60, 42, { secondary: true, count: 80 }).body;
    expect(secondary.spikeLength!).toBeLessThan(spikes("burst", 60, 60, 42, { count: 80 }).body.spikeLength! * 0.85);
  });

  it.each(["shout", "scream"])("makes %s heavier than speech while honoring explicit widths, including empty text", (as) => {
    const props = (style: string, stroke?: object) => resolveDocument({ pages: [{ layers: [{ type: "balloon", text: "", as: style, ...(stroke ? { stroke } : {}) }] }] }, new DiagnosticBag()).pages[0].layers[0].props;
    const width = (p: Record<string, unknown>) => Number.parseFloat((p.stroke as { width: string }).width);
    expect(width(props(as))).toBeGreaterThanOrEqual(width(props("say")) * 1.5);
    expect(width(props(as, { width: "0.1mm" }))).toBe(0.1);
  });
});
