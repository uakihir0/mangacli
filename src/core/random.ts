// Deterministic PRNG, hashing and noise (spec 9.2). No Math.random, no time.

export function splitmix32(state: number): [number, number] {
  state = (state + 0x9e3779b9) >>> 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return [z, state];
}

export function fnv1a32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function deriveSeed(baseSeed: number, elementId: string, stream: string): number {
  return fmix32(fnv1a32(`${baseSeed >>> 0}:${elementId.normalize("NFC")}:${stream}`));
}

export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0;
  return fmix32(h);
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let st = seed >>> 0;
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [z, s] = splitmix32(st);
      st = s;
      out.push(z);
    }
    [this.s0, this.s1, this.s2, this.s3] = out;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** xoshiro128** next 32-bit value */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** uniform [0,1) */
  next(): number {
    return (this.nextU32() >>> 8) / 16777216;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  /** approx standard normal via Irwin-Hall (4 samples) */
  normal(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * Math.sqrt(3);
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length) % list.length];
  }

  /** sample from a range spec [min,max] with distribution */
  sample(min: number, max: number, dist: Dist = "uniform"): number {
    let u = this.next();
    if (dist === "low") u = u * u;
    else if (dist === "high") u = 1 - (1 - u) * (1 - u);
    else if (dist === "normal") {
      const n = this.normal();
      u = Math.min(1, Math.max(0, 0.5 + n / 4));
    }
    return min + (max - min) * u;
  }

  fork(stream: string): Rng {
    return new Rng(fmix32(fnv1a32(`${this.nextU32()}:${stream}`)));
  }
}

export type Dist = "uniform" | "normal" | "low" | "high";

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// ---- noise -----------------------------------------------------------------

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad1(seed: number, i: number): number {
  return (hash2(seed, i, 0) / 4294967296) * 2 - 1;
}

/** 1D gradient noise, roughly in [-1,1] */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = grad1(seed, i) * f;
  const g1 = grad1(seed, i + 1) * (f - 1);
  return (g0 + (g1 - g0) * fade(f)) * 2;
}

/** periodic 1D noise with integer period (for closed contours) */
export function noise1p(seed: number, x: number, period: number): number {
  const p = Math.max(1, Math.round(period));
  const i = Math.floor(x);
  const f = x - i;
  const a = ((i % p) + p) % p;
  const b = (a + 1) % p;
  const g0 = grad1(seed, a) * f;
  const g1 = grad1(seed, b) * (f - 1);
  return (g0 + (g1 - g0) * fade(f)) * 2;
}

export function fbm1(seed: number, x: number, octaves = 2, persistence = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(seed + o * 1013, x * freq) * amp;
    norm += amp;
    amp *= persistence;
    freq *= 2;
  }
  return sum / norm;
}

export function fbm1p(seed: number, x: number, period: number, octaves = 2): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1p(seed + o * 1013, x * freq, period * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function grad2(seed: number, ix: number, iy: number, x: number, y: number): number {
  const h = hash2(seed, ix, iy);
  const a = (h / 4294967296) * Math.PI * 2;
  return Math.cos(a) * x + Math.sin(a) * y;
}

/** 2D gradient noise, roughly in [-1,1] */
export function noise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const n00 = grad2(seed, ix, iy, fx, fy);
  const n10 = grad2(seed, ix + 1, iy, fx - 1, fy);
  const n01 = grad2(seed, ix, iy + 1, fx, fy - 1);
  const n11 = grad2(seed, ix + 1, iy + 1, fx - 1, fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.414;
}
