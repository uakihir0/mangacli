// Shorthand expansion (spec 3.9). Operates on plain JS data (after YAML parse).
import { isColorString } from "../core/color.js";
import type { DiagnosticBag } from "../core/diagnostics.js";
import { isLength } from "../core/units.js";

type Obj = Record<string, unknown>;
type Path = (string | number)[];

export const ELEMENT_TYPES = ["image", "balloon", "text", "sfx", "effect", "fill", "mark", "draw", "group", "scatter"] as const;
const SHORTHAND_ORDER = ["image", "balloon", "aside", "sfx", "text", "effect", "mark", "draw", "tone", "group", "scatter"];
const PRIMARY: Record<string, [string, string]> = {
  image: ["image", "src"],
  balloon: ["balloon", "text"],
  aside: ["balloon", "text"],
  sfx: ["sfx", "text"],
  text: ["text", "text"],
  effect: ["effect", "kind"],
  mark: ["mark", "kind"],
  draw: ["draw", "kind"],
  tone: ["fill", "paint"],
  group: ["group", "children"],
  scatter: ["scatter", "items"],
};
const STROKE_STYLES = new Set(["solid", "dashed", "dotted", "double", "none"]);
const TAIL_KINDS = new Set(["wedge", "bubbles", "line", "zigzag", "none"]);
export const MARK_KINDS = new Set([
  "sweat", "sweat-burst", "anger", "blush", "surprise", "sparkle", "heart", "note", "exclamation", "question", "steam", "zzz",
  "motion", "tremble", "spiral", "dots", "tears", "shine", "pop", "idea", "snot-bubble", "sigh", "pale", "dizzy-stars", "asset",
]);
const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?)$/i;
const IMG_EXT = /\.(png|jpe?g|webp|avif|gif|tiff?|svg)$/i;

export function isObj(x: unknown): x is Obj {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** maps whose keys are user-chosen names, not schema keys: `x-` is a valid name there */
const NAME_MAPS = new Set(["profiles", "styles", "assets", "characters", "fonts", "locales", "anchors", "regions", "diagnostics", "weights"]);

function stripExt(o: unknown, parent = ""): unknown {
  if (Array.isArray(o)) return o.map((x) => stripExt(x));
  if (!isObj(o)) return o;
  const out: Obj = {};
  const names = NAME_MAPS.has(parent);
  for (const [k, v] of Object.entries(o)) if (names || !k.startsWith("x-")) out[k] = stripExt(v, names ? "" : k);
  keepInclude(o, out);
  return out;
}

/** pages from an include carry its `defaults` as a hidden property; keep it through copies */
function keepInclude(from: Obj, to: Obj) {
  const inc = (from as { __includeDefaults?: Obj }).__includeDefaults;
  if (inc) Object.defineProperty(to, "__includeDefaults", { value: inc, enumerable: false });
}

export function normStroke(v: unknown, path: Path, bag: DiagnosticBag): unknown {
  if (typeof v === "number") return { width: v };
  if (isObj(v)) return "pen" in v ? { ...v, pen: normPen(v.pen) } : v;
  if (typeof v !== "string") return v;
  const toks = v.trim().split(/\s+/);
  if (toks.length === 1 && toks[0] === "none") return { style: "none" };
  const out: Obj = {};
  for (const t of toks) {
    if (STROKE_STYLES.has(t) && t !== "none") out.style = t;
    else if (isLength(t)) out.width = t;
    else if (isColorString(t)) out.color = t;
    else bag.error("SCHEMA_TYPE", `invalid stroke token "${t}"`, { path });
  }
  return out;
}

export function normOutline(v: unknown, path: Path, bag: DiagnosticBag): unknown {
  if (v === "none") return [];
  if (typeof v === "string" || typeof v === "number") {
    const toks = String(v).trim().split(/\s+/);
    const o: Obj = {};
    for (const t of toks) {
      if (isLength(t)) o.width = t;
      else if (isColorString(t)) o.color = t;
      else bag.error("SCHEMA_TYPE", `invalid outline token "${t}"`, { path });
    }
    return [o];
  }
  if (isObj(v)) return [v];
  return v;
}

function normHand(v: unknown): unknown {
  if (v === false) return { preset: "clean" };
  if (typeof v === "string") return { preset: v };
  if (typeof v === "number") return { roughness: v };
  return v;
}

function normPen(v: unknown): unknown {
  return typeof v === "string" ? { preset: v } : v;
}

function normElement(raw: unknown, path: Path, bag: DiagnosticBag): unknown {
  if (!isObj(raw)) {
    bag.error("SCHEMA_TYPE", "element must be a mapping", { path });
    return raw;
  }
  let el: Obj = { ...raw };
  if (!("type" in el)) {
    const key = SHORTHAND_ORDER.find((k) => k in el);
    if (!key) {
      bag.error("SCHEMA_REQUIRED", "element needs a type (or shorthand key such as image/balloon/text)", { path });
      return el;
    }
    const [type, prim] = PRIMARY[key];
    const val = el[key];
    delete el[key];
    if (prim !== key && prim in el && key !== "text") {
      bag.error("SCHEMA_SHORTHAND_CONFLICT", `both "${key}" and "${prim}" are given`, { path });
    }
    if (key === "balloon" || key === "aside" || key === "sfx") {
      if ("text" in el) bag.error("SCHEMA_SHORTHAND_CONFLICT", `both "${key}" and "text" are given`, { path });
    }
    el = { type, ...el };
    if (key === "aside") el.as = "aside";
    if (key === "tone") el.paint = typeof val === "string" && /^[\d.]+%$/.test(val.trim()) ? `tone(${val})` : val;
    else if (key === "scatter") el.items = Array.isArray(val) ? val : [val];
    else el[prim] = val;
  }
  const type = el.type as string;
  // property shorthands
  if ("stroke" in el) el.stroke = normStroke(el.stroke, [...path, "stroke"], bag);
  if ("edge" in el && type === "sfx") el.edge = normStroke(el.edge, [...path, "edge"], bag);
  if ("outline" in el) el.outline = normOutline(el.outline, [...path, "outline"], bag);
  if ("textOutline" in el) el.textOutline = normOutline(el.textOutline, [...path, "textOutline"], bag);
  if ("hand" in el) el.hand = normHand(el.hand);
  if ("pen" in el) el.pen = normPen(el.pen);
  if (typeof el.shape === "string") el.shape = { kind: el.shape };
  if (isObj(el.shape) && "strokes" in (el.shape as Obj)) {
    /* keep */
  }
  if ("tail" in el) el.tail = normTail(el.tail);
  if (Array.isArray(el.tails)) el.tails = el.tails.map(normTail);
  if ("padding" in el && !Array.isArray(el.padding)) el.padding = [el.padding, el.padding];
  if (isObj(el.stroke) && "hand" in (el.stroke as Obj)) (el.stroke as Obj).hand = normHand((el.stroke as Obj).hand);
  if (isObj(el.stroke) && "pen" in (el.stroke as Obj)) (el.stroke as Obj).pen = normPen((el.stroke as Obj).pen);
  if (type === "group" && Array.isArray(el.children)) el.children = el.children.map((c, i) => normElement(c, [...path, "children", i], bag));
  if (type === "scatter" && Array.isArray(el.items))
    el.items = el.items.map((it) => (typeof it === "string" ? (MARK_KINDS.has(it) ? { mark: it } : { asset: it }) : it));
  if (typeof el.lettering === "string") el.lettering = { mode: el.lettering };
  if (typeof el.clip === "object" && el.clip && !Array.isArray(el.clip)) {
    /* clip object */
  }
  return el;
}

function normTail(v: unknown): unknown {
  if (typeof v === "string") return TAIL_KINDS.has(v) ? { kind: v } : { to: v };
  if (Array.isArray(v)) return { to: v };
  return v;
}

function normDialogue(lines: unknown, path: Path, bag: DiagnosticBag, characters: Set<string>): unknown[] {
  if (!Array.isArray(lines)) {
    bag.error("SCHEMA_TYPE", "dialogue must be a list", { path });
    return [];
  }
  return lines.map((ln, i) => {
    if (typeof ln === "string") return { text: ln };
    if (!isObj(ln)) return ln;
    const keys = Object.keys(ln);
    let out: Obj = { ...ln };
    if (keys.length === 1 && !["text", "who", "as"].includes(keys[0])) {
      const who = keys[0];
      if (!characters.has(who)) bag.error("REF_NOT_FOUND", `unknown character "${who}" in dialogue`, { path: [...path, i] });
      return { who, text: ln[who] };
    }
    // `<character>: text` combined with other balloon properties ({ taro: えっ, as: shout })
    const charKeys = keys.filter((k) => characters.has(k));
    if (charKeys.length === 1 && !("who" in ln) && !("text" in ln)) {
      const who = charKeys[0];
      out = { who, text: ln[who], ...Object.fromEntries(Object.entries(ln).filter(([k]) => k !== who)) };
    }
    if ("stroke" in out) out.stroke = normStroke(out.stroke, [...path, i, "stroke"], bag);
    if (typeof out.shape === "string") out.shape = { kind: out.shape };
    if ("tail" in out) out.tail = normTail(out.tail);
    if ("textOutline" in out) out.textOutline = normOutline(out.textOutline, [...path, i, "textOutline"], bag);
    return out;
  });
}

function normLayout(v: unknown): unknown {
  if (!isObj(v)) return v;
  const o: Obj = { ...v };
  if (Array.isArray(o.rows)) o.rows = o.rows.map((r) => (Array.isArray(r) ? { cols: r } : r));
  return o;
}

function normPanel(p: unknown, path: Path, bag: DiagnosticBag, chars: Set<string>): unknown {
  if (!isObj(p)) return p;
  const o: Obj = { ...p };
  if (typeof o.bleed === "string") o.bleed = o.bleed === "all" ? ["top", "right", "bottom", "left"] : [o.bleed];
  if (o.bleed === true) o.bleed = ["top", "right", "bottom", "left"];
  if ("border" in o) o.border = normStroke(o.border, [...path, "border"], bag);
  if (typeof o.shape === "string") o.shape = { kind: o.shape };
  if ("hand" in o) o.hand = normHand(o.hand);
  if (Array.isArray(o.layers)) o.layers = o.layers.map((e, i) => normElement(e, [...path, "layers", i], bag));
  if ("dialogue" in o) o.dialogue = normDialogue(o.dialogue, [...path, "dialogue"], bag, chars);
  if (isObj(o.defaults)) o.defaults = normDefaults(o.defaults, [...path, "defaults"], bag);
  return o;
}

function normDefaults(d: Obj, path: Path, bag: DiagnosticBag): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === "effect" || k === "mark") {
      const m: Obj = {};
      if (isObj(v)) for (const [kk, vv] of Object.entries(v)) m[kk] = isObj(vv) ? normElementProps(vv, [...path, k, kk], bag) : vv;
      out[k] = m;
    } else if (k === "panel" && isObj(v)) {
      const pp: Obj = { ...v };
      if ("border" in pp) pp.border = normStroke(pp.border, [...path, k, "border"], bag);
      if ("hand" in pp) pp.hand = normHand(pp.hand);
      out[k] = pp;
    } else out[k] = isObj(v) ? normElementProps(v, [...path, k], bag) : v;
  }
  return out;
}

/** normalize property shorthands for a partial element (styles/defaults/characters) */
export function normElementProps(v: Obj, path: Path, bag: DiagnosticBag): Obj {
  const o: Obj = { ...v };
  if ("stroke" in o) o.stroke = normStroke(o.stroke, [...path, "stroke"], bag);
  if ("outline" in o) o.outline = normOutline(o.outline, [...path, "outline"], bag);
  if ("textOutline" in o) o.textOutline = normOutline(o.textOutline, [...path, "textOutline"], bag);
  if ("hand" in o) o.hand = normHand(o.hand);
  if ("pen" in o) o.pen = normPen(o.pen);
  if (typeof o.shape === "string") o.shape = { kind: o.shape };
  if ("tail" in o) o.tail = normTail(o.tail);
  if ("padding" in o && !Array.isArray(o.padding)) o.padding = [o.padding, o.padding];
  if (o.size === "auto") o.size = ["auto", "auto"];
  if (typeof o.lettering === "string") o.lettering = { mode: o.lettering };
  return o;
}

export function normFontDef(v: unknown): unknown {
  if (typeof v === "string") {
    if (v.startsWith("catalog:")) {
      const m = v.slice(8).match(/^([^@]+)(?:@(\d+))?$/);
      return m ? { catalog: m[1], ...(m[2] ? { weight: Number(m[2]) } : {}) } : { catalog: v.slice(8) };
    }
    if (FONT_EXT.test(v)) return { src: v };
    return { alias: v };
  }
  return v;
}

export function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || IMG_EXT.test(s) || FONT_EXT.test(s) || s.startsWith("data:");
}

export function normalizeDocument(input: unknown, bag: DiagnosticBag): Obj {
  const doc = stripExt(input);
  if (!isObj(doc)) {
    bag.error("SCHEMA_TYPE", "document must be a mapping");
    return {};
  }
  const out: Obj = { ...doc };
  const chars = new Set(isObj(doc.characters) ? Object.keys(doc.characters) : []);
  if (isObj(doc.assets)) {
    const a: Obj = {};
    for (const [k, v] of Object.entries(doc.assets)) a[k] = typeof v === "string" ? { src: v } : v;
    out.assets = a;
  }
  if (isObj(doc.fonts)) {
    const f: Obj = {};
    for (const [k, v] of Object.entries(doc.fonts)) f[k] = normFontDef(v);
    out.fonts = f;
  }
  if (isObj(doc.locales)) {
    const l: Obj = {};
    for (const [lang, v] of Object.entries(doc.locales)) {
      if (!isObj(v)) {
        l[lang] = v;
        continue;
      }
      const o: Obj = { ...v };
      if (isObj(v.fonts)) o.fonts = Object.fromEntries(Object.entries(v.fonts).map(([k, fv]) => [k, normFontDef(fv)]));
      if (isObj(v.defaults)) o.defaults = normDefaults(v.defaults, ["locales", lang, "defaults"], bag);
      if (isObj(v.styles)) o.styles = Object.fromEntries(Object.entries(v.styles).map(([k, sv]) => [k, isObj(sv) ? normElementProps(sv, ["locales", lang, "styles", k], bag) : sv]));
      l[lang] = o;
    }
    out.locales = l;
  }
  if ("hand" in doc) out.hand = normHand(doc.hand);
  if (isObj(doc.defaults)) out.defaults = normDefaults(doc.defaults, ["defaults"], bag);
  if (isObj(doc.styles)) {
    const s: Obj = {};
    for (const [k, v] of Object.entries(doc.styles)) s[k] = isObj(v) ? normElementProps(v, ["styles", k], bag) : v;
    out.styles = s;
  }
  if (isObj(doc.characters)) {
    const c: Obj = {};
    for (const [k, v] of Object.entries(doc.characters)) {
      if (!isObj(v)) {
        c[k] = v;
        continue;
      }
      const cc: Obj = { ...v };
      if (isObj(cc.balloon)) cc.balloon = normElementProps(cc.balloon, ["characters", k, "balloon"], bag);
      if (isObj(cc.text)) cc.text = normElementProps(cc.text, ["characters", k, "text"], bag);
      if (isObj(cc.voice)) {
        const vo: Obj = {};
        for (const [kk, vv] of Object.entries(cc.voice)) vo[kk] = isObj(vv) ? normElementProps(vv, ["characters", k, "voice", kk], bag) : vv;
        cc.voice = vo;
      }
      c[k] = cc;
    }
    out.characters = c;
  }
  // a character named only by an asset (`character: taro`) is declared implicitly
  if (isObj(out.assets)) {
    for (const v of Object.values(out.assets as Obj)) {
      const name = isObj(v) ? (v as Obj).character : undefined;
      if (typeof name !== "string" || !name || chars.has(name)) continue;
      chars.add(name);
      out.characters = { ...((out.characters as Obj | undefined) ?? {}), [name]: {} };
    }
  }
  if (Array.isArray(doc.pages)) {
    out.pages = doc.pages.map((pg, pi) => {
      if (!isObj(pg)) return pg;
      const p: Obj = { ...pg };
      const path: Path = ["pages", pi];
      if ("layout" in p) p.layout = normLayout(p.layout);
      if (Array.isArray(p.panels)) p.panels = p.panels.map((pn, ki) => normPanel(pn, [...path, "panels", ki], bag, chars));
      if (Array.isArray(p.layers)) p.layers = p.layers.map((e, i) => normElement(e, [...path, "layers", i], bag));
      if (isObj(p.defaults)) p.defaults = normDefaults(p.defaults, [...path, "defaults"], bag);
      if ("hand" in p) p.hand = normHand(p.hand);
      const inc = (pg as { __includeDefaults?: Obj }).__includeDefaults;
      if (inc) Object.defineProperty(p, "__includeDefaults", { value: normDefaults(inc, [...path, "defaults"], bag), enumerable: false });
      return p;
    });
  }
  if (isObj(doc.page)) {
    const pg: Obj = { ...doc.page };
    out.page = pg;
  }
  return out;
}
