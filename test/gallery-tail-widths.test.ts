import { expect, it, vi } from "vitest";
import { createRenderer } from "../src/api.js";
import * as balloon from "../src/elements/balloon.js";
import * as shape from "../src/ink/shape.js";

it("makes every gallery preset's automatic base width two thirds of the old calculation (±2%)", async () => {
  const ink = vi.spyOn(shape, "inkShape");
  const original = balloon.renderBalloon;
  const measured: { id: string; preset: string; old: number; width: number }[] = [];
  const pointWidths: (number | undefined)[] = [];
  const render = vi.spyOn(balloon, "renderBalloon").mockImplementation((plan, ctx) => {
    const start = ink.mock.calls.length;
    const result = original(plan, ctx);
    for (const [contour, options] of ink.mock.calls.slice(start)) {
      if (!contour.corners?.some(c => c.kind === "point")) continue;
      pointWidths.push(options.pointWidth);
      const tail = plan.props.tail as { kind?: string; widthScale?: number };
      const kind = tail.kind ?? "wedge";
      const preset = String(plan.props.as ?? "say");
      const whisper = preset === "whisper" && kind === "wedge";
      const spiky = plan.params.kind === "spike" || plan.params.kind === "burst";
      const length = (kind === "zigzag" ? 11 : whisper || spiky ? 6 : 4.5) * ctx.u.k;
      const minSide = Math.min(plan.outer.w, plan.outer.h);
      const scale = tail.widthScale ?? 1;
      const oldBase = Math.min(2.8 * ctx.u.k, Math.max(1.6 * ctx.u.k, minSide * 0.13));
      const old = (kind === "zigzag" ? oldBase * 1.5 : whisper ? minSide / 6 : Math.max(oldBase, Math.min(minSide / 6, length * 0.6))) * scale;
      const width = balloon.automaticTailWidth(minSide, length, ctx.u.k, kind, false, whisper) * scale;
      measured.push({ id: plan.el.id, preset, old, width });
    }
    return result;
  });
  try {
    await createRenderer({ profile: "preview" }).displayList("docs/examples/gallery-balloons.yaml", 1);
    expect(measured).toHaveLength(11);
    expect([...new Set(measured.map(row => row.preset))].sort()).toEqual(["electronic", "gruff", "inverted", "say", "scream", "shout", "tremble", "whisper"]);
    expect(pointWidths.every(width => width === 0)).toBe(true);
    for (const row of measured) {
      expect(row.width / row.old, row.id).toBeGreaterThanOrEqual((2 / 3) * 0.98);
      expect(row.width / row.old, row.id).toBeLessThanOrEqual((2 / 3) * 1.02);
    }
    console.log("Gallery automatic base widths (mm):", JSON.stringify(measured));
  } finally {
    render.mockRestore();
    ink.mockRestore();
  }
});

it.each([8, 16, 40])("shrinks automatic offscreen widths at short side %i mm", minSide => {
  const old = Math.min(2.8, Math.max(1.6, minSide * 0.13));
  expect(balloon.automaticTailWidth(minSide, 6, 1, "wedge", true) / old).toBeCloseTo(2 / 3, 2);
});
