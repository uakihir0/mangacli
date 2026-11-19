import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { validate } from "../src/api.js";

describe("image resolution guidance", () => {
  it.each([
    ["art", 300, "general", "600×300"],
    ["lineart", 540, "line art", "1080×540"],
  ])("reports actionable %s requirements", async (kind, required, threshold, minimum) => {
    const data = await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const result = await validate({ yaml: `mangacli: 1
assets:
  art: { src: art.png, kind: ${kind} }
pages:
  - layers:
      - { image: art, size: [50.8mm, 25.4mm], fit: fill }
` }, { profile: "print-mono", assets: { art: data } });
    expect(result.ok).toBe(true);
    const warning = result.diagnostics.find((d) => d.code === "ASSET_LOW_RESOLUTION");
    expect(warning?.message).toBe(`art: effective 100 ppi < required ${required} ppi (${threshold} threshold); asset 200×100 px; use at least ${minimum} px at this display size (same framing/aspect ratio)`);
    expect(warning?.message).not.toContain("\n");
  });

  it("does not warn for placeholders or sufficiently detailed images", async () => {
    const data = await sharp({ create: { width: 600, height: 600, channels: 3, background: "white" } }).png().toBuffer();
    const result = await validate({ yaml: `mangacli: 1
assets:
  art: { src: art.png }
pages:
  - layers:
      - { image: art, size: [25.4mm, 25.4mm] }
      - { type: image, placeholder: draft }
` }, { profile: "print-mono", assets: { art: data } });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.code === "ASSET_LOW_RESOLUTION")).toEqual([]);
  });
});
