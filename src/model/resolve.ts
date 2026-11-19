// Cascade, IDs, seeds (spec 3.7, 3.8, 9.2.2).
import type { DiagnosticBag } from "../core/diagnostics.js";
import { suggest } from "../core/diagnostics.js";
import { deriveSeed } from "../core/random.js";
import { isObj } from "../load/normalize.js";
import { BUILTIN_DEFAULTS, BUILTIN_EFFECT_DEFAULTS, BUILTIN_MARK_DEFAULTS, BUILTIN_STYLES } from "./defaults.js";

type Obj = Record<string, unknown>;
type Path = (string | number)[];

export interface RElement {
  id: string;
  type: string;
  props: Obj;
  path: Path;
  seed: number;
  children?: RElement[];
  fromDialogue?: boolean;
  /** inherited hand (after cascade, stored in props.hand) */
}

export interface RPanel {
  id: string;
  index: number;
  props: Obj;
  elements: RElement[];
  path: Path;
  seed: number;
}

export interface RPage {
  id: string;
  index: number;
  type: string;
  settings: Obj;
  layout: unknown;
  panels: RPanel[];
  layers: RElement[];
  number: unknown;
  title?: string;
  path: Path;
  seed: number;
  hand: Obj;
}

export interface ResolvedDoc {
  doc: Obj;
  pages: RPage[];
  seed: number;
  styles: Record<string, Obj>;
  characters: Record<string, Obj>;
  ids: Set<string>;
}

const RESERVED = new Set(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right", "panel", "page", "trim", "bleed", "baseFrame", "auto", "none", "wedge", "bubbles", "line", "zigzag"]);
const ID_RE = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

export function deepClone<T>(x: T): T {
  return x === undefined ? x : (structuredClone(x) as T);
}

/** merge b onto a (spec 3.8.1) */
export function merge(a: Obj, b: Obj | undefined, base?: Obj): Obj {
  if (!b) return a;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (v === null) {
      if (base && k in base) out[k] = deepClone(base[k]);
      else delete out[k];
      continue;
    }
    if (k === "hand" && isObj(v) && ("preset" in v || "roughness" in v)) {
      out[k] = deepClone(v);
      continue;
    }
    if (isObj(v) && isObj(out[k])) out[k] = merge(out[k] as Obj, v, isObj(base?.[k]) ? (base![k] as Obj) : undefined);
    else out[k] = deepClone(v);
  }
  return out;
}

/** like merge, but keeps `null` so that it can still reset a value when the style is applied */
function overlay(a: Obj, b: Obj | undefined): Obj {
  if (!b) return a;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (isObj(v) && isObj(out[k]) && !(k === "hand" && ("preset" in v || "roughness" in v))) out[k] = overlay(out[k] as Obj, v);
    else out[k] = v === null ? null : deepClone(v);
  }
  return out;
}

export interface ResolveOptions {
  configDefaults?: Obj;
  configStyles?: Record<string, Obj>;
  seedOverride?: number;
  lang?: string;
}

export function resolveDocument(doc: Obj, bag: DiagnosticBag, opts: ResolveOptions = {}): ResolvedDoc {
  const seed = opts.seedOverride ?? (typeof doc.seed === "number" ? doc.seed : 1);
  const characters = (isObj(doc.characters) ? doc.characters : {}) as Record<string, Obj>;
  const lang = opts.lang ?? ((doc.meta as Obj | undefined)?.lang as string | undefined) ?? "ja";
  const locale = isObj(doc.locales) ? (doc.locales as Obj)[lang] as Obj | undefined : undefined;

  // styles: builtin <- config <- doc <- locale
  const rawStyles: Record<string, Obj> = {};
  for (const src of [BUILTIN_STYLES, opts.configStyles ?? {}, (doc.styles ?? {}) as Record<string, Obj>, ((locale?.styles ?? {}) as Record<string, Obj>)]) {
    for (const [k, v] of Object.entries(src)) rawStyles[k] = rawStyles[k] ? overlay(rawStyles[k], v) : deepClone(v);
  }
  const styles: Record<string, Obj> = {};
  const resolving = new Set<string>();
  const resolveStyle = (name: string, path: Path): Obj | undefined => {
    if (styles[name]) return styles[name];
    const raw = rawStyles[name];
    if (!raw) return undefined;
    if (resolving.has(name)) {
      bag.error("STYLE_CYCLE", `style "${name}" extends itself`, { path });
      return {};
    }
    resolving.add(name);
    let acc: Obj = {};
    const ext = raw.extends;
    for (const e of Array.isArray(ext) ? ext : ext ? [ext] : []) {
      const s = resolveStyle(String(e), path);
      if (!s) bag.error("REF_NOT_FOUND", `unknown style "${e}"`, { path, hint: suggestHint(String(e), Object.keys(rawStyles)) });
      else acc = overlay(acc, s);
    }
    const own = { ...raw };
    delete own.extends;
    acc = overlay(acc, own);
    resolving.delete(name);
    styles[name] = acc;
    return acc;
  };
  for (const k of Object.keys(rawStyles)) resolveStyle(k, ["styles", k]);

  // collect explicit ids
  const ids = new Set<string>();
  const checkId = (id: unknown, path: Path) => {
    if (typeof id !== "string") return;
    if (!ID_RE.test(id) || id.includes(".")) bag.error("ID_INVALID", `invalid id "${id}"`, { path: [...path, "id"] });
    if (RESERVED.has(id)) bag.error("ID_RESERVED", `"${id}" is reserved and cannot be used as an id`, { path: [...path, "id"] });
    if (ids.has(id)) bag.error("ID_DUPLICATE", `duplicate id "${id}"`, { path: [...path, "id"] });
    ids.add(id.normalize("NFC"));
  };
  const pages = (Array.isArray(doc.pages) ? doc.pages : []) as Obj[];
  pages.forEach((pg, pi) => {
    checkId(pg.id, ["pages", pi]);
    const walk = (els: unknown, path: Path) => {
      if (!Array.isArray(els)) return;
      els.forEach((e, i) => {
        if (!isObj(e)) return;
        checkId(e.id, [...path, i]);
        if (Array.isArray(e.children)) walk(e.children, [...path, i, "children"]);
      });
    };
    walk(pg.layers, ["pages", pi, "layers"]);
    ((pg.panels ?? []) as Obj[]).forEach((pn, ki) => {
      checkId(pn.id, ["pages", pi, "panels", ki]);
      walk(pn.layers, ["pages", pi, "panels", ki, "layers"]);
      ((pn.dialogue ?? []) as Obj[]).forEach((d, di) => checkId(d.id, ["pages", pi, "panels", ki, "dialogue", di]));
    });
  });
  const autoId = (want: string) => {
    let id = want;
    let n = 2;
    while (ids.has(id)) id = `${want}_${n++}`;
    ids.add(id);
    return id;
  };

  const docDefaults = (doc.defaults ?? {}) as Obj;
  const cfgDefaults = opts.configDefaults ?? {};
  const locDefaults = (locale?.defaults ?? {}) as Obj;
  const docHand = isObj(doc.hand) ? (doc.hand as Obj) : undefined;

  const outPages: RPage[] = pages.map((pg, pi) => {
    const pageId = typeof pg.id === "string" ? pg.id : autoId(`p${pi + 1}`);
    const pageSeedBase = typeof pg.seed === "number" ? pg.seed : seed;
    const incDefaults = ((pg as { __includeDefaults?: Obj }).__includeDefaults ?? {}) as Obj;
    const pageDefaults = (pg.defaults ?? {}) as Obj;
    const pageHand = isObj(pg.hand) ? (pg.hand as Obj) : undefined;
    const layersFor = (panelDefaults: Obj | undefined, panelHand: Obj | undefined) => [
      { d: cfgDefaults, hand: undefined as Obj | undefined },
      { d: docDefaults, hand: docHand },
      { d: incDefaults, hand: undefined },
      { d: locDefaults, hand: undefined },
      { d: pageDefaults, hand: pageHand },
      { d: panelDefaults ?? {}, hand: panelHand },
    ];
    const resolveEl = (raw0: Obj, path: Path, parentId: string, counters: Record<string, number>, levels: ReturnType<typeof layersFor>, baseSeed: number, fromDialogue = false, dialogueIndex = 0): RElement => {
      let raw = raw0;
      // `from:` on a balloon is the off-panel speaker's side (spec 6.6.2)
      if (raw.type === "balloon" && typeof raw.from === "string") {
        raw = { ...raw, tail: merge(isObj(raw.tail) ? (raw.tail as Obj) : {}, { offscreen: raw.from }) };
        delete raw.from;
      }
      const type = String(raw.type ?? "");
      counters[type] = (counters[type] ?? 0) + 1;
      const id = typeof raw.id === "string" ? raw.id : autoId(fromDialogue ? `${parentId}-d${dialogueIndex}` : `${parentId}-${type}${counters[type]}`);
      const kind = typeof raw.kind === "string" ? raw.kind : undefined;
      const builtin: Obj =
        type === "effect"
          ? merge(deepClone(BUILTIN_EFFECT_DEFAULTS["*"]), kind ? BUILTIN_EFFECT_DEFAULTS[kind] : undefined)
          : type === "mark"
            ? merge(deepClone(BUILTIN_MARK_DEFAULTS["*"]), kind ? BUILTIN_MARK_DEFAULTS[kind] : undefined)
            : deepClone(BUILTIN_DEFAULTS[type] ?? {});
      let acc: Obj = deepClone(builtin);
      for (const lv of levels) {
        if (lv.hand) acc = merge(acc, { hand: lv.hand }, builtin);
        const d = lv.d[type];
        if (type === "effect" || type === "mark") {
          if (isObj(d)) {
            acc = merge(acc, (d as Obj)["*"] as Obj | undefined, builtin);
            if (kind) acc = merge(acc, (d as Obj)[kind] as Obj | undefined, builtin);
          }
        } else if (isObj(d)) acc = merge(acc, d as Obj, builtin);
      }
      const who = typeof raw.who === "string" ? raw.who : undefined;
      if (who) {
        const ch = characters[who];
        if (!ch) bag.error("REF_NOT_FOUND", `unknown character "${who}"`, { path: [...path, "who"], hint: suggestHint(who, Object.keys(characters)) });
        else if (type === "balloon" && isObj(ch.balloon)) acc = merge(acc, ch.balloon as Obj, builtin);
        else if (type === "text" && isObj(ch.text)) acc = merge(acc, ch.text as Obj, builtin);
      }
      if (type === "balloon") {
        const as = typeof raw.as === "string" ? raw.as : "say";
        const st = styles[as];
        if (!st) bag.error("REF_NOT_FOUND", `unknown speech type "${as}"`, { path: [...path, "as"], hint: suggestHint(as, Object.keys(BUILTIN_STYLES)) });
        else acc = merge(acc, st, builtin);
        const voice = who ? (characters[who]?.voice as Obj | undefined) : undefined;
        if (voice && isObj(voice[as])) acc = merge(acc, voice[as] as Obj, builtin);
        acc.as = as;
      }
      const styleNames = Array.isArray(raw.style) ? raw.style : raw.style ? [raw.style] : [];
      for (const sn of styleNames) {
        const st = styles[String(sn)];
        if (!st) {
          bag.error("REF_NOT_FOUND", `unknown style "${sn}"`, { path: [...path, "style"], hint: suggestHint(String(sn), Object.keys(styles)) });
          continue;
        }
        const forT = st.for;
        if (forT && !(Array.isArray(forT) ? forT : [forT]).includes(type)) {
          bag.error("STYLE_TYPE_MISMATCH", `style "${sn}" is for ${forT}, not ${type}`, { path: [...path, "style"] });
          continue;
        }
        const s2 = { ...st };
        delete s2.for;
        acc = merge(acc, s2, builtin);
      }
      const own = { ...raw };
      delete own.style;
      acc = merge(acc, own, builtin);
      acc.id = id;
      const elSeedBase = typeof raw.seed === "number" ? raw.seed : baseSeed;
      const el: RElement = { id, type, props: acc, path, seed: deriveSeed(elSeedBase, id, "element"), fromDialogue };
      if (type === "group" && Array.isArray(raw.children)) {
        const gDefaults = isObj(raw.defaults) ? (raw.defaults as Obj) : undefined;
        const lv2 = gDefaults ? [...levels, { d: gDefaults, hand: undefined }] : levels;
        const cc: Record<string, number> = {};
        el.children = (raw.children as Obj[]).map((c, i) => resolveEl(c, [...path, "children", i], id, cc, lv2, elSeedBase));
      }
      return el;
    };

    const panels: RPanel[] = ((pg.panels ?? []) as Obj[]).map((pn, ki) => {
      const pid = typeof pn.id === "string" ? pn.id : autoId(`${pageId}-k${ki + 1}`);
      const pSeed = typeof pn.seed === "number" ? pn.seed : pageSeedBase;
      const levels = layersFor(pn.defaults as Obj | undefined, isObj(pn.hand) ? (pn.hand as Obj) : undefined);
      // panel props cascade
      let pprops: Obj = deepClone(BUILTIN_DEFAULTS.panel);
      for (const lv of levels) {
        if (lv.hand) pprops = merge(pprops, { hand: lv.hand });
        if (isObj(lv.d.panel)) pprops = merge(pprops, lv.d.panel as Obj, BUILTIN_DEFAULTS.panel);
      }
      const own = { ...pn };
      delete own.layers;
      delete own.dialogue;
      delete own.defaults;
      pprops = merge(pprops, own, BUILTIN_DEFAULTS.panel);
      const counters: Record<string, number> = {};
      const els = ((pn.layers ?? []) as Obj[]).map((e, i) => resolveEl(e, ["pages", pi, "panels", ki, "layers", i], pid, counters, levels, pSeed));
      ((pn.dialogue ?? []) as Obj[]).forEach((d, di) => {
        const raw: Obj = { type: "balloon", ...d };
        if (d.as === "offscreen" && typeof d.from === "string") raw.tail = merge((raw.tail as Obj) ?? {}, { offscreen: d.from });
        delete raw.from;
        els.push(resolveEl(raw, ["pages", pi, "panels", ki, "dialogue", di], pid, counters, levels, pSeed, true, di + 1));
      });
      return { id: pid, index: ki, props: pprops, elements: els, path: ["pages", pi, "panels", ki], seed: deriveSeed(pSeed, pid, "panel") };
    });
    // yonkoma title slot (spec 4.6): a borderless panel holding the page title
    const lay = isObj(pg.layout) ? (pg.layout as Obj) : undefined;
    const lparams = lay && isObj(lay.params) ? (lay.params as Obj) : {};
    const tflag = lparams.title === "false" ? false : lparams.title;
    if (lay?.template === "yonkoma" && tflag) {
      const tid = `${pageId}-title`;
      const ki = panels.length;
      const levels = layersFor(undefined, undefined);
      const title = typeof tflag === "string" && tflag !== "true" ? tflag : typeof pg.title === "string" ? pg.title : typeof (doc.meta as Obj | undefined)?.title === "string" ? ((doc.meta as Obj).title as string) : "";
      const pprops = merge(deepClone(BUILTIN_DEFAULTS.panel), { border: { style: "none" }, background: "none", __titleSlot: true }, BUILTIN_DEFAULTS.panel);
      const els: RElement[] = [];
      if (title) {
        const raw: Obj = { type: "text", text: title, font: "title", writing: "horizontal", place: "center", align: "center", fontSize: lparams.titleSize ?? "24bQ", ...(isObj(lparams.titleStyle) ? (lparams.titleStyle as Obj) : {}) };
        els.push(resolveEl(raw, ["pages", pi, "layout", "params", "title"], tid, {}, levels, pageSeedBase));
      }
      panels.push({ id: tid, index: ki, props: pprops, elements: els, path: ["pages", pi, "layout"], seed: deriveSeed(pageSeedBase, tid, "panel") });
    }
    const pageLevels = layersFor(undefined, undefined);
    const pc: Record<string, number> = {};
    const layers = ((pg.layers ?? []) as Obj[]).map((e, i) => {
      const el = resolveEl(e, ["pages", pi, "layers", i], pageId, pc, pageLevels, pageSeedBase);
      if (el.props.clip === "panel") el.props.clip = "none";
      return el;
    });
    const settings = merge(deepClone((doc.page ?? {}) as Obj), pickPageSettings(pg));
    let hand: Obj = {};
    if (docHand) hand = merge(hand, { hand: docHand }).hand as Obj;
    if (pageHand) hand = merge({ hand }, { hand: pageHand }).hand as Obj;
    return {
      id: pageId,
      index: pi,
      type: typeof pg.type === "string" ? pg.type : "page",
      settings,
      layout: pg.layout,
      panels,
      layers,
      number: pg.number,
      title: typeof pg.title === "string" ? pg.title : undefined,
      path: ["pages", pi],
      seed: deriveSeed(pageSeedBase, pageId, "page"),
      hand,
    };
  });
  return { doc, pages: outPages, seed, styles, characters, ids };
}

function pickPageSettings(pg: Obj): Obj {
  const keys = ["size", "orientation", "units", "dpi", "bleed", "baseFrame", "safeArea", "gutter", "background", "color", "foldMargin", "printScale", "printSize"];
  const o: Obj = {};
  for (const k of keys) if (pg[k] !== undefined) o[k] = pg[k];
  return o;
}

function suggestHint(w: string, cands: string[]): string | undefined {
  const s = suggest(w, cands);
  return s ? `did you mean "${s}"?` : undefined;
}
