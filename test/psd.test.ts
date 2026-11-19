import { join } from "node:path";
import { type Layer, initializeCanvas, readPsd } from "ag-psd";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";

const sample = join(import.meta.dirname, "..", "sample", "manga.yaml");
const order = ["background", "art", "fx", "frame", "balloon", "text", "sfx", "furniture"];
initializeCanvas(() => { throw new Error("Expected raw PSD pixels"); }, (width, height) => ({
  data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: "srgb",
}));
const read = (data: Uint8Array) => readPsd(Buffer.from(data), { useImageData: true, skipThumbnail: true, throwForMissingFeatures: true });

function composeMono(layers: Layer[], width: number, height: number): Buffer {
  const result = Buffer.alloc(width * height * 4);
  for (const layer of layers) {
    if (!layer.imageData) continue;
    const { data, width: w, height: h } = layer.imageData;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 4;
        if (!data[src + 3]) continue;
        const dst = ((y + layer.top!) * width + x + layer.left!) * 4;
        result[dst] = result[dst + 1] = result[dst + 2] = data[src];
        result[dst + 3] = 255;
      }
    }
  }
  return result;
}

describe("layered PSD export", () => {
  it("round-trips the sample and keeps lettering independently removable", async () => {
    const options = { profile: "print-mono", pages: "1", dpi: 127 };
    const { pages: [page] } = await render(sample, { ...options, format: "psd" });
    expect(page.mimeType).toBe("image/vnd.adobe.photoshop");
    const psd = read(page.data);
    expect(psd).toMatchObject({ width: 940, height: 1315, bitsPerChannel: 8, colorMode: 1 });
    expect(psd.imageResources?.resolutionInfo).toMatchObject({
      horizontalResolution: 127, verticalResolution: 127, horizontalResolutionUnit: "PPI", verticalResolutionUnit: "PPI",
    });
    const layers = psd.children!;
    expect(layers.map((layer) => layer.name)).toEqual(order);
    for (const layer of layers) {
      expect(layer.imageData?.data.every((value) => value === 0 || value === 255) ?? true).toBe(true);
    }
    const flattened = composeMono(layers, psd.width, psd.height);
    expect(flattened.equals(Buffer.from(psd.imageData!.data))).toBe(true);
    const noText = order.filter((name) => name !== "text");
    const hidden = composeMono(layers.filter((layer) => layer.name !== "text"), psd.width, psd.height);
    expect(hidden.equals(flattened)).toBe(false);
    const { pages: proof } = await render(sample, { ...options, format: "png", separate: noText });
    expect(proof.map((p) => p.separation)).toEqual(noText);
    const proofLayers = await Promise.all(proof.map(async (p) => ({
      top: 0, left: 0,
      imageData: { data: await sharp(p.data).ensureAlpha().raw().toBuffer(), width: p.width, height: p.height },
    })));
    expect(hidden.equals(composeMono(proofLayers, psd.width, psd.height))).toBe(true);
  });

  it.each([undefined, "all"] as const)("includes custom separations in first-appearance order with separate=%s", async (separate) => {
    const { pages: [page] } = await render({
      mangacli: 1,
      page: { size: ["20mm", "15mm"], bleed: 0 },
      pages: [{ layers: [
        { type: "fill", paint: "red", region: { rect: ["0%", "0%", "50%", "50%"] }, separation: "ink" },
        { type: "fill", paint: "blue", region: { rect: ["50%", "0%", "50%", "50%"] }, separation: "accents" },
        { type: "fill", paint: "red", region: { rect: ["0%", "50%", "50%", "50%"] }, separation: "ink" },
      ] }],
    }, { format: "psd", colorMode: "color", dpi: 127, separate });
    const psd = read(page.data);
    expect(psd.children?.map(({ name }) => name)).toEqual([...order, "ink", "accents"]);
    for (const [x, y, expected] of [[25, 18, [255, 0, 0, 255]], [75, 18, [0, 0, 255, 255]], [25, 56, [255, 0, 0, 255]]] as const) {
      const offset = (y * psd.width + x) * 4;
      expect(Array.from(psd.imageData!.data.slice(offset, offset + 4))).toEqual(expected);
    }
  });

  it.each([{ mode: "color", fileMode: 3 }, { mode: "gray", fileMode: 1 }] as const)(
    "groups custom layers in a $mode PSD from config without changing separate PNG output", async ({ mode, fileMode }) => {
      const result = await render({
        mangacli: 1,
        page: { size: ["20mm", "15mm"], bleed: "1mm" },
        pages: [{ type: "spread", panels: [] }],
      }, {
        config: { output: { format: ["png", "psd"], colorMode: mode, dpi: 50.5, crop: "marks", spread: "split", separate: { "原稿": ["background", "art", "fx", "frame"], lettering: ["balloon", "text", "sfx"] } } },
      });
      const [left, right] = result.pages.filter((p) => p.format === "psd");
      expect(left.side).not.toBe(right.side);
      expect(result.pages.map((p) => p.separation)).toEqual(["原稿", "原稿", "lettering", "lettering", undefined, undefined]);
      for (const page of [left, right]) {
        const psd = read(page.data);
        expect(psd).toMatchObject({ width: 84, height: 74, colorMode: fileMode, bitsPerChannel: 8 });
        expect(psd.children?.map(({ name }) => name)).toEqual(["原稿", "lettering"]);
        expect(psd.imageResources?.resolutionInfo?.horizontalResolution).toBe(50.5);
        expect(psd.imageData?.data.some((value) => value < 255)).toBe(true);
      }
    },
  );
});
