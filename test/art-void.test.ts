import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, validate } from "../src/api.js";

const input = (layers: string, background = "") => ({ yaml: `mangacli: 1
page: { size: [100mm, 40mm], bleed: 0, baseFrame: trim }
pages:
  - id: page1
    number: false
    panels:
      - id: panel1
        ${background || "border: { style: none }"}
        layers: ${layers}
`, filename: join(import.meta.dirname, "..", "docs", "examples", "art-void.yaml") });
const image = (props = "") => `{ image: assets/taro/normal.png${props ? `, ${props}` : ""} }`;
const voids = (v: Awaited<ReturnType<typeof validate>>) => v.diagnostics.filter((d) => d.code === "ART_LEAVES_VOID");

describe("art coverage", () => {
  it("warns once per panel with a contain tile and identifies its source", async () => {
    const v = await validate(input(`[${image("size: [62%, 94%], fit: contain")}]`));
    expect(voids(v)).toHaveLength(1);
    expect(voids(v)[0]).toMatchObject({ severity: "warning", elementId: "panel1", pageId: "page1", path: ["pages", 0, "panels", 0] });
    expect(voids(v)[0].message).toMatch(/panel1: .*% uncovered.*fit: cover/);
  });
  it("accepts full-panel cover and the union of adjacent images", async () => {
    for (const layers of [`[${image()}]`, `[${image("size: [50%, 100%], fit: cover, at: [25%, 50%]")}, ${image("size: [50%, 100%], fit: cover, at: [75%, 50%]")}]`]) {
      expect(voids(await validate(input(layers)))).toEqual([]);
    }
  });
  it("accepts explicit backgrounds and full-panel fills", async () => {
    expect(voids(await validate(input(`[${image("fit: contain")}]`, "background: black")))).toEqual([]);
    expect(voids(await validate(input(`[${image("fit: contain")}, { type: fill, paint: 'tone(20%)', region: panel }]`)))).toEqual([]);
  });
  it("ignores empty panels, placeholders, missing and hidden images", async () => {
    for (const layers of ["[]", "[{ type: image, placeholder: draft, size: [20%, 20%] }]", "[{ image: absent.png }]", `[${image("visible: false, fit: contain")}]`]) {
      expect(voids(await validate(input(layers)))).toEqual([]);
    }
  });
  it("counts opaque effect grounds, including the beta-flash core", async () => {
    for (const effect of ["{ effect: beta-flash }", "{ effect: focus-lines, background: paper }"]) {
      expect(voids(await validate(input(`[${image("fit: contain")}, ${effect}]`)))).toEqual([]);
    }
  });
  it("does not count absent, translucent, hidden or partial effect grounds", async () => {
    for (const effect of ["{ effect: beta-flash, core: none }", "{ effect: beta-flash, opacity: 0.5 }", "{ effect: beta-flash, visible: false }", "{ effect: beta-flash, region: { rect: [0, 0, 20%, 100%] } }", "{ effect: uni-flash }", "{ effect: focus-lines, background: 'rgba(0,0,0,0.5)' }"]) {
      expect(voids(await validate(input(`[${image("fit: contain")}, ${effect}]`)))).toHaveLength(1);
    }
  });
  it("accounts for rotation and does not count overlapping images twice", async () => {
    for (const layers of [`[${image("rotate: 45deg")}]`, `[${image("size: [20%, 20%]")}, ${image("size: [20%, 20%]")}]`]) {
      expect(voids(await validate(input(layers)))).toHaveLength(1);
    }
  });
  it("makes strict validation and rendering fail", async () => {
    const doc = input(`[${image("fit: contain")}]`);
    const v = await validate(doc, { strict: true });
    expect(v.ok).toBe(false);
    expect(voids(v)[0].severity).toBe("error");
    const r = await render(doc, { strict: true, throwOnError: false, profile: "preview" });
    expect(r.diagnostics.some((d) => d.code === "ART_LEAVES_VOID" && d.severity === "error")).toBe(true);
  });
});
