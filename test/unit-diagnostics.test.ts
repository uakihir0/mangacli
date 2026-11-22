import { describe, expect, it } from "vitest";
import { load } from "../src/api.js";
import { Angle, Length } from "../src/schema/schema.js";
import { ANGLE_UNITS, LENGTH_UNITS, parseAngle, toMm } from "../src/core/units.js";

const context = { units: "mm" as const, dpi: 600, k: 1 };

describe("unit diagnostics", () => {
  it.each(LENGTH_UNITS)("accepts public length unit %s", (unit) => {
    expect(Length.safeParse(`12${unit}`).success).toBe(true);
    expect(Length.safeParse(`12${unit}@print`).success).toBe(true);
  });

  it.each(ANGLE_UNITS)("accepts angle unit %s", (unit) => {
    expect(Angle.safeParse(`12${unit}`).success).toBe(true);
  });

  it.each(["12bmm", "12bQ", "12bogus", "", "mm"])("reports rejected document length %j with public units", (value) => {
    const project = load({ yaml: `mangacli: 1\npage: { bleed: ${JSON.stringify(value)} }\npages: []\n` });
    const diagnostic = project.bag.items.find((item) => item.code === "UNIT_INVALID");
    expect(diagnostic?.message).toContain(JSON.stringify(value));
    expect(diagnostic?.message).toContain(`accepted units: ${LENGTH_UNITS.join(", ")}`);
    expect(diagnostic?.message).not.toContain(", bmm");
  });

  it.each(["12degrees", ""])("reports rejected angle %j", (value) => {
    const result = Angle.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(JSON.stringify(value));
      expect(result.error.issues[0].message).toContain(`accepted units: ${ANGLE_UNITS.join(", ")}`);
    }
    expect(() => parseAngle(value)).toThrow(`invalid angle: ${JSON.stringify(value)}; accepted units: ${ANGLE_UNITS.join(", ")}`);
  });

  it("reports the accepted suffix for print-relative lpi", () => {
    const project = load({ yaml: 'mangacli: 1\npage: { background: { tone: { lpi: "60oops" } } }\npages: []\n' });
    expect(project.bag.items.some((item) => item.message.includes('invalid lpi: "60oops"; accepted units: @print'))).toBe(true);
  });

  it("retains internal units and reports context-specific runtime units", () => {
    expect(toMm("12bmm", context)).toBe(12);
    expect(toMm("12bQ", context)).toBe(3);
    const units = LENGTH_UNITS.filter((unit) => unit !== "em" && unit !== "%");
    for (const value of ["12oops", "", "2em", "50%", undefined]) {
      expect(() => toMm(value, context)).toThrow(`accepted units: ${units.join(", ")}`);
      expect(() => toMm(value, context)).toThrow(value === undefined ? "undefined" : JSON.stringify(value));
    }
    expect(() => toMm("oops", { ...context, em: 3, base: 100 })).toThrow(`accepted units: ${LENGTH_UNITS.join(", ")}`);
    expect(toMm(undefined, context, 5)).toBe(5);
  });
});
