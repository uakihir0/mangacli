const SMALL_KANA = new Set(Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ"));

export function sfxScale(index: number, count: number, char: string, grow?: number, smallKanaScale = 0.65): number {
  const ramp = grow === undefined ? (count > 1 ? 0.85 + 0.3 * index / (count - 1) : 1) : 1 + grow * index;
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
