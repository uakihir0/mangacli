// Text composition (spec 7.4-7.10, 7.15).
import * as hb from "harfbuzzjs";
import { Rng, noise1 } from "../core/random.js";
import type { FontPick, FontRegistry, LoadedFont } from "../fonts/registry.js";
import { type PathData, flattenPath, pathFromJson } from "../geom/path.js";
import { type Matrix, type Rect, boundsOf, matMul, matRotate, matScale, matTranslate } from "../geom/vec.js";
import { type KinsokuLevel, inseparable, isClosingPunct, isOpeningPunct, noEnd, noStart, phraseBoundaries, wordBoundaries } from "./linebreak.js";
import { type InlineStyle, type NormalizeOptions, type ParsedText, type Unit, assignTcy, parseMarkup } from "./markup.js";

export interface TextStyle {
  font: string;
  fontSize: number; // mm
  writing: "vertical" | "horizontal";
  /** uppercase: all caps (western comic lettering) */
  textTransform?: "uppercase" | "none";
  lineHeight: number; // multiplier
  lineHeightAbs?: number; // mm
  letterSpacing: number; // em
  align: "start" | "center" | "end" | "justify";
  wrap: "auto" | "none" | "char" | "phrase" | "balanced";
  maxChars?: number;
  maxExtent?: number; // mm
  kinsoku: KinsokuLevel;
  hanging: boolean;
  punctCompress: boolean;
  tcy: { digits: number; marks: boolean; latin: number } | null;
  latin: "auto" | "rotate" | "upright";
  ruby: { size: number; font?: string; position: "auto" | "right" | "left" | "over" | "under"; align?: "center" | "start"; overhang?: number };
  emphasis: { mark: string; size: number; position?: "auto" | "right" | "left" | "over" | "under"; color?: string };
  lettering: LetteringSpec | null;
  markup: boolean;
  normalize: NormalizeOptions;
  lang: string;
  glyphScale: [number, number];
  seed: number;
  /** OpenType features ({ palt: true }) */
  features?: Record<string, boolean | number>;
  /** variable-font weight (wght axis) */
  weight?: number;
}

export interface LetteringSpec {
  rotate: number; // radians sigma
  offset: number; // em sigma
  scale: number;
  baselineAmp: number; // em
  baselineLen: number; // em
  spacing: number; // em sigma
  wobble?: number; // em, outline roughness (applied by lettering consumers)
}

export interface GlyphOut {
  path: PathData;
  color?: string;
  unit: number;
  bold?: boolean;
  /** per-glyph local center for hand jitter / sfx transforms (block coords) */
  cx: number;
  cy: number;
}

export interface LineInfo {
  rect: Rect;
  length: number;
  /** the characters set on this line (inspect --text) */
  text?: string;
}

export interface TextLayout {
  glyphs: GlyphOut[];
  width: number;
  height: number;
  lines: LineInfo[];
  fontSize: number;
  missing: string[];
  errors: { code: string; message: string }[];
  infos: { code: string; message: string; severity?: "warning" | "info" }[];
  autoBreaks: number;
  plain: string;
  /** fonts that supplied glyphs */
  fonts?: string[];
}

type Orient = "upright" | "sideways" | "tcy";

interface Box {
  chars: string;
  units: number[];
  adv: number; // along line (mm)
  size: number; // em size mm
  orient: Orient;
  glyphs: { gid: number; font: LoadedFont; m: Matrix }[]; // matrix relative to box origin: vertical => (col center, box top); horizontal => (box left, baseline)
  breakBefore?: "forced";
  wbrBefore?: boolean;
  space?: boolean;
  ruby?: number;
  nobr?: number;
  color?: string;
  bold?: boolean;
  emph?: boolean | string;
  shake?: boolean;
  hand?: boolean;
  startPhrase?: boolean;
  /** a word start inside a phrase: the fallback when a phrase is longer than the line */
  startWord?: boolean;
  firstChar: string;
  lastChar: string;
}

const jsonCache = new Map<string, { type: string; values: number[] }[]>();

function glyphJson(f: LoadedFont, gid: number) {
  const key = `${f.key}:${gid}`;
  let j = jsonCache.get(key);
  if (!j) {
    j = f.font.glyphToJson(gid);
    jsonCache.set(key, j);
  }
  return j;
}

function shape(font: LoadedFont, text: string, dir: "ttb" | "ltr", lang: string) {
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  buf.setDirection(dir === "ttb" ? hb.Direction.TTB : hb.Direction.LTR);
  try {
    buf.setLanguage(lang);
  } catch {
    /* ignore */
  }
  hb.shape(font.font, buf, shapeFeatures.length ? shapeFeatures : undefined);
  const infos = buf.getGlyphInfos();
  const pos = buf.getGlyphPositions();
  return infos.map((g, i) => ({ gid: g.codepoint, cluster: g.cluster, ...pos[i] }));
}

function isLatinChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x21 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x24f);
}

export function layoutText(text: string, style: TextStyle, reg: FontRegistry, boxLimit?: number): TextLayout {
  const parsed: ParsedText = parseMarkup(text, { markup: style.markup, normalize: { ...(/^(ja|zh|ko)/.test(style.lang) ? style.normalize : { ellipsis: false, dash: false, waveDash: false, smartQuotes: true, ...style.normalize }), uppercase: style.textTransform === "uppercase" }, vertical: style.writing === "vertical" });
  if (style.writing === "vertical") assignTcy(parsed.units, style.tcy, style.latin);
  const vertical = style.writing === "vertical";
  const em = style.fontSize;
  const missing: string[] = [];
  tcyWarn = [];
  shapeFeatures = Object.entries(style.features ?? {}).map(([tag, v]) => new hb.Feature(tag, v === true ? 1 : v === false ? 0 : Number(v)));
  const boxes = buildBoxes(parsed, style, reg, missing);
  spreadRubyBases(parsed, boxes, style, reg, style.writing === "vertical");
  for (const t of tcyWarn) parsed.infos.push({ code: "TEXT_TCY_TOO_LONG", message: `tate-chu-yoko "${t}" does not fit in 1 em`, severity: "warning" });

  // phrase boundaries
  const plain = boxes.map((b) => b.chars).join("");
  const wrap = style.wrap === "auto" ? "phrase" : style.wrap;
  if (wrap === "phrase" || wrap === "balanced") {
    const bounds = phraseBoundaries(plain, style.lang);
    const words = wordBoundaries(plain, style.lang);
    let idx = 0;
    for (const b of boxes) {
      b.startPhrase = bounds.has(idx);
      b.startWord = bounds.has(idx) || words.has(idx);
      idx += b.chars.length;
    }
  }
  const limits: number[] = [];
  if (style.maxChars) {
    // maxChars counts characters: proportional latin text averages about half an em per character
    const latinShare = plain.length ? Array.from(plain).filter((c) => isLatinChar(c) || c === " ").length / Array.from(plain).length : 0;
    const perChar = style.writing === "horizontal" ? 1 - latinShare * 0.45 : 1;
    limits.push(style.maxChars * em * perChar * (1 + style.letterSpacing) + 1e-6);
  }
  if (style.maxExtent) limits.push(style.maxExtent);
  if (boxLimit) limits.push(boxLimit);
  const Lmax = limits.length && wrap !== "none" ? Math.min(...limits) : Infinity;
  let lines = breakLines(boxes, Lmax, wrap, style);
  if (wrap === "balanced" && isFinite(Lmax)) {
    const n = lines.length;
    let lo = em;
    let hi = Lmax;
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2;
      if (breakLines(boxes, mid, wrap, style).length <= n) hi = mid;
      else lo = mid;
    }
    lines = breakLines(boxes, hi, wrap, style);
  }
  const autoBreaks = lines.filter((l) => l.auto).length;

  // per-line advances with letter spacing and punctuation compression
  const ls = style.letterSpacing * em;
  const lineData = lines.map((ln) => {
    const advs = ln.boxes.map((b, i) => {
      let a = b.adv;
      if (style.punctCompress && i + 1 < ln.boxes.length) {
        const nx = ln.boxes[i + 1];
        // only full-width punctuation has the half-em of space that compression removes
        if (isClosingPunct(b.lastChar) && (isClosingPunct(nx.firstChar) || isOpeningPunct(nx.firstChar)) && b.orient !== "sideways" && b.adv > b.size * 0.8) a -= b.size * 0.5;
      }
      if (style.punctCompress && i > 0 && isOpeningPunct(b.firstChar) && isClosingPunct(ln.boxes[i - 1].lastChar) && b.orient !== "sideways" && b.adv > b.size * 0.8) a -= b.size * 0.5;
      return a + (i + 1 < ln.boxes.length ? ls : 0);
    });
    const len = advs.reduce((x, y) => x + y, 0);
    const size = Math.max(em, ...ln.boxes.map((b) => b.size));
    return { ln, advs, len, size };
  });
  const blockLen = Math.max(0, ...lineData.map((d) => d.len));
  const rng = new Rng(style.seed);
  const glyphs: GlyphOut[] = [];
  const outLines: LineInfo[] = [];
  const pitchFor = (size: number) => style.lineHeightAbs ?? size * style.lineHeight;
  const hasRuby = parsed.rubies.length > 0;

  if (vertical) {
    // columns right->left; x measured from block left later
    let x = 0;
    const cols: { center: number; d: (typeof lineData)[number] }[] = [];
    lineData.forEach((d, i) => {
      const pitch = pitchFor(d.size);
      if (i === 0) x = d.size / 2;
      else x += pitch;
      cols.push({ center: x, d });
    });
    const totalW = cols.length ? cols[cols.length - 1].center + cols[cols.length - 1].d.size / 2 : 0;
    const rubyExtra = hasRuby ? em * style.ruby.size : 0;
    const blockW = totalW + rubyExtra;
    for (const c of cols) {
      // right-to-left; the ruby space sits on the side the ruby is set on
      const cx = blockW - c.center - (style.ruby.position === "left" ? 0 : rubyExtra);
      const offset = alignOffset(style.align, blockLen, c.d.len);
      let y = offset;
      const just = style.align === "justify" && c.d.ln.boxes.length > 1 && c !== cols[cols.length - 1] ? (blockLen - c.d.len) / (c.d.ln.boxes.length - 1) : 0;
      c.d.ln.boxes.forEach((b, bi) => {
        emitBox(b, cx, y, true, glyphs, style, rng);
        (b as Box & { _pos?: [number, number] })._pos = [cx, y];
        y += c.d.advs[bi] + just;
      });
      outLines.push({ rect: { x: cx - c.d.size / 2, y: offset, w: c.d.size, h: c.d.len }, length: c.d.len, text: c.d.ln.boxes.map((b) => b.chars).join("") });
    }
    placeRuby(parsed, boxes, glyphs, style, reg, true);
    placeEmphasis(boxes, glyphs, style, reg, true);
    return { glyphs, width: blockW, height: blockLen, lines: outLines, fontSize: em, missing, errors: parsed.errors, infos: parsed.infos, autoBreaks, plain: plainOf(parsed), fonts: [...new Set(boxes.flatMap((b) => b.glyphs.map((g) => g.font.label)))] };
  }

  // horizontal
  let y = hasRuby ? em * style.ruby.size : 0;
  lineData.forEach((d, i) => {
    if (i > 0) y += pitchFor(d.size) - d.size;
    const asc = ascentRatio(d.ln.boxes) * d.size;
    const offset = alignOffset(style.align, blockLen, d.len);
    let x = offset;
    const just = style.align === "justify" && i < lineData.length - 1 && d.ln.boxes.length > 1 ? (blockLen - d.len) / (d.ln.boxes.length - 1) : 0;
    d.ln.boxes.forEach((b, bi) => {
      emitBox(b, x, y + asc, false, glyphs, style, rng);
      (b as Box & { _pos?: [number, number] })._pos = [x, y + asc];
      x += d.advs[bi] + just;
    });
    outLines.push({ rect: { x: offset, y, w: d.len, h: d.size }, length: d.len, text: d.ln.boxes.map((b) => b.chars).join("") });
    y += d.size;
  });
  placeRuby(parsed, boxes, glyphs, style, reg, false);
  placeEmphasis(boxes, glyphs, style, reg, false);
  return { glyphs, width: blockLen, height: y, lines: outLines, fontSize: em, missing, errors: parsed.errors, infos: parsed.infos, autoBreaks, plain: plainOf(parsed), fonts: [...new Set(boxes.flatMap((b) => b.glyphs.map((g) => g.font.label)))] };
}

function plainOf(p: ParsedText): string {
  return p.units.map((u) => (u.kind === "char" ? u.ch : u.kind === "break" ? "\n" : u.kind === "space" ? " " : "")).join("");
}

function ascentRatio(boxes: Box[]): number {
  const g = boxes.find((b) => b.glyphs.length)?.glyphs[0];
  if (!g) return 0.88;
  const f = g.font;
  return f.ascender / (f.ascender - f.descender || 1);
}

function alignOffset(align: TextStyle["align"], block: number, len: number): number {
  if (align === "center") return (block - len) / 2;
  if (align === "end") return block - len;
  return 0;
}

function emitBox(b: Box, ox: number, oy: number, _vertical: boolean, out: GlyphOut[], style: TextStyle, rng: Rng) {
  // <hand> borrows the hand-lettering jitter; <shake> is a stronger, irregular tremble
  const L = b.shake ? { rotate: (6 * Math.PI) / 180, scale: 0.05, offset: 0.07 } : b.hand && !style.lettering ? { rotate: (1.5 * Math.PI) / 180, scale: 0.03, offset: 0.025 } : style.lettering;
  for (const g of b.glyphs) {
    let m = matMul(matTranslate(ox, oy), g.m);
    // approximate glyph cell center for jitter
    const cx = ox + (_vertical ? 0 : b.adv / 2);
    const cy = oy + (_vertical ? b.adv / 2 : -b.size * 0.38);
    if (L) {
      const r = rng.normal() * L.rotate;
      const s = 1 + rng.normal() * L.scale;
      // a slow wave of the baseline across the line, and uneven spacing along it
      const along = _vertical ? oy : ox;
      const base = "baselineAmp" in L ? (L as LetteringSpec).baselineAmp * b.size * noise1(style.seed ^ 0x51, along / Math.max(1e-6, (L as LetteringSpec).baselineLen * b.size)) : 0;
      const sp = "spacing" in L ? rng.normal() * (L as LetteringSpec).spacing * b.size : 0;
      const dx = rng.normal() * L.offset * b.size + (_vertical ? base : sp);
      const dy = rng.normal() * L.offset * b.size + (_vertical ? sp : base);
      const jit: Matrix = matMul(matTranslate(cx + dx, cy + dy), matMul(matRotate(r), matMul(matScale(s), matTranslate(-cx, -cy))));
      m = matMul(jit, m);
    }
    out.push({ path: pathFromJson(glyphJson(g.font, g.gid), m), color: b.color, unit: b.units[0] ?? 0, bold: b.bold, cx, cy });
  }
}

function buildBoxes(parsed: ParsedText, style: TextStyle, reg: FontRegistry, missing: string[]): Box[] {
  const vertical = style.writing === "vertical";
  const em = style.fontSize;
  const boxes: Box[] = [];
  let pendingForced = false;
  let pendingWbr = false;
  const units = parsed.units;
  let i = 0;
  const sizeOf = (st: InlineStyle) => em * (st.size ?? 1);
  const fontOf = (st: InlineStyle) => {
    let f = st.font ?? style.font;
    if (st.bold) f = reg.boldName(f) ?? f;
    return f;
  };
  while (i < units.length) {
    const u = units[i];
    if (u.kind === "break") {
      pendingForced = true;
      i++;
      continue;
    }
    if (u.kind === "wbr") {
      pendingWbr = true;
      i++;
      continue;
    }
    if (u.kind === "space") {
      const size = sizeOf(u.style);
      boxes.push({ chars: " ", units: [i], adv: u.em * size, size, orient: "upright", glyphs: [], space: true, firstChar: " ", lastChar: " ", breakBefore: pendingForced ? "forced" : undefined });
      pendingForced = false;
      i++;
      continue;
    }
    // determine orientation
    const orientOf = (x: Unit & { kind: "char" }): Orient => {
      if (!vertical) return "upright";
      if (x.tcyGroup) return "tcy";
      if (x.style.upright) return "upright";
      if (x.style.sideways) return "sideways";
      if (isLatinChar(x.ch) || x.ch === " ") return style.latin === "upright" ? "upright" : "sideways";
      return "upright";
    };
    const o = orientOf(u);
    // collect run
    const run: number[] = [i];
    let j = i + 1;
    const key = (x: Unit & { kind: "char" }) => `${orientOf(x)}|${fontOf(x.style)}|${sizeOf(x.style)}|${x.style.color ?? ""}|${x.tcyGroup ?? ""}|${x.style.bold ? 1 : 0}|${x.style.nobr ?? ""}|${x.style.shake ? 1 : 0}|${x.style.hand ? 1 : 0}|${x.style.scaleX ?? ""}|${x.style.scaleY ?? ""}`;
    const k0 = key(u);
    while (j < units.length && units[j].kind === "char" && key(units[j] as Unit & { kind: "char" }) === k0 && (o !== "tcy" || (units[j] as { tcyGroup?: number }).tcyGroup === u.tcyGroup)) {
      run.push(j);
      j++;
    }
    const chars = run.map((k) => (units[k] as { ch: string }).ch);
    const st = u.style;
    const size = sizeOf(st);
    const fname = fontOf(st);
    const bold = !!st.bold && !reg.boldName(st.font ?? style.font);
    const first = boxes.length;
    // split run by font pick (per char) for shaping
    const picks: (FontPick | null)[] = chars.map((c) => reg.pick(fname, c.codePointAt(0)!));
    let s0 = 0;
    while (s0 < chars.length) {
      let s1 = s0 + 1;
      while (s1 < chars.length && picks[s1]?.font.key === picks[s0]?.font.key) s1++;
      const seg = chars.slice(s0, s1);
      const pk0 = picks[s0];
      const pk = pk0 && style.weight ? { ...pk0, font: reg.atWeight(pk0.font, style.weight) } : pk0;
      const segUnits = run.slice(s0, s1);
      if (!pk) {
        for (const c of seg) if (c.trim()) missing.push(c);
        const pf = reg.primary(fname);
        segUnits.forEach((ui, k) => {
          boxes.push({ chars: seg[k], units: [ui], adv: size, size, orient: o, glyphs: pf ? [{ gid: 0, font: pf, m: unitMatrix(pf, size, 0, 0, vertical) }] : [], firstChar: seg[k], lastChar: seg[k] });
        });
      } else {
        // <scale x= y=> narrows/flattens the run (長体・平体); the advance follows the line axis
        const runStyle = st.scaleX !== undefined || st.scaleY !== undefined ? { ...style, glyphScale: [style.glyphScale[0] * (st.scaleX ?? 1), style.glyphScale[1] * (st.scaleY ?? 1)] as [number, number] } : style;
        shapeSegment(seg, segUnits, pk, size, o, vertical, runStyle, boxes);
      }
      s0 = s1;
    }
    for (let b = first; b < boxes.length; b++) {
      const bx = boxes[b];
      const uu = units[bx.units[0]] as Unit & { kind: "char" };
      bx.color = st.color;
      bx.bold = bold;
      bx.ruby = uu.ruby;
      bx.nobr = st.nobr;
      bx.emph = uu.emph;
      bx.shake = st.shake;
      bx.hand = st.hand;
    }
    if (boxes.length > first) {
      if (pendingForced) boxes[first].breakBefore = "forced";
      if (pendingWbr) boxes[first].wbrBefore = true;
    }
    pendingForced = false;
    pendingWbr = false;
    i = j;
  }
  if (pendingForced) boxes.push({ chars: "", units: [], adv: 0, size: em, orient: "upright", glyphs: [], breakBefore: "forced", firstChar: "", lastChar: "" });
  return boxes;
}

function unitMatrix(f: LoadedFont, size: number, xOff: number, yOff: number, vertical: boolean): Matrix {
  const s = size / f.upem;
  if (vertical) return [s, 0, 0, -s, xOff * s, -yOff * s];
  return [s, 0, 0, -s, xOff * s, -yOff * s];
}

/** OpenType features of the layout in progress (style.features) */
let shapeFeatures: InstanceType<typeof hb.Feature>[] = [];

/** tate-chu-yoko runs squeezed below ~60 %, collected per layout call */
let tcyWarn: string[] = [];

const VERT_TURN = new Set(Array.from("〜～ー－―—–‐…‥（）「」『』【】〔〕〈〉《》［］｛｝＝＜＞→←"));
const vertCache = new Map<string, boolean>();

/** dashes are drawn cell to cell so a run (――) is one continuous line; some fonts overhang the cell */
const DASHES = new Set(["―", "—", "─", "━"]);
const inkCache = new Map<string, [number, number, number, number]>();
function inkBox(f: LoadedFont, gid: number): [number, number, number, number] {
  const key = `${f.key}:${gid}`;
  let r = inkCache.get(key);
  if (!r) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of glyphJson(f, gid) as { values: number[] }[])
      for (let i = 0; i + 1 < c.values.length; i += 2) {
        x0 = Math.min(x0, c.values[i]);
        x1 = Math.max(x1, c.values[i]);
        y0 = Math.min(y0, c.values[i + 1]);
        y1 = Math.max(y1, c.values[i + 1]);
      }
    r = [x0, y0, x1, y1];
    inkCache.set(key, r);
  }
  return r;
}
function fitDashes(per: Box[], vertical: boolean) {
  for (let i = 0; i < per.length; i++) {
    if (!DASHES.has(per[i].chars)) continue;
    // a font may set a dash pair as one ligature glyph on the first character
    let span = per[i].adv;
    for (let j = i + 1; j < per.length && DASHES.has(per[j].chars) && !per[j].glyphs.length; j++) span += per[j].adv;
    fitDash(per[i], vertical, span);
  }
}
function fitDash(b: Box, vertical: boolean, span: number) {
  if (b.glyphs.length !== 1) return;
  const g = b.glyphs[0];
  const [x0, y0, x1, y1] = inkBox(g.font, g.gid);
  if (!isFinite(x0)) return;
  const m = g.m;
  // extent along the line in box coordinates
  const p0 = vertical ? Math.min(m[3] * y0, m[3] * y1) + m[5] : Math.min(m[0] * x0, m[0] * x1) + m[4];
  const p1 = vertical ? Math.max(m[3] * y0, m[3] * y1) + m[5] : Math.max(m[0] * x0, m[0] * x1) + m[4];
  const len = p1 - p0;
  if (len <= 0 || (p0 >= -0.02 * b.adv && p1 <= span * 1.02)) return;
  const k = span / len;
  g.m = vertical ? [m[0], m[1], m[2], m[3] * k, m[4], (m[5] - p0) * k] : [m[0] * k, m[1], m[2], m[3], (m[4] - p0) * k, m[5]];
}
/** whether the font substitutes a vertical form for ch (vert / vrt2) */
function hasVertForm(f: LoadedFont, ch: string, lang: string): boolean {
  const key = `${f.key}|${ch}`;
  let v = vertCache.get(key);
  if (v === undefined) {
    const a = shape(f, ch, "ttb", lang)[0];
    const b = shape(f, ch, "ltr", lang)[0];
    v = !a || !b || a.gid !== b.gid;
    vertCache.set(key, v);
  }
  return v;
}

function shapeSegment(seg: string[], segUnits: number[], pk: FontPick, size0: number, o: Orient, vertical: boolean, style: TextStyle, boxes: Box[]) {
  const f = pk.font;
  const size = size0 * pk.scale;
  const s = size / f.upem;
  const [gx, gy] = style.glyphScale;
  const text = seg.join("");
  // cluster index -> char index
  const charStart: number[] = [];
  let acc = 0;
  for (const c of seg) {
    charStart.push(acc);
    acc += c.length;
  }
  const charOfCluster = (cl: number) => {
    let k = 0;
    while (k + 1 < charStart.length && charStart[k + 1] <= cl) k++;
    return k;
  };
  const bshift = pk.baselineShift * size;
  if (vertical && o === "upright") {
    // marks that must turn in vertical text: fonts without a vertical alternate get them rotated
    const turn = seg.findIndex((c) => VERT_TURN.has(c) && !hasVertForm(f, c, style.lang));
    if (turn >= 0) {
      if (turn > 0) shapeSegment(seg.slice(0, turn), segUnits.slice(0, turn), pk, size0, o, vertical, style, boxes);
      shapeSegment([seg[turn]], [segUnits[turn]], pk, size0, "sideways", vertical, style, boxes);
      const nb = boxes[boxes.length - 1];
      nb.orient = "upright";
      if (turn + 1 < seg.length) shapeSegment(seg.slice(turn + 1), segUnits.slice(turn + 1), pk, size0, o, vertical, style, boxes);
      return;
    }
    const g = shape(f, text, "ttb", style.lang);
    const per: Box[] = seg.map((c, k) => ({ chars: c, units: [segUnits[k]], adv: 0, size: size0, orient: o, glyphs: [], firstChar: c, lastChar: c }));
    const pen: number[] = new Array(seg.length).fill(0);
    for (const gl of g) {
      const k = charOfCluster(gl.cluster);
      const m: Matrix = [s * gx, 0, 0, -s * gy, gl.xOffset * s * gx + bshift, -(gl.yOffset + f.vOriginFix) * s * gy - pen[k]];
      per[k].glyphs.push({ gid: gl.gid, font: f, m });
      const adv = -gl.yAdvance * s * gy;
      per[k].adv += adv;
      pen[k] -= adv;
    }
    for (const b of per) if (b.adv === 0) b.adv = size;
    fitDashes(per, true);
    boxes.push(...per);
    return;
  }
  // horizontal shaping (horizontal writing, sideways, tcy)
  const g = shape(f, text, "ltr", style.lang);
  const xs: number[] = [];
  let px = 0;
  for (const gl of g) {
    xs.push(px);
    px += gl.xAdvance * s;
  }
  const asc = f.ascender * s;
  const desc = f.descender * s;
  const center = -(asc + desc) / 2; // canvas y of em center relative to baseline
  if (vertical && o === "tcy") {
    const W = px;
    const sx = W > size0 ? Math.max(0.5, size0 / W) : 1;
    if (W > size0 * 1.6) tcyWarn.push(text);
    const box: Box = { chars: text, units: segUnits.slice(), adv: size0, size: size0, orient: o, glyphs: [], firstChar: seg[0], lastChar: seg[seg.length - 1] };
    g.forEach((gl, k) => {
      // horizontal local: x along, y baseline -> place centered in column (x=0) and em cell
      const hx = (xs[k] + gl.xOffset * s - W / 2) * sx;
      const m: Matrix = [s * sx, 0, 0, -s, hx, size0 / 2 - center - gl.yOffset * s];
      box.glyphs.push({ gid: gl.gid, font: f, m });
    });
    boxes.push(box);
    return;
  }
  if (vertical && o === "sideways") {
    // split into words at spaces; each word a box rotated 90deg cw
    let k = 0;
    while (k < seg.length) {
      let e = k + 1;
      const isSp = seg[k] === " ";
      if (!isSp) while (e < seg.length && seg[e] !== " ") e++;
      const startCl = charStart[k];
      const endCl = e < charStart.length ? charStart[e] : text.length;
      const gls = g.map((gl, gi) => ({ gl, gi })).filter(({ gl }) => gl.cluster >= startCl && gl.cluster < endCl);
      const x0 = gls.length ? xs[gls[0].gi] : 0;
      const box: Box = { chars: seg.slice(k, e).join(""), units: segUnits.slice(k, e), adv: 0, size: size0, orient: o, glyphs: [], space: isSp, firstChar: seg[k], lastChar: seg[e - 1] };
      for (const { gl, gi } of gls) {
        const hx = xs[gi] - x0 + gl.xOffset * s;
        // horizontal glyph matrix H = [s,0,0,-s,hx,-yOff*s - center]; rotate cw: (X,Y) = (-y, x)
        const H: Matrix = [s, 0, 0, -s, hx, -gl.yOffset * s - center];
        const R: Matrix = [0, 1, -1, 0, 0, 0];
        box.glyphs.push({ gid: gl.gid, font: f, m: matMul(R, H) });
        box.adv += gl.xAdvance * s;
      }
      if (box.adv === 0) box.adv = size * 0.3;
      boxes.push(box);
      k = e;
    }
    return;
  }
  // horizontal writing: one box per char (cluster)
  const per: Box[] = seg.map((c, k) => ({ chars: c, units: [segUnits[k]], adv: 0, size: size0, orient: o, glyphs: [], firstChar: c, lastChar: c, space: c === " " }));
  const boxStart: number[] = new Array(seg.length).fill(NaN);
  g.forEach((gl, gi) => {
    const k = charOfCluster(gl.cluster);
    if (isNaN(boxStart[k])) boxStart[k] = xs[gi];
    const m: Matrix = [s * gx, 0, 0, -s * gy, (xs[gi] - boxStart[k] + gl.xOffset * s) * gx, -gl.yOffset * s - bshift];
    per[k].glyphs.push({ gid: gl.gid, font: f, m });
    per[k].adv += gl.xAdvance * s * gx;
  });
  fitDashes(per, false);
  // latin words should not break inside
  boxes.push(...per);
}

interface Line {
  boxes: Box[];
  auto: boolean;
}

function canBreakBetween(a: Box, b: Box, wrap: string, style: TextStyle): boolean {
  if (b.breakBefore === "forced") return true;
  if (wrap === "none") return false;
  if (noEnd(a.lastChar, style.kinsoku)) return false;
  if (noStart(b.firstChar, style.kinsoku)) return false;
  if (inseparable(a.lastChar, b.firstChar)) return false;
  if (a.ruby !== undefined && a.ruby === b.ruby) return false;
  if (a.nobr !== undefined && a.nobr === b.nobr) return false;
  // latin word continuity (horizontal): letters adjacent without space
  if (style.writing === "horizontal" && /[A-Za-z0-9'’]$/.test(a.lastChar) && /^[A-Za-z0-9'’.,!?…]/.test(b.firstChar)) return false;
  // trailing punctuation stays with its word (Unbelievable...)
  if (style.writing === "horizontal" && /[.,!?…'’"”)]$/.test(a.lastChar) && /^[.,!?…'’"”)]/.test(b.firstChar)) return false;
  if (/[0-9]$/.test(a.lastChar) && /^[0-9,.]/.test(b.firstChar)) return false;
  if (b.wbrBefore) return true;
  if ((wrap === "phrase" || wrap === "balanced") && b.startPhrase === false) return false;
  if (wrap === "word" && b.startWord === false) return false;
  return true;
}

function breakLines(boxes: Box[], Lmax: number, wrap: string, style: TextStyle): Line[] {
  const lines: Line[] = [];
  let cur: Box[] = [];
  let len = 0;
  let auto = false;
  const ls = style.letterSpacing * style.fontSize;
  const push = (isAuto: boolean) => {
    lines.push({ boxes: trimSpaces(cur), auto });
    auto = isAuto;
    cur = [];
    len = 0;
  };
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.breakBefore === "forced" && (cur.length || lines.length || i > 0)) {
      push(false);
      if (b.chars === "") continue;
    }
    if (b.chars === "" && b.breakBefore === "forced") continue;
    const adv = b.adv + (cur.length ? ls : 0);
    if (cur.length && len + adv > Lmax + 1e-6) {
      const prohibited = noStart(b.firstChar, style.kinsoku) && b.chars.length === 1 && b.adv <= b.size * 1.01;
      // hanging: 、。，． hang outside the line end
      if (prohibited && style.hanging && /^[、。，．,.]$/.test(b.firstChar)) {
        cur.push(b);
        len += adv;
        continue;
      }
      // last allowed break: right before the overflowing box if possible, else further back
      let k = canBreakBetween(cur[cur.length - 1], b, wrap, style) ? cur.length : -1;
      if (k < 0) for (let j = cur.length - 1; j >= 1; j--) {
        if (canBreakBetween(cur[j - 1], cur[j], wrap, style)) {
          k = j;
          break;
        }
      }
      if (k < 0 && (wrap === "phrase" || wrap === "balanced")) {
        // a phrase longer than the line: break at a word start inside it, else between characters
        for (let j = cur.length - 1; j >= 1 && k < 0; j--) if (canBreakBetween(cur[j - 1], cur[j], "word", style)) k = j;
        if (k < 0 && canBreakBetween(cur[cur.length - 1], b, "word", style)) k = cur.length;
      }
      if (k < 0 && (wrap === "phrase" || wrap === "balanced")) {
        for (let j = cur.length - 1; j >= 1; j--) {
          if (canBreakBetween(cur[j - 1], cur[j], "char", style)) {
            k = j;
            break;
          }
        }
        if (k < 0 && canBreakBetween(cur[cur.length - 1], b, "char", style)) k = cur.length;
      }
      if (k < 0 && canBreakBetween(cur[cur.length - 1], b, wrap, style)) k = cur.length;
      // a latin word longer than the line overflows rather than splitting mid-word (the balloon grows)
      if (k < 0 && style.writing === "horizontal" && /[A-Za-z0-9'’.,!?…]$/.test(cur[cur.length - 1].lastChar) && /^[A-Za-z0-9'’.,!?…]/.test(b.firstChar)) {
        cur.push(b);
        len += adv;
        continue;
      }
      if (k < 0) k = cur.length;
      // oidashi would leave a one-character line: fall back to oikomi (exceed by one character)
      if (prohibited && k <= 1) {
        cur.push(b);
        len += adv;
        continue;
      }
      const carry = cur.slice(k);
      cur = cur.slice(0, k);
      push(true);
      for (const c of carry) {
        cur.push(c);
        len += c.adv + (cur.length > 1 ? ls : 0);
      }
      if (cur.length && cur[0].space) {
        cur.shift();
        len = cur.reduce((x, c, idx) => x + c.adv + (idx ? ls : 0), 0);
      }
      if (!cur.length && b.space) continue;
    }
    cur.push(b);
    len += cur.length > 1 ? b.adv + ls : b.adv;
  }
  if (cur.length || lines.length === 0) push(false);
  return lines.filter((l, idx) => l.boxes.length > 0 || idx < lines.length - 1 || lines.length === 1);
}

function trimSpaces(bs: Box[]): Box[] {
  const out = bs.slice();
  while (out.length && out[out.length - 1].space && out[out.length - 1].chars === " ") out.pop();
  return out;
}

/** ruby longer than its base (plus the allowed overhang) spreads the base characters evenly (spec 7.8) */
function spreadRubyBases(parsed: ParsedText, boxes: Box[], style: TextStyle, reg: FontRegistry, vertical: boolean) {
  if (!parsed.rubies.length) return;
  const rsize = style.fontSize * style.ruby.size;
  const font = style.ruby.font ?? style.font;
  const hang = (style.ruby.overhang ?? 1) * rsize;
  const rubyLen = (text: string) => {
    if (vertical) return Array.from(text).length * rsize;
    const c0 = text.codePointAt(0);
    const pk = c0 !== undefined ? reg.pick(font, c0) : null;
    if (!pk) return Array.from(text).length * rsize;
    return shape(pk.font, text, "ltr", style.lang).reduce((a, g) => a + g.xAdvance * (rsize / pk.font.upem), 0);
  };
  for (const r of parsed.rubies) {
    const bs = boxes.filter((b) => b.ruby === r.id);
    if (!bs.length) continue;
    const groups = r.mono ? bs.map((b, k) => ({ text: r.mono![k] ?? "", boxes: [b] })) : [{ text: r.text, boxes: bs }];
    for (const g of groups) {
      const base = g.boxes.reduce((a, b) => a + b.adv, 0);
      const need = rubyLen(g.text) - base - 2 * hang;
      if (need <= 0.01) continue;
      const per = need / g.boxes.length;
      for (const b of g.boxes) {
        // grow the advance and keep the glyph centred in it
        b.adv += per;
        for (const gl of b.glyphs) {
          if (vertical) gl.m = [gl.m[0], gl.m[1], gl.m[2], gl.m[3], gl.m[4], gl.m[5] + per / 2];
          else gl.m = [gl.m[0], gl.m[1], gl.m[2], gl.m[3], gl.m[4] + per / 2, gl.m[5]];
        }
      }
    }
  }
}

function placeRuby(parsed: ParsedText, boxes: Box[], glyphs: GlyphOut[], style: TextStyle, reg: FontRegistry, vertical: boolean) {
  if (!parsed.rubies.length) return;
  const rsize = style.fontSize * style.ruby.size;
  const font = style.ruby.font ?? style.font;
  for (const r of parsed.rubies) {
    const bs = boxes.filter((b) => b.ruby === r.id) as (Box & { _pos?: [number, number] })[];
    if (!bs.length || !bs[0]._pos) continue;
    const segments: { text: string; boxes: typeof bs }[] = r.mono ? bs.map((b, k) => ({ text: r.mono![k] ?? "", boxes: [b] })) : [{ text: r.text, boxes: bs }];
    for (const sg of segments) {
      const first = sg.boxes[0]._pos!;
      const last = sg.boxes[sg.boxes.length - 1];
      const lp = last._pos!;
      const chars = Array.from(sg.text);
      if (!chars.length) continue;
      const startAlign = style.ruby.align === "start";
      if (vertical) {
        const start = first[1];
        const end = lp[1] + last.adv;
        const total = chars.length * rsize;
        let y = startAlign ? start : (start + end) / 2 - total / 2;
        // right of the column by default; `left` puts it on the other side
        const left = style.ruby.position === "left";
        const x = left ? first[0] - sg.boxes[0].size / 2 - rsize / 2 : first[0] + sg.boxes[0].size / 2 + rsize / 2;
        for (const c of chars) {
          const pk = reg.pick(font, c.codePointAt(0)!);
          if (pk) {
            const g = shape(pk.font, c, "ttb", style.lang);
            const s = rsize / pk.font.upem;
            let pen = 0;
            for (const gl of g) {
              const m: Matrix = [s, 0, 0, -s, x + gl.xOffset * s, y - (gl.yOffset + pk.font.vOriginFix) * s + pen];
              glyphs.push({ path: pathFromJson(glyphJson(pk.font, gl.gid), m), unit: sg.boxes[0].units[0], cx: x, cy: y });
              pen += -gl.yAdvance * s;
            }
          }
          y += rsize;
        }
      } else {
        const start = first[0];
        const end = lp[0] + last.adv;
        const pk0 = reg.pick(font, chars[0].codePointAt(0)!);
        if (!pk0) continue;
        const g = shape(pk0.font, sg.text, "ltr", style.lang);
        const s = rsize / pk0.font.upem;
        const W = g.reduce((a, gl) => a + gl.xAdvance * s, 0);
        let x = startAlign ? start : (start + end) / 2 - W / 2;
        // over the line by default; `under` sets it below the baseline
        const y = style.ruby.position === "under" ? first[1] + sg.boxes[0].size * 0.12 + rsize * 0.88 : first[1] - sg.boxes[0].size * 0.95;
        for (const gl of g) {
          const m: Matrix = [s, 0, 0, -s, x + gl.xOffset * s, y - gl.yOffset * s];
          glyphs.push({ path: pathFromJson(glyphJson(pk0.font, gl.gid), m), unit: sg.boxes[0].units[0], cx: x, cy: y });
          x += gl.xAdvance * s;
        }
      }
    }
  }
}

function placeEmphasis(boxes: Box[], glyphs: GlyphOut[], style: TextStyle, reg: FontRegistry, vertical: boolean) {
  const marks: Record<string, string> = { sesame: "﹅", "open-sesame": "﹆", dot: "・", circle: "○", "filled-circle": "●", triangle: "▲" };
  const size = style.fontSize * style.emphasis.size;
  const pos = style.emphasis.position ?? "auto";
  for (const b of boxes as (Box & { _pos?: [number, number] })[]) {
    if (!b.emph || !b._pos || b.space || /^[、。，．「」『』（）！？!?…ー\s]$/.test(b.chars)) continue;
    const ch = marks[typeof b.emph === "string" ? b.emph : style.emphasis.mark] ?? "﹅";
    const pk = reg.pick(style.font, ch.codePointAt(0)!);
    if (!pk) continue;
    const g = shape(pk.font, ch, "ltr", style.lang)[0];
    let s = size / pk.font.upem;
    // center the mark's ink box on the target point (glyph metrics of ﹅ vary by font)
    let raw = pathFromJson(glyphJson(pk.font, g.gid), [s, 0, 0, -s, 0, 0]);
    let pts = flattenPath(raw).flatMap((q) => q.pts);
    if (!pts.length) continue;
    let bb = boundsOf(pts);
    // geometric marks are normalised to a common ink size (fonts draw ● much larger than ・)
    if (ch !== "﹅" && ch !== "﹆") {
      const k = (size * 0.42) / Math.max(1e-6, Math.max(bb.w, bb.h));
      s *= k;
      raw = pathFromJson(glyphJson(pk.font, g.gid), [s, 0, 0, -s, 0, 0]);
      pts = flattenPath(raw).flatMap((q) => q.pts);
      bb = boundsOf(pts);
    }
    const tx = vertical ? b._pos[0] + (pos === "left" ? -1 : 1) * (b.size / 2 + size * 0.45) : b._pos[0] + b.adv / 2;
    const ty = vertical ? b._pos[1] + b.adv / 2 : pos === "under" ? b._pos[1] + b.size * 0.12 + size * 0.6 : b._pos[1] - b.size * 0.88 - size * 0.5;
    const dx = tx - (bb.x + bb.w / 2);
    const dy = ty - (bb.y + bb.h / 2);
    glyphs.push({ path: pathFromJson(glyphJson(pk.font, g.gid), [s, 0, 0, -s, dx, dy]), unit: b.units[0], cx: tx, cy: ty, color: style.emphasis.color ?? b.color });
  }
}

export function defaultTextStyle(partial: Partial<TextStyle> & { font: string; fontSize: number }): TextStyle {
  return {
    writing: "vertical",
    lineHeight: 1.45,
    letterSpacing: 0,
    align: "start",
    wrap: "auto",
    kinsoku: "strict",
    hanging: false,
    punctCompress: true,
    tcy: { digits: 2, marks: true, latin: 0 },
    latin: "auto",
    ruby: { size: 0.5, position: "auto" },
    emphasis: { mark: "sesame", size: 0.5 },
    lettering: null,
    markup: true,
    normalize: {},
    lang: "ja",
    glyphScale: [1, 1],
    seed: 1,
    ...partial,
  };
}
