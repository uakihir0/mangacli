import { describe, expect, it } from "vitest";
import { Rng, deriveSeed } from "../src/core/random.js";
import { parseAngle, parseLength, toMm } from "../src/core/units.js";
import { parseColor } from "../src/core/color.js";

const B5 = { units: "mm" as const, dpi: 600, k: 1 };

describe("units", () => {
  it("parses lengths in every unit", () => {
    expect(toMm("10mm", B5)).toBeCloseTo(10);
    expect(toMm("1cm", B5)).toBeCloseTo(10);
    expect(toMm("1in", B5)).toBeCloseTo(25.4);
    expect(toMm("72pt", B5)).toBeCloseTo(25.4);
    expect(toMm("4Q", B5)).toBeCloseTo(1);
    expect(toMm("50%", { ...B5, base: 80 })).toBeCloseTo(40);
    expect(toMm("2em", { ...B5, em: 3 })).toBeCloseTo(6);
  });
  it("scales B5-relative units and floors bQ", () => {
    const small = { ...B5, k: 0.5 };
    expect(toMm("10bmm", small)).toBeCloseTo(5);
    // 13bQ at half scale would be 6.5Q, below the 8Q floor
    expect(toMm("13bQ", small)).toBeCloseTo(2);
  });
  it("rejects malformed lengths", () => {
    expect(parseLength("10 mm px")).toBeNull();
    expect(parseLength("abc")).toBeNull();
  });
  it("parses angles", () => {
    expect(parseAngle("180deg")).toBeCloseTo(Math.PI);
    expect(parseAngle("0.5turn")).toBeCloseTo(Math.PI);
  });
});

describe("color", () => {
  it("parses css colors and ink/paper", () => {
    expect(parseColor("#ff0000")).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(parseColor("ink")).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(parseColor("paper")).toMatchObject({ r: 1, g: 1, b: 1 });
    expect(parseColor("rebeccapurple")!.r).toBeCloseTo(0.4);
  });
});

describe("random", () => {
  it("is deterministic per seed and stream", () => {
    const a = new Rng(deriveSeed(1, "p1-k1-balloon1", "shape"));
    const b = new Rng(deriveSeed(1, "p1-k1-balloon1", "shape"));
    const c = new Rng(deriveSeed(1, "p1-k1-balloon2", "shape"));
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});
