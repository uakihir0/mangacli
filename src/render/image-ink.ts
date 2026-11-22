import { linearToSrgb, srgbToLinear } from "../core/color.js";

const linearBytes = Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** Separate narrow dark (1) and light (2) ridges from continuous tones. */
export function imageInkMask(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, dpi: number, toneCurve: "linear" | "perceptual" = "linear"): Uint8Array {
  const gray = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const lin = 0.2126 * linearBytes[rgba[i * 4]] + 0.7152 * linearBytes[rgba[i * 4 + 1]] + 0.0722 * linearBytes[rgba[i * 4 + 2]];
    gray[i] = 1 - a + a * (toneCurve === "perceptual" ? linearToSrgb(lin) : lin);
  }
  const radius = Math.max(2, Math.round(dpi * 0.24 / 25.4));
  const midpoint = toneCurve === "perceptual" ? 0.5 : srgbToLinear(0.5);
  const minLength = dpi * 2 / 25.4;
  const maxGap = Math.max(1, Math.round(dpi * 0.8 / 25.4));
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const candidates = new Uint8Array(width * height);
  const strictCandidates = new Uint8Array(width * height);
  for (let direction = 0; direction < directions.length; direction++) {
    const [dx, dy] = directions[direction];
    const inner = Math.max(2, Math.ceil(dpi * 0.15 / (25.4 * Math.hypot(dx, dy))));
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
        if (v <= midpoint && Math.min(a, b, nearA, nearB) - v >= 0.12) strictCandidates[i] |= 1 << direction;
        if (v > midpoint && v - Math.max(a, b, nearA, nearB) >= 0.12) strictCandidates[i] |= 1 << (direction + 4);
        if (Math.min(a, b) - v >= 0.1 && Math.min(nearA, nearB) - v >= Math.max(0.05, contrast * 0.5)) {
          candidates[i] |= 1 << direction;
        }
        if (v - Math.max(a, b) >= 0.1 && v - Math.max(nearA, nearB) >= Math.max(0.05, contrast * 0.5)) {
          candidates[i] |= 1 << (direction + 4);
        }
      }
    }
  }
  const tolerance = Math.min(Math.max(width, height), Math.max(1, Math.round(dpi * 0.08 / 25.4)));
  const meshMask = new Uint8Array(width * height);
  const OffsetArray = tolerance <= 127 ? Uint8Array : Int32Array;
  const dark = new OffsetArray(gray.length), light = new OffsetArray(gray.length);
  const ray = new Int32Array(Math.max(width, height));
  const matches = new Int32Array(ray.length);
  for (const mesh of [false, true]) {
    const activeCandidates = mesh ? candidates : strictCandidates;
    const output = mesh ? meshMask : mask;
    for (const vertical of [false, true]) {
      const major = vertical ? height : width;
      const minor = vertical ? width : height;
      const stride = vertical ? 1 : width;
      let previousNormal = -1;
      for (let angle = -8; angle <= 8; angle++) {
        const slope = angle / 8;
        const normal = Math.abs(slope) <= 0.5 ? (vertical ? 0 : 1) : slope > 0 ? 3 : 2;
        if (normal !== previousNormal) {
          candidateOffsets(activeCandidates, dark, light, major, minor, stride, vertical ? width : 1, normal, tolerance);
          previousNormal = normal;
        }
        const normalOffset = (directions[normal][1] * width + directions[normal][0]) * radius;
        const step = Math.hypot(1, slope);
        const end = Math.round((major - 1) * slope);
        for (let offset = -Math.max(0, end); offset < minor - Math.min(0, end); offset++) {
          const lower = -8 * offset - 4;
          const upper = 8 * (minor - offset) - 4;
          const first = Math.max(0, angle > 0 ? Math.ceil(lower / angle) : angle < 0 ? Math.floor(upper / angle) + 1 : 0);
          const limit = Math.min(major, angle > 0 ? Math.ceil(upper / angle) : angle < 0 ? Math.floor(lower / angle) + 1 : major);
          const rayLength = limit - first;
          if (rayLength <= 0) continue;
          for (let p = first; p < limit; p++) {
            const q = offset + Math.round(p * slope);
            ray[p - first] = vertical ? p * width + q : q * width + p;
          }
          for (const polarity of [1, 2]) {
            const offsets = polarity === 1 ? dark : light;
            let start = -1, last = -1, count = 0;
            let reference = 0;
            const flush = () => {
              const length = last - start + 1;
              if (start >= 0 && length * step >= minLength && count / length >= (mesh ? 0.65 : 0.85)) {
                let background = 0;
                let local = gray[matches[start]];
                for (let p = start; p <= last; p++) {
                  const i = matches[p] >= 0 ? matches[p] : ray[p];
                  if (!mesh) {
                    if (matches[p] >= 0) local = gray[i];
                    const j = ray[p];
                    if ((gray[i] <= midpoint) === (polarity === 1) && Math.abs(gray[i] - local) <= 0.035) output[i] = polarity;
                    if (j !== i && (gray[j] <= midpoint) === (polarity === 1) && Math.abs(gray[j] - local) <= 0.035) output[j] = polarity;
                    continue;
                  }
                  if (matches[p] >= 0) {
                    background = (gray[i - normalOffset] + gray[i + normalOffset]) / 2;
                    output[i] = polarity;
                  }
                  const center = ray[p];
                  if ((polarity === 1 ? background - gray[center] : gray[center] - background) >= 0.1) output[center] = polarity;
                }
              }
              start = last = -1;
              count = 0;
            };
            for (let p = 0; p < rayLength; p++) {
              const i = ray[p], candidate = offsets[i];
              const match = candidate ? i + (candidate - tolerance - 1) * stride : -1;
              if (match >= 0 && (mesh || start < 0 || Math.abs(gray[match] - reference) <= 0.035)) {
                matches[p] = match;
                if (start < 0) start = p;
                reference = gray[match];
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
  }
  preserveMesh(meshMask, mask, width, height, dpi);
  const darkCore = toneCurve === "perceptual" ? linearToSrgb(0.22) : 0.22;
  const lightCore = toneCurve === "perceptual" ? linearToSrgb(0.3) : 0.3;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1 && gray[i] > darkCore) mask[i] = 0;
    if (mask[i] !== 2 || gray[i] >= lightCore) continue;
    const x = i % width, y = Math.floor(i / width);
    let core = gray[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < width && yy >= 0 && yy < height) core = Math.max(core, gray[yy * width + xx]);
    }
    if (core < lightCore) mask[i] = 0;
  }
  return mask;
}

// Angles with the same normal share these one-based offsets from the start of the tolerance window.
function candidateOffsets(candidates: Uint8Array, dark: Uint8Array | Int32Array, light: Uint8Array | Int32Array, major: number, minor: number, stride: number, advance: number, normal: number, tolerance: number): void {
  const darkBit = 1 << normal, lightBit = darkBit << 4;
  for (let p = 0; p < major; p++) {
    const base = p * advance;
    let firstDark = minor, firstLight = minor;
    for (let q = minor - 1 + tolerance; q >= 0; q--) {
      const start = q - tolerance;
      const bits = start >= 0 ? candidates[base + start * stride] : 0;
      if (bits & darkBit) firstDark = start;
      if (bits & lightBit) firstLight = start;
      if (q >= minor) continue;
      const i = base + q * stride, limit = Math.min(minor - 1, q + tolerance);
      dark[i] = firstDark <= limit ? firstDark - start + 1 : 0;
      light[i] = firstLight <= limit ? firstLight - start + 1 : 0;
    }
  }
}

function preserveMesh(mesh: Uint8Array, mask: Uint8Array, width: number, height: number, dpi: number): void {
  const arm = Math.max(5, Math.round(dpi * 0.8 / 25.4));
  const tolerance = Math.max(1, Math.round(dpi * 0.12 / 25.4));
  const separation = dpi / 25.4;
  const seen = new Uint8Array(mesh.length);
  const directions = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]);
  const junction = (x: number, y: number, polarity: number) => {
    const axes: number[] = [];
    for (let angle = 0; angle < directions.length; angle++) {
      const [dx, dy] = directions[angle];
      let complete = true;
      for (const sign of [-1, 1]) {
        let count = 0;
        for (let p = 3; p <= arm; p++) {
          for (let d = -tolerance; d <= tolerance; d++) {
            const xx = Math.round(x + sign * p * dx - d * dy);
            const yy = Math.round(y + sign * p * dy + d * dx);
            if (xx >= 0 && xx < width && yy >= 0 && yy < height && mesh[yy * width + xx] === polarity) { count++; break; }
          }
        }
        if (count < (arm - 2) * 0.85) { complete = false; break; }
      }
      if (complete) {
        if (axes.some((a) => angle - a >= 2 && angle - a <= 6)) return true;
        axes.push(angle);
      }
    }
    return false;
  };
  for (let start = 0; start < mesh.length; start++) {
    if (!mesh[start] || seen[start]) continue;
    const polarity = mesh[start];
    const component = [start];
    const crossings: number[][] = [];
    seen[start] = 1;
    for (let p = 0; p < component.length; p++) {
      const i = component[p], x = i % width, y = Math.floor(i / width);
      if (crossings.length < 3 && crossings.every(([xx, yy]) => Math.hypot(x - xx, y - yy) >= separation) && junction(x, y, polarity)) crossings.push([x, y]);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * width + xx;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && !seen[j] && mesh[j] === polarity) {
          seen[j] = 1;
          component.push(j);
        }
      }
    }
    if (crossings.length >= 3) for (const i of component) mask[i] = polarity;
  }
}
