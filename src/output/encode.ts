// Image encoders (spec 10.4, 10.13).
import sharp from "sharp";
import { deflateSync } from "node:zlib";
import type { ColorMode } from "../render/raster.js";

export type OutputFormat = "png" | "jpeg" | "webp" | "avif" | "tiff" | "pdf" | "svg";

export interface EncodeOptions {
  format: OutputFormat;
  colorMode: ColorMode;
  dpi: number;
  quality?: number;
  lossless?: boolean;
  transparent?: boolean;
  metadata?: Record<string, string>;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG for 1-bit (mono) or 8-bit gray/gray+alpha from RGBA data */
export function encodeGrayPng(rgba: Uint8ClampedArray, w: number, h: number, mode: "mono" | "gray", dpi: number, alpha: boolean, meta: Record<string, string> = {}): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  let raw: Buffer;
  if (mode === "mono" && !alpha) {
    ihdr[8] = 1;
    ihdr[9] = 0;
    const rowBytes = Math.ceil(w / 8);
    raw = Buffer.alloc((rowBytes + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (rowBytes + 1);
      raw[o] = 0;
      for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4] >= 128) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  } else if (alpha) {
    ihdr[8] = 8;
    ihdr[9] = 4;
    raw = Buffer.alloc((w * 2 + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (w * 2 + 1);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        raw[o + 1 + x * 2] = rgba[i];
        raw[o + 2 + x * 2] = rgba[i + 3];
      }
    }
  } else {
    ihdr[8] = 8;
    ihdr[9] = 0;
    raw = Buffer.alloc((w + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (w + 1);
      for (let x = 0; x < w; x++) raw[o + 1 + x] = rgba[(y * w + x) * 4];
    }
  }
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ppm = Math.round(dpi / 0.0254);
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1;
  const texts = Object.entries(meta).map(([k, v]) => {
    const keyword = Buffer.from(k.slice(0, 79), "latin1");
    const val = Buffer.from(v, "utf8");
    // iTXt: keyword\0 compression(0) method(0) lang\0 translated\0 text
    return chunk("iTXt", Buffer.concat([keyword, Buffer.from([0, 0, 0, 0, 0]), val]));
  });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("pHYs", phys), ...texts, chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

export async function encode(rgba: Uint8ClampedArray, w: number, h: number, o: EncodeOptions): Promise<Buffer> {
  if (o.format === "png" && (o.colorMode === "mono" || o.colorMode === "gray")) return encodeGrayPng(rgba, w, h, o.colorMode, o.dpi, !!o.transparent, o.metadata);
  const ch = o.transparent ? 4 : 3;
  let buf: Buffer;
  if (ch === 3) {
    buf = Buffer.alloc(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      buf[j] = rgba[i];
      buf[j + 1] = rgba[i + 1];
      buf[j + 2] = rgba[i + 2];
    }
  } else buf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  let img = sharp(buf, { raw: { width: w, height: h, channels: ch as 3 | 4 }, limitInputPixels: false }).withMetadata({ density: o.dpi });
  if (o.colorMode === "gray" && o.format !== "webp") img = img.toColourspace("b-w");
  switch (o.format) {
    case "png":
      return img.png({ compressionLevel: 6 }).toBuffer();
    case "jpeg":
      if (o.colorMode === "mono") throw new Error("OUTPUT_MODE_UNSUPPORTED: jpeg cannot store 1-bit images");
      return img.jpeg({ quality: o.quality ?? 92, chromaSubsampling: "4:4:4", mozjpeg: false }).toBuffer();
    case "webp":
      return img.webp({ quality: o.quality ?? 92, lossless: !!o.lossless }).toBuffer();
    case "avif":
      return img.avif({ quality: o.quality ?? 80 }).toBuffer();
    case "pdf":
    case "svg":
      throw new Error(`${o.format} is produced by its own backend`);
    case "tiff":
      if (o.colorMode === "mono") return img.toColourspace("b-w").tiff({ compression: "ccittfax4", bitdepth: 1, xres: o.dpi / 25.4, yres: o.dpi / 25.4 }).toBuffer();
      return img.tiff({ compression: "lzw", xres: o.dpi / 25.4, yres: o.dpi / 25.4 }).toBuffer();
  }
}

export const MIME: Record<OutputFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", tiff: "image/tiff", pdf: "application/pdf", svg: "image/svg+xml" };
export const EXT: Record<OutputFormat, string> = { png: "png", jpeg: "jpg", webp: "webp", avif: "avif", tiff: "tif", pdf: "pdf", svg: "svg" };
