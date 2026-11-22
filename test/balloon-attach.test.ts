import { describe, expect, it } from "vitest";
import { attachedBalloonCenter } from "../src/layout/balloon-attach.js";
import { render, validate } from "../src/api.js";

const frame = { x: 10, y: 20, w: 100, h: 80 };
const outer = { x: -10, y: -5, w: 20, h: 10 };
describe("balloon attachment", () => {
  it.each([
    ["top-right", 99, 26], ["top-left", 21, 26],
    ["bottom-right", 99, 94], ["bottom-left", 21, 94],
    ["top", 55, 26], ["right", 99, 65],
    ["bottom", 55, 94], ["left", 21, 65],
  ] as const)("places %s inside the frame, including the box stroke", (side, x, y) => {
    expect(attachedBalloonCenter(side, false, frame, outer, 2, { x: 55, y: 65 })).toEqual({ x, y });
  });
  it("defaults to top-right without at, and to the nearest corner with at", () => {
    expect(attachedBalloonCenter(undefined, true, frame, outer, 2)).toEqual({ x: 99, y: 26 });
    expect(attachedBalloonCenter(undefined, true, frame, outer, 2, { x: 15, y: 90 })).toEqual({ x: 21, y: 94 });
  });
  it("leaves opt-out and ordinary balloons alone", () => {
    expect(attachedBalloonCenter("none", true, frame, outer, 2)).toBeUndefined();
    expect(attachedBalloonCenter(undefined, false, frame, outer, 2)).toBeUndefined();
  });
  it("clamps edge coordinates to keep the box within the frame", () => {
    expect(attachedBalloonCenter("top", true, frame, outer, 2, { x: -500, y: 70 })).toEqual({ x: 21, y: 26 });
  });
  it("rejects invalid attachment values", async () => {
    const result = await validate({ mangacli: 1, pages: [{ panels: [{ layers: [{ balloon: "", attach: "middle" }] }] }] });
    expect(result.diagnostics.some(d => d.severity === "error")).toBe(true);
  });
  it("uses free corners for implicit captions, then falls back without moving explicit attachments", async () => {
    const result = await render({ yaml: `mangacli: 1
page: { size: [100mm, 80mm], baseFrame: trim, bleed: 0 }
pages:
  - panels:
      - layers:
${Array.from({ length: 6 }, (_, i) => `          - { balloon: '', id: c${i}, as: narration, ${i === 5 ? "attach: top-right," : ""} size: [20mm, 12mm], hand: clean, halo: none }`).join("\n")}
` }, { layoutOnly: true });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const boxes = Array.from({ length: 6 }, (_, i) => result.layout[0].elements.find(e => e.id === `c${i}`)!.bbox);
    expect(boxes[0].x).toBeGreaterThan(boxes[1].x);
    expect(boxes[2].x).toBeGreaterThan(boxes[3].x);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
    expect(boxes[3].y).toBeGreaterThan(boxes[1].y);
    expect(boxes[5]).toEqual(boxes[0]);
    for (let i = 0; i < 5; i++) for (let j = 0; j < i; j++) {
      const a = boxes[i], b = boxes[j];
      expect(Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))).toBe(0);
    }
  });
  it("preserves earlier flow item height when a later item jumps past an attachment", async () => {
    const result = await render({ yaml: `mangacli: 1
page: { size: [100mm, 100mm], baseFrame: trim, bleed: 0 }
pages:
  - panels:
      - layers:
          - { balloon: '', id: caption, as: narration, attach: top, at: [50%, 0%], size: [20mm, 12mm], hand: clean, halo: none }
          - { balloon: '', id: first, autoPlace: flow, size: [30mm, 60mm], hand: clean, tail: none, halo: none }
          - { balloon: '', id: second, autoPlace: flow, size: [30mm, 10mm], hand: clean, tail: none, halo: none }
          - { balloon: '', id: third, autoPlace: flow, size: [45mm, 10mm], hand: clean, tail: none, halo: none }
` }, { layoutOnly: true });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const box = (id: string) => result.layout[0].elements.find(e => e.id === id)!.bbox;
    expect(box("second").y).toBeGreaterThan(box("first").y);
    expect(box("third").y).toBeGreaterThanOrEqual(box("first").y + box("first").h);
    expect(box("third").y).toBeGreaterThanOrEqual(box("second").y + box("second").h);
  });
  it.each(["auto", "flow"])("snaps panel narration before %s speech placement", async mode => {
    const result = await render({ yaml: `mangacli: 1
page: { size: [100mm, 80mm], baseFrame: trim, bleed: 0 }
pages:
  - panels:
      - border: { width: 2mm }
        layers:
          - { balloon: '', id: caption, as: narration, size: [20mm, 12mm], stroke: { width: 1mm }, hand: clean, halo: none }
          - { balloon: '', id: speech, autoPlace: ${mode}, size: [20mm, 12mm], hand: clean, tail: none, halo: none }
` }, { layoutOnly: true });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const caption = result.layout[0].elements.find(e => e.id === "caption")!.bbox;
    const speech = result.layout[0].elements.find(e => e.id === "speech")!.bbox;
    expect(caption.x + caption.w + 0.5).toBeCloseTo(99, 1);
    expect(caption.y - 0.5).toBeCloseTo(1, 1);
    const overlap = Math.max(0, Math.min(caption.x + caption.w, speech.x + speech.w) - Math.max(caption.x, speech.x)) * Math.max(0, Math.min(caption.y + caption.h, speech.y + speech.h) - Math.max(caption.y, speech.y));
    expect(overlap).toBe(0);
  });
});
