/** Separate narrow dark (1) and light (2) ridges from continuous tones. */
export function imageInkMask(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, dpi: number): Uint8Array {
  const gray = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    gray[i] = 1 - a + a * (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  }
  const radius = Math.max(2, Math.round(dpi * 0.24 / 25.4));
  const minLength = dpi * 1.5 / 25.4;
  const maxGap = Math.max(1, Math.round(dpi * 0.16 / 25.4));
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of directions) {
    const candidates = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const v = gray[i];
        const x0 = x - dx * radius, x1 = x + dx * radius;
        const y0 = y - dy * radius, y1 = y + dy * radius;
        if (x0 < 0 || x1 >= width || y0 < 0 || y0 >= height || y1 < 0 || y1 >= height) continue;
        const a = gray[y0 * width + x0], b = gray[y1 * width + x1];
        if (v <= 0.5 && Math.min(a, b) - v >= 0.12) {
          candidates[i] = 1;
        }
        if (v > 0.5 && v - Math.max(a, b) >= 0.12) {
          candidates[i] = 2;
        }
      }
    }
    const tx = -dy, ty = dx;
    const inside = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height;
    const step = Math.hypot(tx, ty);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (inside(x - tx, y - ty)) continue;
        const ray: number[] = [];
        for (let xx = x, yy = y; inside(xx, yy); xx += tx, yy += ty) ray.push(yy * width + xx);
        for (const polarity of [1, 2]) {
          let start = -1, last = -1, count = 0;
          const flush = () => {
            const length = last - start + 1;
            if (start >= 0 && length * step >= minLength && count / length >= 0.85) {
              for (let p = start; p <= last; p++) {
                const i = ray[p];
                if ((gray[i] <= 0.5) === (polarity === 1)) mask[i] = polarity;
              }
            }
            start = last = -1;
            count = 0;
          };
          for (let p = 0; p < ray.length; p++) {
            if (candidates[ray[p]] === polarity) {
              if (start < 0) start = p;
              last = p;
              count++;
            } else if (start >= 0 && p - last > maxGap) flush();
          }
          flush();
        }
      }
    }
  }
  return mask;
}
