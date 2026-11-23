// YAML loading with source positions (spec 3.2).
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YNode } from "yaml";
import { DiagnosticBag, type SourceLocation } from "../core/diagnostics.js";

/** keys whose scalar values are always read as their source string (spec 3.2 item 8) */
const TEXT_KEYS = new Set(["text", "balloon", "sfx", "placeholder", "title", "name", "subtitle", "description", "copyright", "note", "format"]);

export interface Loaded {
  data: unknown;
  /** path -> location, path joined by "\u0000"; falls back to the nearest ancestor unless `exact` */
  locate: (path: (string | number)[], exact?: boolean) => SourceLocation | undefined;
  files: string[];
}

interface SourceMapEntry {
  file: string;
  lc: LineCounter;
  offset: number;
}

export function parseYamlText(text: string, file: string, bag: DiagnosticBag, maxAliasNodes = 10000): { data: unknown; map: Map<string, SourceMapEntry> } {
  const lc = new LineCounter();
  const doc = parseDocument(text.replace(/^﻿/, ""), {
    version: "1.2",
    schema: "core",
    merge: true,
    uniqueKeys: true,
    lineCounter: lc,
    keepSourceTokens: false,
    prettyErrors: false,
    customTags: [],
  });
  const map = new Map<string, SourceMapEntry>();
  for (const e of doc.errors) {
    const pos = lc.linePos(e.pos[0]);
    const code = /duplicate|unique/i.test(e.message) ? "YAML_DUPLICATE_KEY" : /tag/i.test(e.message) ? "YAML_UNKNOWN_TAG" : "YAML_SYNTAX";
    bag.error(code, e.message.split("\n")[0], { location: { file, line: pos.line, column: pos.col } });
  }
  for (const w of doc.warnings) {
    const pos = lc.linePos(w.pos[0]);
    if (/tag/i.test(w.message)) bag.error("YAML_UNKNOWN_TAG", w.message.split("\n")[0], { location: { file, line: pos.line, column: pos.col } });
  }
  if (doc.errors.length) return { data: null, map };
  let aliasCount = 0;
  const walk = (node: YNode | null | undefined, path: (string | number)[], parentKey?: string): unknown => {
    if (!node) return null;
    if (node.range) map.set(path.join("\u0000"), { file, lc, offset: node.range[0] });
    if (isMap(node)) {
      const o: Record<string, unknown> = {};
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        if (k === "<<") {
          const merged = walk(pair.value as YNode, path) as Record<string, unknown> | Record<string, unknown>[];
          for (const m of Array.isArray(merged) ? merged : [merged]) if (m && typeof m === "object") for (const [mk, mv] of Object.entries(m)) if (!(mk in o)) o[mk] = mv;
          continue;
        }
        if (pair.key && (pair.key as YNode).range) map.set([...path, k].join("\u0000") + "\u0001key", { file, lc, offset: (pair.key as YNode).range![0] });
        o[k] = walk(pair.value as YNode, [...path, k], k);
      }
      return o;
    }
    if (isSeq(node)) return node.items.map((it, i) => walk(it as YNode, [...path, i], parentKey));
    if (isScalar(node)) {
      if (parentKey && TEXT_KEYS.has(parentKey) && typeof node.value !== "string" && node.value !== undefined) {
        return node.source ?? String(node.value);
      }
      if (typeof node.value === "string" && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED")) {
        if (node.type === "BLOCK_FOLDED" && (parentKey === "text" || parentKey === "balloon" || parentKey === "sfx")) bag.warn("TEXT_FOLDED_SCALAR", "folded block scalar (>) joins lines with spaces; use | for dialogue", { location: loc(node.range![0]) });
        return node.value.replace(/\n+$/, "");
      }
      return node.value;
    }
    // alias
    aliasCount++;
    if (aliasCount > maxAliasNodes) {
      bag.error("YAML_ALIAS_LIMIT", "too many alias expansions");
      return null;
    }
    const resolved = (node as unknown as { resolve(d: unknown): YNode }).resolve(doc);
    return walk(resolved, path, parentKey);
  };
  const loc = (off: number): SourceLocation => {
    const p = lc.linePos(off);
    return { file, line: p.line, column: p.col };
  };
  const data = walk(doc.contents as YNode, []);
  return { data, map };
}

export function loadYamlFile(path: string, bag: DiagnosticBag): Loaded {
  const abs = resolvePath(path);
  const text = readFileSync(abs, "utf8");
  return loadYamlString(text, abs, bag);
}

export function loadYamlString(text: string, file: string, bag: DiagnosticBag): Loaded {
  const { data, map } = parseYamlText(text, file, bag);
  const locate = (path: (string | number)[], exact = false): SourceLocation | undefined => {
    for (let n = path.length; n >= (exact ? path.length : 0); n--) {
      const key = path.slice(0, n).join("\u0000");
      const e = map.get(key + (n === path.length ? "\u0001key" : "")) ?? map.get(key);
      if (e) {
        const p = e.lc.linePos(e.offset);
        return { file: e.file, line: p.line, column: p.col };
      }
    }
    return undefined;
  };
  // annotate base dir for relative paths
  if (data && typeof data === "object") Object.defineProperty(data, "__baseDir", { value: dirname(file), enumerable: false });
  return { data, locate, files: [file] };
}
