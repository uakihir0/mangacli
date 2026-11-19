import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRenderer, validate } from "../src/api.js";

const dir = join(import.meta.dirname, "..", "docs", "examples");
const sampleDir = join(import.meta.dirname, "..", "sample");
const renderer = createRenderer({ profile: "print-mono", dpi: 36, ignoreDocumentOutput: true });

describe("examples", () => {
  for (const folder of [dir, sampleDir]) for (const f of readdirSync(folder).filter((x) => x.endsWith(".yaml"))) {
    it(`${folder === dir ? "docs" : "sample"}/${f} validates and renders without errors`, async () => {
      const r = await renderer.validate(join(folder, f));
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const rendered = await renderer.render(join(folder, f));
      expect(rendered.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(rendered.failures).toEqual([]);
      expect(rendered.pages.length).toBeGreaterThan(0);
    });
  }
  it("minimal.yaml has no warnings (M1 criterion)", async () => {
    const r = await validate(join(dir, "minimal.yaml"));
    expect(r.diagnostics.filter((d) => d.severity === "warning")).toEqual([]);
  });
});
