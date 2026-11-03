// Character range names for composite fonts (spec 7.3.4).

export function isKana(cp: number): boolean {
  if (cp === 0x30f6) return false; // ヶ belongs to kanji
  return (cp >= 0x3041 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff66 && cp <= 0xff9f);
}

export function isKanji(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x3134f) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f) ||
    cp === 0x3005 || cp === 0x3006 || cp === 0x3007 || cp === 0x30f6 || cp === 0x303b
  );
}

export function isPunct(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f && cp !== 0x3005 && cp !== 0x3006 && cp !== 0x3007 && cp !== 0x303b) ||
    (cp >= 0xff01 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20) || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65) ||
    cp === 0x30fb || cp === 0x2026 || cp === 0x2025 || cp === 0x2015 || cp === 0x2014 ||
    cp === 0x203c || cp === 0x2047 || cp === 0x2048 || cp === 0x2049 || cp === 0x2018 || cp === 0x2019 || cp === 0x201c || cp === 0x201d
  );
}

export function isFullwidthAlnum(cp: number): boolean {
  return (cp >= 0xff10 && cp <= 0xff19) || (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a);
}

export function isDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

export function isLatin(cp: number): boolean {
  return ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x24f)) && !isDigit(cp);
}

export function isEmoji(cp: number): boolean {
  return (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf && cp !== 0x2605 && cp !== 0x2606 && cp !== 0x266a && cp !== 0x2661) || cp === 0xfe0f || cp === 0x200d;
}

export function isSymbol(cp: number): boolean {
  return cp >= 0x2000 && cp <= 0x2bff && !isPunct(cp);
}

export function inRange(name: string, cp: number): boolean {
  switch (name) {
    case "kana":
      return isKana(cp);
    case "kanji":
      return isKanji(cp);
    case "punct":
      return isPunct(cp);
    case "fullwidth":
      return isFullwidthAlnum(cp);
    case "latin":
      return isLatin(cp);
    case "digits":
      return isDigit(cp);
    case "symbols":
      return isSymbol(cp);
    case "emoji":
      return isEmoji(cp);
    default: {
      const m = name.match(/^U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/);
      if (!m) return false;
      const a = parseInt(m[1], 16);
      const b = m[2] ? parseInt(m[2], 16) : a;
      return cp >= a && cp <= b;
    }
  }
}

export const RANGE_NAMES = ["kana", "kanji", "punct", "fullwidth", "latin", "digits", "symbols", "emoji"];
