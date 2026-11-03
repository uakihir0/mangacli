import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validate } from "../src/api.js";

const dir = join(import.meta.dirname, "..", "docs", "examples");

describe("examples", () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    it(`${f} validates without errors`, async () => {
      const r = await validate(join(dir, f), { profile: "print-mono" });
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });
  }
  it("minimal.yaml has no warnings (M1 criterion)", async () => {
    const r = await validate(join(dir, "minimal.yaml"));
    expect(r.diagnostics.filter((d) => d.severity === "warning")).toEqual([]);
  });
});
