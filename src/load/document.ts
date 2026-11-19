// Document loading: files, imports, includes, path absolutization (spec 3.1, 3.18).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { DiagnosticBag, type SourceLocation } from "../core/diagnostics.js";
import { isObj, looksLikePath } from "./normalize.js";
import { loadYamlString } from "./yaml.js";

type Obj = Record<string, unknown>;

export interface LoadedDocument {
  data: Obj;
  locate: (path: (string | number)[]) => SourceLocation | undefined;
  files: string[];
  baseDir: string;
  entry?: string;
}

const IMPORT_KEYS = new Set(["mangacli", "fonts", "fontSet", "assets", "characters", "styles", "defaults", "hand", "seed"]);

function absolutize(data: Obj, baseDir: string) {
  const abs = (p: string) => (p.startsWith("data:") || /^https?:\/\//.test(p) || p.startsWith("catalog:") || isAbsolute(p) ? p : resolvePath(baseDir, p));
  if (isObj(data.assets)) {
    for (const [k, v] of Object.entries(data.assets)) {
      if (typeof v === "string") data.assets[k] = abs(v);
      else if (isObj(v) && typeof v.src === "string") v.src = abs(v.src);
    }
  }
  const absFonts = (fonts: unknown) => {
    if (!isObj(fonts)) return;
    for (const [k, v] of Object.entries(fonts)) {
      if (typeof v === "string" && /\.(ttf|otf|ttc|otc|woff2?)$/i.test(v)) fonts[k] = abs(v);
      else if (isObj(v) && typeof v.src === "string") v.src = abs(v.src);
    }
  };
  absFonts(data.fonts);
  if (isObj(data.locales)) for (const l of Object.values(data.locales)) if (isObj(l)) absFonts(l.fonts);
  const absBackground = (page: unknown) => {
    if (!isObj(page) || !isObj(page.background)) return;
    const image = page.background.image;
    if (typeof image === "string" && looksLikePath(image)) page.background.image = abs(image);
  };
  absBackground(data.page);
  const walkEls = (els: unknown) => {
    if (!Array.isArray(els)) return;
    for (const e of els) {
      if (!isObj(e)) continue;
      for (const key of ["image", "src"]) if (typeof e[key] === "string" && looksLikePath(e[key] as string)) e[key] = abs(e[key] as string);
      if (Array.isArray(e.children)) walkEls(e.children);
      if (Array.isArray(e.group)) walkEls(e.group);
    }
  };
  if (Array.isArray(data.pages)) {
    for (const pg of data.pages) {
      if (!isObj(pg)) continue;
      if (typeof pg.include === "string") pg.include = abs(pg.include);
      absBackground(pg);
      walkEls(pg.layers);
      if (Array.isArray(pg.panels)) for (const pn of pg.panels) if (isObj(pn)) walkEls(pn.layers);
    }
  }
  if (Array.isArray(data.imports)) data.imports = data.imports.map((p) => (typeof p === "string" ? abs(p) : p));
}

export function loadDocumentFromString(text: string, file: string, bag: DiagnosticBag, root?: string): LoadedDocument {
  const files: string[] = [];
  const locators: ((p: (string | number)[]) => SourceLocation | undefined)[] = [];
  const mainLoaded = loadYamlString(text, file, bag);
  files.push(file);
  const data = (isObj(mainLoaded.data) ? mainLoaded.data : {}) as Obj;
  const baseDir = dirname(file);
  absolutize(data, baseDir);
  const rootDir = root ?? baseDir;
  const checkRoot = (p: string) => {
    const rel = relative(rootDir, p);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      bag.error("SECURITY_PATH_OUTSIDE_ROOT", `path outside project root: ${p}`);
      return false;
    }
    return true;
  };
  // imports
  const seen = new Set<string>([file]);
  const doImport = (target: Obj, list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (typeof p !== "string") continue;
      if (seen.has(p)) {
        bag.error("IMPORT_CYCLE", `import cycle: ${p}`);
        continue;
      }
      if (!existsSync(p)) {
        bag.error("IMPORT_NOT_FOUND", `import not found: ${p}`);
        continue;
      }
      if (!checkRoot(p)) continue;
      seen.add(p);
      const l = loadYamlString(readFileSync(p, "utf8"), p, bag);
      files.push(p);
      locators.push(l.locate);
      const d = isObj(l.data) ? l.data : {};
      absolutize(d, dirname(p));
      if (Array.isArray(d.imports)) doImport(d, d.imports);
      for (const k of Object.keys(d)) if (!IMPORT_KEYS.has(k) && k !== "imports") bag.error("IMPORT_INVALID_KEY", `imported file ${p} has disallowed key "${k}"`);
      for (const k of ["fonts", "assets", "characters", "styles", "defaults"]) {
        if (!isObj(d[k])) continue;
        const cur = (isObj(target[k]) ? target[k] : {}) as Obj;
        const merged: Obj = { ...(d[k] as Obj) };
        for (const [kk, vv] of Object.entries(cur)) {
          if (kk in merged) bag.info("IMPORT_OVERRIDE", `"${k}.${kk}" from ${p} is overridden`);
          merged[kk] = vv;
        }
        target[k] = merged;
      }
      for (const k of ["hand", "seed", "fontSet"]) if (d[k] !== undefined && target[k] === undefined) target[k] = d[k];
    }
  };
  if (data.imports) doImport(data, data.imports);
  // includes
  if (Array.isArray(data.pages)) {
    const pages: unknown[] = [];
    for (const pg of data.pages) {
      if (isObj(pg) && typeof pg.include === "string") {
        const p = pg.include;
        if (!existsSync(p)) {
          bag.error("IMPORT_NOT_FOUND", `include not found: ${p}`);
          continue;
        }
        if (!checkRoot(p)) continue;
        const l = loadYamlString(readFileSync(p, "utf8"), p, bag);
        files.push(p);
        locators.push(l.locate);
        let incPages: unknown[] = [];
        let incDefaults: Obj | undefined;
        if (Array.isArray(l.data)) incPages = l.data;
        else if (isObj(l.data) && Array.isArray(l.data.pages)) {
          const dd = { pages: l.data.pages } as Obj;
          absolutize(dd, dirname(p));
          incPages = dd.pages as unknown[];
          if (isObj(l.data.defaults)) incDefaults = l.data.defaults as Obj;
        }
        const wrap = { pages: incPages } as Obj;
        absolutize(wrap, dirname(p));
        for (const ip of wrap.pages as unknown[]) {
          if (isObj(ip) && incDefaults) Object.defineProperty(ip, "__includeDefaults", { value: incDefaults, enumerable: false });
          pages.push(ip);
        }
      } else pages.push(pg);
    }
    data.pages = pages;
  }
  const locate = (path: (string | number)[]) => mainLoaded.locate(path);
  return { data, locate, files, baseDir, entry: file };
}

export function loadDocumentFile(path: string, bag: DiagnosticBag, root?: string): LoadedDocument {
  const abs = resolvePath(path);
  if (!existsSync(abs)) {
    bag.error("IMPORT_NOT_FOUND", `file not found: ${path}`);
    return { data: {}, locate: () => undefined, files: [], baseDir: dirname(abs) };
  }
  const text = readFileSync(abs, "utf8");
  if (abs.endsWith(".json")) {
    try {
      const data = JSON.parse(text) as Obj;
      absolutize(data, dirname(abs));
      return { data, locate: () => undefined, files: [abs], baseDir: dirname(abs), entry: abs };
    } catch (e) {
      bag.error("YAML_SYNTAX", (e as Error).message, { location: { file: abs, line: 1, column: 1 } });
      return { data: {}, locate: () => undefined, files: [abs], baseDir: dirname(abs) };
    }
  }
  return loadDocumentFromString(text, abs, bag, root);
}

export function loadDocumentFromObject(obj: Obj, baseDir: string): LoadedDocument {
  const data = structuredClone(obj) as Obj;
  absolutize(data, baseDir);
  return { data, locate: () => undefined, files: [], baseDir };
}
