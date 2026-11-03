// Line-break rules (spec 7.6): kinsoku classes aligned with CSS Text 3 line-break.

export type KinsokuLevel = "strict" | "normal" | "loose" | "none";

const CLOSING = new Set(Array.from("、。，．）］｝」』】〕〉》〙〗’”｠»),.]}>"));
const MARKS = new Set(Array.from("？！‼⁇⁈⁉?!"));
const MIDDLE = new Set(Array.from("・：；:;"));
const ITER = new Set(Array.from("々〻ゝゞヽヾ"));
const HYPHEN = new Set(Array.from("‐–〜～゠"));
const SMALL = new Set(Array.from("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶーㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ"));
const OPENING = new Set(Array.from("（［｛「『【〔〈《〘〖‘“｟«([{<"));
const INSEP = new Set(Array.from("…‥―"));

export function noStart(ch: string, level: KinsokuLevel): boolean {
  if (level === "none") return false;
  if (CLOSING.has(ch) || MARKS.has(ch)) return true;
  if (level === "loose") return false;
  if (MIDDLE.has(ch) || ITER.has(ch) || HYPHEN.has(ch)) return true;
  if (level === "strict" && (SMALL.has(ch) || ch === "―" || ch === "…" || ch === "‥")) return true;
  return false;
}

export function noEnd(ch: string, level: KinsokuLevel): boolean {
  if (level === "none") return false;
  return OPENING.has(ch);
}

export function inseparable(a: string, b: string): boolean {
  return INSEP.has(a) && a === b;
}

export function isClosingPunct(ch: string): boolean {
  return CLOSING.has(ch);
}

export function isOpeningPunct(ch: string): boolean {
  return OPENING.has(ch);
}

const HIRA = /^[ぁ-ゟー]+$/u;
const ENDS_KANJI_KATA = /[一-鿿㐀-䶿々゠-ヿー]$/u;
const PUNCT_START = /^[、。，．！？!?」』）】〉》…―ーっゃゅょぁぃぅぇぉッャュョァィゥェォ〜]/u;

/** Phrase (bunsetsu-like) units via Intl.Segmenter (spec 7.6.2). Returns break-allowed boundaries as char indices. */
export function phraseBoundaries(text: string, lang = "ja"): Set<number> {
  const seg = new Intl.Segmenter(lang, { granularity: "word" });
  const words: { s: string; i: number }[] = [];
  for (const w of seg.segment(text)) words.push({ s: w.segment, i: w.index });
  const phrases: { s: string; i: number }[] = [];
  for (const w of words) {
    const prev = phrases[phrases.length - 1];
    if (prev) {
      const attach =
        (HIRA.test(w.s) && ENDS_KANJI_KATA.test(prev.s)) ||
        PUNCT_START.test(w.s) ||
        (/^[゠-ヿ]+$/u.test(w.s) && /[゠-ヿ]$/u.test(prev.s)) ||
        (HIRA.test(w.s) && HIRA.test(prev.s) && w.s.length <= 2) ||
        /^\s+$/.test(prev.s) === false && /^[0-9,.]+$/.test(w.s) && /[0-9]$/.test(prev.s);
      if (attach) {
        prev.s += w.s;
        continue;
      }
    }
    phrases.push({ ...w });
  }
  const out = new Set<number>();
  for (const p of phrases) out.add(p.i);
  return out;
}
