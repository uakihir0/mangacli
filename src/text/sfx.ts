import { flattenPath, type PathData } from "../geom/path.js";

const SMALL_KANA = new Set(Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ"));

export const isSmallKana = (char: string): boolean => SMALL_KANA.has(char);

export function fullSizeKana(char: string): string {
  const small = Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ");
  const full = Array.from("あいうえおつやゆよわかけアイウエオツヤユヨワカケクシストヌハヒフヘホムラリルレロ");
  return full[small.indexOf(char)] ?? char;
}

export function sfxScale(index: number, count: number, char: string, grow?: number, smallKanaScale = 0.7, style: "impact" | "speed" = "impact"): number {
  const t = count > 1 ? index / (count - 1) : style === "impact" ? 0 : 1;
  const ramp = grow === undefined ? style === "impact" ? 1.3 * (1 - t) + 1.05 * t : 0.95 * (1 - t) + 1.3 * t : 1 + grow * index;
  return ramp * (SMALL_KANA.has(char) ? smallKanaScale : 1);
}

export function sfxWeightRadius(style: "impact" | "speed", smallScale = 1): number {
  const body = style === "impact" ? 0.025 : 0.005;
  return body + (0.08 + body) * (1 / smallScale - 1);
}

export function sfxShifts(scales: number[], em: number): number[] {
  let advance = 0;
  return scales.map((scale) => {
    const shift = advance + (scale - 1) * em / 2;
    advance += (scale - 1) * em;
    return shift;
  });
}

export function sfxInkGap(before: PathData, after: PathData, vertical: boolean, em: number): number | undefined {
  const contours = [before, after].map(path => flattenPath(path, em * 0.005).filter(c => c.closed).map(c => c.pts.map(p => ({ across: vertical ? p.x : p.y, along: vertical ? p.y : p.x }))));
  const ranges = contours.map(cs => {
    const values = cs.flatMap(c => c.map(p => p.across));
    return [Math.min(...values), Math.max(...values)];
  });
  const start = Math.max(ranges[0][0], ranges[1][0]), end = Math.min(ranges[0][1], ranges[1][1]);
  let gap: number | undefined;
  const samples = Math.max(1, Math.ceil((end - start) / (em * 0.02)));
  for (let i = 0; i < samples && end > start; i++) {
    const x = start + (i + 0.5) / samples * (end - start);
    const intersections = contours.map(cs => cs.flatMap(c => c.flatMap((a, j) => {
      const b = c[(j + 1) % c.length];
      return (a.across > x) !== (b.across > x) ? [a.along + (b.along - a.along) * (x - a.across) / (b.across - a.across)] : [];
    })));
    if (!intersections[0].length || !intersections[1].length) continue;
    const distance = Math.min(...intersections[1]) - Math.max(...intersections[0]);
    gap = gap === undefined ? distance : Math.min(gap, distance);
  }
  return gap;
}
