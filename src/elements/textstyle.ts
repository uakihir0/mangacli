// props -> TextStyle (spec 7.2)
import { type UnitContext, parseAngle, parseLength, toMm } from "../core/units.js";
import { isObj } from "../load/normalize.js";
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
  const fontSize0 = toMm((p.fontSize as string) ?? "13bQ", u);
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
  const align = (p.align as TextStyle["align"]) ?? (isBalloon && writing === "horizontal" ? "center" : "start");
  let maxChars = typeof p.maxChars === "number" ? p.maxChars : undefined;
  if (maxChars === undefined && isBalloon) maxChars = writing === "vertical" ? 8 : 14;
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
      baselineAmp: 0.04,
      baselineLen: 4,
      spacing: 0.03,
    };
  }
  const ruby = (p.ruby ?? {}) as Obj;
  const emph = (p.emphasis ?? {}) as Obj;
  return defaultTextStyle({
    font: (p.font as string) ?? "dialogue",
    fontSize,
    writing,
    lineHeight,
    lineHeightAbs,
    letterSpacing: ls,
    align,
    wrap: (p.wrap as TextStyle["wrap"]) ?? "auto",
    maxChars,
    maxExtent: p.maxExtent !== undefined ? toMm(p.maxExtent as string, emCtx) : undefined,
    kinsoku: (p.kinsoku as TextStyle["kinsoku"]) ?? "strict",
    hanging: !!p.hanging,
    punctCompress: p.punctCompress !== "none",
    tcy,
    latin: (p.latin as TextStyle["latin"]) ?? "auto",
    ruby: { size: (ruby.size as number) ?? 0.5, font: ruby.font as string | undefined, position: (ruby.position as TextStyle["ruby"]["position"]) ?? "auto", align: (ruby.align as "center" | "start") ?? "center", overhang: typeof ruby.overhang === "number" ? ruby.overhang : 1 },
    emphasis: { mark: (emph.mark as string) ?? "sesame", size: (emph.size as number) ?? 0.5 },
    lettering,
    markup: p.markup !== false,
    normalize: (p.normalize as Obj) ?? {},
    lang,
    glyphScale: (p.glyphScale as [number, number]) ?? [1, 1],
    seed,
  });
}
