// Pen presets (spec 9.7) and hand presets (spec 9.8). Lengths are mm at B5 scale (scaled by k at resolve time).

export interface PenSpec {
  preset: string;
  pressure: number;
  taperIn: number;
  taperOut: number;
  curvature: number;
  pull: number;
  tremor: number;
  inkPool: number;
  cap: "round" | "flat";
  minWidth: number;
  tipWidth: number;
  color?: string;
  opacity?: number;
  texture: "none" | "graphite";
  dryBrush?: { amount: number; start: number };
}

export const PEN_PRESETS: Record<string, PenSpec> = {
  "g-pen": { preset: "g-pen", pressure: 0.3, taperIn: 1.2, taperOut: 3.0, curvature: 0.15, pull: 0.18, tremor: 1.0, inkPool: 0.4, cap: "round", minWidth: 0.06, tipWidth: 0.02, texture: "none" },
  "maru-pen": { preset: "maru-pen", pressure: 0.15, taperIn: 0.8, taperOut: 2.0, curvature: 0.08, pull: 0.08, tremor: 0.8, inkPool: 0.1, cap: "round", minWidth: 0.05, tipWidth: 0.015, texture: "none" },
  "kabura-pen": { preset: "kabura-pen", pressure: 0.1, taperIn: 0.5, taperOut: 0.8, curvature: 0.05, pull: 0.05, tremor: 0.6, inkPool: 0, cap: "round", minWidth: 0.06, tipWidth: 0.03, texture: "none" },
  marker: { preset: "marker", pressure: 0.03, taperIn: 0, taperOut: 0, curvature: 0, pull: 0, tremor: 0.5, inkPool: 0, cap: "round", minWidth: 0.06, tipWidth: 0.06, texture: "none" },
  brush: { preset: "brush", pressure: 0.55, taperIn: 2.5, taperOut: 6.0, curvature: 0.3, pull: 0.25, tremor: 1.2, inkPool: 0.6, cap: "round", minWidth: 0.05, tipWidth: 0.02, texture: "none", dryBrush: { amount: 0.3, start: 0.65 } },
  pencil: { preset: "pencil", pressure: 0.2, taperIn: 1.0, taperOut: 2.0, curvature: 0, pull: 0, tremor: 1.5, inkPool: 0, cap: "round", minWidth: 0.05, tipWidth: 0.03, color: "#555555", opacity: 0.85, texture: "graphite" },
};

export interface HandSpec {
  preset: string;
  wobbleAmp: number;
  wobbleLen: number;
  tremorAmp: number;
  tremorLen: number;
  irregularity: number;
  pressure: number;
  taper: number;
  overshoot: [number, number];
  overlap: [number, number];
  gap: [number, number];
  gapChance: number;
  misalign: number;
  cornerAngle: number; // radians
  maxLength: number;
  rulerAngleError: number; // radians
  handedness: "right" | "left";
  resolution: number;
  passes: number;
  passOffset: [number, number];
  passOpacity: number;
  /** replaces pen (sketch) */
  pen?: string;
}

const deg = Math.PI / 180;

export const HAND_PRESETS: Record<string, HandSpec> = {
  clean: {
    preset: "clean", wobbleAmp: 0, wobbleLen: 14, tremorAmp: 0, tremorLen: 0.9, irregularity: 0, pressure: 0, taper: 0,
    overshoot: [0, 0], overlap: [0, 0], gap: [0, 0], gapChance: 0, misalign: 0, cornerAngle: 50 * deg, maxLength: 100000,
    rulerAngleError: 0, handedness: "right", resolution: 0.2, passes: 1, passOffset: [0, 0], passOpacity: 1,
  },
  ink: {
    preset: "ink", wobbleAmp: 0.1, wobbleLen: 14, tremorAmp: 0.015, tremorLen: 0.9, irregularity: 1, pressure: 1, taper: 1,
    overshoot: [0, 0.4], overlap: [0.8, 2.5], gap: [0.05, 0.3], gapChance: 0.2, misalign: 0.08, cornerAngle: 50 * deg, maxLength: 70,
    rulerAngleError: 0.15 * deg, handedness: "right", resolution: 0.2, passes: 1, passOffset: [0, 0], passOpacity: 1,
  },
  loose: {
    preset: "loose", wobbleAmp: 0.25, wobbleLen: 11, tremorAmp: 0.03, tremorLen: 0.9, irregularity: 1.6, pressure: 1.3, taper: 1.15,
    overshoot: [0.3, 1.2], overlap: [1.2, 4], gap: [0.1, 0.5], gapChance: 0.35, misalign: 0.15, cornerAngle: 50 * deg, maxLength: 50,
    rulerAngleError: 0.3 * deg, handedness: "right", resolution: 0.2, passes: 1, passOffset: [0, 0], passOpacity: 1,
  },
  sketch: {
    preset: "sketch", wobbleAmp: 0.4, wobbleLen: 9, tremorAmp: 0.05, tremorLen: 0.9, irregularity: 2, pressure: 1, taper: 1,
    overshoot: [0.5, 2.0], overlap: [1.5, 5], gap: [0.2, 0.8], gapChance: 0.5, misalign: 0.25, cornerAngle: 50 * deg, maxLength: 40,
    rulerAngleError: 0.5 * deg, handedness: "right", resolution: 0.2, passes: 2, passOffset: [0.12, 0.3], passOpacity: 0.6, pen: "pencil",
  },
};

/** piecewise-linear interpolation clean(0) -> ink(0.35) -> loose(0.65) -> sketch(1.0, without pen swap) */
export function handFromRoughness(r: number): HandSpec {
  const pts: [number, HandSpec][] = [
    [0, HAND_PRESETS.clean],
    [0.35, HAND_PRESETS.ink],
    [0.65, HAND_PRESETS.loose],
    [1, { ...HAND_PRESETS.sketch, pen: undefined, passes: 1 }],
  ];
  const x = Math.min(1, Math.max(0, r));
  let i = 0;
  while (i < pts.length - 2 && x > pts[i + 1][0]) i++;
  const [x0, a] = pts[i];
  const [x1, b] = pts[i + 1];
  const t = (x - x0) / (x1 - x0);
  const L = (p: number, q: number) => p + (q - p) * t;
  const LA = (p: [number, number], q: [number, number]): [number, number] => [L(p[0], q[0]), L(p[1], q[1])];
  return {
    ...a,
    preset: `roughness:${x}`,
    wobbleAmp: L(a.wobbleAmp, b.wobbleAmp), wobbleLen: L(a.wobbleLen, b.wobbleLen),
    tremorAmp: L(a.tremorAmp, b.tremorAmp), tremorLen: L(a.tremorLen, b.tremorLen),
    irregularity: L(a.irregularity, b.irregularity), pressure: L(a.pressure, b.pressure), taper: L(a.taper, b.taper),
    overshoot: LA(a.overshoot, b.overshoot), overlap: LA(a.overlap, b.overlap), gap: LA(a.gap, b.gap),
    gapChance: L(a.gapChance, b.gapChance), misalign: L(a.misalign, b.misalign), maxLength: L(Math.min(a.maxLength, 200), Math.min(b.maxLength, 200)),
    rulerAngleError: L(a.rulerAngleError, b.rulerAngleError),
  };
}
