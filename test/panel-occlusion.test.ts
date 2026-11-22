import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";

const renderer = createRenderer({ profile: "preview" });
const input = (element: string, owner = "base", inset = "", page = false) => ({ yaml: `mangacli: 1
meta: { lang: en }
page: { size: B5, baseFrame: trim }
pages:
  - id: p1
    panels:
      - id: base
        layers: ${owner === "base" && !page ? `[${element}]` : "[]"}
      - id: inset
        overlay: true
        box: [40mm, 40mm, 70mm, 70mm]
        ${inset || "z: 1"}
        layers: ${owner === "inset" ? `[${element}]` : "[]"}
    layers: ${page ? `[${element}]` : "[]"}
` });
const sfx = "{ sfx: BOOM, id: sound, at: [60mm, 60mm], coords: page, fontSize: 10mm, writing: horizontal, clip: panel }";
const warnings = async (doc: ReturnType<typeof input>) => {
  const result = await renderer.render(doc, { format: "svg" });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.diagnostics.filter((d) => d.code === "TEXT_OCCLUDED_BY_PANEL");
};

describe("panel occlusion", () => {
  it("checks lettering in nested transformed groups", async () => {
    const group = `{ type: group, id: outer, size: [100mm, 100mm], at: [50mm, 50mm], anchor: top-left, clip: panel, children: [{ type: group, children: [${sfx.replace("60mm, 60mm", "10mm, 10mm")}] }] }`;
    expect(await warnings(input(group))).toEqual([expect.objectContaining({ elementId: "sound" })]);
    expect(await warnings(input(group.replace("50mm, 50mm", "120mm, 120mm")))).toEqual([]);
    expect(await warnings(input(group, "inset"))).toEqual([]);
  });
  it.each(["sfx", "text", "balloon"])("warns for %s beneath an inset", async (type) => {
    expect(await warnings(input(sfx.replace("sfx:", `${type}:`)))).toEqual([
      expect.objectContaining({ severity: "warning", elementId: "sound", pageId: "p1", path: ["pages", 0, "panels", 0, "layers", 0], message: "sound is covered by panel inset" }),
    ]);
  });
  it("does not warn for the inset's own lettering", async () => {
    expect(await warnings(input(sfx, "inset"))).toEqual([]);
  });
  it("does not warn for lettering in the free layer above panels", async () => {
    expect(await warnings(input(sfx.replace("clip: panel", "clip: none")))).toEqual([]);
  });
  it("respects panel z order", async () => {
    expect(await warnings(input(sfx, "base", "z: -1"))).toEqual([]);
  });
  it("ignores hidden insets and nonintersecting lettering", async () => {
    expect(await warnings(input(sfx, "base", "visible: false"))).toEqual([]);
    expect(await warnings(input(sfx.replace("60mm, 60mm", "130mm, 150mm")))).toEqual([]);
  });
  it("warns for partial coverage", async () => {
    expect(await warnings(input(sfx.replace("60mm, 60mm", "40mm, 60mm")))).toHaveLength(1);
  });
  it("checks page lettering below panels but not above them", async () => {
    expect(await warnings(input(sfx.replace("clip: panel", "stack: under"), "base", "", true))).not.toHaveLength(0);
    expect(await warnings(input(sfx, "base", "", true))).toEqual([]);
  });
  it("handles empty pages", async () => {
    expect(await warnings({ yaml: "mangacli: 1\npages: [{ panels: [] }]" })).toEqual([]);
  });
});
