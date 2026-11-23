import { expect, it } from "vitest";
import { automaticTailWidth } from "../src/elements/balloon.js";

it.each([
  [8, 0.9],
  [12, 12 * 0.087],
  [16, 1.3],
  [40, 1.3],
] as const)("clamps automatic wedge width at short side %imm", (minSide, expected) => {
  expect(automaticTailWidth(minSide, 1, "wedge")).toBeCloseTo(expected, 8);
});

it("keeps zigzag width outside the wedge thinning", () => {
  expect(automaticTailWidth(16, 1, "zigzag")).toBeCloseTo(16 * 0.087 * 1.5, 8);
});
