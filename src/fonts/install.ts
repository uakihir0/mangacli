// installFonts / `mangacli fonts install` (spec 7.3.10, 11.2, 12.3.8).
import { rmSync } from "node:fs";
import { type CatalogFont, findCatalogFont, loadCatalog, parseCatalogRef, type SetRole } from "./catalog.js";
import { type FontFetchOptions, ensureCatalogFont, findLocalCatalogFont } from "./download.js";

export interface InstallFontsOptions extends FontFetchOptions {
  /** font set name (default manga-basic when neither ids nor all are given) */
  set?: string;
  ids?: string[];
  all?: boolean;
  /** catalog refs a document uses (resolved by the caller from `for`) */
  refs?: string[];
  /** install into this directory instead of the user cache */
  dir?: string;
  force?: boolean;
}

export interface InstalledFont {
  id: string;
  weight: number;
  family: string;
  path: string;
  downloaded: boolean;
}

/** catalog refs used by a font set (all roles, compose items and fallbacks) */
export function setFontRefs(setName: string): string[] {
  const set = loadCatalog().sets[setName];
  if (!set) throw new Error(`FONT_CATALOG_UNKNOWN: font set "${setName}"`);
  const out = new Set<string>();
  for (const r of Object.values(set) as SetRole[]) {
    if (typeof r === "string") continue;
    if (r.font) out.add(r.font);
    for (const c of r.compose ?? []) out.add(c.font);
    for (const f of r.fallback ?? []) out.add(f);
  }
  return [...out];
}

function toFont(ref: string): CatalogFont {
  const { id, weight } = parseCatalogRef(ref);
  const f = findCatalogFont(id, weight);
  if (!f) throw new Error(`FONT_CATALOG_UNKNOWN: ${ref}`);
  return f;
}

export async function installFonts(o: InstallFontsOptions = {}): Promise<InstalledFont[]> {
  const cat = loadCatalog();
  let fonts: CatalogFont[];
  if (o.all) fonts = cat.fonts;
  else {
    const refs = [...(o.ids ?? []), ...(o.refs ?? [])];
    if (o.set || refs.length === 0) refs.push(...setFontRefs(o.set ?? "manga-basic"));
    const seen = new Set<string>();
    fonts = [];
    for (const r of refs) {
      const f = toFont(r);
      const k = `${f.id}@${f.weight}`;
      if (seen.has(k)) continue;
      seen.add(k);
      fonts.push(f);
    }
  }
  const out: InstalledFont[] = [];
  let done = 0;
  for (const f of fonts) {
    o.signal?.throwIfAborted();
    const fetchOpts: FontFetchOptions = { ...o, fontDownload: "auto" };
    const where: FontFetchOptions = o.dir ? { fontDir: o.dir, fontCacheDir: o.dir } : fetchOpts;
    let local = findLocalCatalogFont(f, where);
    if (local && o.force) {
      rmSync(local, { force: true });
      local = null;
    }
    const path = local ?? (await ensureCatalogFont(f, fetchOpts, o.dir));
    out.push({ id: f.id, weight: f.weight, family: f.family, path, downloaded: !local });
    o.onProgress?.({ font: `${f.family} ${f.weight}`, done: ++done, total: fonts.length });
  }
  return out;
}

/** installation state of catalog fonts */
export function catalogStatus(o: FontFetchOptions = {}): { font: CatalogFont; path: string | null }[] {
  return loadCatalog().fonts.map((font) => ({ font, path: findLocalCatalogFont(font, o) }));
}
