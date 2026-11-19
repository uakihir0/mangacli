const SMALL_KANA = new Set(Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ"));

export const isSmallKana = (char: string): boolean => SMALL_KANA.has(char);

export function sfxScale(index: number, count: number, char: string, grow?: number, smallKanaScale = 0.7): number {
  const t = count > 1 ? index / (count - 1) : 1;
  const ramp = grow === undefined ? 0.95 * (1 - t) + 1.3 * t : 1 + grow * index;
  return ramp * (SMALL_KANA.has(char) ? smallKanaScale : 1);
}

export function sfxShifts(scales: number[], em: number): number[] {
  let advance = 0;
  return scales.map((scale) => {
    const shift = advance + (scale - 1) * em / 2;
    advance += (scale - 1) * em;
    return shift;
  });
}
