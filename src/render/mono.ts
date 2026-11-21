export const MONO_BAND_PIXELS = 4_000_000;
export const DEFAULT_OUTPUT_BYTES = 384 * 1024 * 1024;

export interface MonoRaster {
  data: Uint8ClampedArray;
  packed: Uint8Array;
  width: number;
  height: number;
}

export function monoWorkingBytes(width: number, height: number): number {
  return Math.ceil(width / 8) * height * 4 + Math.min(width * height, MONO_BAND_PIXELS) * 24 + 32 * 1024 * 1024;
}

export function packBand(packed: Uint8Array, width: number, rgba: Uint8ClampedArray, height: number, y0: number) {
  const stride = Math.ceil(width / 8);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(y * width + x) * 4] >= 128) packed[(y0 + y) * stride + (x >> 3)] |= 0x80 >> (x & 7);
}
