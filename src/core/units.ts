// Lengths, angles and ranges (spec 3.4, 3.5, 16.2).

export const LENGTH_UNITS = ["mm", "cm", "in", "pt", "px", "Q", "H", "em", "%"] as const;
export const INTERNAL_LENGTH_UNITS = [...LENGTH_UNITS, "bmm", "bQ"] as const;
export const ANGLE_UNITS = ["deg", "rad", "turn"] as const;
export const LPI_SUFFIXES = ["@print"] as const;
export type LengthUnit = (typeof INTERNAL_LENGTH_UNITS)[number] | "";

const NUMBER_PATTERN = String.raw`[-+]?(?:\d+(?:\.\d+)?|\.\d+)`;
export const LENGTH_PATTERN = new RegExp(`^${NUMBER_PATTERN}\\s*(${LENGTH_UNITS.join("|")})?(@print)?$`);
export const ANGLE_PATTERN = new RegExp(`^${NUMBER_PATTERN}\\s*(${ANGLE_UNITS.join("|")})?$`);
export const LPI_PATTERN = new RegExp(String.raw`^(?:\d+(?:\.\d+)?|\.\d+)(${LPI_SUFFIXES.join("|")})$`);

export function unitParseError(kind: string, input: unknown, units: readonly string[]): string {
  return `invalid ${kind}: ${JSON.stringify(input) ?? String(input)}; accepted units: ${units.join(", ")}`;
}

export interface Quantity {
  value: number;
  unit: LengthUnit;
  print?: boolean;
}

export type LengthInput = number | string;

const LEN_RE = new RegExp(`^(${NUMBER_PATTERN})\\s*(${INTERNAL_LENGTH_UNITS.join("|")})?$`);

export function parseLength(input: LengthInput): Quantity | null {
  if (typeof input === "number") return isFinite(input) ? { value: input, unit: "" } : null;
  if (typeof input !== "string") return null;
  const print = input.trim().endsWith("@print");
  const m = input.trim().replace(/@print$/, "").match(LEN_RE);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: (m[2] ?? "") as LengthUnit, ...(print ? { print: true } : {}) };
}

export function isLength(input: unknown): input is LengthInput {
  return (typeof input === "number" || typeof input === "string") && parseLength(input as LengthInput) !== null;
}

export interface UnitContext {
  /** unit for bare numbers */
  units: "mm" | "px" | "pt" | "in" | "cm";
  dpi: number;
  printScale?: number;
  /** B5 scale factor for built-in defaults (short side / 182mm) */
  k: number;
  /** current font size in mm (for em) */
  em?: number;
  /** percent base in mm */
  base?: number;
}

export function quantityToMm(q: Quantity, ctx: UnitContext): number {
  if (q.print) return quantityToMm({ ...q, print: false }, ctx) / (ctx.printScale ?? 1);
  switch (q.unit) {
    case "mm":
      return q.value;
    case "cm":
      return q.value * 10;
    case "in":
      return q.value * 25.4;
    case "pt":
      return (q.value * 25.4) / 72;
    case "px":
      return (q.value * 25.4) / ctx.dpi;
    case "Q":
    case "H":
      return q.value * 0.25;
    case "em":
      if (ctx.em === undefined) throw new UnitError(unitParseError("length (em unit is not allowed here)", `${q.value}${q.unit}`, availableLengthUnits(ctx)));
      return q.value * ctx.em;
    case "%":
      if (ctx.base === undefined) throw new UnitError(unitParseError("length (% unit is not allowed here)", `${q.value}${q.unit}`, availableLengthUnits(ctx)));
      return (q.value / 100) * ctx.base;
    case "bmm":
      return q.value * ctx.k;
    case "bQ":
      return Math.max(2, q.value * 0.25 * ctx.k);
    case "":
      return quantityToMm({ value: q.value, unit: ctx.units }, ctx);
  }
}

export class UnitError extends Error {}

function availableLengthUnits(ctx: UnitContext): readonly string[] {
  return LENGTH_UNITS.filter((unit) => (unit !== "em" || ctx.em !== undefined) && (unit !== "%" || ctx.base !== undefined));
}

export function toMm(input: LengthInput | undefined, ctx: UnitContext, fallback?: number): number {
  if (input === undefined || input === null) {
    if (fallback === undefined) throw new UnitError(unitParseError("length (missing length)", input, availableLengthUnits(ctx)));
    return fallback;
  }
  const q = parseLength(input);
  if (!q) throw new UnitError(unitParseError("length", input, availableLengthUnits(ctx)));
  return quantityToMm(q, ctx);
}

const ANG_RE = new RegExp(`^(${NUMBER_PATTERN})\\s*(${ANGLE_UNITS.join("|")})?$`);

/** returns radians */
export function parseAngle(input: number | string | undefined, fallbackDeg = 0): number {
  if (input === undefined || input === null) return (fallbackDeg * Math.PI) / 180;
  if (typeof input === "number") return (input * Math.PI) / 180;
  const m = String(input).trim().match(ANG_RE);
  if (!m) throw new UnitError(unitParseError("angle", input, ANGLE_UNITS));
  const v = parseFloat(m[1]);
  if (m[2] === "rad") return v;
  if (m[2] === "turn") return v * Math.PI * 2;
  return (v * Math.PI) / 180;
}

export function isAngle(input: unknown): boolean {
  if (typeof input === "number") return true;
  return typeof input === "string" && ANG_RE.test(input.trim());
}

export function parsePercent(input: unknown): number | null {
  if (typeof input === "number") return input;
  if (typeof input !== "string") return null;
  const m = input.trim().match(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*%$/);
  return m ? parseFloat(m[1]) / 100 : null;
}

export type RangeInput<T> = T | [T, T] | { min: T; max: T; dist?: "uniform" | "normal" | "low" | "high" };

export interface Range {
  min: number;
  max: number;
  dist: "uniform" | "normal" | "low" | "high";
}

export function toRange<T>(input: RangeInput<T> | undefined, conv: (x: T) => number, fallback: Range): Range {
  if (input === undefined || input === null) return fallback;
  if (Array.isArray(input)) return { min: conv(input[0]), max: conv(input[1]), dist: fallback.dist };
  if (typeof input === "object" && "min" in (input as object)) {
    const o = input as { min: T; max: T; dist?: Range["dist"] };
    return { min: conv(o.min), max: conv(o.max), dist: o.dist ?? fallback.dist };
  }
  const x = conv(input as T);
  return { min: x, max: x, dist: "uniform" };
}

export function fixed(x: number): Range {
  return { min: x, max: x, dist: "uniform" };
}
