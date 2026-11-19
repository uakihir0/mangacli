import { describe, expect, it, vi } from "vitest";
import { render } from "../src/api.js";
import { monoWorkingBytes } from "../src/render/mono.js";
import { RasterBackend } from "../src/render/raster.js";

const source = `mangacli: 1
page: { size: [12mm, 15mm], bleed: 0 }
book: { pageNumbers: { enabled: false } }
pages:
  - { id: background, type: blank }
`;
const options = { profile: "print-mono", dpi: 100, crop: "trim", format: "png", limits: { maxOutputBytes: monoWorkingBytes(47, 59) + 1000 }, throwOnError: false } as const;

describe("effective mono background budget", () => {
  it.each(["API", "document"])("counts a gray %s background override before rendering", async (where) => {
    const calls = vi.spyOn(RasterBackend.prototype, "render");
    try {
      const result = await render({ yaml: source + (where === "document" ? "output: { background: '#808080' }\n" : "") }, { ...options, ...(where === "API" ? { background: "#808080" } : {}) });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "OUTPUT_TOO_LARGE", message: expect.stringContaining("including node buffers") }));
      expect(result.pages).toEqual([]);
      expect(calls).not.toHaveBeenCalled();
    } finally { calls.mockRestore(); }
  });

  it.each([undefined, "white", "black"])("does not charge screening buffers for %s", async (background) => {
    const result = await render({ yaml: source }, { ...options, background });
    expect(result.failures).toEqual([]);
    expect(result.pages).toHaveLength(1);
  });
});
