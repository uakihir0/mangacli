// CSS Color Level 4 subset (spec 3.4.8, 16.3).

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff",
  beige: "f5f5dc", bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
  blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00",
  chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c",
  cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9",
  darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f",
  darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f",
  darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f", darkturquoise: "00ced1",
  darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969",
  dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff",
  gainsboro: "dcdcdc", ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4",
  indianred: "cd5c5c", indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa",
  lavenderblush: "fff0f5", lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080",
  lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90",
  lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a", lightseagreen: "20b2aa",
  lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899", lightsteelblue: "b0c4de",
  lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff",
  maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3",
  mediumpurple: "9370db", mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc", mediumvioletred: "c71585", midnightblue: "191970", mintcream: "f5fffa",
  mistyrose: "ffe4e1", moccasin: "ffe4b5", navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6",
  olive: "808000", olivedrab: "6b8e23", orange: "ffa500", orangered: "ff4500", orchid: "da70d6",
  palegoldenrod: "eee8aa", palegreen: "98fb98", paleturquoise: "afeeee", palevioletred: "db7093",
  papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f", pink: "ffc0cb", plum: "dda0dd",
  powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399", red: "ff0000", rosybrown: "bc8f8f",
  royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072", sandybrown: "f4a460", seagreen: "2e8b57",
  seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb", slateblue: "6a5acd",
  slategray: "708090", slategrey: "708090", snow: "fffafa", springgreen: "00ff7f", steelblue: "4682b4",
  tan: "d2b48c", teal: "008080", thistle: "d8bfd8", tomato: "ff6347", turquoise: "40e0d0", violet: "ee82ee",
  wheat: "f5deb3", white: "ffffff", whitesmoke: "f5f5f5", yellow: "ffff00", yellowgreen: "9acd32",
  ink: "000000", paper: "ffffff",
};

export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function isColorString(s: string): boolean {
  return parseColor(s) !== null;
}

export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { ...TRANSPARENT };
  if (NAMED[s]) return hex(NAMED[s]);
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) return hex(h.split("").map((c) => c + c).join(""));
    if (h.length === 6 || h.length === 8) return hex(h);
    return null;
  }
  const m = s.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();
  let alphaPart: string | undefined;
  let parts: string[];
  if (body.includes(",")) {
    parts = body.split(",").map((p) => p.trim());
    if (parts.length === 4) alphaPart = parts.pop();
  } else {
    const slash = body.split("/");
    body = slash[0].trim();
    alphaPart = slash[1]?.trim();
    parts = body.split(/\s+/);
  }
  if (parts.length !== 3) return null;
  const alpha = alphaPart === undefined ? 1 : num01(alphaPart, 1);
  if (alpha === null) return null;
  if (fn.startsWith("rgb")) {
    const c = parts.map((p) => num01(p, 255));
    if (c.some((x) => x === null)) return null;
    return { r: c[0]!, g: c[1]!, b: c[2]!, a: alpha };
  }
  const hDeg = parseHue(parts[0]);
  const sat = num01(parts[1], 100);
  const lig = num01(parts[2], 100);
  if (hDeg === null || sat === null || lig === null) return null;
  return { ...hslToRgb(hDeg, sat, lig), a: alpha };
}

function num01(p: string, scale: number): number | null {
  if (p.endsWith("%")) {
    const v = parseFloat(p);
    return isNaN(v) ? null : clamp01(v / 100);
  }
  const v = parseFloat(p);
  return isNaN(v) ? null : clamp01(v / scale);
}

function parseHue(p: string): number | null {
  const m = p.match(/^(-?[\d.]+)(deg|rad|turn)?$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (m[2] === "rad") return (v * 180) / Math.PI;
  if (m[2] === "turn") return v * 360;
  return v;
}

function hex(h: string): RGBA {
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

function hslToRgb(h: number, s: number, l: number) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3), g: f(h), b: f(h - 1 / 3) };
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** linear luminance Y_lin (spec 10.2.1) */
export function luminanceLinear(c: RGBA): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** gamma-encoded gray value Y */
export function grayValue(c: RGBA): number {
  return linearToSrgb(luminanceLinear(c));
}

export function cssColor(c: RGBA): string {
  const f = (x: number) => Math.round(clamp01(x) * 255);
  return `rgba(${f(c.r)},${f(c.g)},${f(c.b)},${+c.a.toFixed(4)})`;
}

export function toGrayRGBA(c: RGBA): RGBA {
  const y = grayValue(c);
  return { r: y, g: y, b: y, a: c.a };
}
