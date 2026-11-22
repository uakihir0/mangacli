import { describe, expect, it } from "vitest";
import { validate } from "../src/api.js";

async function check(a: number[], b: number[], direction = "rtl", extra = "") {
  const result = await validate({ yaml: `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm }
book: { readingDirection: ${direction} }
pages:
  - id: p1
    panels:
      - id: pn1
        layers:
          - { balloon: "", id: first, at: [${a[0]}mm, ${a[1]}mm], size: [20mm, 20mm], hand: clean, tail: none }
          - { balloon: "", id: second, at: [${b[0]}mm, ${b[1]}mm], size: [20mm, 20mm], hand: clean, tail: none ${extra} }
` });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.diagnostics.filter((d) => ["BALLOON_OVERLAP", "BALLOON_READING_ORDER"].includes(d.code));
}

describe("final balloon readability diagnostics", () => {
  it("warns about overlapping bodies with both ids and panel context", async () => {
    const diagnostics = await check([40, 30], [30, 40]);
    expect(diagnostics.map((d) => d.code)).toEqual(["BALLOON_OVERLAP"]);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", pageId: "p1", elementId: "second" });
    expect(diagnostics[0].message).toContain("first (panel pn1) and second (panel pn1)");
  });
  it("warns when the later overlapping balloon is upper-right", async () => {
    expect((await check([30, 40], [40, 30])).map((d) => d.code)).toEqual(["BALLOON_OVERLAP", "BALLOON_READING_ORDER"]);
  });
  it("accepts separated balloons in reading order", async () => {
    expect(await check([60, 20], [20, 60])).toEqual([]);
  });
  it("ignores tiny overlaps", async () => {
    expect(await check([40, 30], [20.5, 40])).toEqual([]);
  });
  it("warns about a clearly earlier separated position", async () => {
    expect((await check([20, 60], [60, 20])).map((d) => d.code)).toEqual(["BALLOON_READING_ORDER"]);
  });
  it("flips the horizontal reading direction for ltr", async () => {
    expect((await check([40, 40], [30, 30], "ltr")).map((d) => d.code)).toEqual(["BALLOON_OVERLAP", "BALLOON_READING_ORDER"]);
    expect((await check([30, 30], [40, 40], "ltr")).map((d) => d.code)).toEqual(["BALLOON_OVERLAP"]);
  });
  it("excludes both ends of intentional connections", async () => {
    expect(await check([30, 40], [40, 30], "rtl", ", connect: { to: first, style: overlap }")).toEqual([]);
  });
  it("handles an empty page", async () => {
    const result = await validate({ yaml: "mangacli: 1\npages: [{ type: blank }]" });
    expect(result.diagnostics.filter((d) => d.code.startsWith("BALLOON_"))).toEqual([]);
  });
});
