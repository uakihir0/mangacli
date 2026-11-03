// Public API (spec 11).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { type Diagnostic, DiagnosticBag, MangaError, MangaValidationError, suggest } from "./core/diagnostics.js";
import { FontRegistry, type FontDef } from "./fonts/registry.js";
import { type LoadedDocument, loadDocumentFile, loadDocumentFromObject, loadDocumentFromString } from "./load/document.js";
import { isObj, normalizeDocument } from "./load/normalize.js";
import { type ResolvedDoc, resolveDocument } from "./model/resolve.js";
import { type EncodeOptions, EXT, MIME, type OutputFormat, encode } from "./output/encode.js";
import { type Profile, resolveProfile } from "./output/profiles.js";
import { PdfWriter } from "./output/pdf.js";
import { AssetRegistry } from "./render/assets.js";
import { type PageLayoutInfo, composePage } from "./render/compose.js";
import type { DisplayList } from "./render/ir.js";
import { RasterBackend } from "./render/raster.js";
import { renderSvg } from "./render/svg.js";
import { Document } from "./schema/schema.js";
import { computePageGeom } from "./layout/page.js";
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
  pages?: string | (number | string)[];
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
  assets?: Record<string, Uint8Array>;
  fonts?: Record<string, Uint8Array | Obj>;
  fontSet?: string;
  fontDownload?: "auto" | "never";
  fontDir?: string;
  fontCacheDir?: string;
  fontMirror?: string;
  fontFallback?: string[];
  missingAssets?: "error" | "placeholder";
  ignoreDocumentOutput?: boolean;
  config?: Obj;
  emit?: ("layout" | "ir" | "transcript" | "manifest")[];
  onProgress?: (e: { phase: string; pageId?: string; done: number; total: number }) => void;
  onDiagnostic?: (d: Diagnostic) => void;
  signal?: AbortSignal;
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

function isLoaded(x: unknown): x is LoadedDocument {
  return isObj(x) && "data" in x && "locate" in x && "files" in x;
}

export function load(input: MangaInput, options: RenderOptions = {}): Project {
  const bag = new DiagnosticBag(undefined, options.diagnostics ?? (options.config?.diagnostics as Record<string, "off">) ?? {});
  let loaded: LoadedDocument;
  let name = "manga";
  if (typeof input === "string" || input instanceof URL) {
    const p = input instanceof URL ? input.pathname : input;
    loaded = loadDocumentFile(p, bag, options.root);
    name = basename(p, extname(p));
  } else if (isLoaded(input)) loaded = input;
  else if (isObj(input) && typeof input.yaml === "string") {
    const base = (input.baseDir as string) ?? options.baseDir ?? options.root ?? process.cwd();
    loaded = loadDocumentFromString(input.yaml as string, (input.filename as string) ?? join(base, "<input>.yaml"), bag, options.root);
  } else loaded = loadDocumentFromObject(input as Obj, options.baseDir ?? options.root ?? process.cwd());
  bag.setLocator(loaded.locate);
  const doc = bag.hasErrors ? {} : normalizeDocument(loaded.data, bag);
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
      else if (typeof v.alias === "string") defs.set(k, { kind: "alias", name: v.alias });
      else if (typeof v.catalog === "string") defs.set(k, { kind: "catalog", id: v.catalog, weight: v.weight as number, bold: v.bold as string, fallback: v.fallback as string[] });
      else if (Array.isArray(v.compose)) defs.set(k, { kind: "compose", items: v.compose as never, fallback: v.fallback as string[], bold: v.bold as string });
    }
  };
  addDefs(o.config?.fonts as Obj);
  addDefs(p.doc.fonts as Obj);
  const loc = isObj(p.doc.locales) && o.lang ? ((p.doc.locales as Obj)[o.lang] as Obj | undefined) : undefined;
  addDefs(loc?.fonts as Obj);
  addDefs(o.fonts as Obj);
  const set = o.fontSet ?? (p.doc.fontSet as string) ?? (o.config?.fontSet as string) ?? "manga-basic";
  // global fallback entries may be font names or file paths
  const fallback = (o.fontFallback ?? (o.config?.fontFallback as string[]) ?? []).map((f, i) => {
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
    onInfo: (code, message) => p.bag.info(code, message),
  }, o.fontCache);
}

function selectPages(sel: RenderOptions["pages"], ids: string[]): Set<number> {
  const all = new Set(ids.map((_, i) => i));
  if (!sel) return all;
  const out = new Set<number>();
  const items = typeof sel === "string" ? sel.split(",").map((s) => s.trim()).filter(Boolean) : sel.map(String);
  for (const it of items) {
    const m = it.match(/^(\d+)(?:-(\d*))?$/);
    if (m) {
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : m[2] === "" ? ids.length : Number(m[2]);
      for (let i = a; i <= b; i++) if (i >= 1 && i <= ids.length) out.add(i - 1);
      continue;
    }
    const idx = ids.indexOf(it);
    if (idx >= 0) out.add(idx);
    else throw new MangaError("REF_NOT_FOUND", `page "${it}" not found`);
  }
  return out;
}

function fillName(tpl: string, vars: Record<string, string | number>): string {
  return tpl
    .replace(/\{\{/g, "\u0001")
    .replace(/\}\}/g, "\u0002")
    .replace(/\{(\w+)(?::(\d+))?\}/g, (_, k: string, w?: string) => {
      const v = vars[k];
      if (v === undefined) throw new MangaError("SCHEMA_ENUM", `unknown file name placeholder {${k}}`);
      const s = String(v);
      return w && /^\d+$/.test(s) ? s.padStart(Number(w), "0") : s;
    })
    .replace(/\u0001/g, "{")
    .replace(/\u0002/g, "}")
    .replace(/[\\/]|\.\./g, "_");
}

export async function render(input: MangaInput | Project, options: RenderOptions = {}): Promise<RenderResult> {
  const t0 = performance.now();
  const given = typeof input === "object" && input !== null && !(input instanceof URL) && "bag" in input && "loaded" in input;
  // a Project can be rendered many times: each run reports into its own copy of the load diagnostics
  const p = given ? { ...(input as Project), bag: (input as Project).bag.fork() } : load(input as MangaInput, options);
  const bag = p.bag;
  const timings: Record<string, number> = {};
  const result: RenderResult = { pages: [], files: [], diagnostics: bag.items, failures: [], layout: [], timings };
  const throwOnError = options.throwOnError !== false;
  const fail = () => {
    if (throwOnError) throw new MangaValidationError(bag.items);
    return result;
  };
  if (bag.hasErrors) return fail();
  const docOutput = (!options.ignoreDocumentOutput && isObj(p.doc.output) ? p.doc.output : {}) as Obj;
  const profName = options.profile ?? (docOutput.profile as string) ?? (options.config?.output as Obj | undefined)?.profile as string ?? "web";
  let prof: Profile;
  try {
    prof = resolveProfile(profName, { ...(((options.config?.output as Obj)?.profiles ?? {}) as Record<string, Obj>), ...((docOutput.profiles ?? {}) as Record<string, Obj>) });
  } catch (e) {
    bag.error("SCHEMA_ENUM", (e as Error).message);
    return fail();
  }
  const draft = options.draft ?? prof.draft ?? false;
  const lang = options.lang ?? ((p.doc.meta as Obj | undefined)?.lang as string) ?? "ja";
  const defaultLang = ((p.doc.meta as Obj | undefined)?.lang as string) ?? "ja";
  const resolved = resolveDocument(p.doc, bag, { seedOverride: options.seed, lang, configDefaults: options.config?.defaults as Obj, configStyles: options.config?.styles as Record<string, Obj> });
  p.resolved = resolved;
  if (bag.hasErrors) return fail();
  const fonts = buildFonts(p, options);
  const assets = new AssetRegistry((p.doc.assets ?? {}) as Record<string, Obj>, options.assets ?? {}, bag, 350, draft ? "placeholder" : (options.missingAssets ?? (options.config?.missingAssets as "error") ?? "error"));
  const ids = resolved.pages.map((pg) => pg.id);
  let selected: Set<number>;
  try {
    selected = selectPages(options.pages, ids);
  } catch (e) {
    bag.error("REF_NOT_FOUND", (e as Error).message);
    return fail();
  }
  timings.prepare = performance.now() - t0;
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
    const nb = isBlank && !countBlank ? null : nombre;
    plan.push({ idx: i, physical, nombre: nb });
    const span = pg.type === "spread" ? 2 : 1;
    physical += span;
    if (!isBlank || countBlank) nombre += span;
  }
  const formats = (Array.isArray(options.format ?? prof.format) ? (options.format ?? prof.format) : [options.format ?? prof.format]) as OutputFormat[];
  const outDir = options.outDir ? resolvePath(options.outDir) : undefined;
  const nameTpl = options.name ?? (docOutput.name as string) ?? prof.name ?? "{name}-{page:03}";
  const emitted = new Set<string>();
  // pdf: all pages of a run go into one document
  const pdfs = new Map<string, { writer: PdfWriter; colorMode: string; dpi: number }>();
  const meta = (p.doc.meta ?? {}) as Obj;
  const sde = process.env.SOURCE_DATE_EPOCH;
  const total = selected.size;
  let done = 0;
  for (const pl of plan) {
    if (!selected.has(pl.idx)) continue;
    options.signal?.throwIfAborted();
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
        if (options.width || options.height) {
          const ws = options.width ? (options.width / cropW) * 25.4 : Infinity;
          const hs = options.height ? (options.height / cropH) * 25.4 : Infinity;
          d = Math.min(ws, hs);
        } else if (options.scale) d = geom.dpi * options.scale;
        else if (options.dpi) d = options.dpi;
        else if (sz.unit === "px" && (prof.longSide || prof.dpi === 96)) d = geom.dpi;
        else if (prof.longSide) d = (prof.longSide / Math.max(cropW, cropH)) * 25.4;
        else d = prof.dpi ?? geom.dpi;
        if (draft && !options.dpi) d = Math.min(d, 150);
        return d;
      };
      const { list, info } = await composePage(resolved, page, pl.physical, { bag: pageBag, fonts, assets, lang, defaultLang, draft, print: prof.print, physical: pl.physical, nombre: pl.nombre, outputDpi: dpiFor });
      result.layout.push(info);
      if (options.keepLists) (result.lists ??= []).push(list);
      if (bag.hasErrors && throwOnError) throw new MangaValidationError(bag.items);
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
      const seps = normalizeSeparations(options.separate ?? prof.separate);
      const runs: { name?: string; list?: string[] }[] = seps ? seps : [{}];
      for (const run of runs) {
        const backend = new RasterBackend({ dpi, crop, marks: prof.marks, colorMode, toneRendering: options.toneRendering ?? prof.toneRendering, monoLpi: prof.monoLpi ?? 60, toneCurve: prof.toneCurve ?? "linear", transparent: options.transparent ?? prof.transparent ?? !!run.list, separations: run.list, assets });
        const needRaster = formats.some((f) => f !== "svg");
        const full = needRaster ? await backend.render(list) : { data: new Uint8ClampedArray(0), width: 0, height: 0, dpi };
        if (options.debug) drawDebug(full, list, info, dpi, crop, options.debug);
        // spreads: one joined image, or two pages each with bleed on all sides (spec 10.9)
        const spreadMode = options.spread ?? (docOutput.spread as "joined" | "split" | undefined) ?? prof.spread ?? "joined";
        const parts: { raster: { data: Uint8ClampedArray; width: number; height: number }; side: string; nombre: number | null }[] = [];
        if (geom.type === "spread" && spreadMode === "split" && needRaster) {
          const trimPx = Math.round((geom.trimW * dpi) / 25.4 + 1e-6);
          const edge = Math.round((full.width - trimPx) / 2);
          const half = Math.round(trimPx / 2);
          const leftW = edge + half + edge;
          const slice = (x0: number, w: number) => {
            const out = new Uint8ClampedArray(w * full.height * 4);
            for (let y = 0; y < full.height; y++) out.set(full.data.subarray((y * full.width + x0) * 4, (y * full.width + x0 + w) * 4), y * w * 4);
            return { data: out, width: w, height: full.height };
          };
          const left = { raster: slice(0, leftW), side: "left" };
          const right = { raster: slice(full.width - (trimPx - half + 2 * edge), trimPx - half + 2 * edge), side: "right" };
          const first = geom.rtl ? right : left;
          const second = geom.rtl ? left : right;
          parts.push({ ...first, nombre: pl.nombre }, { ...second, nombre: pl.nombre === null ? null : pl.nombre + 1 });
        } else parts.push({ raster: full, side: geom.side, nombre: pl.nombre });
        for (const part of parts)
        for (const fmt of formats) {
          const raster = part.raster;
          if (fmt === "pdf") {
            const key = run.name ?? "";
            let pw = pdfs.get(key);
            if (!pw) {
              pw = { writer: new PdfWriter({ title: typeof meta.title === "string" ? meta.title : undefined, author: typeof meta.author === "string" ? meta.author : undefined, date: sde ? new Date(Number(sde) * 1000) : undefined }), colorMode, dpi };
              pdfs.set(key, pw);
            }
            const trimH = Math.round((geom.trimH * dpi) / 25.4 + 1e-6);
            const edge = Math.round((raster.height - trimH) / 2);
            const bleedPx = crop === "trim" ? 0 : Math.round((geom.bleed * dpi) / 25.4 + 1e-6);
            const trim = { x: edge, y: edge, w: raster.width - 2 * edge, h: raster.height - 2 * edge };
            pw.writer.addPage({ rgba: raster.data, width: raster.width, height: raster.height, dpi, colorMode: (options.debug ? "color" : colorMode) as "color", trim, bleed: { x: trim.x - bleedPx, y: trim.y - bleedPx, w: trim.w + 2 * bleedPx, h: trim.h + 2 * bleedPx } });
            continue;
          }
          if (fmt === "svg" && part !== parts[0]) continue;
          const enc: EncodeOptions = { format: fmt, colorMode: options.debug ? "color" : colorMode, dpi, quality: prof.quality, lossless: prof.lossless, transparent: options.transparent ?? !!run.list, metadata: { Software: "mangacli", Title: String((p.doc.meta as Obj | undefined)?.title ?? ""), "mangacli:page": page.id, "mangacli:seed": String(resolved.seed) } };
          const data = fmt === "svg" ? Buffer.from(await renderSvg(list, { crop, assets, colorMode: colorMode as "color", imageDpi: Math.min(dpi, 300) })) : await encode(raster.data, raster.width, raster.height, enc);
          const rp: RenderedPage = { id: page.id, index: pl.idx + 1, number: part.nombre, side: part.side, format: fmt, mimeType: MIME[fmt], colorMode, width: raster.width, height: raster.height, dpi, separation: run.name, data };
          if (outDir) {
            const splitSuffix = parts.length > 1 && !/\{(page|side)/.test(nameTpl) ? `-${part.side}` : "";
            const base = fillName(nameTpl, { name: p.name, title: String((p.doc.meta as Obj | undefined)?.title ?? p.name), page: part.nombre ?? `i${pl.idx + 1}`, index: pl.idx + 1, id: page.id, side: part.side, profile: profName, lang, sep: run.name ?? "" }) + splitSuffix + (run.name && !nameTpl.includes("{sep}") ? `-${run.name}` : "");
            const file = join(outDir, `${base}.${EXT[fmt]}`);
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
      if (outDir && options.emit?.includes("ir")) writeFileSync(join(outDir, `${p.name}-${page.id}.ir.json`), JSON.stringify(roundList(list)));
    } catch (e) {
      if (e instanceof MangaValidationError) throw e;
      result.failures.push({ pageId: page.id, index: pl.idx + 1, error: e as Error });
      bag.error("RENDER_FAILED", `page ${page.id}: ${(e as Error).message}`, { pageId: page.id });
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
  if (outDir && options.emit?.includes("transcript")) {
    const tr = result.layout.map((l) => ({ id: l.geom.id, items: l.transcript }));
    writeFileSync(join(outDir, `${p.name}.transcript.json`), JSON.stringify({ pages: tr }, null, 2));
    writeFileSync(join(outDir, `${p.name}.transcript.md`), tr.map((pg) => `## ${pg.id}\n\n` + pg.items.map((i) => `- ${i.who ? `**${(resolved.characters[i.who]?.name as string) ?? i.who}**: ` : ""}${i.text.replace(/\n/g, " ")}`).join("\n")).join("\n\n"));
  }
  if (outDir && options.emit?.includes("layout")) writeFileSync(join(outDir, `${p.name}.layout.json`), JSON.stringify(result.layout.map((l) => ({ ...l, geom: { ...l.geom, units: undefined } }))));
  if (outDir && options.emit?.includes("manifest")) writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ files: result.pages.map((r) => ({ path: r.path, page: r.id, width: r.width, height: r.height, format: r.format })) }, null, 2));
  timings.total = performance.now() - t0;
  if (options.strict && bag.items.some((d) => d.severity === "warning")) {
    if (throwOnError) throw new MangaValidationError(bag.items.map((d) => (d.severity === "warning" ? { ...d, severity: "error" as const } : d)));
  }
  if (result.failures.length && throwOnError) throw new MangaError("RENDER_FAILED", result.failures.map((f) => `${f.pageId}: ${f.error.message}`).join("\n"), bag.items);
  return result;
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

function drawDebug(raster: { data: Uint8ClampedArray; width: number; height: number }, list: DisplayList, info: PageLayoutInfo, dpi: number, crop: string, layers: boolean | string[]) {
  const s = dpi / 25.4;
  const off = crop === "bleed" ? list.boxes.bleed.x : crop === "marks" ? list.boxes.bleed.x - 10 : 0;
  const want = (k: string) => layers === true || (Array.isArray(layers) && layers.includes(k));
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const px = Math.round((x - off) * s);
    const py = Math.round((y - off) * s);
    if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) return;
    const i = (py * raster.width + px) * 4;
    raster.data[i] = (raster.data[i] + r) >> 1;
    raster.data[i + 1] = (raster.data[i + 1] + g) >> 1;
    raster.data[i + 2] = (raster.data[i + 2] + b) >> 1;
  };
  const rect = (r: { x: number; y: number; w: number; h: number }, c: [number, number, number]) => {
    const step = 0.5 / s;
    for (let x = r.x; x <= r.x + r.w; x += step) {
      put(x, r.y, ...c);
      put(x, r.y + r.h, ...c);
    }
    for (let y = r.y; y <= r.y + r.h; y += step) {
      put(r.x, y, ...c);
      put(r.x + r.w, y, ...c);
    }
  };
  if (want("boxes")) {
    rect(list.boxes.trim, [255, 0, 0]);
    rect(list.boxes.baseFrame, [0, 160, 255]);
    rect(list.boxes.safe, [0, 200, 0]);
  }
  if (want("elements")) for (const e of info.elements) rect(e.bbox, [255, 0, 255]);
  void computePageGeom;
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
  layout(input: MangaInput | Project, options?: RenderOptions): Promise<PageLayoutInfo[]>;
  displayList(input: MangaInput | Project, page: number | string, options?: RenderOptions): Promise<DisplayList>;
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
    layout: async (input, o) => (await validate(input, merged(o))).layout,
    displayList: async (input, page, o) => {
      const r = await render(input, { ...merged(o), pages: [page], layoutOnly: true, keepLists: true, throwOnError: false });
      const list = r.lists?.[0];
      if (!list) throw new MangaError("RENDER_FAILED", `page ${page} produced no display list`, r.diagnostics);
      return list;
    },
  };
}

/** layout without rasterizing (spec 11.2) */
export async function layout(input: MangaInput | Project, options: RenderOptions = {}): Promise<PageLayoutInfo[]> {
  return (await validate(input, options)).layout;
}
