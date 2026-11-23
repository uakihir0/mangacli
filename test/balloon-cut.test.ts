import { describe, expect, it } from "vitest";
import { validate } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import type { BalloonPlan } from "../src/elements/balloon.js";
import type { ElemCtx } from "../src/elements/context.js";
import type { Vec } from "../src/geom/vec.js";
import { containBalloon, cutCenter, cutDepth, cutSides, cutSize, polygonSpan } from "../src/render/balloon-contain.js";

const rect = (x: number, y: number, w: number, h: number): Vec[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const panel = { x: 0, y: 0, w: 60, h: 40 };

describe("balloon cut geometry", () => {
  it("reads sides in order and clamps depth to 45%", () => {
    expect(cutSides({ cut: ["right", "top"] })).toEqual(["top", "right"]);
    expect(cutSides({ cut: { sides: ["left"] } })).toEqual(["left"]);
    expect(cutDepth({ cut: ["top"] }, "top")).toBe(0.3);
    expect(cutDepth({ cut: { sides: ["top"], depth: 0.9 } }, "top")).toBe(0.45);
    expect(cutDepth({ cut: { sides: ["top", "left"], depth: { left: 0.4 } } }, "left")).toBe(0.4);
    expect(cutDepth({ cut: ["left", "right"] }, "left")).toBeLessThan(0.3);
  });
  it("sinks the body past each cut side by its depth", () => {
    const body = { x: -10, y: -8, w: 20, h: 16 };
    const c = cutCenter(body, panel, ["top", "right"], () => 0.45, { x: 1, y: 2 });
    expect(c.y + body.y).toBeCloseTo(-0.45 * 16);
    expect(c.x + body.x + body.w).toBeCloseTo(60 + 0.45 * 20);
    expect(cutCenter(body, panel, ["bottom"], () => 0.3, { x: 7, y: 0 }).x).toBe(7);
  });
  it("spans two facing sides and centres the body on the panel", () => {
    const size = cutSize({ w: 20, h: 16 }, panel, ["left", "right", "top"], s => (s === "top" ? 0.3 : 0.1));
    expect(size.w).toBeCloseTo(60 / 0.8);
    expect(size.h).toBeCloseTo(16 / 0.7);
    const c = cutCenter({ x: -size.w / 2, y: -size.h / 2, ...size }, panel, ["left", "right", "top"], s => (s === "top" ? 0.3 : 0.1), { x: 0, y: 0 });
    expect(c.x).toBeCloseTo(30);
  });
  it("splits the overhang of two facing sides by their depths", () => {
    const depth = (s: string) => (s === "left" ? 0.45 : 0.08);
    const size = cutSize({ w: 20, h: 16 }, panel, ["left", "right"], depth);
    const c = cutCenter({ x: -size.w / 2, y: -size.h / 2, ...size }, panel, ["left", "right"], depth, { x: 0, y: 0 });
    expect(0 - (c.x - size.w / 2)).toBeCloseTo(0.45 * size.w);
    expect(c.x + size.w / 2 - 60).toBeCloseTo(0.08 * size.w);
  });
  it("cuts a slanted side where it runs past the body", () => {
    const poly = [{ x: 0, y: 0 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 0, y: 60 }];
    expect(polygonSpan(poly, "x", 45)).toEqual([15, 60]);
    const body = { x: -10, y: -8, w: 20, h: 16 };
    const c = cutCenter(body, { x: 0, y: 0, w: 60, h: 60 }, ["top", "right"], () => 0.3, { x: 0, y: 0 }, poly);
    const edge = (c.x / 60) * 20;
    expect(c.y + body.y).toBeCloseTo(edge - 0.3 * 16);
  });
  it("keeps the text max(2.5bmm, 0.8em) inside every cut side", () => {
    const props = { contain: "panel", clip: "auto", cut: ["top", "right"] };
    const p = { el: { id: "b", type: "balloon", props, path: [] }, props, body: { contour: { pts: rect(-15, -15, 30, 30) } }, outer: { x: -15, y: -15, w: 30, h: 30 }, center: { x: 60 + 15 - 0.4 * 30, y: -15 + 0.4 * 30 }, edgeCut: true, text: { plain: "あいう", width: 6, height: 8, fontSize: 4, lines: [{ text: "あいう" }] }, textOffset: { x: 0, y: 0 }, innerCenter: { x: 0, y: 0 } } as unknown as BalloonPlan;
    const ctx = { panel: { panel: { props: { border: { width: "0.5mm" } } } }, panelPoly: rect(0, 0, 60, 40), u: { units: "mm", dpi: 300, k: 1 }, geom: {}, bag: new DiagnosticBag() } as unknown as ElemCtx;
    const center = { ...p.center! };
    containBalloon(p, ctx, () => null);
    expect(p.center).toEqual(center);
    const tx = p.center!.x + p.textOffset.x;
    const ty = p.center!.y + p.textOffset.y;
    expect(tx + 3).toBeLessThanOrEqual(60 - 3.2 + 1e-6);
    expect(ty - 4).toBeGreaterThanOrEqual(3.2 - 1e-6);
  });
});

const page = (layers: string) => `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm }
defaults: { balloon: { fontSize: 14bQ } }
pages:
  - panels:
      - coords: page
        box: [20mm, 20mm, 60mm, 50mm]
        layers:
${layers}
`;

describe("balloons cut by several panel sides", () => {
  it.each([
    ["ellipse", "", "[top, right]"],
    ["spike", "as: shout,", "[top, left]"],
    ["burst", "as: scream,", "[bottom, left]"],
    ["cloud", "as: think,", "[top, right, bottom]"],
    ["rect", "shape: { kind: rect },", "[top, left, right]"],
  ])("%s cut by %s %s keeps its depth and its text clear", async (_kind, style, sides) => {
    const r = await validate({ yaml: page(`          - { balloon: 切れる　セリフ, id: b, ${style} cut: ${sides}, tail: { direction: 90deg } }`) });
    const codes = r.diagnostics.map(d => d.code);
    expect(codes).not.toContain("BALLOON_NO_SPACE");
    expect(codes).not.toContain("TEXT_OUTSIDE_SAFE_AREA");
    expect(codes).not.toContain("TEXT_CLIPPED");
    const { bbox } = r.layout[0].elements.find(e => e.id === "b")!;
    const s = new Set(sides.slice(1, -1).split(", "));
    const facingX = s.has("left") && s.has("right");
    const facingY = s.has("top") && s.has("bottom");
    const past = (outside: number, size: number, facing: boolean) => expect(outside).toBeGreaterThan(size * (facing ? 0.03 : 0.2));
    if (s.has("top")) past(20 - bbox.y, bbox.h, facingY);
    if (s.has("bottom")) past(bbox.y + bbox.h - 70, bbox.h, facingY);
    if (s.has("left")) past(20 - bbox.x, bbox.w, facingX);
    if (s.has("right")) past(bbox.x + bbox.w - 80, bbox.w, facingX);
  });
  it("accepts a 45% corner cut and rejects deeper or empty cuts", async () => {
    const ok = await validate({ yaml: page("          - { balloon: 深い, id: b, cut: { sides: [top, right], depth: 0.45 }, tail: none }") });
    expect(ok.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    for (const cut of ["{ sides: [top], depth: 0.5 }", "[]", "[top, right, bottom, left]"]) {
      const bad = await validate({ yaml: page(`          - { balloon: 深い, cut: ${cut} }`) });
      expect(bad.diagnostics.some(d => d.severity === "error")).toBe(true);
    }
  });
  it("reads only the part of a cut body inside its panel for overlaps", async () => {
    const yaml = `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm }
defaults: { balloon: { fontSize: 14bQ } }
pages:
  - panels:
      - coords: page
        box: [10mm, 20mm, 40mm, 50mm]
        layers:
          - { balloon: 右へ　切れる, cut: { sides: [top, right], depth: 0.45 }, tail: none }
      - coords: page
        box: [52mm, 20mm, 40mm, 50mm]
        layers:
          - { balloon: となり, at: [25%, 20%], tail: none }
`;
    const r = await validate({ yaml });
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_OVERLAP");
  });
  it.each([
    ["a flowing balloon", "autoPlace: flow,"],
    ["a narration", "as: narration,"],
  ])("cuts %s by its cut sides", async (_name, style) => {
    const r = await validate({ yaml: page(`          - { balloon: 短い, id: b, ${style} cut: [bottom], tail: none }`) });
    const { bbox } = r.layout[0].elements.find(e => e.id === "b")!;
    expect(bbox.y + bbox.h - 70).toBeGreaterThan(bbox.h * 0.2);
  });
  it.each([
    ["two narrations cut by the bottom", "as: narration, cut: [bottom]"],
    ["two flowing balloons cut by the left", "autoPlace: flow, cut: [left]"],
  ])("keeps %s apart", async (_name, style) => {
    const r = await validate({ yaml: page(`          - { balloon: ひとつめ, id: a, ${style}, tail: none }\n          - { balloon: ふたつめ, id: b, ${style}, tail: none }`) });
    const [a, b] = ["a", "b"].map(id => r.layout[0].elements.find(e => e.id === id)!.bbox);
    const gx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    const gy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    expect(Math.max(gx, gy)).toBeGreaterThanOrEqual(-0.01);
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_TEXT_HIDDEN");
  });
  it("leaves the flow rows alone when a cut balloon has nowhere else to go", async () => {
    const r = await validate({ yaml: page(`          - { balloon: いち, id: a, autoPlace: flow, cut: [top, left], tail: none }\n          - { balloon: にい, id: b, autoPlace: flow, cut: [top, left], tail: none }\n          - { balloon: さん, id: c, autoPlace: flow, tail: none }`) });
    const c = r.layout[0].elements.find(e => e.id === "c")!.bbox;
    expect(c.y).toBeLessThan(25);
  });
  it("lets a cut flowing balloon overlap the balloon it connects to", async () => {
    const r = await validate({ yaml: page(`          - { balloon: いちいち, id: a, autoPlace: flow, tail: none }\n          - { balloon: にいにい, id: b, autoPlace: flow, cut: [right], connect: { to: a, style: overlap }, tail: none }`) });
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_CONNECT_DISJOINT");
  });
  it("keeps a cut flowing balloon in the panel when no row below is free", async () => {
    const r = await validate({
      yaml: page(`          - { balloon: いちいちいちいちいちいちいちいちいちいち, id: a, at: [90%, 50%], tail: none }
          - { balloon: にいにい, id: b, autoPlace: flow, cut: [right], tail: none }`),
    });
    const b = r.layout[0].elements.find(e => e.id === "b")!.bbox;
    expect(b.y + b.h).toBeLessThanOrEqual(70.01);
  });
  it("moves a bottom-cut flowing balloon to the row start even when the next row would not fit", async () => {
    const r = await validate({
      yaml: page(`          - { balloon: あああああああああああああ, id: a, autoPlace: flow, maxChars: 13, tail: none }
          - { balloon: うう, id: d, autoPlace: flow, tail: none }
          - { balloon: いちいち, id: c, at: [62%, 88%], tail: none }
          - { balloon: にいにい, id: b, autoPlace: flow, cut: [bottom], tail: none }`),
    });
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_OVERLAP");
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_TEXT_HIDDEN");
  });
  it("lets the flow go on from the row a bottom-cut balloon left", async () => {
    const r = await validate({
      yaml: page(`          - { balloon: あああああああああああああ, id: a, autoPlace: flow, maxChars: 13, tail: none }
          - { balloon: うう, id: d, autoPlace: flow, tail: none }
          - { balloon: いちいち, id: c, at: [62%, 88%], tail: none }
          - { balloon: にいにい, id: b, autoPlace: flow, cut: [bottom], tail: none }
          - { balloon: さんさんさんさんさん, id: e, autoPlace: flow, contain: none, tail: none }`),
    });
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_OVERLAP");
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_TEXT_HIDDEN");
  });
  it("moves a cut flowing balloon off a balloon placed by at", async () => {
    const r = await validate({ yaml: page(`          - { balloon: いちいち, id: a, at: [90%, 15%], tail: none }\n          - { balloon: にいにい, id: b, autoPlace: flow, cut: [right], tail: none }`) });
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_TEXT_HIDDEN");
    expect(r.diagnostics.map(d => d.code)).not.toContain("BALLOON_OVERLAP");
  });
  it("keeps a cut flowing balloon off the balloon it connects to by a line", async () => {
    const r = await validate({ yaml: page(`          - { balloon: いちいち, id: a, autoPlace: flow, tail: none }\n          - { balloon: にいにい, id: b, autoPlace: flow, cut: [right], connect: { to: a, style: line }, tail: none }`) });
    // the pair is reported as one element; stacked apart it is about two bodies tall
    expect(r.layout[0].elements.find(e => e.id === "a")!.bbox.h).toBeGreaterThan(25);
  });
  it("keeps the lettering size of a short horizontal box cut left and right", async () => {
    const box = async (cut: string) => {
      const r = await validate({ yaml: page(`          - { balloon: はい, id: b, writing: horizontal, shape: { kind: rect }, ${cut} tail: none }`) });
      return r.layout[0].elements.find(e => e.id === "b")!.bbox;
    };
    expect((await box("cut: [left, right],")).h).toBeGreaterThanOrEqual((await box("")).h - 0.01);
  });
  it("warns when the tail can only leave through a cut side", async () => {
    const inward = await validate({ yaml: page("          - { balloon: 角で, cut: [top, right], tail: { direction: 135deg } }") });
    expect(inward.diagnostics.map(d => d.code)).not.toContain("BALLOON_TAIL_CUT");
    const outward = await validate({ yaml: page("          - { balloon: 角で, cut: [top, right], tail: { direction: -45deg, length: 30mm } }") });
    expect(outward.diagnostics.map(d => d.code)).toContain("BALLOON_TAIL_CUT");
  });
});
