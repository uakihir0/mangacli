import { deflateSync } from "node:zlib";
import type { ColorMode, RasterResult } from "../render/raster.js";

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const bytes = (s: string) => Buffer.from(s, "ascii");
const pad = (length: number, multiple: number) => Buffer.alloc((multiple - length % multiple) % multiple);

function section(buffers: Buffer[], alignment = 1): Buffer[] {
  const size = buffers.reduce((n, b) => n + b.length, 0);
  const padding = pad(size, alignment);
  return [u32(size + padding.length), ...buffers, padding];
}

function layerName(name: string): Buffer[] {
  const fallback = bytes(name.replace(/[^\x20-\x7e]/g, "?").slice(0, 255));
  const unicode = Buffer.from(name, "utf16le").swap16();
  return [
    Buffer.from([fallback.length]), fallback, pad(fallback.length + 1, 4),
    bytes("8BIMluni"), u32(unicode.length + 4), u32(name.length), unicode,
  ];
}

/** PSD v1, 8-bit grayscale or RGB: ZIP layer channels and a planar merged preview. */
export class PsdWriter {
  private readonly colorChannels: number;
  private readonly merged: Buffer;
  private readonly layers: { record: Buffer[]; pixels: Buffer[] }[] = [];

  constructor(private width: number, private height: number, private mode: ColorMode, private dpi: number) {
    if (width < 1 || height < 1 || width > 30_000 || height > 30_000) {
      throw new Error(`OUTPUT_TOO_LARGE: ${width}x${height} exceeds PSD dimensions (1–30000 px per axis)`);
    }
    this.colorChannels = mode === "color" ? 3 : 1;
    this.merged = Buffer.alloc(width * height * (this.colorChannels + 1));
  }

  addLayer(name: string, raster: Pick<RasterResult, "data" | "width" | "height">): void {
    const { width, height, colorChannels, merged } = this;
    const size = width * height;
    const { data } = raster;
    let left = width, right = 0, top = height, bottom = 0;
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p++) {
        const src = p * 4;
        const alpha = data[src + 3];
        if (!alpha) continue;
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = y + 1;
        const alphaOffset = size * colorChannels + p;
        const dstWeight = merged[alphaOffset] * (255 - alpha);
        const srcWeight = alpha * 255;
        const total = srcWeight + dstWeight;
        for (let c = 0; c < colorChannels; c++) {
          const i = c * size + p;
          merged[i] = Math.round((data[src + c] * srcWeight + merged[i] * dstWeight) / total);
        }
        merged[alphaOffset] = Math.round(total / 255);
      }
    }
    if (!bottom) left = top = 0;
    const channelIds = colorChannels === 3 ? [0, 1, 2, -1] : [0, -1];
    const plane = Buffer.alloc((right - left) * (bottom - top));
    const pixels: Buffer[] = [];
    const channels = channelIds.flatMap((id) => {
      const offset = id < 0 ? 3 : id;
      for (let y = top, i = 0; y < bottom; y++) {
        for (let x = left; x < right; x++) plane[i++] = data[(y * width + x) * 4 + offset];
      }
      const compressed = plane.length ? deflateSync(plane) : Buffer.alloc(0);
      pixels.push(u16(plane.length ? 2 : 0), compressed);
      return [u16(id & 0xffff), u32(compressed.length + 2)];
    });
    const extra = section([u32(0), u32(0), ...layerName(name)]);
    this.layers.push({
      record: [u32(top), u32(left), u32(bottom), u32(right), u16(channelIds.length), ...channels,
        bytes("8BIMnorm"), Buffer.from([255, 0, 8, 0]), ...extra],
      pixels,
    });
  }

  build(): Buffer {
    const { width, height, colorChannels, merged, layers } = this;
    const size = width * height;
    const alpha = merged.subarray(size * colorChannels);
    const hasAlpha = alpha.some((a) => a !== 255);
    if (layers.length > 0x7fff) throw new Error("OUTPUT_TOO_LARGE: PSD supports at most 32767 layers");
    if (hasAlpha && this.mode !== "mono") {
      // The merged preview with a negative layer count stores color matted against white.
      for (let c = 0; c < colorChannels; c++) {
        for (let p = 0; p < size; p++) {
          const i = c * size + p;
          merged[i] = 255 - Math.round((255 - merged[i]) * alpha[p] / 255);
        }
      }
    }
    const header = [bytes("8BPS"), u16(1), Buffer.alloc(6), u16(colorChannels + Number(hasAlpha)),
      u32(height), u32(width), u16(8), u16(colorChannels === 1 ? 1 : 3)];
    const resolution = [u32(Math.round(this.dpi * 65536)), u16(1), u16(1)];
    const resources = section([bytes("8BIM"), u16(1005), u16(0), ...section([...resolution, ...resolution], 2)]);
    const count = hasAlpha ? -layers.length : layers.length;
    const layerInfo = section([u16(count & 0xffff), ...layers.flatMap((l) => l.record), ...layers.flatMap((l) => l.pixels)], 2);
    return Buffer.concat([...header, u32(0), ...resources, ...section([...layerInfo, u32(0)]), u16(0),
      hasAlpha ? merged : merged.subarray(0, size * colorChannels)]);
  }
}
