import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";

const renderer = createRenderer({ profile: "preview" });
const input = (type: "page" | "spread", at: string, layers = true) => ({
  yaml: `mangacli: 1
page: { size: B5, bleed: 3mm }
pages:
  - type: ${type}
    panels: []
    layers: ${layers ? `
      - { sfx: CRASH, id: sfx, fontSize: 12mm, writing: horizontal, at: [${at}], anchor: center }` : "[]"}
`,
  filename: "/v/text-safety.yaml",
});
const safetyCodes = ["TEXT_OUTSIDE_SAFE_AREA", "TEXT_NEAR_FOLD"];

describe("sfx text safety", () => {
  it("warns without preventing rendering when sfx crosses the trim", async () => {
    const result = await renderer.render(input("page", "180mm, 70mm"), { format: "svg" });
    expect(result.pages).toHaveLength(1);
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([
      expect.objectContaining({ code: "TEXT_OUTSIDE_SAFE_AREA", severity: "warning", elementId: "sfx" }),
    ]);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("warns without preventing split rendering when sfx crosses the fold", async () => {
    const result = await renderer.render(input("spread", "185mm, 90mm"), { format: "png", spread: "split", dpi: 72 });
    expect(result.pages).toHaveLength(2);
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([
      expect.objectContaining({ code: "TEXT_NEAR_FOLD", severity: "warning", elementId: "sfx" }),
    ]);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it.each(["page", "spread"] as const)("does not warn for safe sfx on a %s", async (type) => {
    const result = await renderer.render(input(type, "60mm, 70mm"), { format: "svg" });
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([]);
  });

  it("does not warn for an empty page", async () => {
    const result = await renderer.render(input("page", "0, 0", false), { format: "svg" });
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([]);
  });
});
