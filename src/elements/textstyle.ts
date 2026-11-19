// props -> TextStyle (spec 7.2)
import { type UnitContext, parseAngle, parseLength, toMm } from "../core/units.js";
import { isObj } from "../load/normalize.js";
import { DEFAULT_BALLOON_FONT_SIZE } from "../model/defaults.js";
import { type LetteringSpec, type TextStyle, defaultTextStyle } from "../text/layout.js";

type Obj = Record<string, unknown>;

export function textValue(v: unknown, lang: string, defaultLang: string, onMissing?: () => void): string {
  if (typeof v === "string") return v;
  if (isObj(v)) {
    if (typeof v[lang] === "string") return v[lang] as string;
    onMissing?.();
    if (typeof v[defaultLang] === "string") return v[defaultLang] as string;
    const first = Object.values(v).find((x) => typeof x === "string");
    return (first as string) ?? "";
  }
  return v === undefined || v === null ? "" : String(v);
}

export function resolveTextStyle(p: Obj, u: UnitContext, lang: string, isBalloon: boolean, seed: number): TextStyle {
  const vertDefault = lang.startsWith("ja") ? "vertical" : "horizontal";
  const writing = (p.writing as "vertical" | "horizontal") ?? vertDefault;
  const fontSize0 = toMm((p.fontSize as string) ?? (isBalloon ? DEFAULT_BALLOON_FONT_SIZE : "13bQ"), u);
  const fontSize = fontSize0 * (typeof p.fontScale === "number" ? p.fontScale : 1);
  const emCtx: UnitContext = { ...u, em: fontSize };
  let lineHeight = writing === "vertical" ? 1.45 : 1.4;
  let lineHeightAbs: number | undefined;
  if (typeof p.lineHeight === "number") lineHeight = p.lineHeight;
  else if (typeof p.lineHeight === "string") {
    const q = parseLength(p.lineHeight);
    if (q && q.unit === "") lineHeight = q.value;
    else lineHeightAbs = toMm(p.lineHeight, emCtx);
  }
  const ls = p.letterSpacing !== undefined ? toMm(p.letterSpacing as string, emCtx) / fontSize : 0;
  const shape = isObj(p.shape) ? p.shape.kind ?? "ellipse" : "ellipse";
  const centered = isBalloon && (writing === "horizontal" || shape === "ellipse" || shape === "round-rect" || shape === "cloud");
  const align = (p.align as TextStyle["align"]) ?? (centered ? "center" : "start");
  let maxChars = typeof p.maxChars === "number" ? p.maxChars : undefined;
  if (maxChars === undefined && isBalloon) {
    maxChars = writing === "vertical" ? 8 : 14;
    // lines the author broke by hand are kept whole when they are only a little longer
    if (typeof p.text === "string" && p.text.includes("\n")) {
      const plain = p.text.replace(/<[^>]*>/g, "").replace(/《[^》]*》/g, "").replace(/[｜|]/g, "");
      const longest = Math.max(...plain.split("\n").map((l) => Array.from(l.trim()).length));
      maxChars = Math.min(Math.round(maxChars * 1.5), Math.max(maxChars, longest));
    }
  }
  const tcy =
    p.tcy === "none"
      ? null
      : isObj(p.tcy)
        ? { digits: (p.tcy.digits as number) ?? 2, marks: (p.tcy.marks as boolean) ?? true, latin: (p.tcy.latin as number) ?? 0 }
        : { digits: 2, marks: true, latin: 0 };
  let lettering: LetteringSpec | null = null;
  const L = p.lettering as Obj | undefined;
  if (isObj(L) && L.mode === "hand") {
    lettering = {
      rotate: L.rotate !== undefined ? parseAngle(L.rotate as string) : (1.5 * Math.PI) / 180,
      offset: L.offset !== undefined ? toMm(L.offset as string, emCtx) / fontSize : 0.03,
      scale: typeof L.scale === "number" ? L.scale : 0.04,
      baselineAmp: isObj(L.baseline) && (L.baseline as Obj).amplitude !== undefined ? toMm((L.baseline as Obj).amplitude as string, emCtx) / fontSize : 0.04,
      baselineLen: isObj(L.baseline) && (L.baseline as Obj).wavelength !== undefined ? toMm((L.baseline as Obj).wavelength as string, emCtx) / fontSize : 4,
      spacing: L.spacing !== undefined ? toMm(L.spacing as string, emCtx) / fontSize : 0.03,
      wobble: L.wobble !== undefined ? toMm(L.wobble as string, emCtx) / fontSize : 0.012,
    };
  }
  const ruby = (p.ruby ?? {}) as Obj;
  const emph = (p.emphasis ?? {}) as Obj;
  return defaultTextStyle({
    font: (p.font as string) ?? "dialogue",
    fontSize,
    writing,
    // western comic balloons are lettered in capitals unless the document says otherwise
    textTransform: p.textTransform === "uppercase" || (p.textTransform !== "none" && isBalloon && !/^(ja|zh|ko)/.test(lang) && writing === "horizontal") ? "uppercase" : "none",
    lineHeight,
    lineHeightAbs,
    letterSpacing: ls,
    align,
    // horizontal balloons balance their lines (no short last line)
    wrap: (p.wrap as TextStyle["wrap"]) ?? (isBalloon && writing === "horizontal" ? "balanced" : "auto"),
    maxChars,
    maxExtent: p.maxExtent !== undefined ? toMm(p.maxExtent as string, emCtx) : undefined,
    kinsoku: (p.kinsoku as TextStyle["kinsoku"]) ?? "strict",
    hanging: !!p.hanging,
    punctCompress: p.punctCompress !== "none",
    tcy,
    latin: (p.latin as TextStyle["latin"]) ?? "auto",
    ruby: { size: (ruby.size as number) ?? 0.5, font: ruby.font as string | undefined, position: (ruby.position as TextStyle["ruby"]["position"]) ?? "auto", align: (ruby.align as "center" | "start") ?? "center", overhang: typeof ruby.overhang === "number" ? ruby.overhang : 1 },
    weight: typeof p.weight === "number" ? p.weight : undefined,
    features: isObj(p.features) ? (p.features as Record<string, boolean | number>) : undefined,
    emphasis: { mark: (emph.mark as string) ?? "sesame", size: (emph.size as number) ?? 0.5, position: emph.position as TextStyle["emphasis"]["position"], color: emph.color as string | undefined },
    lettering,
    markup: p.markup !== false,
    normalize: (p.normalize as Obj) ?? {},
    lang,
    glyphScale: (p.glyphScale as [number, number]) ?? [1, 1],
    seed,
  });
}
