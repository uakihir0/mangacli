import { flattenPath, type PathData } from "../geom/path.js";
import { boundsOf, type Vec } from "../geom/vec.js";

export function sfxInkHeadDepth(path: PathData, vertical: boolean): number {
  const contours = flattenPath(path, 0.02).map(c => c.pts);
  const points = contours.flat();
  if (!points.length) return 0;
  const bb = boundsOf(points);
  const axis = (p: Vec) => vertical ? p.y : p.x;
  const area = (pts: Vec[]) => pts.reduce((sum, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0) / 2;
  const total = Math.abs(contours.reduce((sum, pts) => sum + area(pts), 0));
  if (total < 1e-8) return 0;
  const start = vertical ? bb.y : bb.x;
  let lo = start, hi = start + (vertical ? bb.h : bb.w);
  for (let step = 0; step < 24; step++) {
    const cutoff = (lo + hi) / 2;
    const covered = Math.abs(contours.reduce((sum, pts) => {
      const clipped: Vec[] = [];
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        if (axis(p) <= cutoff) clipped.push(p);
        if ((axis(p) <= cutoff) !== (axis(q) <= cutoff)) {
          const t = (cutoff - axis(p)) / (axis(q) - axis(p));
          clipped.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
        }
      });
      return sum + area(clipped);
    }, 0));
    if (covered <= total * 0.14) lo = cutoff;
    else hi = cutoff;
  }
  return lo - start;
}

const SMALL_KANA = new Set(Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ"));

export const isSmallKana = (char: string): boolean => SMALL_KANA.has(char);

export function sfxStretch(char: string, vertical: boolean): [number, number] {
  const along = "ー〜～ｰ︱︲︴".includes(char) && char.length > 0 ? 1.6 : 1;
  return vertical ? [1, along] : [along, 1];
}

export function fullSizeKana(char: string): string {
  const small = Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ");
  const full = Array.from("あいうえおつやゆよわかけアイウエオツヤユヨワカケクシストヌハヒフヘホムラリルレロ");
  return full[small.indexOf(char)] ?? char;
}

export type SfxScaleRamp = "grow" | "shrink" | "burst" | "flat" | { from: number; to: number };

export function sfxScale(index: number, count: number, char: string, grow?: number, smallKanaScale = 0.6, style: "impact" | "speed" = "impact", preset?: SfxScaleRamp): number {
  const t = count > 1 ? index / (count - 1) : style === "impact" ? 0 : 1;
  const mode = preset ?? (style === "impact" ? "shrink" : undefined);
  let ramp = style === "speed" ? 0.95 * (1 - t) + 1.3 * t : 1;
  if (mode === "grow") ramp = 0.85 * (1 - t) + 1.3 * t;
  else if (mode === "shrink") ramp = 1.3 * (1 - t) + 0.8 * t;
  else if (mode === "burst") ramp = 0.9 + 0.45 * (count === 1 ? 1 : 1 - Math.abs(2 * t - 1));
  else if (mode === "flat") ramp = 1;
  else if (typeof mode === "object") ramp = mode.from * (1 - t) + mode.to * t;
  if (grow !== undefined) ramp = 1 + grow * index;
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
