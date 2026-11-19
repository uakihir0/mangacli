// Built-in defaults (B5-scaled values use the internal "bmm" unit, spec 3.5.1).
// NOTE: provisional numbers; tuned during M1 (decision D-24).

type Obj = Record<string, unknown>;

export const DEFAULT_BALLOON_FONT_SIZE = "16bQ";

export const BUILTIN_DEFAULTS: Record<string, Obj> = {
  panel: {
    border: { width: "0.7bmm", color: "black", pen: { preset: "kabura-pen" }, style: "solid", ruler: true, join: "clean" },
    background: "paper",
  },
  balloon: {
    shape: { kind: "ellipse", irregularity: 0.12, tilt: ["-1.5deg", "1.5deg"] },
    stroke: { width: "0.34bmm", color: "black", pen: { preset: "g-pen" }, style: "solid", dash: ["1.6bmm", "1.0bmm"], dot: { size: "0.45bmm", gap: "0.9bmm" }, double: { gap: "0.6bmm", inner: "0.2bmm" } },
    fill: "paper",
    tail: { kind: "wedge", gap: "2bmm", bend: 0.08, sideCurve: 0.35, root: "auto", count: 3, shrink: 0.66, segments: 3 },
    maxSize: ["75%", "80%"],
    aspect: "auto",
    aspectRange: [0.55, 1.8],
    padding: ["0.7em", "0.65em"],
    minFontScale: 0.75,
    font: "dialogue",
    fontSize: DEFAULT_BALLOON_FONT_SIZE,
    clip: "auto",
    autoPlace: "auto",
  },
  text: { font: "narration", fontSize: "12bQ", clip: "none", padding: ["0.45em", "0.6em"], overflow: "shrink", outline: [{ width: "0.8bmm", color: "paper" }] },
  sfx: {
    font: "sfx",
    fontSize: "12bmm",
    letterSpacing: "-0.05em",
    perChar: { rotate: ["-10deg", "10deg"], scale: [0.86, 1.12] },
    distort: { roughen: 0.25, warp: 0.15, skew: "-8deg" },
    color: "black",
    outline: [{ width: "0.13em", color: "white" }],
    lettering: { mode: "hand" },
    clip: "none",
  },
  image: { smoothing: "high", clip: "panel" },
  fill: { clip: "panel", edge: "clean" },
  draw: { stroke: { width: "0.3bmm", pen: { preset: "g-pen" }, color: "black" }, fill: "none", ruler: false, clip: "panel" },
  group: { clip: "panel" },
  scatter: { clip: "panel", rate: 0.3, itemScale: [0.7, 1.3], itemRotate: ["-20deg", "20deg"] },
};

export const BUILTIN_EFFECT_DEFAULTS: Record<string, Obj> = {
  lightning: { background: "black", direction: "90deg", bolts: 3, branches: 2, length: "90%", thickness: ["3bmm", "6bmm"], jaggedness: 0.8, fill: "paper", stroke: { width: "0.25bmm" }, pen: { preset: "g-pen" } },
  crack: { radius: "30%", count: 7, branching: 0.35, rings: 1, thickness: ["0.15bmm", "0.65bmm"], shade: "black", pen: { preset: "g-pen" } },
  dust: { direction: "both", size: "25%", puffs: 7, fill: "paper", stroke: { width: "0.3bmm" }, debris: 10, pen: { preset: "g-pen" } },
  smoke: { direction: "-90deg", density: 0.5, fill: "paper", stroke: { width: "0.2bmm" }, pen: { preset: "g-pen" } },
  "*": { color: "black", opacity: 1, density: 1, background: "none", clip: "panel" },
  "focus-lines": { center: "auto", inner: ["32%", "26%"], innerJitter: 0.5, spikes: { ratio: 0.06, depth: 0.45 }, count: "auto", thickness: { min: "0.12bmm", max: "0.5bmm", dist: "low" }, taper: "in", angleJitter: 0.8, cluster: 0.65, curve: 0, ruler: true, pen: { preset: "maru-pen" } },
  "beta-flash": { center: "auto", inner: ["24%", "20%"], outer: ["44%", "38%"], outerJitter: 0.15, innerJitter: 0.5, spikes: { ratio: 0.1, depth: 0.6 }, count: "auto", thickness: { min: "0.25bmm", max: "1.0bmm", dist: "low" }, core: "paper", ruler: true, pen: { preset: "g-pen" } },
  "uni-flash": { center: "auto", inner: ["18%", "15%"], outer: ["36%", "30%"], innerJitter: 0.25, outerJitter: 0.35, count: "auto", thickness: { min: "0.08bmm", max: "0.3bmm", dist: "low" }, taper: "both", peak: 0.6, core: "paper", rings: 1, ruler: true, pen: { preset: "maru-pen" } },
  "speed-lines": { angle: 0, spacing: ["0.5bmm", "2.2bmm"], length: ["30%", "90%"], thickness: { min: "0.1bmm", max: "0.4bmm", dist: "low" }, taper: "both", align: "random", cluster: 0.4, ruler: true, pen: { preset: "maru-pen" } },
  "swirl-lines": { center: "center", radius: ["15%", "60%"], arc: ["25deg", "90deg"], count: "auto", direction: "cw", thickness: ["0.1bmm", "0.4bmm"], spiral: 0, pen: { preset: "maru-pen" } },
  impact: { radius: "18%", spikes: 14, irregularity: 0.5, fill: "paper", stroke: { width: "0.3bmm", pen: { preset: "g-pen" } }, double: true, rays: { count: 24, length: ["2bmm", "8bmm"], thickness: ["0.15bmm", "0.4bmm"] } },
  "gloom-lines": { region: { band: { side: "top", size: "55%" } }, spacing: ["0.7bmm", "1.5bmm"], length: ["45%", "100%"], thickness: ["0.15bmm", "0.35bmm"], taper: "end", tone: "none", ruler: true, pen: { preset: "maru-pen" } },
  hatching: { pattern: "hatch", angle: "45deg", spacing: "0.6bmm", thickness: ["0.08bmm", "0.16bmm"], blockSize: ["2bmm", "3.5bmm"], linesPerBlock: 4, edge: "soft", ruler: false, pen: { preset: "maru-pen" } },
  rain: { angle: "100deg", rate: 2.5, length: ["4bmm", "14bmm"], thickness: ["0.1bmm", "0.22bmm"], taper: "both", ruler: true, pen: { preset: "maru-pen" } },
  vignette: { color: "paper", width: "8bmm", shape: "rect", softness: 0.7, screen: "am" },
  glow: { color: "white", blur: "4bmm" },
  "light-rays": { color: "white", count: 24, angle: 0, spread: 0.55 },
  spotlight: { color: "white", source: ["18%", "0%"], target: ["60%", "78%"], width: "45%", shade: 0.8 },
};

export const BUILTIN_MARK_DEFAULTS: Record<string, Obj> = {
  "*": { color: "black", stroke: { width: "0.25bmm", pen: { preset: "g-pen" } }, clip: "panel" },
  sweat: { size: "5bmm", count: 1, fill: "paper" },
  "sweat-burst": { size: "12bmm", count: 5, fill: "paper" },
  anger: { size: "6bmm", variant: "cross" },
  blush: { size: "6bmm", lines: 5, angle: "60deg" },
  surprise: { size: "8bmm", lines: 4, spread: "70deg" },
  sparkle: { size: "4bmm", points: 4, count: 3, fill: "paper" },
  heart: { size: "5bmm", fill: "none" },
  note: { size: "5bmm", variant: "eighth" },
  exclamation: { size: "7bmm", count: 1 },
  question: { size: "7bmm", count: 1 },
  steam: { size: "8bmm", puffs: 3 },
  zzz: { size: "8bmm", count: 3 },
  motion: { size: "8bmm", lines: 3, direction: "0deg", arc: "60deg" },
  tremble: { size: "6bmm", pairs: 2 },
  spiral: { size: "6bmm", turns: 2.5 },
  dots: { size: "6bmm", count: 3 },
  tears: { size: "10bmm", streams: 2 },
  shine: { size: "5bmm", rays: 8 },
  pop: { size: "8bmm", rays: 7 },
  idea: { size: "8bmm", rays: 6 },
  "snot-bubble": { size: "5bmm" },
  sigh: { size: "8bmm", puffs: 2 },
  pale: { size: "10bmm", lines: 6 },
  "dizzy-stars": { size: "12bmm", count: 4 },
};

/** Built-in speech styles selected by `as` (spec 6.13). */
export const BUILTIN_STYLES: Record<string, Obj> = {
  aside: { shape: { kind: "none" }, font: "hand", fontScale: 0.75, lettering: { mode: "hand" }, textOutline: [{ width: "0.65bmm", color: "paper" }], minSize: ["0bmm", "0bmm"], padding: ["0.05em", "0.05em"], autoConnect: false, tail: { kind: "none", maxLength: "3bmm", gap: "0.5bmm", bend: 0, curl: false, allowVertical: true } },
  say: { shape: { kind: "ellipse" }, stroke: { pen: { preset: "g-pen" }, style: "solid" }, tail: { kind: "wedge" }, font: "dialogue" },
  think: { shape: { kind: "cloud", depth: 0.23 }, stroke: { width: "0.3bmm", pen: { preset: "maru-pen" }, style: "solid" }, tail: { kind: "bubbles" }, font: "thought" },
  shout: { shape: { kind: "spike" }, stroke: { width: "0.3bmm", pen: { preset: "g-pen" }, style: "solid" }, tail: { kind: "wedge", widthScale: 1.3, bend: 0, sideCurve: 0 }, font: "shout", fontScale: 1.4 },
  whisper: { shape: { kind: "ellipse" }, stroke: { width: "0.2bmm", style: "dashed" }, tail: { kind: "wedge", widthScale: 0.7 }, font: "whisper", fontScale: 0.85 },
  tremble: { shape: { kind: "wavy" }, stroke: { width: "0.22bmm" }, tail: { kind: "wedge" }, font: "dialogue" },
  narration: { shape: { kind: "rect", ruler: true }, stroke: { width: "0.45bmm", pen: { preset: "g-pen" } }, tail: { kind: "none" }, font: "narration", autoPlace: "flow", padding: ["0.75em", "0.7em"] },
  monologue: { shape: { kind: "none" }, tail: { kind: "none" }, font: "narration", textOutline: [{ width: "0.8bmm", color: "white" }] },
  inverted: { shape: { kind: "ellipse" }, stroke: { width: "0.25bmm" }, tail: { kind: "wedge" }, font: "dialogue", fill: "black", color: "white" },
  scream: { shape: { kind: "burst" }, stroke: { width: "0.35bmm" }, tail: { kind: "wedge", widthScale: 1.5, bend: 0, sideCurve: 0 }, font: "shout", fontScale: 1.5 },
  shock: { shape: { kind: "flash" }, stroke: { style: "none" }, tail: { kind: "none" }, font: "thought" },
  electronic: { shape: { kind: "electronic" }, stroke: { width: "0.25bmm" }, tail: { kind: "zigzag" }, font: "dialogue" },
  offscreen: { shape: { kind: "ellipse" }, stroke: { width: "0.25bmm" }, tail: { kind: "wedge" }, font: "dialogue" },
  // a blunt, flat or gruff voice: squared-off balloon with straight sides
  gruff: { shape: { kind: "hexagon" }, stroke: { width: "0.25bmm" }, tail: { kind: "wedge" }, font: "dialogue" },
};

export interface PagePreset {
  w: number;
  h: number;
  unit: "mm" | "px";
  baseFrame?: "trim" | { size?: [string | number, string | number]; offset?: [string | number, string | number]; margins?: { top: string | number; bottom: string | number; inner: string | number; outer: string | number } };
  bleed?: string | number;
  printSize?: string | [string | number, string | number];
  dpi?: number;
}

export const PAGE_PRESETS: Record<string, PagePreset> = {
  "manga-b4": { w: 220, h: 310, unit: "mm", baseFrame: { size: ["180mm", "270mm"] }, bleed: "5mm", printSize: "B5" },
  A4: { w: 210, h: 297, unit: "mm" },
  A5: { w: 148, h: 210, unit: "mm" },
  A6: { w: 105, h: 148, unit: "mm" },
  B4: { w: 257, h: 364, unit: "mm" },
  B5: { w: 182, h: 257, unit: "mm" },
  B6: { w: 128, h: 182, unit: "mm" },
  postcard: { w: 100, h: 148, unit: "mm" },
  shiroku: { w: 127, h: 188, unit: "mm" },
  shinsho: { w: 103, h: 182, unit: "mm" },
  "sns-portrait": { w: 1080, h: 1350, unit: "px" },
  "sns-square": { w: 1080, h: 1080, unit: "px" },
  "sns-landscape": { w: 1600, h: 900, unit: "px" },
};
