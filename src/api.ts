// Public API (spec 11).
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { relative as relativePath } from "node:path";
import { PACKAGE_ROOT, defaultFontSet } from "./fonts/catalog.js";

const PKG_VERSION = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
import { type Diagnostic, DiagnosticBag, MangaAbortError, MangaError, MangaRenderError, MangaResourceError, MangaSecurityError, MangaValidationError, suggest } from "./core/diagnostics.js";
import { FontRegistry, type FontDef } from "./fonts/registry.js";
import { type LoadedDocument, loadDocumentFile, loadDocumentFromObject, loadDocumentFromString } from "./load/document.js";
import { isObj, normalizeDocument } from "./load/normalize.js";
import { type ResolvedDoc, resolveDocument } from "./model/resolve.js";
import { type EncodeOptions, EXT, MIME, type OutputFormat, encode } from "./output/encode.js";
import { PROFILES, type Profile, applyOutput, resolveProfile } from "./output/profiles.js";
import { PdfWriter } from "./output/pdf.js";
import { PsdWriter } from "./output/psd.js";
import { type Finish, applyFinish } from "./output/finish.js";
import { AssetRegistry } from "./render/assets.js";
import { type PageLayoutInfo, composePage } from "./render/compose.js";
import type { DisplayList, Node } from "./render/ir.js";
import { parsePaint } from "./model/values.js";
import { polyPath } from "./geom/path.js";
import type { RElement, RPage } from "./model/resolve.js";
import { RasterBackend } from "./render/raster.js";
import { createCanvas } from "@napi-rs/canvas";
import { renderSvg } from "./render/svg.js";
import { type MangaPlugin, PluginSet, withPlugins } from "./plugin.js";
import { BODY_GENERATORS } from "./shapes/balloon.js";
import { HAND_PRESETS, PEN_PRESETS } from "./ink/presets.js";
import { BUILTIN_STYLES, PAGE_PRESETS } from "./model/defaults.js";
import { MARK_KINDS } from "./load/normalize.js";
import { Document, ELEMENT_KEYS } from "./schema/schema.js";
import { KEYWORDS } from "./layout/place.js";
import { bookOf, computePageGeom } from "./layout/page.js";
import { pageSize } from "./layout/page.js";

type Obj = Record<string, unknown>;

export type MangaInput = string | URL | { yaml: string; filename?: string; baseDir?: string } | Obj | LoadedDocument;

export interface RenderOptions {
  profile?: string;
  format?: OutputFormat | OutputFormat[];
  colorMode?: "color" | "gray" | "mono";
  dpi?: number;
  scale?: number;
  width?: number;
  height?: number;
  crop?: "trim" | "bleed" | "marks";
  spread?: "joined" | "split";
  toneRendering?: "dots" | "flat" | "auto";
  transparent?: boolean;
  separate?: string[] | Record<string, string[]> | "all" | false;
  outDir?: string;
  name?: string;
  pages?: string | (number | string)[] | ((page: { id: string; index: number }) => boolean);
  lang?: string;
  seed?: number;
  draft?: boolean;
  debug?: boolean | string[];
  strict?: boolean;
  throwOnError?: boolean;
  failFast?: boolean;
  diagnostics?: Record<string, "error" | "warning" | "info" | "off">;
  root?: string;
  baseDir?: string;
  /** in-memory assets: bytes, or { path } / { data } */
  assets?: Record<string, Uint8Array | { path: string } | { data: Uint8Array }>;
  fonts?: Record<string, Uint8Array | Obj>;
  fontSet?: string;
  fontDownload?: "auto" | "never";
  fontDir?: string;
  fontCacheDir?: string;
  fontMirror?: string;
  fontFallback?: string[];
  missingAssets?: "error" | "placeholder";
  ignoreDocumentOutput?: boolean;
  /** a loaded config object, or true to search for mangacli.config.* from the entry's directory */
  config?: Obj | true;
  emit?: ("layout" | "ir" | "transcript" | "manifest")[];
  onProgress?: (e: { phase: string; pageId?: string; done: number; total: number }) => void;
  onDiagnostic?: (d: Diagnostic) => void;
  /** internal: an installed font was loaded from this path */
  onSystemFont?: (path: string) => void;
  signal?: AbortSignal;
  finish?: Finish | false;
  /** URL assets (spec 2.13): true, or limits */
  allowNetwork?: boolean | { hosts?: string[]; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean };
  allowOutsideRoot?: boolean;
  /** page ground override (spec 10.15): a paint, or "transparent" */
  background?: string;
  /** remove earlier outputs that match the file name template before writing */
  clean?: boolean;
  /** input and workload limits (spec 2.13) */
  limits?: Limits;
  /** plugins (spec 11.8); config plugins are added after these */
  plugins?: MangaPlugin[];
  /** internal: compose only (validate / layout) */
  layoutOnly?: boolean;
  /** internal: keep display lists in the result */
  keepLists?: boolean;
  /** internal: font cache shared by a renderer */
  fontCache?: Map<string, import("./fonts/registry.js").LoadedFont>;
}

export interface RenderedPage {
  id: string;
  index: number;
  number: number | null;
  side: string;
  format: OutputFormat;
  mimeType: string;
  colorMode: string;
  width: number;
  height: number;
  dpi: number;
  separation?: string;
  data: Uint8Array;
  path?: string;
}

export interface RenderResult {
  pages: RenderedPage[];
  files: string[];
  diagnostics: Diagnostic[];
  failures: { pageId: string; index: number; error: Error }[];
  layout: PageLayoutInfo[];
  /** display lists (only with keepLists) */
  lists?: DisplayList[];
  timings: Record<string, number>;
}

export interface Project {
  loaded: LoadedDocument;
  doc: Obj;
  resolved: ResolvedDoc | null;
  bag: DiagnosticBag;
  name: string;
}

export interface Limits {
  maxSourceBytes?: number;
  maxPages?: number;
  maxElementsPerPage?: number;
  maxTextLength?: number;
  maxOutputPixels?: number;
  maxDpi?: number;
}

/** the loaded config (`config: true` is resolved by render before use) */
function cfgOf(o: RenderOptions): Obj | undefined {
  return o.config === true ? undefined : o.config;
}

const DEFAULT_LIMITS: Required<Limits> = { maxSourceBytes: 10e6, maxPages: 1000, maxElementsPerPage: 5000, maxTextLength: 2000, maxOutputPixels: 200e6, maxDpi: 2400 };

function limitsOf(o: RenderOptions): Required<Limits> {
  return { ...DEFAULT_LIMITS, ...((cfgOf(o)?.limits as Limits | undefined) ?? {}), ...(o.limits ?? {}) };
}

const BUILTIN_EFFECTS = new Set(["focus-lines", "beta-flash", "uni-flash", "speed-lines", "gloom-lines", "rain", "swirl-lines", "hatching", "impact", "vignette"]);
const BUILTIN_TEMPLATES = new Set(["single", "grid", "tiers", "yonkoma", "hero-top", "hero-bottom"]);

function pluginSetFor(o: RenderOptions, bag?: DiagnosticBag): PluginSet | undefined {
  const list = [...(o.plugins ?? []), ...(((cfgOf(o)?.plugins as MangaPlugin[] | undefined) ?? []).filter((x) => x && typeof x === "object"))];
  if (!list.length) return undefined;
  const set = new PluginSet(list, {
    shapes: new Set(Object.keys(BODY_GENERATORS)),
    effects: BUILTIN_EFFECTS,
    marks: MARK_KINDS,
    pens: new Set(Object.keys(PEN_PRESETS)),
    hands: new Set(Object.keys(HAND_PRESETS)),
    templates: BUILTIN_TEMPLATES,
    pageSizes: new Set(Object.keys(PAGE_PRESETS)),
    styles: new Set(Object.keys(BUILTIN_STYLES)),
  });
  for (const c of set.conflicts) bag?.error("PLUGIN_NAME_CONFLICT", c);
  return set;
}

function isLoaded(x: unknown): x is LoadedDocument {
  return isObj(x) && "data" in x && "locate" in x && "files" in x;
}

export function load(input: MangaInput, options: RenderOptions = {}): Project {
  const bag = new DiagnosticBag(undefined, options.diagnostics ?? (cfgOf(options)?.diagnostics as Record<string, "off">) ?? {});
  let loaded: LoadedDocument;
  let name = "manga";
  const lim = limitsOf(options);
  if (typeof input === "string" || input instanceof URL) {
    const p = input instanceof URL ? fileURLToPath(input) : input;
    try {
      if (statSync(p).size > lim.maxSourceBytes) throw new MangaError("SECURITY_LIMIT_EXCEEDED", `${p} is larger than maxSourceBytes (${lim.maxSourceBytes})`);
    } catch (e) {
      if (e instanceof MangaError) throw e;
    }
    loaded = loadDocumentFile(p, bag, options.root);
    name = basename(p, extname(p));
  } else if (isLoaded(input)) loaded = input;
  else if (isObj(input) && typeof input.yaml === "string") {
    if (Buffer.byteLength(input.yaml as string) > lim.maxSourceBytes) throw new MangaError("SECURITY_LIMIT_EXCEEDED", `document is larger than maxSourceBytes (${lim.maxSourceBytes})`);
    const base = (input.baseDir as string) ?? options.baseDir ?? options.root ?? process.cwd();
    loaded = loadDocumentFromString(input.yaml as string, (input.filename as string) ?? join(base, "<input>.yaml"), bag, options.root);
  } else loaded = loadDocumentFromObject(input as Obj, options.baseDir ?? options.root ?? process.cwd());
  bag.setLocator(loaded.locate);
  let doc = bag.hasErrors ? {} : normalizeDocument(loaded.data, bag);
  const plugins = pluginSetFor(options, bag);
  if (plugins && !bag.hasErrors) doc = plugins.hook("afterLoad", doc) as Obj;
  if (!bag.hasErrors) validateSchema(doc, bag);
  const meta = (doc.meta ?? {}) as Obj;
  if (typeof input !== "string" && !(input instanceof URL) && typeof meta.title === "string") name = meta.title.replace(/[\\/:*?"<>|\s]+/g, "_");
  return { loaded, doc, resolved: null, bag, name };
}

function validateSchema(doc: Obj, bag: DiagnosticBag) {
  if (doc.mangacli === undefined) {
    bag.error("SCHEMA_UNSUPPORTED_VERSION", 'missing "mangacli: 1" at the top of the document', { path: [] });
    return;
  }
  if (doc.mangacli !== 1) {
    bag.error("SCHEMA_UNSUPPORTED_VERSION", `unsupported schema version ${String(doc.mangacli)}`, { path: ["mangacli"] });
    return;
  }
  // mutually exclusive keys (spec 4.1.1, 6.2)
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...path, i]));
    if (!isObj(v)) return;
    if ("tail" in v && "tails" in v) bag.error("SCHEMA_EXCLUSIVE", `"tail" and "tails" cannot be used together`, { path: [...path, "tails"] });
    if (path[path.length - 1] === "baseFrame" && "size" in v && "margins" in v) bag.error("SCHEMA_EXCLUSIVE", `baseFrame takes either "size" or "margins"`, { path: [...path, "margins"] });
    for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(doc, []);
  // style keys that no element of the style's type accepts (spec 3.16)
  for (const [name, st] of Object.entries(isObj(doc.styles) ? (doc.styles as Record<string, Obj>) : {})) {
    if (!isObj(st)) continue;
    const forT = st.for === undefined ? undefined : Array.isArray(st.for) ? (st.for as string[]) : [String(st.for)];
    const types = forT ?? Object.keys(ELEMENT_KEYS);
    for (const k of Object.keys(st)) {
      if (k === "for" || k === "extends") continue;
      const ok = types.some((t) => { const ks = ELEMENT_KEYS[t]; return ks === undefined || ks === null || ks.has(k); });
      if (!ok) {
        if (forT) bag.error("SCHEMA_UNKNOWN_KEY", `style "${name}": "${k}" is not a ${forT.join("/")} property`, { path: ["styles", name, k], hint: hintFor(k, doc, []) });
        else bag.info("STYLE_KEY_NOT_APPLICABLE", `style "${name}": "${k}" applies to no element type`, { path: ["styles", name, k] });
      }
    }
  }
  // position keywords cannot name asset anchors/regions (they would shadow e.g. taro1.top)
  for (const [an, a] of Object.entries(isObj(doc.assets) ? (doc.assets as Record<string, Obj>) : {})) {
    for (const kind of ["anchors", "regions"] as const)
      for (const k of Object.keys(isObj(a?.[kind]) ? (a[kind] as Obj) : {})) if (k in KEYWORDS) bag.error("ID_RESERVED", `"${k}" is a position keyword and cannot name an asset ${kind.slice(0, -1)}`, { path: ["assets", an, kind, k] });
  }
  const r = Document.safeParse(doc);
  if (r.success) return;
  for (const iss of r.error.issues.slice(0, 100)) {
    const path = iss.path as (string | number)[];
    const i = iss as unknown as { code: string; keys?: string[]; message: string; expected?: string };
    if (i.code === "unrecognized_keys") {
      for (const k of i.keys ?? []) bag.error("SCHEMA_UNKNOWN_KEY", `unknown key "${k}"`, { path: [...path, k], hint: hintFor(k, doc, path) });
    } else if (i.code === "invalid_type") bag.error(iss.message.includes("undefined") ? "SCHEMA_REQUIRED" : "SCHEMA_TYPE", `${path.join(".")}: ${iss.message}`, { path });
    else if (i.code === "invalid_value" || i.code === "invalid_enum_value") bag.error("SCHEMA_ENUM", `${path.join(".")}: ${iss.message}`, { path });
    else if (i.code === "too_small" || i.code === "too_big") bag.error("SCHEMA_RANGE", `${path.join(".")}: ${iss.message}`, { path });
    else if (i.code === "invalid_format" || i.code === "invalid_string") bag.error("UNIT_INVALID", `${path.join(".")}: ${iss.message}`, { path });
    else bag.error("SCHEMA_TYPE", `${path.join(".")}: ${iss.message}`, { path });
  }
}

const COMMON_KEYS = ["text", "tail", "shape", "stroke", "fill", "font", "fontSize", "at", "place", "anchor", "size", "who", "as", "layers", "dialogue", "panels", "layout", "border", "bleed", "image", "src", "kind", "region", "paint", "color", "outline", "writing", "rotate", "offset", "id", "style", "hand", "pages", "assets", "fonts", "characters", "styles", "defaults", "meta", "book", "page"];

function hintFor(k: string, _doc: Obj, _path: (string | number)[]): string | undefined {
  const s = suggest(k, COMMON_KEYS);
  return s ? `did you mean "${s}"?` : undefined;
}

function buildFonts(p: Project, o: RenderOptions): FontRegistry {
  const defs = new Map<string, FontDef>();
  const addDefs = (src: Record<string, unknown> | undefined) => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      if (v instanceof Uint8Array) {
        defs.set(k, { kind: "bytes", data: v });
        continue;
      }
      if (!isObj(v)) continue;
      if (typeof v.src === "string") defs.set(k, { kind: "file", path: v.src, index: v.index as number, variations: v.variations as Record<string, number>, bold: v.bold as string, fallback: v.fallback as string[] });
      else if (typeof v.system === "string") defs.set(k, { kind: "system", name: v.system, index: v.index as number, variations: v.variations as Record<string, number>, bold: v.bold as string, fallback: v.fallback as string[] });
      else if (typeof v.alias === "string") defs.set(k, { kind: "alias", name: v.alias });
      else if (typeof v.catalog === "string") defs.set(k, { kind: "catalog", id: v.catalog, weight: v.weight as number, bold: v.bold as string, fallback: v.fallback as string[] });
      else if (Array.isArray(v.compose)) defs.set(k, { kind: "compose", items: v.compose as never, fallback: v.fallback as string[], bold: v.bold as string });
    }
  };
  addDefs(cfgOf(o)?.fonts as Obj);
  addDefs(p.doc.fonts as Obj);
  const loc = isObj(p.doc.locales) && o.lang ? ((p.doc.locales as Obj)[o.lang] as Obj | undefined) : undefined;
  addDefs(loc?.fonts as Obj);
  addDefs(o.fonts as Obj);
  const set = o.fontSet ?? (p.doc.fontSet as string) ?? (cfgOf(o)?.fontSet as string) ?? defaultFontSet(o.lang ?? ((p.doc.meta as Obj | undefined)?.lang as string));
  // global fallback entries may be font names or file paths
  const fallback = (o.fontFallback ?? (cfgOf(o)?.fontFallback as string[]) ?? []).map((f, i) => {
    if (defs.has(f) || !/[./\\]/.test(f) || f.startsWith("catalog:")) return f;
    const name = `__fallback${i}`;
    defs.set(name, { kind: "file", path: resolvePath(o.baseDir ?? process.cwd(), f) });
    return name;
  });
  return new FontRegistry(defs, set, fallback, {
    fontDownload: o.fontDownload,
    fontDir: o.fontDir,
    fontCacheDir: o.fontCacheDir,
    fontMirror: o.fontMirror,
    onSystemFont: o.onSystemFont,
    onInfo: (code, message) => p.bag.info(code, message),
    onError: (code, message) => p.bag.error(code, message),
  }, o.fontCache);
}

function selectPages(sel: RenderOptions["pages"], ids: string[]): Set<number> {
  const all = new Set(ids.map((_, i) => i));
  if (!sel) return all;
  const out = new Set<number>();
  if (typeof sel === "function") {
    ids.forEach((id, i) => sel({ id, index: i + 1 }) && out.add(i));
    return out;
  }
  const items = typeof sel === "string" ? sel.split(",").map((s) => s.trim()).filter(Boolean) : sel.map(String);
  for (const it of items) {
    const m = it.match(/^(\d+)(?:-(\d*))?$/);
    if (m) {
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : m[2] === "" ? ids.length : Number(m[2]);
      if (a > ids.length) throw new MangaError("REF_NOT_FOUND", `page ${a} is out of range (the document has ${ids.length} page(s))`);
      for (let i = a; i <= b; i++) if (i >= 1 && i <= ids.length) out.add(i - 1);
      continue;
    }
    const idx = ids.indexOf(it);
    if (idx >= 0) out.add(idx);
    else throw new MangaError("REF_NOT_FOUND", `page "${it}" not found`);
  }
  return out;
}

function fillName(tpl: string, vars: Record<string, string | number | number[]>): string {
  return String(tpl)
    .replace(/\{\{/g, "\u0001")
    .replace(/\}\}/g, "\u0002")
    .replace(/\{(\w+)(?::(\d+))?\}/g, (_, k: string, w?: string) => {
      const v = vars[k];
      if (v === undefined) throw new MangaError("SCHEMA_ENUM", `unknown file name placeholder {${k}}`);
      // a joined spread carries two page numbers: {page:03} -> 002-003
      const pad = (x: string | number) => {
        const t = String(x);
        return w && /^\d+$/.test(t) ? t.padStart(Number(w), "0") : t;
      };
      return Array.isArray(v) ? v.map(pad).join("-") : pad(v);
    })
    .replace(/\u0001/g, "{")
    .replace(/\u0002/g, "}")
    .replace(/[\\/]|\.\./g, "_");
}

export async function render(input: MangaInput | Project, options0: RenderOptions = {}): Promise<RenderResult> {
  let options = options0;
  if (options.config === true) {
    // discover the config file from the entry document's directory
    const { findConfig, loadConfig } = await import("./config.js");
    const from = typeof input === "string" ? dirname(resolvePath(input)) : input instanceof URL ? dirname(fileURLToPath(input)) : (options.baseDir ?? process.cwd());
    const f = findConfig(from);
    options = { ...options, config: f ? ((await loadConfig(f)) as unknown as Obj) : undefined };
  }
  if (options.assets) {
    const conv: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(options.assets)) conv[k] = v instanceof Uint8Array ? v : "path" in v ? readFileSync(v.path) : v.data;
    options = { ...options, assets: conv };
  }
  return withPlugins(pluginSetFor(options), () => renderInner(input, options));
}

async function renderInner(input: MangaInput | Project, options: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  const plugins = pluginSetFor(options);
  const given = typeof input === "object" && input !== null && !(input instanceof URL) && "bag" in input && "loaded" in input;
  // a Project can be rendered many times: each run reports into its own copy of the load diagnostics
  const p = given ? { ...(input as Project), bag: (input as Project).bag.fork() } : load(input as MangaInput, options);
  const bag = p.bag;
  const timings: Record<string, number> = {};
  const result: RenderResult = { pages: [], files: [], diagnostics: bag.items, failures: [], layout: [], timings };
  const throwOnError = options.throwOnError !== false;
  const fail = () => {
    if (throwOnError) throw errorFor(bag.items);
    return result;
  };
  if (bag.hasErrors) return fail();
  const docOutput = (!options.ignoreDocumentOutput && isObj(p.doc.output) ? p.doc.output : {}) as Obj;
  const profName = options.profile ?? (docOutput.profile as string) ?? (cfgOf(options)?.output as Obj | undefined)?.profile as string ?? "web";
  let prof: Profile;
  try {
    prof = resolveProfile(profName, { ...(((cfgOf(options)?.output as Obj)?.profiles ?? {}) as Record<string, Obj>), ...((docOutput.profiles ?? {}) as Record<string, Obj>) });
    // precedence: profile < config output < document output < render options
    const strip = (o: Obj | undefined) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !["profile", "profiles", "dir"].includes(k))) : undefined);
    prof = applyOutput(applyOutput(prof, strip(cfgOf(options)?.output as Obj | undefined)), strip(docOutput));
  } catch (e) {
    bag.error("SCHEMA_ENUM", (e as Error).message);
    return fail();
  }
  const draft = options.draft ?? prof.draft ?? false;
  const lang = options.lang ?? ((p.doc.meta as Obj | undefined)?.lang as string) ?? "ja";
  const defaultLang = ((p.doc.meta as Obj | undefined)?.lang as string) ?? "ja";
  const configStyles = { ...(plugins?.styles ?? {}), ...((cfgOf(options)?.styles as Record<string, Obj>) ?? {}) };
  let resolved = resolveDocument(p.doc, bag, { seedOverride: options.seed, lang, configDefaults: cfgOf(options)?.defaults as Obj, configStyles });
  if (plugins) resolved = plugins.hook("afterResolve", resolved) as typeof resolved;
  p.resolved = resolved;
  const lim = limitsOf(options);
  if (resolved.pages.length > lim.maxPages) bag.error("SECURITY_LIMIT_EXCEEDED", `${resolved.pages.length} pages exceed maxPages (${lim.maxPages})`);
  for (const pg of resolved.pages) {
    let n = 0;
    const visit = (el: RElement) => {
      n++;
      const t = el.props.text;
      const len = typeof t === "string" ? t.length : isObj(t) ? Math.max(0, ...Object.values(t).map((v) => String(v).length)) : 0;
      if (len > lim.maxTextLength) bag.error("SECURITY_LIMIT_EXCEEDED", `text of ${el.id} is longer than maxTextLength (${lim.maxTextLength})`, { path: el.path, elementId: el.id });
      el.children?.forEach(visit);
    };
    pg.panels.forEach((pn) => pn.elements.forEach(visit));
    pg.layers.forEach(visit);
    if (n > lim.maxElementsPerPage) bag.error("SECURITY_LIMIT_EXCEEDED", `page ${pg.id} has ${n} elements (maxElementsPerPage ${lim.maxElementsPerPage})`, { pageId: pg.id });
  }
  if (bag.hasErrors) return fail();
  const fonts = buildFonts(p, options);
  const allowNet = options.allowNetwork ?? (cfgOf(options)?.allowNetwork as RenderOptions["allowNetwork"]) ?? false;
  const assets = new AssetRegistry((p.doc.assets ?? {}) as Record<string, Obj>, (options.assets ?? {}) as Record<string, Uint8Array>, bag, 350, draft ? "placeholder" : (options.missingAssets ?? (cfgOf(options)?.missingAssets as "error") ?? "error"), {
    root: options.root ?? (cfgOf(options)?.root as string | undefined) ?? p.loaded.baseDir,
    allowOutsideRoot: options.allowOutsideRoot ?? (cfgOf(options)?.allowOutsideRoot as boolean | undefined) ?? false,
    network: allowNet === true ? {} : allowNet || false,
  });
  const ids = resolved.pages.map((pg) => pg.id);
  let selected: Set<number>;
  try {
    selected = selectPages(options.pages, ids);
  } catch (e) {
    bag.error("REF_NOT_FOUND", (e as Error).message);
    return fail();
  }
  timings.prepare = performance.now() - t0;
  options.onProgress?.({ phase: "load", done: 1, total: 1 });
  // physical numbering
  const book = (p.doc.book ?? {}) as Obj;
  const pn = (book.pageNumbers ?? {}) as Obj;
  const start = typeof pn.start === "number" ? pn.start : 1;
  const countBlank = pn.countBlank !== false;
  let physical = 1;
  let nombre = start;
  const plan: { idx: number; physical: number; nombre: number | null }[] = [];
  for (const [i, pg] of resolved.pages.entries()) {
    const isBlank = pg.type === "blank";
    const nb = pn.enabled === false || (isBlank && !countBlank) ? null : nombre;
    plan.push({ idx: i, physical, nombre: nb });
    const span = pg.type === "spread" ? 2 : 1;
    physical += span;
    if (!isBlank || countBlank) nombre += span;
  }
  // debug output is always colour PNG (the overlay is translucent)
  const formats = (options.debug ? ["png"] : Array.isArray(options.format ?? prof.format) ? (options.format ?? prof.format) : [options.format ?? prof.format]) as OutputFormat[];
  const outDir = options.outDir ? resolvePath(options.outDir) : undefined;
  const nameTpl = options.name ?? (docOutput.name as string) ?? prof.name ?? "{name}-{page:03}";
  const emitted = new Set<string>();
  const seps0 = normalizeSeparations(options.separate ?? prof.separate);
  const regularFormats = formats.filter((f) => f !== "psd");
  const regularRuns: { name?: string; list?: string[]; formats: OutputFormat[] }[] =
    regularFormats.length ? (seps0 ?? [{}]).map((run) => ({ ...run, formats: regularFormats })) : [];
  const psdLayers = formats.includes("psd") ? (seps0?.length ? seps0 : normalizeSeparations("all")!) : [];
  const psdFormats: OutputFormat[] = ["psd"];
  const outputRuns = psdLayers.length ? [...regularRuns, { name: undefined, formats: psdFormats }] : regularRuns;
  // print profiles hand spreads to the printer as two pages
  const spreadMode = options.spread ?? prof.spread ?? (prof.print ? "split" : "joined");
  const title = String((p.doc.meta as Obj | undefined)?.title ?? p.name);
  const outName = (page: RPage, idx: number, side: string, nombre: number | null, spreadJoined: boolean, split: boolean, runName: string | undefined, ext: string) => {
    const splitSuffix = split && !/\{(page|side)/.test(nameTpl) ? `-${side}` : "";
    const pageVar: string | number | number[] = nombre === null ? `i${idx + 1}` : spreadJoined ? [nombre, nombre + 1] : nombre;
    const base = fillName(nameTpl, { name: p.name, title, page: pageVar, index: idx + 1, id: page.id, side, profile: profName, lang, sep: runName ?? "" }) + splitSuffix + (runName && !nameTpl.includes("{sep}") ? `-${runName}` : "");
    return join(outDir!, `${base}.${ext}`);
  };
  if (outDir && options.clean && !options.layoutOnly) {
    // the template with its placeholders as wildcards
    const rx = new RegExp("^" + String(nameTpl).replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+(?::\d+)?\}/g, ".+") + "(-[a-z]+)?\\.(" + Object.values(EXT).join("|") + ")$");
    try {
      for (const f of readdirSync(outDir)) if (rx.test(f)) rmSync(join(outDir, f), { force: true });
    } catch {
      /* no directory yet */
    }
  }
  // every output name is known before rendering: refuse to write anything on a collision (spec 10.8)
  if (outDir && !options.layoutOnly) {
    const seen = new Map<string, string>();
    const probe = bag.fork();
    for (const pl of plan) {
      if (!selected.has(pl.idx)) continue;
      const page = resolved.pages[pl.idx];
      const g = computePageGeom(page, pl.physical, bookOf(p.doc), probe);
      const split = g.type === "spread" && spreadMode === "split";
      const halves = split ? [{ side: g.rtl ? "right" : "left", n: pl.nombre }, { side: g.rtl ? "left" : "right", n: pl.nombre === null ? null : pl.nombre + 1 }] : [{ side: g.side, n: pl.nombre }];
      for (const run of outputRuns)
        for (const h of halves)
          for (const fmt of run.formats) {
            if (fmt === "pdf") continue;
            const f = outName(page, pl.idx, h.side, h.n, g.type === "spread" && !split, split, run.name, EXT[fmt]);
            const prev = seen.get(f);
            if (prev) bag.error("OUTPUT_NAME_COLLISION", `pages ${prev} and ${page.id} both map to ${f}`, { pageId: page.id, hint: "use {page}, {index} or {id} in the file name template" });
            seen.set(f, page.id);
          }
    }
    if (bag.hasErrors) return fail();
  }
  // pdf: all pages of a run go into one document
  const pdfs = new Map<string, { writer: PdfWriter; colorMode: string; dpi: number }>();
  const meta = (p.doc.meta ?? {}) as Obj;
  const sde = process.env.SOURCE_DATE_EPOCH;
  const sourceHash = createHash("sha256").update(JSON.stringify(p.doc)).digest("hex").slice(0, 16);
  const total = selected.size;
  let done = 0;
  for (const pl of plan) {
    if (!selected.has(pl.idx)) continue;
    if (options.signal?.aborted) throw new MangaAbortError();
    const page = resolved.pages[pl.idx];
    const tp = performance.now();
    try {
      const pageBag = bag;
      const crop = options.crop ?? prof.crop;
      const dpiFor = (geom: import("./layout/page.js").PageGeom) => {
        const sz = pageSize(page.settings, bag, page.path);
        const markW = crop === "marks" ? 2 * (((prof as { marks?: { margin?: number } }).marks?.margin) ?? 10) : 0;
        const cropW = crop === "bleed" || crop === "marks" ? geom.bleedBox.w + markW : geom.trimW;
        const cropH = crop === "bleed" || crop === "marks" ? geom.bleedBox.h + markW : geom.trimH;
        let d: number;
        const W0 = options.width ?? (options.dpi || options.scale ? undefined : prof.width);
        const H0 = options.height ?? (options.dpi || options.scale ? undefined : prof.height);
        const S0 = options.scale ?? (options.dpi ? undefined : prof.scale);
        if (W0 || H0) {
          const ws = W0 ? (W0 / cropW) * 25.4 : Infinity;
          const hs = H0 ? (H0 / cropH) * 25.4 : Infinity;
          d = Math.min(ws, hs);
        } else if (S0) d = geom.dpi * S0;
        else if (options.dpi) d = options.dpi;
        else if (sz.unit === "px" && (prof.longSide || prof.dpi === 96)) d = geom.dpi;
        else if (prof.longSide) d = (prof.longSide / Math.max(cropW, cropH)) * 25.4;
        else d = prof.dpi ?? geom.dpi;
        if (draft && !options.dpi) d = Math.min(d, 150);
        return d;
      };
      if (!options.layoutOnly) options.onProgress?.({ phase: "layout", pageId: page.id, done, total });
      const { list: list0, info } = await composePage(resolved, page, pl.physical, { bag: pageBag, fonts, assets, lang, defaultLang, draft, print: prof.print, physical: pl.physical, nombre: pl.nombre, outputDpi: dpiFor, characters: resolved.characters });
      info.number = pl.nombre;
      let list = plugins ? (plugins.hook("beforeRender", list0) as DisplayList) : list0;
      // transparent output: no page ground (panel grounds stay; spec 10.15)
      const bgOverride = options.background ?? (typeof docOutput.background === "string" ? (docOutput.background as string) : undefined);
      const transparentOut = options.transparent ?? (bgOverride === "transparent" ? true : undefined) ?? prof.transparent ?? false;
      if (bgOverride && bgOverride !== "transparent") {
        // replace the page ground
        const paint = parsePaint(bgOverride, { u: info.geom.units, box: list.boxes.bleed, seed: resolved.seed, bag, path: ["output", "background"] });
        if (paint) {
          const kids = list.root.children.filter((c) => !(c.kind === "path" && c.tag?.elementType === "page" && c.tag.role === "background"));
          const bgNode: Node = { kind: "path", path: polyPath([{ x: list.boxes.bleed.x, y: list.boxes.bleed.y }, { x: list.boxes.bleed.x + list.boxes.bleed.w, y: list.boxes.bleed.y }, { x: list.boxes.bleed.x + list.boxes.bleed.w, y: list.boxes.bleed.y + list.boxes.bleed.h }, { x: list.boxes.bleed.x, y: list.boxes.bleed.y + list.boxes.bleed.h }], true), fillRule: "nonzero", paint, tag: { elementId: page.id, elementType: "page", role: "background", separation: "background" } };
          list = { ...list, background: paint, root: { ...list.root, children: [bgNode, ...kids] } };
        }
      }
      if (transparentOut && regularFormats.length && (options.colorMode ?? prof.colorMode) === "mono") bag.error("OUTPUT_MODE_UNSUPPORTED", "1-bit output cannot have a transparent background", { pageId: page.id });
      if (transparentOut && formats.some((f) => f === "jpeg")) bag.error("OUTPUT_MODE_UNSUPPORTED", "jpeg cannot store a transparent background", { pageId: page.id });
      if (transparentOut) list = { ...list, background: null, root: { ...list.root, children: list.root.children.filter((c) => !(c.kind === "path" && c.tag?.elementType === "page" && c.tag.role === "background")) } };
      result.layout.push(info);
      if (options.keepLists) (result.lists ??= []).push(list);
      if (bag.hasErrors && throwOnError) throw errorFor(bag.items);
      if (options.layoutOnly) {
        timings[page.id] = performance.now() - tp;
        options.onProgress?.({ phase: "layout", pageId: page.id, done: ++done, total });
        continue;
      }
      const geom = info.geom;
      // resolution
      const intent = geom.color;
      const colorMode = options.colorMode ?? (prof.colorMode === "intent" ? (intent === "mono" ? "gray" : "color") : prof.colorMode);
      const dpi = dpiFor(geom);
      if (dpi > lim.maxDpi) throw new Error(`SECURITY_LIMIT_EXCEEDED: ${Math.round(dpi)} dpi exceeds maxDpi (${lim.maxDpi})`);
      const splitMarks = geom.type === "spread" && spreadMode === "split" && crop === "marks";
      const rasterCrop = splitMarks ? "bleed" : crop;
      const runs = [
        ...regularRuns.map((run) => ({ ...run, layer: undefined, transparent: transparentOut || !!run.list, drawMarks: true })),
        ...psdLayers.map((layer, index) => ({
          name: undefined,
          list: layer.list,
          layer: layer.name,
          formats: index === psdLayers.length - 1 ? psdFormats : [],
          transparent: transparentOut || !layer.list.includes("background"),
          drawMarks: index === 0,
        })),
      ];
      const psds = new Map<string, PsdWriter>();
      for (const run of runs) {
        const backend = new RasterBackend({ maxPixels: lim.maxOutputPixels, dpi, crop: rasterCrop, marks: prof.marks, drawMarks: run.drawMarks, colorMode, toneRendering: options.toneRendering ?? prof.toneRendering, monoLpi: prof.monoLpi ?? 60, imageLpi: prof.imageLpi, monoImages: prof.monoImages, toneCurve: prof.toneCurve ?? "linear", transparent: run.transparent, separations: run.list, assets });
        const needRaster = run.layer !== undefined || run.formats.some((f) => f !== "svg");
        let full = needRaster ? await backend.render(list) : { data: new Uint8ClampedArray(0), width: 0, height: 0, dpi };
        if (plugins && needRaster) full = { ...full, ...(plugins.hook("afterRender", { data: full.data, width: full.width, height: full.height }) as object) };
        // finishing passes: off for print profiles unless the profile itself asks for them
        // finishing: never for print/preview/draft unless the profile itself (not the document) asks for it
        const profOwn = (PROFILES as Record<string, Profile>)[profName] ? undefined : (resolveProfile(profName, { ...(((cfgOf(options)?.output as Obj)?.profiles ?? {}) as Record<string, Obj>), ...((docOutput.profiles ?? {}) as Record<string, Obj>) }) as { finish?: Finish }).finish;
        const quiet = prof.print || profName === "preview" || profName === "draft" || draft;
        const finish = options.finish === false ? undefined : (options.finish ?? profOwn ?? (quiet ? undefined : (prof.finish as Finish | undefined)));
        if (finish && needRaster && !run.list) full = { ...full, ...(await applyFinish(full, finish, { dpi, colorMode: colorMode as "color", seed: resolved.seed, bag })) };
        if (options.debug) drawDebug(full, list, info, dpi, rasterCrop, options.debug, prof.marks?.margin ?? 10);
        // spreads: one joined image, or two pages each with bleed on all sides (spec 10.9)
        const trimWidth = Math.round((geom.trimW * dpi) / 25.4 + 1e-6);
        const trimHeight = Math.round((geom.trimH * dpi) / 25.4 + 1e-6);
        const fullTrim = { x: Math.round((full.width - trimWidth) / 2), y: Math.round((full.height - trimHeight) / 2), w: trimWidth, h: trimHeight };
        const parts: { raster: { data: Uint8ClampedArray; width: number; height: number }; trim: typeof fullTrim; side: string; nombre: number | null }[] = [];
        if (geom.type === "spread" && spreadMode === "split" && needRaster) {
          const trimPx = Math.round((geom.trimW * dpi) / 25.4 + 1e-6);
          const edge = Math.round((full.width - trimPx) / 2);
          const half = Math.round(trimPx / 2);
          // Preserve artwork past the fold for each page's bleed.
          const inner = crop === "trim" ? 0 : Math.round((geom.bleed * dpi) / 25.4 + 1e-6);
          const leftW = edge + half + inner;
          const slice = (x0: number, w: number) => {
            const out = new Uint8ClampedArray(w * full.height * 4);
            for (let y = 0; y < full.height; y++) out.set(full.data.subarray((y * full.width + x0) * 4, (y * full.width + x0 + w) * 4), y * w * 4);
            const raster = { data: out, width: w, height: full.height };
            return splitMarks ? backend.addMarks(raster, geom.bleed) : raster;
          };
          const left = { raster: slice(0, leftW), trim: { ...fullTrim, w: half }, side: "left" };
          const rightW = inner + (trimPx - half) + edge;
          const right = { raster: slice(full.width - rightW, rightW), trim: { ...fullTrim, x: fullTrim.x + half - (full.width - rightW), w: trimPx - half }, side: "right" };
          if (splitMarks) {
            for (const part of [left, right]) {
              const margin = (part.raster.height - full.height) / 2;
              part.trim.x += margin;
              part.trim.y += margin;
            }
          }
          const first = geom.rtl ? right : left;
          const second = geom.rtl ? left : right;
          parts.push({ ...first, nombre: pl.nombre }, { ...second, nombre: pl.nombre === null ? null : pl.nombre + 1 });
        } else parts.push({ raster: full, trim: fullTrim, side: geom.side, nombre: pl.nombre });
        if (run.layer !== undefined) {
          for (const { raster, side } of parts) {
            let psd = psds.get(side);
            if (!psd) {
              psd = new PsdWriter(raster.width, raster.height, colorMode, dpi);
              psds.set(side, psd);
            }
            psd.addLayer(run.layer, raster);
          }
        }
        for (const part of parts)
        for (const fmt of run.formats) {
          const raster = part.raster;
          if (fmt === "pdf") {
            const key = run.name ?? "";
            let pw = pdfs.get(key);
            if (!pw) {
              pw = { writer: new PdfWriter({ title: typeof meta.title === "string" ? meta.title : undefined, author: typeof meta.author === "string" ? meta.author : undefined, date: sde ? new Date(Number(sde) * 1000) : undefined }), colorMode, dpi };
              pdfs.set(key, pw);
            }
            const bleedPx = crop === "trim" ? 0 : Math.round((geom.bleed * dpi) / 25.4 + 1e-6);
            const trim = part.trim;
            pw.writer.addPage({ rgba: raster.data, width: raster.width, height: raster.height, dpi, colorMode: (options.debug ? "color" : colorMode) as "color", transparent: transparentOut || !!run.list, trim, bleed: { x: trim.x - bleedPx, y: trim.y - bleedPx, w: trim.w + 2 * bleedPx, h: trim.h + 2 * bleedPx } });
            continue;
          }
          if (fmt === "svg" && part !== parts[0]) continue;
          const enc: EncodeOptions = { format: fmt, colorMode: options.debug ? "color" : colorMode, dpi, quality: prof.quality, lossless: prof.lossless, compression: prof.compression, chroma: prof.chroma, tiffCompression: prof.tiffCompression, transparent: transparentOut || !!run.list, metadata: prof.metadata === false ? {} : { Software: `mangacli ${PKG_VERSION}`, Title: String(meta.title ?? ""), ...(meta.author ? { Author: String(meta.author) } : {}), ...(meta.copyright ? { Copyright: String(meta.copyright) } : {}), "mangacli:page": page.id, "mangacli:seed": String(resolved.seed), ...(sourceHash ? { "mangacli:source-hash": sourceHash } : {}) } };
          const data = fmt === "psd" ? psds.get(part.side)!.build() : fmt === "svg" ? Buffer.from(await renderSvg(list, { crop, assets, colorMode: colorMode as "color", imageDpi: Math.min(dpi, 300) })) : await encode(raster.data, raster.width, raster.height, enc);
          const svgSize = () => {
            const bw = crop === "trim" ? geom.trimW : geom.bleedBox.w;
            const bh = crop === "trim" ? geom.trimH : geom.bleedBox.h;
            return { w: Math.round((bw * dpi) / 25.4), h: Math.round((bh * dpi) / 25.4) };
          };
          const size = fmt === "svg" ? svgSize() : { w: raster.width, h: raster.height };
          const rp: RenderedPage = { id: page.id, index: pl.idx + 1, number: part.nombre, side: part.side, format: fmt, mimeType: MIME[fmt], colorMode, width: size.w, height: size.h, dpi, separation: run.name, data };
          if (outDir) {
            const file = outName(page, pl.idx, part.side, part.nombre, geom.type === "spread" && parts.length === 1, parts.length > 1, run.name, EXT[fmt]);
            if (emitted.has(file)) {
              bag.error("OUTPUT_NAME_COLLISION", `two outputs map to ${file}`);
              continue;
            }
            emitted.add(file);
            mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, data);
            renameSync(tmp, file);
            rp.path = file;
            result.files.push(file);
          }
          result.pages.push(rp);
        }
      }
      if (outDir && options.emit?.includes("ir")) {
        const pv: string | number | number[] = pl.nombre === null ? `i${pl.idx + 1}` : geom.type === "spread" ? [pl.nombre, pl.nombre + 1] : pl.nombre;
        const f = join(outDir, `${fillName("{name}-{page:03}", { name: p.name, page: pv })}.ir.json`);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify(roundList(list)));
      }
    } catch (e) {
      if (e instanceof MangaError && !(e instanceof MangaRenderError)) throw e;
      result.failures.push({ pageId: page.id, index: pl.idx + 1, error: e as Error });
      // errors raised as "CODE: message" keep their code (OUTPUT_TOO_LARGE, OUTPUT_MODE_UNSUPPORTED, …)
      const m = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+): ([\s\S]*)$/.exec((e as Error).message);
      const sys = (e as { code?: string }).code;
      if (m) bag.error(m[1], `page ${page.id}: ${m[2]}`, { pageId: page.id });
      else if (sys && /^E[A-Z]+$/.test(sys) && (e as { syscall?: string }).syscall === "open") bag.error("OUTPUT_WRITE_FAILED", `page ${page.id}: ${(e as Error).message}`, { pageId: page.id });
      else bag.error("RENDER_FAILED", `page ${page.id}: ${(e as Error).message}`, { pageId: page.id });
      if (options.failFast) break;
    }
    timings[page.id] = performance.now() - tp;
    options.onProgress?.({ phase: "render", pageId: page.id, done: ++done, total });
  }
  for (const [sep, pw] of pdfs) {
    if (!pw.writer.pageCount) continue;
    const data = pw.writer.build();
    const rp: RenderedPage = { id: resolved.pages[0]?.id ?? "document", index: 0, number: null, side: "document", format: "pdf", mimeType: MIME.pdf, colorMode: pw.colorMode, width: 0, height: 0, dpi: pw.dpi, separation: sep || undefined, data };
    if (outDir) {
      const file = join(outDir, `${p.name}${sep ? `-${sep}` : ""}.pdf`);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, file);
      rp.path = file;
      result.files.push(file);
    }
    result.pages.push(rp);
  }
  if (outDir && options.emit?.length) mkdirSync(outDir, { recursive: true });
  if (outDir && options.emit?.includes("transcript")) {
    const tr = result.layout.map((l) => ({ id: l.geom.id, number: l.number ?? null, items: l.transcript }));
    writeFileSync(join(outDir, `${p.name}.transcript.json`), JSON.stringify({ pages: tr }, null, 2));
    writeFileSync(join(outDir, `${p.name}.transcript.md`), tr.map((pg) => `## ${pg.id}\n\n` + pg.items.map((i) => `- ${i.who ? `**${(resolved.characters[i.who]?.name as string) ?? i.who}**: ` : ""}${i.text.replace(/\n/g, " ")}`).join("\n")).join("\n\n"));
  }
  if (outDir && options.emit?.includes("layout")) writeFileSync(join(outDir, `${p.name}.layout.json`), JSON.stringify(result.layout.map((l) => ({ ...l, geom: { ...l.geom, units: undefined } }))));
  if (outDir && options.emit?.includes("manifest")) {
    const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ generator: `mangacli ${PKG_VERSION}`, source: p.loaded.entry ?? null, seed: resolved.seed, files: result.pages.map((r) => ({ path: r.path ? relativePath(outDir, r.path) : null, page: r.id, number: r.number, side: r.side, width: r.width, height: r.height, dpi: Math.round(r.dpi), format: r.format, separation: r.separation ?? null, sha256: sha(r.data) })) }, null, 2));
  }
  timings.total = performance.now() - t0;
  if (options.strict && bag.items.some((d) => d.severity === "warning")) {
    // strict: warnings count as errors, also in the returned diagnostics
    result.diagnostics = bag.items.map((d) => (d.severity === "warning" ? { ...d, severity: "error" as const } : d));
    if (throwOnError) throw new MangaValidationError(result.diagnostics);
  }
  if (options.onDiagnostic) for (const d of result.diagnostics) options.onDiagnostic(d);
  if (result.failures.length && throwOnError) {
    const codes = bag.items.filter((d) => d.severity === "error").map((d) => d.code);
    const msg = result.failures.map((f) => `${f.pageId}: ${f.error.message}`).join("\n");
    if (codes.some((c) => /^(ASSET|FONT)_/.test(c))) throw new MangaResourceError(codes.find((c) => /^(ASSET|FONT)_/.test(c))!, msg, bag.items);
    if (codes.some((c) => /^SECURITY_/.test(c))) throw new MangaSecurityError(codes.find((c) => /^SECURITY_/.test(c))!, msg, bag.items);
    throw new MangaRenderError(codes[0] ?? "RENDER_FAILED", msg, bag.items, result.failures);
  }
  return result;
}

/** the exception class for a set of error diagnostics (spec 11.9.1) */
function errorFor(items: Diagnostic[]): MangaError {
  const first = items.find((d) => d.severity === "error");
  // unreadable assets/fonts found while drawing are resource errors; everything else is validation
  if (first && /^(ASSET_DECODE_FAILED|ASSET_UNSUPPORTED_FORMAT|FONT_LOAD_FAILED|FONT_UNSUPPORTED_FORMAT|FONT_DOWNLOAD_FAILED|FONT_INTEGRITY_FAILED)$/.test(first.code)) return new MangaResourceError(first.code, first.message, items);
  return new MangaValidationError(items);
}

function normalizeSeparations(s: RenderOptions["separate"]): { name: string; list: string[] }[] | null {
  if (!s) return null;
  const all = ["background", "art", "fx", "frame", "balloon", "text", "sfx", "furniture"];
  if (s === "all") return all.map((n) => ({ name: n, list: [n] }));
  if (Array.isArray(s)) return s.map((n) => ({ name: n, list: [n] }));
  return Object.entries(s).map(([name, list]) => ({ name, list }));
}

function roundList(list: DisplayList): unknown {
  return JSON.parse(JSON.stringify(list, (_, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v)));
}

/** debug overlay (spec 10.11.1): boxes, panels with reading order, elements, text, balloons, order, grid */
function drawDebug(raster: { data: Uint8ClampedArray; width: number; height: number }, list: DisplayList, info: PageLayoutInfo, dpi: number, crop: string, layers: boolean | string[], markMargin = 10) {
  const s = dpi / 25.4;
  const off = crop === "bleed" ? list.boxes.bleed.x : crop === "marks" ? list.boxes.bleed.x - markMargin : 0;
  const want = (k: string) => layers === true || (Array.isArray(layers) && layers.includes(k));
  const cv = createCanvas(raster.width, raster.height);
  const g = cv.getContext("2d");
  const id = g.createImageData(raster.width, raster.height);
  id.data.set(raster.data);
  g.putImageData(id, 0, 0);
  g.setTransform(s, 0, 0, s, -off * s, -off * s);
  const lw = 0.6 / s;
  const fontPx = Math.max(9, dpi / 12);
  g.font = `${fontPx / s}px sans-serif`;
  const rect = (r: { x: number; y: number; w: number; h: number }, c: string, dash?: number[]) => {
    g.strokeStyle = c;
    g.lineWidth = lw * 1.5;
    g.setLineDash(dash ? dash.map((d) => d / s) : []);
    g.strokeRect(r.x, r.y, r.w, r.h);
    g.setLineDash([]);
  };
  const label = (t: string, x: number, y: number, c: string) => {
    g.fillStyle = "rgba(255,255,255,0.75)";
    const w = g.measureText(t).width;
    g.fillRect(x - 1 / s, y - fontPx / s, w + 2 / s, (fontPx * 1.25) / s);
    g.fillStyle = c;
    g.fillText(t, x, y);
  };
  if (want("grid")) {
    g.strokeStyle = "rgba(0,120,255,0.25)";
    g.lineWidth = lw;
    for (let x = 0; x <= list.boxes.trim.w; x += 10) {
      g.beginPath();
      g.moveTo(x, list.boxes.bleed.y);
      g.lineTo(x, list.boxes.bleed.y + list.boxes.bleed.h);
      g.stroke();
    }
    for (let y = 0; y <= list.boxes.trim.h; y += 10) {
      g.beginPath();
      g.moveTo(list.boxes.bleed.x, y);
      g.lineTo(list.boxes.bleed.x + list.boxes.bleed.w, y);
      g.stroke();
    }
  }
  if (want("boxes")) {
    rect(list.boxes.bleed, "#ff9900", [4, 2]);
    rect(list.boxes.trim, "#ff0000");
    rect(list.boxes.baseFrame, "#00a0ff");
    rect(list.boxes.safe, "#00c000", [2, 2]);
  }
  if (want("panels"))
    for (const pn of info.panels) {
      g.strokeStyle = "rgba(0,90,255,0.9)";
      g.lineWidth = lw * 2;
      g.beginPath();
      pn.polygon.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      g.stroke();
      label(`${pn.order}  ${pn.id}`, pn.box.x + 1.5, pn.box.y + 4, "#0050ff");
    }
  if (want("elements"))
    for (const e of info.elements) {
      rect(e.bbox, "rgba(255,0,255,0.8)");
      label(e.id, e.bbox.x, e.bbox.y + e.bbox.h + 3, "#c000c0");
    }
  if (want("text") || want("balloons"))
    for (const e of info.elements) if (e.type === "text" || e.type === "balloon" || e.type === "sfx") rect(e.bbox, e.type === "balloon" ? "rgba(0,170,0,0.9)" : "rgba(255,120,0,0.9)", [3, 2]);
  if (want("order")) {
    // reading order of balloons inside each panel
    const byPanel = new Map<string, { x: number; y: number }[]>();
    for (const t of info.transcript) {
      const e = info.elements.find((x) => x.id === t.id);
      if (!e || e.type !== "balloon") continue;
      const k = t.panel ?? "page";
      byPanel.set(k, [...(byPanel.get(k) ?? []), { x: e.bbox.x + e.bbox.w / 2, y: e.bbox.y + e.bbox.h / 2 }]);
    }
    g.strokeStyle = "rgba(255,0,0,0.85)";
    g.fillStyle = "rgba(255,0,0,0.85)";
    g.lineWidth = lw * 2;
    for (const pts of byPanel.values())
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b2 = pts[i];
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b2.x, b2.y);
        g.stroke();
        const ang = Math.atan2(b2.y - a.y, b2.x - a.x);
        const h = 2.2;
        g.beginPath();
        g.moveTo(b2.x, b2.y);
        g.lineTo(b2.x - Math.cos(ang - 0.4) * h, b2.y - Math.sin(ang - 0.4) * h);
        g.lineTo(b2.x - Math.cos(ang + 0.4) * h, b2.y - Math.sin(ang + 0.4) * h);
        g.closePath();
        g.fill();
      }
  }
  raster.data.set(g.getImageData(0, 0, raster.width, raster.height).data);
}

export { DiagnosticBag };

export interface ValidateResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  layout: PageLayoutInfo[];
}

/** schema validation plus layout (no rasterization): overflow, resolution, references (spec 12.3.2) */
export async function validate(input: MangaInput | Project, options: RenderOptions = {}): Promise<ValidateResult> {
  const r = await render(input, { ...options, outDir: undefined, emit: undefined, throwOnError: false, layoutOnly: true });
  const strict = !!options.strict;
  const ok = !r.diagnostics.some((d) => d.severity === "error" || (strict && d.severity === "warning")) && r.failures.length === 0;
  return { ok, diagnostics: r.diagnostics, layout: r.layout };
}

/** render a single page (1-based index or page ID) */
export async function renderPage(input: MangaInput | Project, page: number | string, options: RenderOptions = {}): Promise<RenderedPage> {
  const r = await render(input, { ...options, pages: [page] });
  const out = r.pages[0];
  if (!out) throw new MangaError("RENDER_FAILED", `page ${page} produced no output`, r.diagnostics);
  return out;
}

export interface Renderer {
  load(input: MangaInput, options?: RenderOptions): Project;
  validate(input: MangaInput | Project, options?: RenderOptions): Promise<ValidateResult>;
  render(input: MangaInput | Project, options?: RenderOptions): Promise<RenderResult>;
  renderPage(input: MangaInput | Project, page: number | string, options?: RenderOptions): Promise<RenderedPage>;
  layout(input: MangaInput | Project, options?: RenderOptions): Promise<LayoutTree>;
  displayList(input: MangaInput | Project, page: number | string, options?: RenderOptions): Promise<DisplayList>;
  resolve(input: MangaInput | Project, options?: RenderOptions): ResolvedDoc;
  renderStream(input: MangaInput | Project, options?: RenderOptions): AsyncGenerator<RenderedPage>;
  /** drop cached fonts (all, or those whose key contains `match`) */
  invalidate(match?: string): void;
  dispose(): void;
}

/** a renderer with shared defaults and font cache (spec 11.4) */
export function createRenderer(base: RenderOptions = {}): Renderer {
  const fontCache = new Map<string, import("./fonts/registry.js").LoadedFont>();
  const merged = (o: RenderOptions = {}): RenderOptions => ({ ...base, ...o, fontCache, config: o.config ?? base.config });
  // a project loaded through the renderer keeps the renderer's root/diagnostic settings
  return {
    load: (input, o) => load(input, merged(o)),
    validate: (input, o) => validate(input, merged(o)),
    render: (input, o) => render(input, merged(o)),
    renderPage: (input, page, o) => renderPage(input, page, merged(o)),
    layout: (input, o) => layout(input, merged(o)),
    resolve: (input, o) => resolve(input, merged(o)),
    renderStream: (input, o) => renderStream(input, merged(o)),
    invalidate: (match) => {
      for (const k of [...fontCache.keys()]) if (!match || k.includes(match)) fontCache.delete(k);
    },
    dispose: () => fontCache.clear(),
    displayList: async (input, page, o) => {
      const r = await render(input, { ...merged(o), pages: [page], layoutOnly: true, keepLists: true, throwOnError: false });
      const list = r.lists?.[0];
      if (!list) throw new MangaError("RENDER_FAILED", `page ${page} produced no display list`, r.diagnostics);
      return list;
    },
  };
}

/** the layout of every page without rasterizing (spec 11.2) */
export interface LayoutTree {
  pages: PageLayoutInfo[];
  diagnostics: Diagnostic[];
}

export async function layout(input: MangaInput | Project, options: RenderOptions = {}): Promise<LayoutTree> {
  const v = await validate(input, options);
  return { pages: v.layout, diagnostics: v.diagnostics };
}

/** render pages one by one, yielding each page's outputs as soon as it is done (spec 11.2) */
export async function* renderStream(input: MangaInput | Project, options: RenderOptions = {}): AsyncGenerator<RenderedPage> {
  const fontCache = options.fontCache ?? new Map();
  const project = typeof input === "object" && input !== null && !(input instanceof URL) && "bag" in input && "loaded" in input ? (input as Project) : load(input as MangaInput, options);
  const first = await render(project, { ...options, fontCache, layoutOnly: true, throwOnError: false, outDir: undefined, onDiagnostic: undefined });
  // validation errors are thrown before the first page (spec 11.9.2)
  if (first.diagnostics.some((d) => d.severity === "error") && options.throwOnError !== false) throw errorFor(first.diagnostics);
  const ids = first.layout.map((l) => l.geom.id);
  const failures: RenderResult["failures"] = [];
  for (const id of ids) {
    if (options.signal?.aborted) throw new MangaAbortError();
    const r = await render(project, { ...options, fontCache, pages: [id], throwOnError: false });
    failures.push(...r.failures);
    if (r.failures.length && options.failFast) throw new MangaRenderError("RENDER_FAILED", r.failures.map((f) => `${f.pageId}: ${f.error.message}`).join("\n"), r.diagnostics, r.failures);
    for (const pg of r.pages) yield pg;
  }
  if (failures.length && options.throwOnError !== false) throw new MangaRenderError("RENDER_FAILED", failures.map((f) => `${f.pageId}: ${f.error.message}`).join("\n"), [], failures);
}

/** parse a YAML string into a project (spec 11.2) */
export function parseDocument(text: string, options: RenderOptions & { filename?: string } = {}): Project {
  return load({ yaml: text, filename: options.filename, baseDir: options.baseDir }, options);
}

/** the cascade-resolved document (spec 11.2) */
export function resolve(input: MangaInput | Project, options: RenderOptions = {}): ResolvedDoc {
  const p = typeof input === "object" && input !== null && !(input instanceof URL) && "bag" in input && "loaded" in input ? (input as Project) : load(input as MangaInput, options);
  const bag = p.bag.fork();
  const r = resolveDocument(p.doc, bag, { seedOverride: options.seed, lang: options.lang, configDefaults: cfgOf(options)?.defaults as Obj, configStyles: cfgOf(options)?.styles as Record<string, Obj> });
  if (bag.hasErrors && options.throwOnError !== false) throw errorFor(bag.items);
  return r;
}
