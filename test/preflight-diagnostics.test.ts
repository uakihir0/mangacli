import { describe, expect, it, vi } from "vitest";
import { render, type RenderOptions } from "../src/api.js";
import { monoWorkingBytes } from "../src/render/mono.js";

const source = { yaml: `mangacli: 1
page: { size: [12mm, 15mm], bleed: 0 }
book: { pageNumbers: { enabled: false } }
pages:
  - { id: preflight, type: blank }
` };
const options = { profile: "print-mono", dpi: 100, crop: "trim", format: "png", throwOnError: false } as const;

describe("preflight diagnostics callbacks", () => {
  it.each<[string, RenderOptions]>([
    ["pixels", { colorMode: "gray", limits: { maxOutputPixels: 1 } }],
    ["packed bytes", { limits: { maxOutputBytes: 1 } }],
    ["node buffers", { background: "#808080", limits: { maxOutputBytes: monoWorkingBytes(47, 59) + 1000 } }],
  ])("delivers all %s rejection diagnostics exactly once", async (_, overrides) => {
    const onDiagnostic = vi.fn();
    const result = await render(source, { ...options, ...overrides, onDiagnostic });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "OUTPUT_TOO_LARGE" }));
    expect(onDiagnostic.mock.calls.map(([diagnostic]) => diagnostic)).toEqual(result.diagnostics);
    expect(result.pages).toEqual([]);
  });

  it("does not duplicate diagnostics on normal completion", async () => {
    const onDiagnostic = vi.fn();
    const result = await render(source, { ...options, onDiagnostic });
    expect(result.failures).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(onDiagnostic.mock.calls.map(([diagnostic]) => diagnostic)).toEqual(result.diagnostics);
  });

  it("does not call back when there are no diagnostics", async () => {
    const onDiagnostic = vi.fn();
    const clean = { yaml: source.yaml.replace("bleed: 0", "bleed: 0, baseFrame: trim, safeArea: { inset: 0 }") };
    const result = await render(clean, { ...options, onDiagnostic });
    expect(result.diagnostics).toEqual([]);
    expect(onDiagnostic).not.toHaveBeenCalled();
  });
});
