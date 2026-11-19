#!/usr/bin/env node
// mangacli command line (spec 12).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { cac } from "cac";
import { parse as parseYaml } from "yaml";
import { type RenderOptions, render, validate } from "../api.js";
import { PDF_X_VERSIONS } from "../output/pdfx.js";
import { type MangaConfig, findConfig, loadConfig } from "../config.js";
import { type Diagnostic, MangaError, MangaValidationError } from "../core/diagnostics.js";
import { defaultFontSet, loadCatalog } from "../fonts/catalog.js";
import { defaultFontCacheDir, findLocalCatalogFont } from "../fonts/download.js";
import { installFonts } from "../fonts/install.js";
import { listSystemFonts } from "../fonts/system.js";
import { PACKAGE_ROOT } from "../fonts/catalog.js";
import { jsonSchema } from "../schema/jsonschema.js";
import { collectDeps } from "./deps.js";
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
  out = { level, json: !!o.json, color: o.ansi !== false && !process.env.NO_COLOR && !!process.stderr.isTTY, ja: locale.startsWith("ja") };
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
  const pdfXVersion = oneOf(o.pdfX, "--pdf-x", PDF_X_VERSIONS);
  const iccPath = o["pdfX-icc"];
  const condition = o["pdfX-condition"];
  let pdfX: RenderOptions["pdfX"];
  if (pdfXVersion || iccPath !== undefined || condition !== undefined) {
    if (!pdfXVersion || typeof iccPath !== "string" || !iccPath || typeof condition !== "string" || !condition.trim()) {
      throw new UsageError("--pdf-x, --pdf-x-icc and --pdf-x-condition must be supplied together");
    }
    pdfX = { version: pdfXVersion, iccProfile: readFileSync(resolve(iccPath)), outputCondition: condition };
  }
  const opts: RenderOptions = {
    config: config as Obj | undefined,
    profile: o.profile as string | undefined,
    format: format && format.length === 1 ? format[0] : format,
    pdfX,
    colorMode: oneOf(o.color === true ? undefined : o.color, "--color", ["color", "gray", "mono"] as const),
    dpi: parsePositiveNumber(o.dpi, "--dpi"),
    limits: { ...config?.limits, ...(o.maxOutputPixels === undefined ? {} : { maxOutputPixels: parsePositiveNumber(o.maxOutputPixels, "--max-output-pixels") }), ...(o.maxOutputBytes === undefined ? {} : { maxOutputBytes: parsePositiveNumber(o.maxOutputBytes, "--max-output-bytes") }) },
    output: oneOf(o.outputSize, "--output-size", ["manuscript", "print"] as const),
    scale: parsePositiveNumber(o.scale, "--scale"),
    width: parsePositiveNumber(o.width, "--width"),
    height: parsePositiveNumber(o.height, "--height"),
    crop: oneOf(o.crop, "--crop", ["trim", "bleed", "marks"] as const),
    spread: oneOf(o.spread, "--spread", ["joined", "split"] as const),
    toneRendering: oneOf(o.tone, "--tone", ["dots", "flat", "auto"] as const),
    pages: o.pages !== undefined ? String(o.pages) : undefined,
    lang: o.lang as string | undefined,
    seed: o.seed !== undefined ? Number(o.seed) : undefined,
    draft: o.draft ? true : undefined,
    debug,
    strict: !!o.strict,
    separate: o.separate === undefined ? undefined : o.separate === true ? "all" : list(o.separate),
    emit: list(o.emit) as RenderOptions["emit"],
    name: o.name !== undefined ? String(o.name) : undefined,
    root: o.root ? resolve(String(o.root)) : config?.root,
    allowNetwork: o.allowNetwork ? true : (config?.allowNetwork as RenderOptions["allowNetwork"]),
    allowOutsideRoot: config?.allowOutsideRoot,
    clean: !!o.clean,
    baseDir: o.baseDir ? resolve(String(o.baseDir)) : undefined,
    fontDownload: o.download === false ? "never" : (config?.fontDownload ?? undefined),
    fontDir: config?.fontDir,
    fontCacheDir: config?.fontCacheDir,
    fontMirror: config?.fontMirror,
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

async function cmdRender(file: string, o: Obj, onSystemFont?: (path: string) => void): Promise<number> {
  const cwd = process.cwd();
  const input = readInput(file, o);
  const opts = await renderOptions(o, file);
  opts.onSystemFont = onSystemFont;
  const cfgOut = ((opts.config as Obj | undefined)?.output ?? {}) as Obj;
  const toStdout = !!o.stdout;
  if (!toStdout) {
    // precedence: -o, the document's output.dir (relative to the document), the config's, ./out
    let docDir: string | undefined;
    if (o.out === undefined && typeof input === "string") {
      try {
        const d = (parseYaml(readFileSync(input, "utf8")) ?? {}) as Obj;
        const od = (d.output ?? {}) as Obj;
        if (typeof od.dir === "string") docDir = resolve(dirname(input), od.dir);
      } catch {
        /* reported by the loader */
      }
    }
    opts.outDir = o.out !== undefined ? resolve(String(o.out)) : (docDir ?? resolve(String(cfgOut.dir ?? "./out")));
  }
  const t0 = performance.now();
  opts.onProgress = (e) => {
    emitJson({ type: "progress", ...e });
    if (e.phase === "render") log("info", `  ${paint("2", `${e.done}/${e.total}`)} ${e.pageId ?? ""}`);
  };
  const conc = Math.max(1, Math.round(Number(o.concurrency ?? process.env.MANGACLI_CONCURRENCY ?? (opts.config as Obj | undefined)?.concurrency ?? 1)) || 1);
  const formats = ([] as unknown[]).concat(opts.format ?? []);
  const canSplit = conc > 1 && !toStdout && !opts.pdfX && !formats.includes("pdf") && !(opts.emit ?? []).some((k) => k === "transcript" || k === "manifest");
  const r = canSplit ? await renderParallel(input, opts, conc) : await render(input, opts);
  for (const d of r.diagnostics) reportDiagnostic(d, cwd);
  const { errors, warnings } = summarize(r.diagnostics);
  if (toStdout && !(opts.pdfX && (errors || r.failures.length))) {
    if (r.pages.length !== 1) {
      log("error", t("--stdout は出力が 1 ファイルの場合だけ使えます", "--stdout requires exactly one output image"));
      return 3;
    }
    process.stdout.write(r.pages[0].data);
  }
  if (o.contactSheet && r.pages.length && opts.outDir) {
    const sheet = await contactSheet(r.pages.filter((p) => p.format !== "pdf" && p.format !== "svg" && p.format !== "psd" && !p.separation), !!(opts.config as Obj | undefined) && false);
    if (sheet) {
      const base = typeof input === "string" ? basename(input).replace(/\.[^.]+$/, "") : "manga";
      const f = join(opts.outDir, `${base}-contact.png`);
      writeFileSync(f, sheet);
      r.files.push(f);
    }
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

/** all pages side by side in reading order (right to left), labelled with number and ID (spec 10.11.2) */
async function contactSheet(pages: { id: string; number: number | null; side: string; data: Uint8Array; path?: string }[], _ltr: boolean): Promise<Buffer | null> {
  if (!pages.length) return null;
  const sharp = (await import("sharp")).default;
  const { createCanvas } = await import("@napi-rs/canvas");
  const TW = 320;
  const thumbs = await Promise.all(pages.map(async (p) => {
    const buf = p.path ? readFileSync(p.path) : Buffer.from(p.data);
    const img = sharp(buf).resize({ width: TW }).flatten({ background: "#ffffff" }).png();
    const meta = await img.toBuffer({ resolveWithObject: true });
    return { buf: meta.data, h: meta.info.height, p };
  }));
  const cols = Math.min(6, thumbs.length);
  const rows = Math.ceil(thumbs.length / cols);
  const cellH = Math.max(...thumbs.map((t) => t.h)) + 28;
  const gap = 16;
  const W = cols * TW + (cols + 1) * gap;
  const H = rows * cellH + (rows + 1) * gap;
  const label = createCanvas(W, H);
  const g = label.getContext("2d");
  g.fillStyle = "#e8e8e8";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#333";
  g.font = "14px sans-serif";
  const composites: { input: Buffer; left: number; top: number }[] = [];
  thumbs.forEach((t, i) => {
    const row = Math.floor(i / cols);
    const col = cols - 1 - (i % cols); // right to left
    const left = gap + col * (TW + gap);
    const top = gap + row * (cellH + gap);
    composites.push({ input: t.buf, left, top });
    g.fillText(`${t.p.number ?? "-"}  ${t.p.id}`, left, top + t.h + 18);
  });
  return sharp(label.toBuffer("image/png")).composite(composites).png().toBuffer();
}

/** split the pages over worker threads (each loads the document and fonts itself) */
async function renderParallel(input: string | { yaml: string; baseDir: string }, opts: RenderOptions, n: number): Promise<Awaited<ReturnType<typeof render>>> {
  const { Worker } = await import("node:worker_threads");
  const { load } = await import("../api.js");
  const { resolveDocument } = await import("../model/resolve.js");
  const project = load(input, opts);
  const all = project.bag.hasErrors ? [] : resolveDocument(project.doc, project.bag.fork(), { lang: opts.lang }).pages.map((pg, i) => ({ id: pg.id, i }));
  // the --pages selection is applied by each worker; split the candidate ids round-robin
  const wanted = opts.pages ? all.filter((pg) => selectedBy(opts.pages as string, pg.id, pg.i + 1, all.length)) : all;
  if (wanted.length < 2) return render(input, opts);
  const groups: string[][] = Array.from({ length: Math.min(n, wanted.length) }, () => []);
  wanted.forEach((pg, k) => groups[k % groups.length].push(pg.id));
  const here = new URL(import.meta.url);
  const ts = here.pathname.endsWith(".ts");
  const workerUrl = new URL(ts ? "./render-worker.ts" : "./render-worker.js", here);
  const { onProgress, onSystemFont, config, ...plain } = opts;
  const configPath = (config as { __file?: string } | undefined)?.__file;
  let done = 0;
  const results = await Promise.all(
    groups.map(
      (ids) =>
        new Promise<Obj>((ok, ng) => {
          const w = new Worker(workerUrl, { workerData: { input, opts: { ...plain, pages: ids }, configPath, trackSystemFonts: !!onSystemFont }, execArgv: ts ? ["--import", "tsx"] : [] });
          w.on("message", (m: Obj) => {
            if (m.type === "progress") onProgress?.({ ...(m.e as { phase: string; pageId?: string }), done: ++done, total: wanted.length });
            else if (m.type === "systemFont") onSystemFont?.(m.path as string);
            else if (m.type === "done") ok(m);
          });
          w.on("error", ng);
        }),
    ),
  );
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const res of results)
    for (const d of res.diagnostics as Diagnostic[]) {
      const k = `${d.code}|${d.message}|${d.location?.line}|${d.pageId}`;
      if (!seen.has(k)) {
        seen.add(k);
        diagnostics.push(d);
      }
    }
  return {
    pages: results.flatMap((res) => res.pages as never[]),
    files: results.flatMap((res) => res.files as string[]),
    diagnostics,
    failures: results.flatMap((res) => (res.failures as { pageId: string; index: number; message: string }[]).map((f) => ({ pageId: f.pageId, index: f.index, error: new Error(f.message) }))),
    layout: [],
    timings: Object.assign({}, ...results.map((res) => res.timings as Record<string, number>)),
  };
}

function selectedBy(sel: string, id: string, index: number, total: number): boolean {
  for (const it of sel.split(",").map((x) => x.trim())) {
    const m = it.match(/^(\d+)(?:-(\d*))?$/);
    if (m) {
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : m[2] === "" ? total : Number(m[2]);
      if (index >= a && index <= b) return true;
    } else if (it === id) return true;
  }
  return false;
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
  const addDep = (path: string) => {
    if (watched.has(path)) return;
    watched.add(path);
    watcher.add(path);
  };
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      if (!out.json && process.stderr.isTTY) process.stderr.write("\x1bc");
      log("info", paint("2", new Date().toLocaleTimeString()));
      await cmdRender(file, o, addDep);
      // watch imports, includes and assets referenced by the document
      for (const f of collectDeps(entry)) addDep(f);
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

async function cmdPreview(file: string, o: Obj): Promise<number> {
  const http = await import("node:http");
  const { watch } = await import("chokidar");
  const entry = resolve(file);
  const port = o.port !== undefined ? Number(o.port) : 4173;
  const host = (o.host as string) ?? "127.0.0.1";
  let pages: { id: string; data: Uint8Array; mime: string; ext: string }[] = [];
  let diags: Diagnostic[] = [];
  let version = 0;
  const clients = new Set<import("node:http").ServerResponse>();
  const watcher = watch(collectDeps(entry), { ignoreInitial: true });
  const build = async () => {
    try {
      const opts = await renderOptions({ ...o, profile: o.profile ?? "preview" }, file);
      opts.onSystemFont = (path) => watcher.add(path);
      const r = await render(entry, opts);
      pages = r.pages.map((p) => ({ id: p.id, data: p.data, mime: p.mimeType, ext: p.format }));
      diags = r.diagnostics;
    } catch (e) {
      diags = [{ code: "RENDER_FAILED", severity: "error", message: (e as Error).message }];
    }
    version++;
    for (const c of clients) c.write(`data: ${version}\n\n`);
    const { errors, warnings } = summarize(diags);
    log("info", `${paint("2", new Date().toLocaleTimeString())} ${pages.length} page(s)${errors ? `, ${errors} error(s)` : ""}${warnings ? `, ${warnings} warning(s)` : ""}`);
  };
  const html = () => `<!doctype html><meta charset="utf-8"><title>mangacli preview</title>
<style>body{margin:0;background:#3a3a3a;font:13px system-ui;color:#ddd}header{padding:8px 12px;background:#222;position:sticky;top:0}
main{display:flex;flex-wrap:wrap;flex-direction:row-reverse;gap:16px;padding:16px;justify-content:center}figure{margin:0}
img{max-height:85vh;box-shadow:0 2px 12px #0008;background:#fff}figcaption{text-align:center;padding:4px}
.d{padding:2px 12px}.error{color:#ff8080}.warning{color:#ffd480}</style>
<header>${esc(relative(process.cwd(), entry))} — ${pages.length} page(s)</header>
<section>${diags.filter((d) => d.severity !== "info").map((d) => `<div class="d ${d.severity}">${esc(d.code)} ${d.location ? `${d.location.line}:${d.location.column} ` : ""}${esc(d.message)}</div>`).join("")}</section>
<main>${pages.map((p, i) => `<figure><img src="/page/${i}.${p.ext}?v=${version}"><figcaption>${i + 1} · ${esc(p.id)}</figcaption></figure>`).join("")}</main>
<script>new EventSource("/events").onmessage=()=>location.reload()</script>`;
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const m = url.pathname.match(/^\/page\/(\d+)\.\w+$/);
    if (m && pages[Number(m[1])]) {
      const p = pages[Number(m[1])];
      res.writeHead(200, { "content-type": p.mime, "cache-control": "no-store" });
      res.end(p.data);
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html());
      return;
    }
    res.writeHead(404).end();
  });
  await build();
  let timer: NodeJS.Timeout | undefined;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await build();
      for (const f of collectDeps(entry)) watcher.add(f);
    }, 150);
  });
  await new Promise<void>((ok) => server.listen(port, host, ok));
  const url = `http://${host}:${port}/`;
  log("info", `${paint("32", "✔")} ${t("プレビュー", "preview")}: ${url}`);
  if (o.open) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    spawn(cmd, process.platform === "win32" ? ["/c", "start", url] : [url], { stdio: "ignore", detached: true }).unref();
  }
  return new Promise<number>(() => {});
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
    if (o.system) {
      if (o.catalog || args.length) throw new UsageError(t("--system は --catalog やファイル指定と併用できません", "--system cannot be combined with --catalog or a document"));
      for (const { path, index, families, fullNames, postScriptNames } of await listSystemFonts()) {
        emitJson({ type: "font", source: "system", path, index, families, fullNames, postScriptNames });
        if (!out.json) {
          const names = [...new Set([...families, ...fullNames, ...postScriptNames])];
          process.stdout.write(`${names.join(" / ")}\t${path}#${index}\n`);
        }
      }
      return 0;
    }
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
  if (sub === "check") {
    // glyphs missing from the document's fonts
    if (!args[0]) throw new UsageError(t("fonts check にはファイルを指定してください", "fonts check needs a file"));
    const opts = await renderOptions(o, args[0]);
    const { validate: v } = await import("../api.js");
    const r = await v(readInput(args[0], o), opts);
    let missing = 0;
    for (const l of r.layout)
      for (const x of l.text)
        if (x.missing.length) {
          missing += x.missing.length;
          emitJson({ type: "missing", page: l.geom.id, element: x.id, chars: x.missing });
          if (!out.json) process.stdout.write(`${paint("33", "⚠")} ${l.geom.id} ${x.id}: ${x.missing.join(" ")}  (${x.fonts.join(", ")})\n`);
        }
    if (!missing) log("info", `${paint("32", "✔")} ${t("欠けている字形はありません", "no missing glyphs")}`);
    return missing ? 1 : 0;
  }
  if (sub === "verify") {
    const { createHash } = await import("node:crypto");
    const config = await configFor(o);
    let bad = 0;
    for (const f of loadCatalog().fonts) {
      const path = findLocalCatalogFont(f, { fontDir: o.dir ? resolve(String(o.dir)) : config?.fontDir, fontCacheDir: config?.fontCacheDir });
      if (!path) continue;
      const ok = createHash("sha256").update(readFileSync(path)).digest("hex") === f.sha256;
      if (!ok) bad++;
      emitJson({ type: "font", id: f.id, weight: f.weight, path, ok });
      if (!out.json) process.stdout.write(`${ok ? paint("32", "✔") : paint("31", "✖")} ${`${f.id}@${f.weight}`.padEnd(30)} ${path}\n`);
    }
    return bad ? 2 : 0;
  }
  if (sub === "licenses") {
    const refs = args[0] ? await documentFontRefs(args[0], o) : loadCatalog().fonts.map((f) => `catalog:${f.id}@${f.weight}`);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const ref of refs) {
      const [fid] = ref.replace(/^catalog:/, "").split("@");
      if (seen.has(fid)) continue;
      seen.add(fid);
      const f = loadCatalog().fonts.find((x) => x.id === fid);
      if (!f) continue;
      lines.push(`## ${f.family}\n\n${f.license.copyright}\nLicense: ${f.license.id} (${f.license.url})\n`);
      const lic = join(dirname(findLocalCatalogFont(f) ?? join(defaultFontCacheDir(), "x")), `${f.id}-OFL.txt`);
      if (existsSync(lic)) lines.push(readFileSync(lic, "utf8").trim() + "\n");
    }
    const text = lines.join("\n");
    if (o.out) writeFileSync(resolve(String(o.out)), text);
    else process.stdout.write(text);
    return 0;
  }
  throw new UsageError(t("fonts のサブコマンドは install・list・verify・licenses です", "fonts subcommand must be install, list, verify or licenses"));
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
  const set = (p.doc.fontSet as string) ?? defaultFontSet((p.doc.meta as Obj | undefined)?.lang as string);
  if (set !== "none") for (const r of setFontRefs(set)) refs.add(`catalog:${r}`);
  return [...refs];
}

async function cmdTranscript(file: string, o: Obj): Promise<number> {
  const opts = await renderOptions(o, file);
  const { validate: v, load } = await import("../api.js");
  const project = load(readInput(file, o), opts);
  const r = await v(project, opts);
  for (const d of r.diagnostics.filter((x) => x.severity === "error")) reportDiagnostic(d, process.cwd());
  const chars = (project.doc.characters ?? {}) as Record<string, { name?: string }>;
  const pages = r.layout.map((l) => {
    const order = new Map(l.panels.map((p) => [p.id, p.order]));
    const items = l.transcript.map((t, i) => ({ ...t, i })).sort((a, b) => (order.get(a.panel ?? "") ?? 1e9) - (order.get(b.panel ?? "") ?? 1e9) || a.i - b.i);
    return { id: l.geom.id, items: items.map(({ i: _i, ...t }) => t) };
  });
  const fmt = oneOf(o.format, "--format", ["md", "json", "txt"] as const) ?? "md";
  const name = (who?: string) => (who ? (chars[who]?.name ?? who) : "");
  let text: string;
  if (fmt === "json") text = JSON.stringify({ pages }, null, 2) + "\n";
  else if (fmt === "txt") text = pages.map((pg) => pg.items.map((i) => `${i.who ? `${name(i.who)}「${i.text.replace(/\n/g, "")}」` : i.text.replace(/\n/g, "")}`).join("\n")).join("\n\n") + "\n";
  else text = pages.map((pg) => `## ${pg.id}\n\n` + pg.items.map((i) => `- ${i.who ? `**${name(i.who)}**: ` : ""}${i.text.replace(/\n/g, " ")}`).join("\n")).join("\n\n") + "\n";
  if (o.out) writeFileSync(resolve(String(o.out)), text);
  else process.stdout.write(text);
  return r.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

async function cmdInspect(file: string, o: Obj): Promise<number> {
  const opts = await renderOptions(o, file);
  const { validate: v, load } = await import("../api.js");
  const { resolveDocument } = await import("../model/resolve.js");
  const project = load(readInput(file, o), opts);
  const out: Obj = {};
  if (o.resolved) {
    const resolved = resolveDocument(project.doc, project.bag.fork(), { lang: opts.lang });
    const pick = (els: { id: string; type: string; props: Obj; children?: unknown[] }[]): unknown[] => els.filter((e) => !o.element || e.id === o.element).map((e) => ({ id: e.id, type: e.type, props: e.props }));
    out.resolved = resolved.pages
      .filter((p) => !o.page || p.id === o.page)
      .map((p) => ({ id: p.id, panels: p.panels.map((pn) => ({ id: pn.id, props: pn.props, elements: pick(pn.elements as never) })), layers: pick(p.layers as never) }));
  }
  if (o.layout || o.text || !o.resolved) {
    const r = await v(project, opts);
    if (o.text)
      out.text = r.layout
        .filter((l) => !o.page || l.geom.id === o.page)
        .map((l) => ({ id: l.geom.id, elements: l.text.filter((x) => !o.element || x.id === o.element) }));
    if (o.layout || !o.text) out.layout = r.layout
      .filter((l) => !o.page || l.geom.id === o.page)
      .map((l) => ({ id: l.geom.id, trim: [l.geom.trimW, l.geom.trimH], panels: l.panels, elements: o.element ? l.elements.filter((e) => e.id === o.element) : l.elements }));
    for (const d of r.diagnostics) reportDiagnostic(d, process.cwd());
  }
  process.stdout.write(JSON.stringify(out, (_, x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x), 2) + "\n");
  return 0;
}

async function cmdMigrate(file: string, o: Obj): Promise<number> {
  const text = readFileSync(resolve(file), "utf8");
  const m = text.match(/^mangacli:\s*(\S+)/m);
  const v = m ? Number(m[1]) : NaN;
  if (v === 1) {
    log("info", `${paint("32", "✔")} ${t("最新の形式（mangacli: 1）です。変換は不要です", "already at the current version (mangacli: 1); nothing to migrate")}`);
    return 0;
  }
  log("error", `${paint("31", "✖")} ${t(`未対応のバージョンです: ${m?.[1] ?? "（なし）"}`, `unsupported version: ${m?.[1] ?? "(missing)"}`)}`);
  void o;
  return 1;
}

async function cmdCache(sub: string | undefined): Promise<number> {
  const { readdirSync, statSync, rmSync } = await import("node:fs");
  const dir = defaultFontCacheDir();
  const files = existsSync(dir) ? readdirSync(dir) : [];
  if (sub === "info" || !sub) {
    const bytes = files.reduce((a, f) => a + statSync(join(dir, f)).size, 0);
    process.stdout.write(`${dir}\n  ${files.filter((f) => f.endsWith(".ttf")).length} font(s), ${(bytes / 1e6).toFixed(1)} MB\n`);
    return 0;
  }
  if (sub === "clean") {
    rmSync(dir, { recursive: true, force: true });
    log("info", `${paint("32", "✔")} ${t("キャッシュを削除しました", "cache removed")}: ${dir}`);
    return 0;
  }
  throw new UsageError(t("cache のサブコマンドは info または clean です", "cache subcommand must be info or clean"));
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
    .option("--no-ansi", "Disable colored output (also --no-color, NO_COLOR)")
    .option("--locale <ja|en>", "Message language");

const renderOpts = (c: ReturnType<typeof cli.command>) =>
  common(c)
    .option("-o, --out <dir>", "Output directory")
    .option("-p, --profile <name>", "Output profile (print-mono, print-gray, print-color, web, sns, preview, draft)")
    .option("-f, --format <fmt>", "png, jpeg, webp, avif, tiff, pdf, svg, psd (comma separated)")
    .option("--pdf-x <version>", "Monochrome print PDF: 1a (PDF/X-1a:2001) or 4 (PDF/X-4)")
    .option("--pdf-x-icc <path>", "CMYK printer ICC profile for PDF/X")
    .option("--pdf-x-condition <name>", "Printer's output condition for PDF/X")
    .option("--color <mode>", "color | gray | mono")
    .option("--dpi <n>", "Resolution")
    .option("--max-output-pixels <n>", "Maximum pixels per output page (split spreads: per side)")
    .option("--max-output-bytes <n>", "Estimated memory budget for packed 1-bit output (default: 402653184 bytes)")
    .option("--output-size <size>", "manuscript | print")
    .option("--scale <n>", "Scale factor on the design resolution")
    .option("--width <px>", "Output width")
    .option("--height <px>", "Output height")
    .option("--crop <area>", "trim | bleed | marks")
    .option("--spread <mode>", "joined | split")
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
    .option("--concurrency <n>", "Render pages in parallel worker threads")
    .option("--clean", "Remove earlier outputs matching the file name template first")
    .option("--contact-sheet", "Also write an overview image of all pages")
    .option("--allow-network", "Allow URL assets")
    .option("--no-cache", "Do not use caches (accepted; there is no persistent render cache yet)")
    .option("--timings", "Print timings");

// cac (mri) turns numeric-looking values into numbers: recover the text as typed (--name 001, -o 007)
const STRING_OPTS: [string, string[]][] = [
  ["name", ["--name"]], ["out", ["--out", "-o"]], ["profile", ["--profile", "-p"]], ["lang", ["--lang"]], ["pages", ["--pages"]],
  ["template", ["--template"]], ["dir", ["--dir"]], ["set", ["--set"]], ["for", ["--for"]], ["host", ["--host"]], ["page", ["--page"]],
  ["element", ["--element"]], ["format", ["--format", "-f"]], ["emit", ["--emit"]], ["root", ["--root"]], ["cwd", ["--cwd"]],
  ["baseDir", ["--base-dir"]], ["config", ["--config"]], ["separate", ["--separate"]],
  ["pdfX", ["--pdf-x"]], ["pdfX-icc", ["--pdf-x-icc"]], ["pdfX-condition", ["--pdf-x-condition"]],
];

function rawStrings(o: Obj) {
  const argv = process.argv;
  for (const [key, flags] of STRING_OPTS) {
    if (typeof o[key] !== "number") continue;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const eq = flags.find((f) => a.startsWith(f + "="));
      if (eq) o[key] = a.slice(eq.length + 1);
      else if (flags.includes(a) && i + 1 < argv.length) o[key] = argv[i + 1];
    }
  }
}

/** a bare `-` (stdin) is dropped by the parser: it is swapped for this token before parsing */
const STDIN_TOKEN = "__mangacli_stdin__";

const wrap =
  <A extends unknown[]>(fn: (...a: A) => Promise<number>) =>
  async (...a: A) => {
    const o = a[a.length - 1] as Obj;
    rawStrings(o);
    for (let i = 0; i < a.length - 1; i++) if (a[i] === STDIN_TOKEN) (a as unknown[])[i] = "-";
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
renderOpts(cli.command("preview <file>", "Live preview in the browser"))
  .option("--port <n>", "Port (default 4173)")
  .option("--host <host>", "Host (default 127.0.0.1)")
  .option("--open", "Open the browser")
  .action(wrap((file: string, o: Obj) => cmdPreview(file, o)));
common(cli.command("schema", "Print the JSON Schema"))
  .option("--out <file>", "Write to a file")
  .action(wrap((o: Obj) => cmdSchema(o)));
common(cli.command("transcript <file>", "Print the dialogue list"))
  .option("--format <fmt>", "md | json | txt")
  .option("--lang <tag>", "Text language")
  .option("-o, --out <file>", "Write to a file")
  .action(wrap((file: string, o: Obj) => cmdTranscript(file, o)));
common(cli.command("inspect <file>", "Show resolved values and layout"))
  .option("--page <id>", "Page ID")
  .option("--element <id>", "Element ID")
  .option("--resolved", "Resolved values")
  .option("--layout", "Panel polygons, reading order, element boxes")
  .option("--text", "Line breaks, font sizes, fonts and missing glyphs of each text")
  .option("--lang <tag>", "Text language")
  .action(wrap((file: string, o: Obj) => cmdInspect(file, o)));
common(cli.command("migrate <file>", "Convert an older document to the current version"))
  .option("--write", "Write the result")
  .action(wrap((file: string, o: Obj) => cmdMigrate(file, o)));
common(cli.command("cache [sub]", "Font cache: info | clean")).action(wrap((sub: string | undefined, _o: Obj) => cmdCache(sub)));
common(cli.command("fonts <sub> [...args]", "Fonts: install [ids...] | list [--catalog | --system | file] | check <file> | verify | licenses [file]"))
  .option("-o, --out <file>", "Write licenses to a file")
  .option("--set <name>", "Font set")
  .option("--for <file>", "Fonts used by a document")
  .option("--all", "All catalog fonts")
  .option("--dir <dir>", "Install into a directory")
  .option("--force", "Download again")
  .option("--catalog", "List the catalog")
  .option("--system", "List installed fonts; check their licenses before use")
  .action(wrap((sub: string, args: string[], o: Obj) => cmdFonts(sub, args, o)));

cli.help();
cli.version(VERSION);

process.on("SIGINT", () => process.exit(130));

try {
  // `--no-color` (terminal colours) would clash with `--color <mode>` (output colour mode) in the parser
  cli.parse(process.argv.map((x, i) => (i > 1 && x === "-" ? STDIN_TOKEN : i > 1 && x === "--no-color" ? "--no-ansi" : x)), { run: false });
  if (!cli.matchedCommand && cli.args.length) {
    process.stderr.write(`unknown command: ${cli.args[0]}\n`);
    process.exitCode = 3;
  } else if (!cli.matchedCommand && !cli.options.help && !cli.options.version) cli.outputHelp();
  else await cli.runMatchedCommand();
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = 3;
}
