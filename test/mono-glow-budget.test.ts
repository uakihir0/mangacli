import { describe, expect, it, vi } from "vitest";
import { render } from "../src/api.js";
import { RasterBackend } from "../src/render/raster.js";

const scene = (effect: string, size = "B4") => ({ yaml: `mangacli: 1
page: { size: ${size}, bleed: 0, baseFrame: trim, safeArea: { inset: 0 } }
book: { pageNumbers: { enabled: false } }
pages:
  - layers:
      - ${effect}
` });

describe("mono glow memory budget", () => {
  it.each(["trim", "{ rect: [0, 0, 257mm, 364mm] }"])("rejects a full B4 1200 dpi glow targeting %s before raster allocation", async (target) => {
    const calls = vi.spyOn(RasterBackend.prototype, "render").mockRejectedValue(new Error("unexpected raster allocation"));
    try {
      const result = await render(scene(`{ effect: glow, target: ${target}, blur: 2mm }`), { profile: "print-mono", dpi: 1200, crop: "trim", format: "png", throwOnError: false });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "OUTPUT_TOO_LARGE", message: expect.stringContaining("including node buffers") }));
      expect(result.pages).toEqual([]);
      expect(calls).not.toHaveBeenCalled();
    } finally { calls.mockRestore(); }
  });

  it("renders a small glow within the budget", async () => {
    const result = await render(scene("{ effect: glow, target: trim, blur: 1mm }", "[12mm, 15mm]"), { profile: "print-mono", dpi: 25.4, crop: "trim", format: "png" });
    expect(result.failures).toEqual([]);
    expect(result.pages).toHaveLength(1);
  });
});
