import { linearToSrgb, srgbToLinear } from "../core/color.js";

/** Separate narrow dark (1) and light (2) ridges from continuous tones. */
export function imageInkMask(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, dpi: number, toneCurve: "linear" | "perceptual" = "linear"): Uint8Array {
  const gray = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const lin = 0.2126 * srgbToLinear(rgba[i * 4] / 255) + 0.7152 * srgbToLinear(rgba[i * 4 + 1] / 255) + 0.0722 * srgbToLinear(rgba[i * 4 + 2] / 255);
    gray[i] = 1 - a + a * (toneCurve === "perceptual" ? linearToSrgb(lin) : lin);
  }
  const midpoint = toneCurve === "perceptual" ? 0.5 : srgbToLinear(0.5);
  const radius = Math.max(2, Math.round(dpi * 0.24 / 25.4));
  const minLength = dpi * 2 / 25.4;
  const maxGap = Math.max(1, Math.round(dpi * 0.8 / 25.4));
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const candidates = new Uint8Array(width * height);
  for (let direction = 0; direction < directions.length; direction++) {
    const [dx, dy] = directions[direction];
    const inner = Math.max(1, Math.round(dpi * 0.12 / (25.4 * Math.hypot(dx, dy))));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const v = gray[i];
        const x0 = x - dx * radius, x1 = x + dx * radius;
        const y0 = y - dy * radius, y1 = y + dy * radius;
        if (x0 < 0 || x1 >= width || y0 < 0 || y0 >= height || y1 < 0 || y1 >= height) continue;
        const a = gray[y0 * width + x0], b = gray[y1 * width + x1];
        const nearA = gray[(y - dy * inner) * width + x - dx * inner];
        const nearB = gray[(y + dy * inner) * width + x + dx * inner];
        const contrast = Math.min(Math.abs(a - v), Math.abs(b - v));
        if (Math.abs(a - b) > Math.max(0.025, contrast * 0.35)) continue;
        if (v <= midpoint && Math.min(a, b, nearA, nearB) - v >= 0.12) {
          candidates[i] |= 1 << direction;
        }
        if (v > midpoint && v - Math.max(a, b, nearA, nearB) >= 0.12) {
          candidates[i] |= 1 << (direction + 4);
        }
      }
    }
  }
  const tolerance = Math.max(1, Math.round(dpi * 0.08 / 25.4));
  for (const vertical of [false, true]) {
    const major = vertical ? height : width;
    const minor = vertical ? width : height;
    for (let angle = -8; angle <= 8; angle++) {
      const slope = angle / 8;
      const normal = Math.abs(slope) <= 0.5 ? (vertical ? 0 : 1) : slope > 0 ? 3 : 2;
      const step = Math.hypot(1, slope);
      const end = Math.round((major - 1) * slope);
      for (let offset = -Math.max(0, end); offset < minor - Math.min(0, end); offset++) {
        const ray: number[] = [];
        const lower = -8 * offset - 4;
        const upper = 8 * (minor - offset) - 4;
        const first = Math.max(0, angle > 0 ? Math.ceil(lower / angle) : angle < 0 ? Math.floor(upper / angle) + 1 : 0);
        const limit = Math.min(major, angle > 0 ? Math.ceil(upper / angle) : angle < 0 ? Math.floor(lower / angle) + 1 : major);
        for (let p = first; p < limit; p++) {
          const q = offset + Math.round(p * slope);
          ray.push(vertical ? p * width + q : q * width + p);
        }
        for (const polarity of [1, 2]) {
          const bit = 1 << (normal + (polarity === 1 ? 0 : 4));
          const matches = new Int32Array(ray.length).fill(-1);
          for (let p = 0; p < ray.length; p++) {
            const i = ray[p];
            const q = vertical ? i % width : Math.floor(i / width);
            for (let d = -tolerance; d <= tolerance; d++) {
              if (q + d < 0 || q + d >= minor) continue;
              const j = i + d * (vertical ? 1 : width);
              if (candidates[j] & bit) { matches[p] = j; break; }
            }
          }
          let start = -1, last = -1, count = 0;
          let reference = 0;
          const flush = () => {
            const length = last - start + 1;
            if (start >= 0 && length * step >= minLength && count / length >= 0.85) {
              let local = gray[matches[start]];
              for (let p = start; p <= last; p++) {
                const i = matches[p] >= 0 ? matches[p] : ray[p];
                if (matches[p] >= 0) local = gray[i];
                if ((gray[i] <= midpoint) === (polarity === 1) && Math.abs(gray[i] - local) <= 0.035) mask[i] = polarity;
                const center = ray[p];
                if ((gray[center] <= midpoint) === (polarity === 1) && Math.abs(gray[center] - local) <= 0.035) mask[center] = polarity;
              }
            }
            start = last = -1;
            count = 0;
          };
          for (let p = 0; p < ray.length; p++) {
            if (matches[p] >= 0 && (start < 0 || Math.abs(gray[matches[p]] - reference) <= 0.035)) {
              if (start < 0) start = p;
              reference = gray[matches[p]];
              last = p;
              count++;
            } else {
              matches[p] = -1;
              if (start >= 0 && p - last > maxGap) flush();
            }
          }
          flush();
        }
      }
    }
  }
  return mask;
}
