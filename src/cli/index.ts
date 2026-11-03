#!/usr/bin/env node
// mangacli command line (spec 12).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cac } from "cac";
import { type RenderOptions, render, validate } from "../api.js";
import { type MangaConfig, findConfig, loadConfig } from "../config.js";
import { type Diagnostic, MangaError, MangaValidationError } from "../core/diagnostics.js";
import { loadCatalog } from "../fonts/catalog.js";
import { defaultFontCacheDir, findLocalCatalogFont } from "../fonts/download.js";
import { installFonts } from "../fonts/install.js";
import { PACKAGE_ROOT } from "../fonts/catalog.js";
import { jsonSchema } from "../schema/jsonschema.js";
import { ASSETS_README, CONFIG_TEMPLATE, FONTS_README, TEMPLATES } from "./templates.js";

type Obj = Record<string, unknown>;

const VERSION = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;

// ---- output helpers -----------------------------------------------------------

const LEVELS = ["silent", "error", "warn", "info", "debug", "trace"] as const;
type Level = (typeof LEVELS)[number];

interface Out {
  level: Level;
  json: boolean;
  color: boolean;
  ja: boolean;
}

let out: Out = { level: "info", json: false, color: true, ja: false };

function setupOutput(o: Obj) {
  let level: Level = (o.logLevel as Level) ?? "info";
  if (o.quiet) level = "error";
  if (o.verbose) level = "debug";
  const locale = (o.locale as string) ?? process.env.MANGACLI_LOCALE ?? process.env.LANG ?? "";
  out = { level, json: !!o.json, color: o.color !== false && !process.env.NO_COLOR && !!process.stderr.isTTY, ja: locale.startsWith("ja") };
}

const at = (l: Level) => LEVELS.indexOf(out.level) >= LEVELS.indexOf(l);
const paint = (code: string, s: string) => (out.color ? `\x1b[${code}m${s}\x1b[0m` : s);
const t = (ja: string, en: string) => (out.ja ? ja : en);

function log(l: Level, s: string) {
  if (!out.json && at(l)) process.stderr.write(s + "\n");
}

function emitJson(o: Obj) {
  if (out.json) process.stdout.write(JSON.stringify(o) + "\n");
}

const sourceCache = new Map<string, string[]>();

function codeFrame(file: string, line: number, column: number): string {
  let lines = sourceCache.get(file);
  if (!lines) {
    try {
      lines = readFileSync(file, "utf8").split(/\r?\n/);
    } catch {
      return "";
    }
    sourceCache.set(file, lines);
  }
  const from = Math.max(1, line - 2);
  const to = Math.min(lines.length, line + 1);
  const w = String(to).length;
  const rows: string[] = [];
  for (let i = from; i <= to; i++) {
    const mark = i === line ? paint("31", ">") : " ";
    rows.push(`  ${mark} ${String(i).padStart(w)} | ${lines[i - 1]}`);
    if (i === line) {
      const text = lines[i - 1] ?? "";
      const len = Math.max(1, text.trimEnd().length - (column - 1));
      rows.push(`    ${" ".repeat(w)} | ${" ".repeat(Math.max(0, column - 1))}${paint("31", "^".repeat(Math.min(len, 60)))}`);
    }
  }
  return rows.join("\n");
}

function reportDiagnostic(d: Diagnostic, cwd: string) {
  emitJson({ type: "diagnostic", ...d });
  const lvl: Level = d.severity === "error" ? "error" : d.severity === "warning" ? "warn" : "info";
  if (!at(lvl) || out.json) return;
  const mark = d.severity === "error" ? paint("31", "✖") : d.severity === "warning" ? paint("33", "⚠") : paint("36", "ℹ");
  const loc = d.location ? `  ${relative(cwd, d.location.file) || d.location.file}:${d.location.line}:${d.location.column}` : "";
  let s = `${mark} ${paint("1", d.code)}${loc}\n  ${d.message}`;
  if (d.location && d.severity !== "info") {
    const f = codeFrame(d.location.file, d.location.line, d.location.column);
    if (f) s += "\n" + f;
  }
  if (d.hint) s += `\n  ${t("ヒント", "hint")}: ${d.hint}`;
  process.stderr.write(s + "\n");
}

function reportGithub(d: Diagnostic, cwd: string) {
  const kind = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "notice";
  const loc = d.location ? ` file=${relative(cwd, d.location.file)},line=${d.location.line},col=${d.location.column}` : "";
  process.stdout.write(`::${kind}${loc},title=${d.code}::${d.message.replace(/\n/g, "%0A")}\n`);
}

class UsageError extends Error {}

// ---- shared option handling ------------------------------------------------------

async function configFor(o: Obj, entry?: string): Promise<MangaConfig | undefined> {
  if (o.config === false) return undefined;
  const explicit = typeof o.config === "string" ? o.config : process.env.MANGACLI_CONFIG;
  const path = explicit ? resolve(explicit) : findConfig(entry && entry !== "-" ? dirname(resolve(entry)) : process.cwd());
  if (!path) return undefined;
  const cfg = await loadConfig(path);
  log("debug", `config: ${path}`);
  return cfg;
}

function parsePositiveNumber(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!isFinite(n) || n <= 0) throw new UsageError(`${name}: ${t("正の数を指定してください", "expected a positive number")} (${String(v)})`);
  return n;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw new UsageError(`${name}: ${t("次のいずれかを指定してください", "expected one of")} ${allowed.join(", ")} (${String(v)})`);
  return v as T;
}

function list(v: unknown): string[] | undefined {
  if (v === undefined || v === true) return undefined;
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function renderOptions(o: Obj, entry: string): Promise<RenderOptions> {
  const config = await configFor(o, entry);
  const debug = o.debug === undefined ? undefined : o.debug === true ? true : list(o.debug);
  const format = list(o.format) as import("../output/encode.js").OutputFormat[] | undefined;
  const opts: RenderOptions = {
    config: config as Obj | undefined,
    profile: o.profile as string | undefined,
    format: format && format.length === 1 ? format[0] : format,
    colorMode: oneOf(o.color === true || o.color === false ? undefined : o.color, "--color", ["color", "gray", "mono"] as const),
    dpi: parsePositiveNumber(o.dpi, "--dpi"),
    scale: parsePositiveNumber(o.scale, "--scale"),
    width: parsePositiveNumber(o.width, "--width"),
    height: parsePositiveNumber(o.height, "--height"),
    crop: oneOf(o.crop, "--crop", ["trim", "bleed"] as const),
    toneRendering: oneOf(o.tone, "--tone", ["dots", "flat", "auto"] as const),
    pages: o.pages !== undefined ? String(o.pages) : undefined,
    lang: o.lang as string | undefined,
    seed: o.seed !== undefined ? Number(o.seed) : undefined,
    draft: o.draft ? true : undefined,
    debug,
    strict: !!o.strict,
    separate: o.separate === undefined ? undefined : o.separate === true ? "all" : list(o.separate),
    emit: list(o.emit) as RenderOptions["emit"],
    name: o.name as string | undefined,
    root: o.root ? resolve(String(o.root)) : config?.root,
    baseDir: o.baseDir ? resolve(String(o.baseDir)) : undefined,
    fontDownload: o.download === false ? "never" : (config?.fontDownload ?? undefined),
    fontDir: config?.fontDir,
    fontCacheDir: config?.fontCacheDir,
    fontMirror: config?.fontMirror,
    fontSet: config?.fontSet,
    missingAssets: config?.missingAssets,
    diagnostics: config?.diagnostics,
    throwOnError: false,
  };
  if (opts.seed !== undefined && !Number.isInteger(opts.seed)) throw new UsageError(`--seed: ${t("整数を指定してください", "expected an integer")}`);
  return opts;
}

function readInput(file: string, o: Obj): string | { yaml: string; baseDir: string } {
  if (file === "-") return { yaml: readFileSync(0, "utf8"), baseDir: o.baseDir ? resolve(String(o.baseDir)) : process.cwd() };
  const p = resolve(file);
  if (!existsSync(p)) throw new MangaError("IO_NOT_FOUND", `${t("ファイルが見つかりません", "file not found")}: ${file}`);
  return p;
}

function summarize(diags: Diagnostic[]) {
  const e = diags.filter((d) => d.severity === "error").length;
  const w = diags.filter((d) => d.severity === "warning").length;
  return { errors: e, warnings: w };
}

// ---- commands ----------------------------------------------------------------------

async function cmdRender(file: string, o: Obj): Promise<number> {
  const cwd = process.cwd();
  const input = readInput(file, o);
  const opts = await renderOptions(o, file);
  const cfgOut = (opts.config?.output ?? {}) as Obj;
  const toStdout = !!o.stdout;
  if (!toStdout) opts.outDir = resolve(String(o.out ?? cfgOut.dir ?? "./out"));
  if (o.out === undefined && !toStdout && typeof input === "string") {
    // document output.dir is relative to the document
    const raw = readFileSync(input, "utf8");
    const m = raw.match(/^output:\s*\n(?:[ \t]+.*\n)*?[ \t]+dir:\s*(\S+)/m);
    if (m && !cfgOut.dir) opts.outDir = resolve(dirname(input), m[1].replace(/^["']|["']$/g, ""));
  }
  const t0 = performance.now();
  opts.onProgress = (e) => {
    emitJson({ type: "progress", ...e });
    log("info", `  ${paint("2", `${e.done}/${e.total}`)} ${e.pageId ?? ""}`);
  };
  const r = await render(input, opts);
  for (const d of r.diagnostics) reportDiagnostic(d, cwd);
  const { errors, warnings } = summarize(r.diagnostics);
  if (toStdout) {
    if (r.pages.length !== 1) {
      log("error", t("--stdout は出力が 1 ファイルの場合だけ使えます", "--stdout requires exactly one output image"));
      return 3;
    }
    process.stdout.write(r.pages[0].data);
  }
  emitJson({ type: "result", files: r.pages.map((p) => ({ path: p.path, pageId: p.id, width: p.width, height: p.height })), warnings, errors });
  if (o.timings) for (const [k, v] of Object.entries(r.timings)) log("info", `  ${k}: ${v.toFixed(0)} ms`);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (r.files.length) {
    const dir = relative(cwd, opts.outDir!) || ".";
    log("info", `${paint("32", "✔")} ${t(`${r.files.length} ファイルを出力しました（${dir}/、${secs} 秒）`, `wrote ${r.files.length} file(s) to ${dir}/ in ${secs}s`)}`);
  }
  if (warnings) log("info", `  ${t(`警告 ${warnings} 件`, `${warnings} warning(s)`)}`);
  if (r.failures.length) return 2;
  if (errors) return r.diagnostics.some((d) => d.severity === "error" && /^(ASSET|FONT|IO|RENDER)_/.test(d.code)) ? 2 : 1;
  if (o.strict && warnings) return 1;
  return 0;
}

async function cmdValidate(file: string, o: Obj): Promise<number> {
  const cwd = process.cwd();
  const input = readInput(file, o);
  const opts = await renderOptions(o, file);
  const r = await validate(input, opts);
  const reporter = oneOf(o.reporter, "--reporter", ["text", "json", "github"] as const) ?? (out.json ? "json" : "text");
  for (const d of r.diagnostics) {
    if (reporter === "github") reportGithub(d, cwd);
    else if (reporter === "json") process.stdout.write(JSON.stringify({ type: "diagnostic", ...d }) + "\n");
    else reportDiagnostic(d, cwd);
  }
  const { errors, warnings } = summarize(r.diagnostics);
  if (reporter === "json") process.stdout.write(JSON.stringify({ type: "result", ok: r.ok, errors, warnings }) + "\n");
  else if (reporter === "text") log("info", r.ok ? `${paint("32", "✔")} ${t("問題は見つかりませんでした", "no problems found")}${warnings ? t(`（警告 ${warnings} 件）`, ` (${warnings} warning(s))`) : ""}` : `${paint("31", "✖")} ${t(`エラー ${errors} 件、警告 ${warnings} 件`, `${errors} error(s), ${warnings} warning(s)`)}`);
  return r.ok ? 0 : 1;
}

async function cmdInit(dir: string | undefined, o: Obj): Promise<number> {
  const root = resolve(dir ?? ".");
  const tpl = String(o.template ?? "basic");
  const body = TEMPLATES[tpl];
  if (!body) throw new UsageError(`--template: ${t("次のいずれかを指定してください", "expected one of")} ${Object.keys(TEMPLATES).join(", ")}`);
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, "fonts"), { recursive: true });
  // .ts is only loaded as ESM inside "type": "module" packages; use .mts elsewhere
  const configName = isEsmPackage(root) ? "mangacli.config.ts" : "mangacli.config.mts";
  const files: [string, string][] = [
    ["manga.yaml", body],
    [configName, CONFIG_TEMPLATE],
    ["assets/README.md", ASSETS_README],
    ["fonts/README.md", FONTS_README],
  ];
  for (const [name, content] of files) {
    const p = join(root, name);
    if (existsSync(p) && !o.force) {
      log("warn", `${paint("33", "⚠")} ${t("既に存在するため作りませんでした", "exists, skipped")}: ${name}`);
      continue;
    }
    writeFileSync(p, content);
    log("info", `${paint("32", "✔")} ${name}`);
  }
  const gi = join(root, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\/?out\/?$/m.test(cur)) writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "out/\n");
  if (o.fonts !== false) {
    log("info", t("フォント（manga-basic）を取得しています…", "installing fonts (manga-basic)..."));
    try {
      const r = await installFonts({ set: "manga-basic", onProgress: (e) => log("info", `  ${e.done}/${e.total} ${e.font}`) });
      log("info", `${paint("32", "✔")} ${t(`フォント ${r.length} 件`, `${r.length} font(s)`)}`);
    } catch (e) {
      log("warn", `${paint("33", "⚠")} ${t("フォントを取得できませんでした（初回のレンダリング時に再び試みます）", "could not install fonts (will retry on first render)")}: ${(e as Error).message}`);
    }
  }
  log("info", `\n  npx mangacli render ${relative(process.cwd(), join(root, "manga.yaml")) || "manga.yaml"} --draft`);
  return 0;
}

function isEsmPackage(dir: string): boolean {
  let d = resolve(dir);
  for (;;) {
    const pj = join(d, "package.json");
    if (existsSync(pj)) {
      try {
        return (JSON.parse(readFileSync(pj, "utf8")) as { type?: string }).type === "module";
      } catch {
        return false;
      }
    }
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

async function cmdWatch(file: string, o: Obj): Promise<number> {
  const { watch } = await import("chokidar");
  const entry = resolve(file);
  let running = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  const watched = new Set<string>();
  const watcher = watch([entry], { ignoreInitial: true });
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      if (!out.json && process.stderr.isTTY) process.stderr.write("\x1bc");
      log("info", paint("2", new Date().toLocaleTimeString()));
      await cmdRender(file, o);
      // watch imports, includes and assets referenced by the document
      for (const f of collectDeps(entry)) {
        if (!watched.has(f)) {
          watched.add(f);
          watcher.add(f);
        }
      }
    } catch (e) {
      reportError(e);
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 150);
  });
  await run();
  log("info", paint("2", t("変更を監視しています（Ctrl+C で終了）", "watching for changes (Ctrl+C to quit)")));
  return new Promise<number>(() => {});
}

/** files a document depends on (best effort: imports, includes, asset paths) */
function collectDeps(entry: string): string[] {
  const out = new Set<string>();
  const visit = (f: string, depth: number) => {
    if (depth > 8 || out.has(f) || !existsSync(f)) return;
    out.add(f);
    const text = readFileSync(f, "utf8");
    const base = dirname(f);
    for (const m of text.matchAll(/(?:^|[\s,{[])(?:src|import|include|imports|path)\s*:\s*["']?([^\s"',}\]#]+\.(?:ya?ml|json|png|jpe?g|webp|avif|tiff?|svg|ttf|otf))["']?/gm)) visit(resolve(base, m[1]), depth + 1);
    for (const m of text.matchAll(/^\s*-\s+["']?([^\s"'#]+\.ya?ml)["']?\s*$/gm)) visit(resolve(base, m[1]), depth + 1);
  };
  visit(entry, 0);
  return [...out];
}

async function cmdSchema(o: Obj): Promise<number> {
  const s = JSON.stringify(jsonSchema(), null, 2) + "\n";
  if (o.out) {
    writeFileSync(resolve(String(o.out)), s);
    log("info", `${paint("32", "✔")} ${o.out}`);
  } else process.stdout.write(s);
  return 0;
}

async function cmdFonts(sub: string | undefined, args: string[], o: Obj): Promise<number> {
  if (sub === "install") {
    const config = await configFor(o);
    let refs: string[] | undefined;
    if (o.for) refs = await documentFontRefs(String(o.for), o);
    const r = await installFonts({
      ids: args.length ? args : undefined,
      set: o.set as string | undefined,
      all: !!o.all,
      refs,
      dir: o.dir ? resolve(String(o.dir)) : undefined,
      force: !!o.force,
      fontCacheDir: config?.fontCacheDir,
      fontMirror: config?.fontMirror,
      onProgress: (e) => log("info", `  ${paint("2", `${e.done}/${e.total}`)} ${e.font}`),
    });
    for (const f of r) emitJson({ type: "font", ...f });
    const n = r.filter((f) => f.downloaded).length;
    log("info", `${paint("32", "✔")} ${t(`${r.length} 件（新たに取得 ${n} 件）`, `${r.length} font(s), ${n} downloaded`)}  ${paint("2", o.dir ? String(o.dir) : defaultFontCacheDir())}`);
    return 0;
  }
  if (sub === "list") {
    const config = await configFor(o, args[0]);
    const fetchOpts = { fontDir: config?.fontDir, fontCacheDir: config?.fontCacheDir };
    if (o.catalog || !args[0]) {
      const rows = loadCatalog().fonts.map((f) => {
        const path = findLocalCatalogFont(f, fetchOpts);
        emitJson({ type: "font", id: f.id, weight: f.weight, family: f.family, bytes: f.bytes, installed: !!path, path });
        return `${path ? paint("32", "●") : paint("2", "○")} ${`${f.id}@${f.weight}`.padEnd(30)} ${f.family.padEnd(24)} ${(f.bytes / 1e6).toFixed(1).padStart(5)} MB`;
      });
      if (!out.json) process.stdout.write(rows.join("\n") + "\n");
      return 0;
    }
    const refs = await documentFontRefs(args[0], o);
    for (const ref of refs) {
      const id = ref.replace(/^catalog:/, "");
      const [fid, w] = id.split("@");
      const f = loadCatalog().fonts.find((x) => x.id === fid && (w ? x.weight === Number(w) : x.weight === 400)) ?? loadCatalog().fonts.find((x) => x.id === fid);
      const path = f ? findLocalCatalogFont(f, fetchOpts) : null;
      emitJson({ type: "font", ref, installed: !!path, path });
      if (!out.json) process.stdout.write(`${path ? paint("32", "●") : paint("2", "○")} ${id.padEnd(30)} ${f?.family ?? "?"}\n`);
    }
    return 0;
  }
  throw new UsageError(t("fonts のサブコマンドは install または list です", "fonts subcommand must be install or list"));
}

/** catalog refs a document uses: its catalog font definitions plus the font set */
async function documentFontRefs(file: string, o: Obj): Promise<string[]> {
  const { load } = await import("../api.js");
  const { setFontRefs } = await import("../fonts/install.js");
  const p = load(readInput(file, o));
  const refs = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("catalog:")) refs.add(v);
    else if (v && typeof v === "object") {
      const ob = v as Obj;
      if (typeof ob.catalog === "string") refs.add(`catalog:${ob.catalog}${ob.weight ? `@${ob.weight}` : ""}`);
      Object.values(ob).forEach(walk);
    }
  };
  walk(p.doc.fonts);
  const set = (p.doc.fontSet as string) ?? "manga-basic";
  if (set !== "none") for (const r of setFontRefs(set)) refs.add(`catalog:${r}`);
  return [...refs];
}

function reportError(e: unknown): number {
  if (e instanceof UsageError) {
    log("error", `${paint("31", "✖")} ${e.message}`);
    emitJson({ type: "error", code: "USAGE", message: e.message });
    return 3;
  }
  if (e instanceof MangaValidationError) {
    for (const d of e.diagnostics) reportDiagnostic(d, process.cwd());
    return 1;
  }
  if (e instanceof MangaError) {
    log("error", `${paint("31", "✖")} ${e.code}: ${e.message}`);
    emitJson({ type: "error", code: e.code, message: e.message });
    return /^(SCHEMA|REF|UNIT|CONFIG)_/.test(e.code) ? 1 : 2;
  }
  const err = e as Error;
  if ((err as { name?: string }).name === "AbortError") return 130;
  const sysCode = (err as unknown as { code?: string }).code;
  if (sysCode && /^E[A-Z]+$/.test(sysCode)) {
    log("error", `${paint("31", "✖")} ${err.message}`);
    return 2;
  }
  log("error", `${paint("31", "✖")} ${t("内部エラー", "internal error")}: ${err?.stack ?? String(e)}`);
  return 70;
}

// ---- wiring --------------------------------------------------------------------

const cli = cac("mangacli");

const common = (c: ReturnType<typeof cli.command>) =>
  c
    .option("--config [path]", "Config file")
    .option("--no-config", "Do not search for a config file")
    .option("--cwd <dir>", "Working directory")
    .option("--root <dir>", "Project root (upper bound for file references)")
    .option("--log-level <level>", "silent | error | warn | info | debug | trace")
    .option("-q, --quiet", "Same as --log-level error")
    .option("-v, --verbose", "Same as --log-level debug")
    .option("--json", "NDJSON diagnostics and results on stdout")
    .option("--no-color", "Disable colored output")
    .option("--locale <ja|en>", "Message language");

const renderOpts = (c: ReturnType<typeof cli.command>) =>
  common(c)
    .option("-o, --out <dir>", "Output directory")
    .option("-p, --profile <name>", "Output profile (print-mono, print-gray, print-color, web, sns, preview, draft)")
    .option("-f, --format <fmt>", "png, jpeg, webp, avif, tiff (comma separated)")
    .option("--color [mode]", "color | gray | mono")
    .option("--dpi <n>", "Resolution")
    .option("--scale <n>", "Scale factor on the design resolution")
    .option("--width <px>", "Output width")
    .option("--height <px>", "Output height")
    .option("--crop <area>", "trim | bleed")
    .option("--pages <range>", "Pages to render, e.g. 1-3,5 or p7")
    .option("--lang <tag>", "Text language")
    .option("--seed <n>", "Override the document seed")
    .option("--draft", "Draft mode")
    .option("--debug [layers]", "Debug overlay")
    .option("--tone <mode>", "dots | flat | auto")
    .option("--separate [names]", "Separation output")
    .option("--emit <kinds>", "layout, ir, transcript, manifest")
    .option("--name <template>", "File name template")
    .option("--stdout", "Write the image to stdout")
    .option("--base-dir <dir>", "Base directory when reading from stdin")
    .option("--strict", "Treat warnings as errors")
    .option("--no-download", "Do not download catalog fonts")
    .option("--timings", "Print timings");

const wrap =
  <A extends unknown[]>(fn: (...a: A) => Promise<number>) =>
  async (...a: A) => {
    const o = a[a.length - 1] as Obj;
    setupOutput(o);
    if (typeof o.cwd === "string") process.chdir(resolve(o.cwd));
    let code: number;
    try {
      code = await fn(...a);
    } catch (e) {
      code = reportError(e);
    }
    process.exitCode = code;
  };

renderOpts(cli.command("render <file>", "Render a document")).action(wrap((file: string, o: Obj) => cmdRender(file, o)));
common(cli.command("validate <file>", "Validate a document (schema and layout)"))
  .option("-p, --profile <name>", "Profile used for resolution checks")
  .option("--lang <tag>", "Text language")
  .option("--strict", "Treat warnings as errors")
  .option("--reporter <kind>", "text | json | github")
  .option("--no-download", "Do not download catalog fonts")
  .action(wrap((file: string, o: Obj) => cmdValidate(file, o)));
common(cli.command("init [dir]", "Create a new project"))
  .option("--template <name>", "basic | b5-mono | sns-color | yonkoma", { default: "basic" })
  .option("--no-fonts", "Do not install fonts")
  .option("--force", "Overwrite existing files")
  .action(wrap((dir: string | undefined, o: Obj) => cmdInit(dir, o)));
renderOpts(cli.command("watch <file>", "Re-render on changes")).action(wrap((file: string, o: Obj) => cmdWatch(file, o)));
common(cli.command("schema", "Print the JSON Schema"))
  .option("--out <file>", "Write to a file")
  .action(wrap((o: Obj) => cmdSchema(o)));
common(cli.command("fonts <sub> [...args]", "Catalog fonts: install [ids...] | list [file]"))
  .option("--set <name>", "Font set")
  .option("--for <file>", "Fonts used by a document")
  .option("--all", "All catalog fonts")
  .option("--dir <dir>", "Install into a directory")
  .option("--force", "Download again")
  .option("--catalog", "List the catalog")
  .action(wrap((sub: string, args: string[], o: Obj) => cmdFonts(sub, args, o)));

cli.help();
cli.version(VERSION);

process.on("SIGINT", () => process.exit(130));

try {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand && cli.args.length) {
    process.stderr.write(`unknown command: ${cli.args[0]}\n`);
    process.exitCode = 3;
  } else if (!cli.matchedCommand && !cli.options.help && !cli.options.version) cli.outputHelp();
  else await cli.runMatchedCommand();
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 3;
}
