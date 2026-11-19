/** Separate narrow dark ridges from continuous tones at the final device resolution. */
export function imageInkMask(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, dpi: number): Uint8Array {
  const gray = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    gray[i] = 1 - a + a * (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  }
  const radius = Math.max(2, Math.round(dpi * 0.24 / 25.4));
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = gray[i];
      if (v <= 0.12) { mask[i] = 1; continue; }
      if (v > 0.5) continue;
      for (const [dx, dy] of directions) {
        const x0 = x - dx * radius, x1 = x + dx * radius;
        const y0 = y - dy * radius, y1 = y + dy * radius;
        if (x0 < 0 || x1 >= width || y0 < 0 || y0 >= height || y1 < 0 || y1 >= height) continue;
        if (Math.min(gray[y0 * width + x0], gray[y1 * width + x1]) - v >= 0.12) {
          mask[i] = 1;
          break;
        }
      }
    }
  }
  return mask;
}
