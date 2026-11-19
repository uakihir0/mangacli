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
  it.each([
    join(dir, "minimal.yaml"),
    join(dir, "b5-mono.yaml"),
    join(dir, "..", "..", "sample", "manga.yaml"),
    join(dir, "..", "..", "sample", "shonen-proof.yaml"),
  ])("has no low-resolution rooftop art in print: %s", async (file) => {
    const r = await validate(file, { profile: "print-mono" });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => d.code === "ASSET_LOW_RESOLUTION")).toEqual([]);
  });
  it("lays out the whole rooftop story without placement warnings", async () => {
    const r = await validate(join(dir, "..", "..", "sample", "manga.yaml"), { profile: "preview" });
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(r.layout.map((page) => page.panels.length)).toEqual([3, 4, 4, 4]);
    for (const page of r.layout) {
      expect(page.panels.some((panel) => panel.polygon.some(({ x, y }) =>
        x < page.geom.trim.x || y < page.geom.trim.y ||
        x > page.geom.trim.x + page.geom.trim.w || y > page.geom.trim.y + page.geom.trim.h,
      ))).toBe(true);
    }
  });
});
