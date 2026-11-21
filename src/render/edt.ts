// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), for silhouette outlines.
const INF = 1e20;

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** squared distance to nearest "inside" pixel (mask true) */
export function distanceSquared(mask: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

/** Grayscale closing with a square kernel, matching SVG feMorphology. */
export function closeAlpha(alpha: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.min(Math.max(w, h), Math.max(0, Math.round(radius)));
  if (!r || !alpha.length) return alpha.slice();
  const pass = (src: Uint8Array, horizontal: boolean, dilate: boolean): Uint8Array => {
    const dst = new Uint8Array(src.length);
    const length = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const queue = new Int32Array(length + 2 * r);
    const values = new Uint8Array(length + 2 * r);
    for (let line = 0; line < lines; line++) {
      let head = 0;
      let tail = 0;
      for (let p = -r; p < length + r; p++) {
        const value = p < 0 || p >= length ? 0 : src[horizontal ? line * w + p : p * w + line];
        while (head < tail && queue[head] < p - 2 * r) head++;
        while (head < tail && (dilate ? values[tail - 1] <= value : values[tail - 1] >= value)) tail--;
        queue[tail] = p;
        values[tail++] = value;
        if (p >= r) dst[horizontal ? line * w + p - r : (p - r) * w + line] = values[head];
      }
    }
    return dst;
  };
  return pass(pass(pass(pass(alpha, true, true), false, true), true, false), false, false);
}
