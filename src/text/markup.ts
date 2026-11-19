// Inline markup (spec 7.7, 16.10) and symbol normalization (spec 7.11).
import { isKanji } from "../fonts/ranges.js";

export interface InlineStyle {
  size?: number; // multiplier
  sizeAbs?: string; // absolute length string
  font?: string;
  color?: string;
  bold?: boolean;
  tcy?: boolean;
  upright?: boolean;
  sideways?: boolean;
  nobr?: number;
  shake?: boolean;
  hand?: boolean;
  scaleX?: number;
  scaleY?: number;
}

export type Unit =
  | { kind: "char"; ch: string; style: InlineStyle; emph?: boolean | string; ruby?: number; tcyGroup?: number; nobr?: number }
  | { kind: "break" }
  | { kind: "wbr" }
  | { kind: "space"; em: number; style: InlineStyle };

export interface RubyDef {
  id: number;
  text: string;
  mono: string[] | null;
}

export interface ParsedText {
  units: Unit[];
  rubies: RubyDef[];
  errors: { code: string; message: string }[];
  infos: { code: string; message: string; severity?: "warning" | "info" }[];
}

export interface NormalizeOptions {
  ellipsis?: boolean;
  ellipsisPair?: boolean;
  dash?: boolean;
  fullwidthMarks?: boolean;
  waveDash?: boolean;
  spaceAfterMarks?: boolean;
  dropTrailingPeriod?: boolean;
  spaces?: boolean;
  /** typographer's quotes: ' " -> ’ “ ” (on by default outside CJK text) */
  smartQuotes?: boolean;
  /** all caps (comic lettering) */
  uppercase?: boolean;
}

const TAGS = new Set(["ruby", "em", "tcy", "upright", "sideways", "b", "size", "big", "small", "font", "color", "shake", "hand", "nobr", "scale", "br", "wbr", "space"]);

export function splitGraphemes(s: string): string[] {
  const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
  return Array.from(seg.segment(s), (x) => x.segment);
}

export function normalizeChunk(s: string, o: NormalizeOptions, vertical: boolean): string {
  let t = s;
  if (o.ellipsis !== false) t = t.replace(/\.{3,}|・{3,}|。{3,}/g, (m) => "…".repeat(Math.max(1, Math.round(m.length / 3))));
  if (o.ellipsisPair) t = t.replace(/(?<!…)…(?!…)/g, "……");
  if (o.dash !== false) t = t.replace(/[—―─━]{2,}/g, (m) => "―".repeat(m.length)).replace(/--+/g, "――").replace(/(?<![―—─━])[―—─━](?![―—─━])/g, "――");
  if (o.waveDash !== false) t = t.replace(/~/g, "〜");
  if (o.uppercase) t = t.toUpperCase();
  if (o.smartQuotes) t = t.replace(/(\w)'(\w)/g, "$1’$2").replace(/(^|[\s(\[{])'/g, "$1‘").replace(/'/g, "’").replace(/(^|[\s(\[{])"/g, "$1“").replace(/"/g, "”");
  if (vertical) t = t.replace(/“/g, "〝").replace(/”/g, "〟");
  if ((o.fullwidthMarks ?? vertical) !== false && vertical) {
    // keep 2-3 char runs of !? for tcy; convert lone marks
    t = t.replace(/[!?]+/g, (m) => (m.length >= 2 && m.length <= 3 ? m : m.replace(/!/g, "！").replace(/\?/g, "？")));
  }
  return t;
}

/** Parse markup into units. */
export function parseMarkup(input: string, opts: { markup?: boolean; normalize?: NormalizeOptions; vertical: boolean }): ParsedText {
  const out: ParsedText = { units: [], rubies: [], errors: [], infos: [] };
  const norm = opts.normalize ?? {};
  let text = input.replace(/\r\n?/g, "\n");
  if (norm.dropTrailingPeriod) text = text.replace(/。(?=\n|$)/g, "");
  if (opts.markup === false) {
    for (const g of splitGraphemes(normalizeChunk(text, norm, opts.vertical))) pushChar(out, g, {});
    return finish(out, norm, opts.vertical);
  }
  const styleStack: { name: string; style: InlineStyle }[] = [];
  const cur = (): InlineStyle => Object.assign({}, ...styleStack.map((s) => s.style));
  let nobrCounter = 0;
  let emph: boolean | string = false;
  let i = 0;
  let literal = "";
  const flush = () => {
    if (!literal) return;
    const st = cur();
    for (const g of splitGraphemes(normalizeChunk(literal, norm, opts.vertical))) {
      if (g === "\n") out.units.push({ kind: "break" });
      else pushChar(out, g, st, emph);
    }
    literal = "";
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && "《》｜|<>\\".includes(text[i + 1])) {
      literal += text[i + 1];
      i += 2;
      continue;
    }
    if (text.startsWith("《《", i)) {
      const end = text.indexOf("》》", i + 2);
      if (end < 0) {
        out.errors.push({ code: "TEXT_MARKUP_UNBALANCED", message: "unclosed 《《 emphasis" });
        literal += text.slice(i);
        break;
      }
      flush();
      emph = true;
      literal = text.slice(i + 2, end);
      flush();
      emph = false;
      i = end + 2;
      continue;
    }
    if ((c === "｜" || c === "|")) {
      const open = text.indexOf("《", i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (open > i + 1 && open - i - 1 <= 20 && (nl < 0 || nl > open) && text[open + 1] !== "《") {
        const close = text.indexOf("》", open + 1);
        if (close > open + 1) {
          flush();
          addRuby(out, text.slice(i + 1, open), text.slice(open + 1, close), cur(), norm, opts.vertical);
          i = close + 1;
          continue;
        }
      }
      literal += c;
      i++;
      continue;
    }
    if (c === "《") {
      const close = text.indexOf("》", i + 1);
      // implicit ruby: preceding kanji run in literal
      const m = literal.match(/[㐀-䶿一-鿿豈-﫿々〆ヶ]+$/u);
      if (close > i + 1 && m) {
        literal = literal.slice(0, literal.length - m[0].length);
        flush();
        addRuby(out, m[0], text.slice(i + 1, close), cur(), norm, opts.vertical);
        i = close + 1;
        continue;
      }
      if (close > i + 1) out.infos.push({ code: "TEXT_RUBY_NO_BASE", message: `《${text.slice(i + 1, close)}》 has no kanji base` });
      literal += c;
      i++;
      continue;
    }
    if (c === "<" && i + 1 < text.length && /[A-Za-z/]/.test(text[i + 1])) {
      const close = text.indexOf(">", i);
      if (close < 0) {
        out.errors.push({ code: "TEXT_UNKNOWN_TAG", message: "unterminated tag" });
        literal += text.slice(i);
        break;
      }
      const body = text.slice(i + 1, close).trim();
      i = close + 1;
      const isClose = body.startsWith("/");
      const m = body.replace(/^\//, "").replace(/\/$/, "").match(/^([A-Za-z]+)(?:=("[^"]*"|'[^']*'|[^\s]+))?(.*)$/);
      if (!m || !TAGS.has(m[1])) {
        out.errors.push({ code: "TEXT_UNKNOWN_TAG", message: `unknown tag <${body}>` });
        continue;
      }
      const name = m[1];
      const val = m[2]?.replace(/^["']|["']$/g, "");
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([A-Za-z-]+)=("[^"]*"|'[^']*'|[^\s]+)/g)) attrs[a[1]] = a[2].replace(/^["']|["']$/g, "");
      flush();
      if (name === "br") {
        out.units.push({ kind: "break" });
        continue;
      }
      if (name === "wbr") {
        out.units.push({ kind: "wbr" });
        continue;
      }
      if (name === "space") {
        const v = val ?? "1em";
        const em = v.endsWith("em") ? parseFloat(v) : parseFloat(v) || 1;
        out.units.push({ kind: "space", em, style: cur() });
        continue;
      }
      if (isClose) {
        const idx = styleStack.map((s) => s.name).lastIndexOf(name);
        if (idx < 0) {
          out.errors.push({ code: "TEXT_MARKUP_UNBALANCED", message: `unexpected </${name}>` });
          continue;
        }
        const popped = styleStack.splice(idx);
        if (name === "em") emph = false;
        void popped;
        continue;
      }
      if (name === "ruby") {
        const end = text.indexOf("</ruby>", i);
        if (end < 0) {
          out.errors.push({ code: "TEXT_MARKUP_UNBALANCED", message: "unclosed <ruby>" });
          continue;
        }
        addRuby(out, text.slice(i, end), val ?? attrs.text ?? "", cur(), norm, opts.vertical);
        i = end + "</ruby>".length;
        continue;
      }
      const st: InlineStyle = {};
      switch (name) {
        case "b":
          st.bold = true;
          break;
        case "size":
          if (val && /^[\d.]+$/.test(val)) st.size = parseFloat(val);
          else if (val) st.sizeAbs = val;
          break;
        case "big":
          st.size = 1.25;
          break;
        case "small":
          st.size = 0.8;
          break;
        case "font":
          st.font = val;
          break;
        case "color":
          st.color = val;
          break;
        case "tcy":
          st.tcy = true;
          break;
        case "upright":
          st.upright = true;
          break;
        case "sideways":
          st.sideways = true;
          break;
        case "nobr":
          st.nobr = ++nobrCounter;
          break;
        case "shake":
          st.shake = true;
          break;
        case "hand":
          st.hand = true;
          break;
        case "em":
          // <em mark=dot> chooses the mark for this span
          emph = val ?? attrs.mark ?? true;
          break;
        case "scale":
          st.scaleX = attrs.x ? parseFloat(attrs.x) : val ? parseFloat(val) : 1;
          st.scaleY = attrs.y ? parseFloat(attrs.y) : 1;
          break;
      }
      // nested multipliers
      const parentSize = cur().size;
      if (st.size && parentSize) st.size *= parentSize;
      styleStack.push({ name, style: st });
      continue;
    }
    literal += c;
    i++;
  }
  flush();
  if (styleStack.length) out.errors.push({ code: "TEXT_MARKUP_UNBALANCED", message: `unclosed <${styleStack[styleStack.length - 1].name}>` });
  return finish(out, norm, opts.vertical);
}

function pushChar(out: ParsedText, g: string, style: InlineStyle, emph: boolean | string = false) {
  if (g === "\n") out.units.push({ kind: "break" });
  else out.units.push({ kind: "char", ch: g, style, emph: emph || undefined });
}

function addRuby(out: ParsedText, base: string, ruby: string, style: InlineStyle, norm: NormalizeOptions, vertical: boolean) {
  const id = out.rubies.length;
  const chars = splitGraphemes(normalizeChunk(base, norm, vertical));
  const parts = ruby.split(" ").filter(Boolean);
  let mono: string[] | null = null;
  if (parts.length > 1) {
    if (parts.length !== chars.length) out.errors.push({ code: "TEXT_RUBY_MISMATCH", message: `mono ruby count mismatch: ${base}《${ruby}》` });
    else mono = parts;
  }
  out.rubies.push({ id, text: parts.join(""), mono });
  for (const g of chars) out.units.push({ kind: "char", ch: g, style, ruby: id });
}

const TCY_MARKS = /^(?:[!?！？]{2,3})$/;

function finish(out: ParsedText, norm: NormalizeOptions, vertical: boolean): ParsedText {
  // spaceAfterMarks: insert full-width space after mid-line ！？ followed by ordinary char
  if (norm.spaceAfterMarks !== false) {
    const u = out.units;
    for (let i = 0; i + 1 < u.length; i++) {
      const a = u[i];
      const b = u[i + 1];
      if (a.kind === "char" && /^[！？]$/.test(a.ch) && b.kind === "char" && !/^[！？!?」』）】〉》、。…―ー\s]/.test(b.ch)) {
        u.splice(i + 1, 0, { kind: "space", em: 1, style: a.style });
        i++;
      }
    }
  }
  void vertical;
  return out;
}

/** auto tate-chu-yoko grouping (spec 7.10): marks digits */
export function assignTcy(units: Unit[], opt: { digits: number; marks: boolean; latin: number } | null, latinMode = "auto") {
  // manga lettering sets longer numbers and short capitals (OK, TV) upright, one per square
  const upright = (a: number, b: number) => {
    if (latinMode !== "auto") return;
    for (let k = a; k < b; k++) {
      const uu = units[k] as { style: InlineStyle };
      if (!uu.style.sideways && !uu.style.upright) uu.style = { ...uu.style, upright: true };
    }
  };
  const isLetter = (k: number) => k >= 0 && k < units.length && units[k].kind === "char" && /^[A-Za-z]$/.test((units[k] as { ch: string }).ch);
  let gid = 0;
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    if (u.kind !== "char") {
      i++;
      continue;
    }
    if (u.style.tcy) {
      let j = i;
      gid++;
      while (j < units.length && units[j].kind === "char" && (units[j] as { style: InlineStyle }).style.tcy) {
        (units[j] as { tcyGroup?: number }).tcyGroup = gid;
        j++;
      }
      i = j;
      continue;
    }
    if (!opt || u.ruby !== undefined) {
      i++;
      continue;
    }
    const runOf = (re: RegExp) => {
      let j = i;
      while (j < units.length) {
        const next = units[j];
        if (next.kind !== "char" || next.ruby !== undefined || next.style.tcy || !re.test(next.ch)) break;
        j++;
      }
      return j;
    };
    if (/^[0-9]$/.test(u.ch)) {
      const j = runOf(/^[0-9]$/);
      if (j - i <= opt.digits && opt.digits > 0) {
        gid++;
        for (let k = i; k < j; k++) (units[k] as { tcyGroup?: number }).tcyGroup = gid;
      } else if (!isLetter(i - 1) && !isLetter(j)) upright(i, j);
      i = j;
      continue;
    }
    if (/^[!?！？]$/.test(u.ch) && opt.marks) {
      const j = runOf(/^[!?！？]$/);
      const s = units.slice(i, j).map((x) => (x as { ch: string }).ch).join("");
      if (j - i >= 2 && TCY_MARKS.test(s)) {
        gid++;
        for (let k = i; k < j; k++) {
          const uu = units[k] as { ch: string; tcyGroup?: number };
          uu.ch = uu.ch === "！" ? "!" : uu.ch === "？" ? "?" : uu.ch;
          uu.tcyGroup = gid;
        }
      }
      i = j;
      continue;
    }
    if (/^[A-Za-z]$/.test(u.ch)) {
      const j = runOf(/^[A-Za-z]$/);
      if (opt.latin > 0 && j - i <= opt.latin) {
        gid++;
        for (let k = i; k < j; k++) (units[k] as { tcyGroup?: number }).tcyGroup = gid;
      } else if (j - i <= 3 && /^[A-Z]+$/.test(units.slice(i, j).map((x) => (x as { ch: string }).ch).join(""))) {
        // a standalone short capital word (not part of a longer latin phrase):
        // two letters go across the column (OK, TV), three stand upright one per square
        const prev = i > 0 ? (units[i - 1] as { ch?: string }).ch ?? "" : "";
        const next = j < units.length ? (units[j] as { ch?: string }).ch ?? "" : "";
        if (!/^[A-Za-z0-9 ]$/.test(prev) && !/^[A-Za-z0-9 ]$/.test(next)) {
          if (j - i <= 2 && latinMode === "auto") {
            gid++;
            for (let k = i; k < j; k++) (units[k] as { tcyGroup?: number }).tcyGroup = gid;
          } else upright(i, j);
        }
      }
      i = j;
      continue;
    }
    i++;
  }
}

export function plainText(p: ParsedText): string {
  let s = "";
  for (const u of p.units) {
    if (u.kind === "char") s += u.ch;
    else if (u.kind === "break") s += "\n";
    else if (u.kind === "space") s += " ";
  }
  return s;
}

export { isKanji };
