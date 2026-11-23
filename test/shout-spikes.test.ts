import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { Rng } from "../src/core/random.js";
import { inksToNodes } from "../src/elements/inkir.js";
import { pointInPolygon } from "../src/geom/path.js";
import { add, dist, mul, norm, sub } from "../src/geom/vec.js";
import { HAND_PRESETS, PEN_PRESETS } from "../src/ink/presets.js";
import { inkShape } from "../src/ink/shape.js";
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
  it.each(["spike", "burst"])("keeps both %s flanks at nominal width at the tip and closes them with a sharp miter", (kind) => {
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
      const [b, apex, a, tip] = miters[i].pts;
      const tipIndex = fill.indexOf(tip);
      const incoming = norm(sub(tip, fill[tipIndex - 1]));
      const outgoing = norm(sub(fill[tipIndex + 1], tip));
      expect(dist(apex, a)).toBeGreaterThan(0);
      expect(dist(apex, add(a, mul(incoming, dist(apex, a))))).toBeCloseTo(0, 8);
      expect(dist(apex, add(b, mul(outgoing, -dist(apex, b))))).toBeCloseTo(0, 8);
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
      const nominal = kind === "spike" ? 3 : 5;
      expect(Math.max(...depths) / Math.min(...depths)).toBeLessThanOrEqual(1.3);
      expect(Math.min(...depths)).toBeGreaterThanOrEqual(nominal * 0.9 - 1e-8);
      expect(Math.max(...depths)).toBeLessThanOrEqual(nominal * 1.1 + 1e-8);
    }
  });

  it.each(["spike", "burst"])("keeps %s lengths in bmm across sizes, and scales pitch with bmm", (kind) => {
    for (const unitScale of [0.5, 1, 2]) {
      for (const [w, h] of [[20, 30], [80, 120]]) {
        const { body, depths } = spikes(kind, w, h, 42, { unitScale });
        const nominal = (kind === "spike" ? 3 : 5) * unitScale;
        expect(body.spikeLength).toBeCloseTo(depths.reduce((a, b) => a + b) / depths.length);
        expect(body.spikeLength! / nominal).toBeGreaterThan(0.9);
        expect(body.spikeLength! / nominal).toBeLessThan(1.1);
      }
      const scaled = spikes(kind, 40 * unitScale, 60 * unitScale, 42, { unitScale });
      expect(scaled.depths.length).toBe(spikes(kind, 40, 60, 42).depths.length);
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
      for (let i = 0; i < roots.length; i++) {
        const gap = (positions[(i + 1) % roots.length] - positions[i] + per) % per;
        expect(gap / (per / roots.length)).toBeGreaterThan(1 - jitter - 0.002);
        expect(gap / (per / roots.length)).toBeLessThan(1 + jitter + 0.002);
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
    expect(secondary.spikeLength).toBeLessThan(4.5);
  });

  it.each(["shout", "scream"])("makes %s heavier than speech while honoring explicit widths, including empty text", (as) => {
    const props = (style: string, stroke?: object) => resolveDocument({ pages: [{ layers: [{ type: "balloon", text: "", as: style, ...(stroke ? { stroke } : {}) }] }] }, new DiagnosticBag()).pages[0].layers[0].props;
    const width = (p: Record<string, unknown>) => Number.parseFloat((p.stroke as { width: string }).width);
    expect(width(props(as))).toBeGreaterThanOrEqual(width(props("say")) * 1.5);
    expect(width(props(as, { width: "0.1mm" }))).toBe(0.1);
  });
});
