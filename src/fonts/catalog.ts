// Font catalog (spec 7.3.10).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CatalogFont {
  id: string;
  family: string;
  weight: number;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  variations?: Record<string, number>;
  vertical: boolean;
  license: { id: string; url: string; sha256: string; copyright: string };
  coverage: string;
  revision: number;
}

export type SetRole = string | { font?: string; compose?: { font: string; ranges?: string[]; /** face size correction */ scale?: number }[]; fallback?: string[]; /** size factor (condensed display faces) */ scale?: number };

export interface Catalog {
  version: number;
  source: { repository: string; commit: string };
  allowedHosts: string[];
  fonts: CatalogFont[];
  coverage: Record<string, string>;
  sets: Record<string, Record<string, SetRole>>;
}

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (!cached) cached = JSON.parse(readFileSync(join(PACKAGE_ROOT, "catalog", "fonts.json"), "utf8")) as Catalog;
  return cached;
}

/** parse "id@700" or "catalog:id@700" */
export function parseCatalogRef(ref: string): { id: string; weight?: number } {
  const r = ref.startsWith("catalog:") ? ref.slice(8) : ref;
  const m = r.match(/^([a-z0-9][a-z0-9-]*)(?:@(\d+))?$/);
  if (!m) throw new Error(`invalid catalog reference: ${ref}`);
  return { id: m[1], weight: m[2] ? Number(m[2]) : undefined };
}

export function findCatalogFont(id: string, weight?: number): CatalogFont | undefined {
  const cat = loadCatalog();
  const cands = cat.fonts.filter((f) => f.id === id);
  if (cands.length === 0) return undefined;
  if (weight === undefined) return cands.find((f) => f.weight === 400) ?? cands[0];
  return cands.find((f) => f.weight === weight);
}

const coverageCache = new Map<string, [number, number][]>();

export function catalogCoverage(id: string): [number, number][] {
  let r = coverageCache.get(id);
  if (r) return r;
  const enc = loadCatalog().coverage[id] ?? "";
  r = [];
  let prev = 0;
  for (const part of enc.split(",")) {
    if (!part) continue;
    const [d, l] = part.split(":");
    const a = prev + parseInt(d, 36);
    const b = a + (l ? parseInt(l, 36) : 0);
    r.push([a, b]);
    prev = b;
  }
  coverageCache.set(id, r);
  return r;
}

export function coverageHas(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cp < ranges[m][0]) hi = m - 1;
    else if (cp > ranges[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}

/** the font set used when none is chosen: manga lettering for CJK text, comic lettering otherwise */
export function defaultFontSet(lang: string | undefined): string {
  return !lang || /^(ja|zh|ko)/.test(lang) ? "manga-basic" : "comic-basic";
}
