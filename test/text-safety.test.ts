import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";

const renderer = createRenderer({ profile: "preview" });
const input = (type: "page" | "spread", at: string, layers = true, bleed?: boolean) => ({
  yaml: `mangacli: 1
meta: { lang: en }
page: { size: B5, bleed: 3mm }
pages:
  - type: ${type}
    panels: []
    layers: ${layers ? `
      - { sfx: CRASH, id: sfx, fontSize: 12mm, writing: horizontal, at: [${at}], anchor: center${bleed === undefined ? "" : `, bleed: ${bleed}`} }` : "[]"}
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

  it("suppresses the safe-area warning without changing the drawing", async () => {
    const baseline = await renderer.render(input("page", "180mm, 70mm", true, false), { format: "svg" });
    const result = await renderer.render(input("page", "180mm, 70mm", true, true), { format: "svg" });
    expect(baseline.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([
      expect.objectContaining({ code: "TEXT_OUTSIDE_SAFE_AREA", severity: "warning", elementId: "sfx" }),
    ]);
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code) || d.severity === "error")).toEqual([]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].data).toEqual(baseline.pages[0].data);
  });

  it("still warns about the fold when the same sfx is allowed to bleed past trim", async () => {
    const baseline = await renderer.validate(input("spread", "185mm, 0mm"));
    const result = await renderer.validate(input("spread", "185mm, 0mm", true, true));
    expect(baseline.diagnostics.filter((d) => safetyCodes.includes(d.code)).map((d) => d.code)).toEqual(safetyCodes);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([
      expect.objectContaining({
        code: "TEXT_NEAR_FOLD", severity: "warning", elementId: "sfx",
        message: "sfx: のどをまたいでいます（左側 8.7mm、右側 14.7mm）。警告帯（のどから左右 10.0mm）を避けるには左へ 24.8mm または右へ 18.8mm 移動してください",
      }),
    ]);
  });

  it.each(["page", "spread"] as const)("does not warn for safe sfx on a %s", async (type) => {
    const result = await renderer.render(input(type, "60mm, 70mm"), { format: "svg" });
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([]);
  });

  it("does not warn for an empty page", async () => {
    const result = await renderer.render(input("page", "0, 0", false), { format: "svg" });
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([]);
  });

  it("reports right trim overflow and the full safe-line movement in mm", async () => {
    const doc = input("page", "180mm, 70mm");
    doc.yaml = doc.yaml.replace("sfx: CRASH", "sfx: CUT");
    const result = await renderer.render(doc, { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")?.message)
      .toBe("sfx: 右の断裁線を 4.6mm 越えています、安全線まで 9.6mm 内側に入れてください");
  });

  it("reports every crossed side", async () => {
    const result = await renderer.render(input("page", "0mm, 0mm"), { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")?.message)
      .toBe("sfx: 上の断裁線を 6.0mm 越えています、安全線まで 11.0mm 内側に入れてください；左の断裁線を 11.7mm 越えています、安全線まで 16.8mm 内側に入れてください");
  });

  it("distinguishes safe-line-only overflow", async () => {
    const result = await renderer.render(input("page", "170mm, 70mm"), { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")?.message)
      .toBe("sfx: 右の安全線を 4.7mm 越えています、安全線まで 4.8mm 内側に入れてください");
  });

  it("reports fold overlap and both escape directions", async () => {
    const result = await renderer.render(input("spread", "185mm, 90mm"), { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_NEAR_FOLD")?.message)
      .toBe("sfx: のどをまたいでいます（左側 8.7mm、右側 14.7mm）。警告帯（のどから左右 10.0mm）を避けるには左へ 24.8mm または右へ 18.8mm 移動してください");
  });

  it("reports distance to the fold for sfx entirely on one side", async () => {
    const result = await renderer.render(input("spread", "165mm, 90mm"), { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_NEAR_FOLD")?.message)
      .toBe("sfx: のどまで 5.3mm です。警告帯（のどから左右 10.0mm）を避けるには左へ 4.8mm または右へ 38.8mm 移動してください");
  });

  it("clears the fold band when moving by either displayed distance", async () => {
    const result = await renderer.render(input("spread", "185mm, 90mm"), { format: "svg" });
    const message = result.diagnostics.find((d) => d.code === "TEXT_NEAR_FOLD")!.message;
    const [, left, right] = message.match(/左へ ([\d.]+)mm または右へ ([\d.]+)mm/)!;
    for (const x of [185 - Number(left), 185 + Number(right)]) {
      const moved = await renderer.render(input("spread", `${x}mm, 90mm`), { format: "svg" });
      expect(moved.diagnostics.filter((d) => d.code === "TEXT_NEAR_FOLD")).toEqual([]);
    }
  });

  it("does not round an exact tenth up because of floating point noise", async () => {
    const result = await renderer.render(input("spread", "185.048mm, 90mm"), { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_NEAR_FOLD")?.message)
      .toContain("右へ 18.7mm");
  });

  it("moves fully inside the safe line by the displayed distance", async () => {
    const result = await renderer.render(input("page", "170mm, 70mm"), { format: "svg" });
    const message = result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")!.message;
    const distance = Number(message.match(/安全線まで ([\d.]+)mm/)![1]);
    expect(170 - distance + 23.496 / 2).toBeLessThanOrEqual(177);
    const moved = await renderer.render(input("page", `${170 - distance}mm, 70mm`), { format: "svg" });
    expect(moved.diagnostics.filter((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")).toEqual([]);
  });

  it("reports mm for documents using cm", async () => {
    const doc = input("page", "18, 7");
    doc.yaml = doc.yaml.replace("size: B5", "units: cm, size: B5").replace("sfx: CRASH", "sfx: CUT");
    const result = await renderer.render(doc, { format: "svg" });
    expect(result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")?.message)
      .toBe("sfx: 右の断裁線を 4.6mm 越えています、安全線まで 9.6mm 内側に入れてください");
  });

  it("does not move a nearly full-width sfx past the opposite tolerance", async () => {
    const doc = input("page", "16.748mm, 30mm");
    doc.yaml = doc.yaml.replace("size: B5", "size: [32.986mm, 60mm]");
    const result = await renderer.render(doc, { format: "svg" });
    const message = result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")!.message;
    expect(message).toContain("反対側も許容範囲に収めるため");
    const distance = Number(message.match(/ため ([\d.]+)mm/)![1]);
    expect(distance).toBeGreaterThanOrEqual(0.01);
    expect(distance).toBeLessThanOrEqual(0.5);
    doc.yaml = doc.yaml.replace("16.748mm, 30mm", `${16.748 - distance}mm, 30mm`);
    const moved = await renderer.render(doc, { format: "svg" });
    expect(moved.diagnostics.filter((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")).toEqual([]);
  });

  it("requests shrinking when no movement can fit within both tolerances", async () => {
    const doc = input("page", "16.748mm, 30mm");
    doc.yaml = doc.yaml.replace("size: B5", "size: [32mm, 60mm]");
    const result = await renderer.render(doc, { format: "svg" });
    const message = result.diagnostics.find((d) => d.code === "TEXT_OUTSIDE_SAFE_AREA")!.message;
    expect(message).toContain("移動だけでは安全領域の許容範囲に収まりません。幅を 0.5mm 以上小さくしてください");
    expect(message).not.toContain("内側に入れてください");
  });

  it("continues to skip px documents", async () => {
    const doc = input("page", "0, 0");
    doc.yaml = doc.yaml.replace("size: B5", "units: px, size: B5");
    const result = await renderer.render(doc, { format: "svg" });
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([]);
  });

  it("does not warn exactly 0.5mm past the bottom safe line on Letter", async () => {
    const doc = input("page", "60mm, 261.2mm");
    doc.yaml = doc.yaml.replace("size: B5", "size: [8.5in, 11in], safeArea: { inset: 12.7mm }")
      .replace("panels: []", "panels: [{}]");
    expect(261.2 + 6 - 12.7 - (11 * 25.4 - 2 * 12.7)).toBeGreaterThan(0.5);
    const result = await renderer.render(doc, { format: "svg", strict: true });
    expect(result.diagnostics.filter((d) => safetyCodes.includes(d.code))).toEqual([]);
  });
});
