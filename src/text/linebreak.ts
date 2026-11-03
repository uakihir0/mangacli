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
const HAS_KANJI = /[一-鿿㐀-䶿々]/u;
const ENDS_HIRA = /[ぁ-ゟ]$/u;
const KANJI_ONLY = /^[一-鿿㐀-䶿々]+$/u;
const STARTS_KANJI = /^[一-鿿㐀-䶿々]/u;
/** 連用形 of a single-kanji verb (吹き, 折り, 引き, 取り…) that forms compound verbs/nouns */
const RENYOU = /^[一-鿿㐀-䶿々][きりちしいみひびけえぎじ]$/u;
const PUNCT_START = /^[、。，．！？!?」』）】〉》…―ーっゃゅょぁぃぅぇぉッャュョァィゥェォ〜]/u;
const PARTICLES = new Set(["は", "が", "を", "に", "で", "と", "も", "の", "へ", "や", "か", "ね", "よ", "な", "わ", "さ", "ぞ", "ぜ", "て", "た", "だ", "です", "ます", "でし", "まし", "から", "まで", "より", "けど", "って", "ので", "のに", "だけ", "しか", "ばかり", "など", "くらい", "ぐらい", "でも", "じゃ", "なあ", "ねえ", "よね", "かな", "のよ", "わよ", "ん"]);

/** hiragana words that start a phrase even right after a kanji word (今度|なんか, 明日|また) */
const STANDALONE = new Set(["また", "まだ", "もう", "なんか", "なんて", "ちょっと", "とても", "すごく", "すごい", "いつも", "ずっと", "やっぱり", "やっぱ", "たぶん", "きっと", "もっと", "こんな", "そんな", "あんな", "どんな", "この", "その", "あの", "どの", "これ", "それ", "あれ", "どれ", "ここ", "そこ", "あそこ", "どこ", "いい", "よく", "みんな", "ほら", "ねえ", "おい", "ほんとに", "ほんと", "ぜんぜん", "なぜ", "どうして", "いま", "さっき", "あと", "まず", "ぜひ", "ただ", "ほぼ", "かなり"]);
/** a separate hiragana word that reads as a verb in its plain form (おごる, あける) */
const HIRA_VERB = /^[ぁ-ゟ]{2,}[るうくすつぬむぶぐ]$/u;

/** auxiliaries that never start a phrase (いる|ない, 行き|ます) */
const AUX = new Set(["ない", "なかっ", "なく", "なけれ", "ます", "まし", "ませ", "ません", "たい", "たかっ", "たく", "られ", "られる", "れる", "れ", "せる", "させ", "させる", "よう", "だろう", "でしょう", "らしい", "ちゃ", "じゃう", "ちゃう"]);

/** Phrase (bunsetsu-like) units via Intl.Segmenter (spec 7.6.2). Returns break-allowed boundaries as char indices. */
export function phraseBoundaries(text: string, lang = "ja"): Set<number> {
  const seg = new Intl.Segmenter(lang, { granularity: "word" });
  const words: { s: string; i: number }[] = [];
  for (const w of seg.segment(text)) words.push({ s: w.segment, i: w.index });
  const phrases: { s: string; i: number }[] = [];
  let lastWord = "";
  for (const w of words) {
    const prev = phrases[phrases.length - 1];
    if (prev) {
      // a word after punctuation always starts a new phrase; standalone words never attach
      const afterPunct = /[、。，．！？!?…」』）]$/u.test(prev.s) && !PUNCT_START.test(w.s);
      const free = STANDALONE.has(w.s) || (HIRA_VERB.test(w.s) && !AUX.has(w.s) && !PARTICLES.has(w.s));
      const attach =
        !afterPunct &&
        (PUNCT_START.test(w.s) || w.s === "ん" ||
        // okurigana / particles after a kanji or katakana word
        (HIRA.test(w.s) && ENDS_KANJI_KATA.test(prev.s) && !free) ||
        // okurigana / particles after a kanji or katakana word
        // inflection and auxiliaries after an inflected word (入れる|と, 整え|ます, 返し|て)
        (HIRA.test(w.s) && w.s.length <= 3 && HAS_KANJI.test(lastWord) && ENDS_HIRA.test(lastWord) && !free) ||
        // particles in hiragana-only text (これ|は)
        (HIRA.test(w.s) && HIRA.test(prev.s) && (PARTICLES.has(w.s) || w.s.length === 1)) ||
        (AUX.has(w.s) && !/\s$/.test(prev.s)) ||
        // sentence-final and case particles never start a phrase (です|ね)
        (PARTICLES.has(w.s) && w.s.length <= 2 && !/\s$/.test(prev.s)) ||
        // auxiliaries after the te-form (残って|る, て|しまった, て|みた)
        (HIRA.test(w.s) && w.s.length <= 3 && isTe(lastWord)) ||
        // compound verbs / nouns: 吹き|出し, 引き|寄せ
        (STARTS_KANJI.test(w.s) && RENYOU.test(lastWord)) ||
        // split single kanji (角|丸)
        (KANJI_ONLY.test(w.s) && KANJI_ONLY.test(lastWord) && (w.s.length === 1 || lastWord.length === 1) && KANJI_ONLY.test(prev.s)) ||
        (/^[゠-ヿ]+$/u.test(w.s) && /[゠-ヿ]$/u.test(prev.s)) ||
        (!/^\s+$/.test(prev.s) && /^[0-9,.]+$/.test(w.s) && /[0-9]$/.test(prev.s)));
      if (attach) {
        const teChain = isTe(lastWord) && HIRA.test(w.s) && w.s.length <= 3;
        prev.s += w.s;
        lastWord = teChain ? "TE" : joinLast(lastWord, w.s);
        continue;
      }
    }
    phrases.push({ ...w });
    lastWord = w.s;
  }
  const out = new Set<number>();
  for (const p of phrases) out.add(p.i);
  return out;
}

/** track the last lexical word, keeping okurigana with its kanji (吹 + き -> 吹き) */
function joinLast(last: string, w: string): string {
  if (HIRA.test(w) && !PARTICLES.has(w) && /[一-鿿㐀-䶿々]/u.test(last)) return last + w;
  return w;
}

function isTe(w: string): boolean {
  return w === "TE" || /^(?:っ?て|っ?で)$/.test(w);
}
