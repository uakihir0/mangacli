import { describe, expect, it } from "vitest";
import { validate } from "../src/api.js";

const input = (kind: string, extra = "") => ({ yaml: `mangacli: 1
pages:
  - panels:
      - layers:
          - { effect: ${kind}, center: [50%, 50%], seed: 42, ${extra} }
`, filename: "/v/effects.yaml" });

describe("effect direction validation", () => {
  it.each(["cw", "ccw"])("accepts swirl-lines direction %s", async direction => {
    expect((await validate(input("swirl-lines", `direction: ${direction}`))).diagnostics).toEqual([]);
  });
  it.each(["90deg", "both"])("rejects swirl-lines direction %s", async direction => {
    expect((await validate(input("swirl-lines", `direction: ${direction}`))).diagnostics.some(d => d.severity === "error")).toBe(true);
  });
});
