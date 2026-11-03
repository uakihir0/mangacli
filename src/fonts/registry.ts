// Font registry: definitions, roles, composite fonts, fallback (spec 7.3).
import * as hb from "harfbuzzjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, type SetRole, catalogCoverage, coverageHas, findCatalogFont, loadCatalog, parseCatalogRef } from "./catalog.js";
import { type FontFetchOptions, FontFetchError, ensureCatalogFont } from "./download.js";
import { inRange } from "./ranges.js";

export type FontDef =
  | { kind: "file"; path: string; index?: number; variations?: Record<string, number>; bold?: string; fallback?: string[] }
  | { kind: "bytes"; data: Uint8Array; index?: number; bold?: string; fallback?: string[] }
  | { kind: "catalog"; id: string; weight?: number; bold?: string; fallback?: string[] }
  | { kind: "alias"; name: string }
  | { kind: "compose"; items: ComposeItem[]; fallback?: string[]; bold?: string };

export interface ComposeItem {
  font: string;
  ranges?: string[];
  scale?: number;
  baselineShift?: number;
}

export interface LoadedFont {
  key: string;
  label: string;
  face: hb.Face;
  font: hb.Font;
  upem: number;
  ascender: number;
  descender: number;
  hasVert: boolean;
  /** correction (font units) added to HarfBuzz TTB yOffset so the ideographic em box top sits at the pen (fonts without VORG) */
  vOriginFix: number;
  has(cp: number): boolean;
}

export interface FontPick {
  font: LoadedFont;
  scale: number;
  baselineShift: number;
}

export const ROLE_CHAINS: Record<string, string[]> = {
  dialogue: ["default"],
  narration: ["dialogue", "default"],
  thought: ["dialogue", "default"],
  shout: ["dialogue", "default"],
  whisper: ["dialogue", "default"],
  sfx: ["shout", "dialogue", "default"],
  hand: ["dialogue", "default"],
  title: ["narration", "dialogue", "default"],
  ruby: [],
  ui: [],
};

const UI_FONT = join(PACKAGE_ROOT, "assets", "fonts", "Lato-Regular.ttf");

/** A physical font descriptor */
interface Phys {
  key: string;
  load: () => Promise<Uint8Array>;
  index: number;
  variations?: Record<string, number>;
  /** cheap coverage check before loading */
  coverage?: (cp: number) => boolean;
  label: string;
}

interface Chain {
  /** ordered candidates with optional range predicates */
  items: { phys: Phys; ranges?: string[]; scale: number; baselineShift: number }[];
}

export class FontRegistry {
  private loaded = new Map<string, LoadedFont>();
  private failed = new Set<string>();
  private chains = new Map<string, Chain>();
  readonly diagnostics: { code: string; message: string; severity: "error" | "warning" | "info" }[] = [];

  constructor(
    private defs: Map<string, FontDef>,
    private fontSet: string | "none",
    private globalFallback: string[],
    private fetchOpts: FontFetchOptions,
    /** cache shared between registries (catalog fonts are immutable) */
    private shared?: Map<string, LoadedFont>,
  ) {}

  hasDef(name: string): boolean {
    return this.defs.has(name);
  }

  private setRole(role: string): SetRole | undefined {
    if (this.fontSet === "none") return undefined;
    const set = loadCatalog().sets[this.fontSet];
    if (!set) throw new Error(`FONT_CATALOG_UNKNOWN: font set ${this.fontSet}`);
    let r = set[role];
    let guard = 0;
    while (typeof r === "string" && guard++ < 5) r = set[r];
    return r;
  }

  private catalogPhys(ref: string): Phys {
    let f: ReturnType<typeof findCatalogFont>;
    try {
      const { id, weight } = parseCatalogRef(ref);
      f = findCatalogFont(id, weight);
    } catch {
      f = undefined;
    }
    if (!f) {
      // unknown catalog entries never cover anything; loading reports the error once
      return {
        key: `cat-unknown:${ref}`,
        label: ref,
        index: 0,
        coverage: () => false,
        load: async () => {
          throw new FontFetchError("FONT_CATALOG_UNKNOWN", `font "${ref}" is not in the catalog`);
        },
      };
    }
    const cov = catalogCoverage(f.id);
    return {
      key: `cat:${f.id}@${f.weight}`,
      label: `${f.family} ${f.weight}`,
      index: 0,
      variations: f.variations,
      coverage: (cp) => coverageHas(cov, cp),
      load: async () => readFileSync(await ensureCatalogFont(f, this.fetchOpts)),
    };
  }

  private physOf(def: FontDef, name: string): Phys | null {
    switch (def.kind) {
      case "file":
        return { key: `file:${def.path}#${def.index ?? 0}`, label: name, index: def.index ?? 0, variations: def.variations, load: async () => readFileSync(def.path) };
      case "bytes":
        return { key: `bytes:${name}`, label: name, index: def.index ?? 0, load: async () => def.data };
      case "catalog":
        return this.catalogPhys(`${def.id}${def.weight ? "@" + def.weight : ""}`);
      default:
        return null;
    }
  }

  private pushSetRole(name: string, items: Chain["items"], fallbackOnly: boolean) {
    let role: SetRole | undefined;
    try {
      role = this.setRole(name) ?? this.setRole("dialogue");
    } catch (e) {
      this.fetchOpts.onError?.("FONT_CATALOG_UNKNOWN", (e as Error).message.replace(/^FONT_CATALOG_UNKNOWN: /, ""));
      return;
    }
    if (!role || typeof role === "string") return;
    const add = (font: string, ranges?: Chain["items"][number]["ranges"]) => {
      const phys = this.catalogPhys(font);
      if (!items.some((i) => i.phys.key === phys.key && !i.ranges)) items.push({ phys, ranges, scale: 1, baselineShift: 0 });
    };
    if (!fallbackOnly) {
      if (role.compose) for (const it of role.compose) add(it.font, it.ranges);
      if (role.font) add(role.font);
    }
    for (const f of role.fallback ?? []) add(f);
  }

  /** Build a candidate chain for a font name (role or registered name). */
  chain(name: string, seen = new Set<string>()): Chain {
    const hit = this.chains.get(name);
    if (hit) return hit;
    if (seen.has(name)) return { items: [] };
    const top = seen.size === 0;
    seen.add(name);
    const items: Chain["items"] = [];
    const pushName = (n: string) => items.push(...this.chain(n, seen).items);
    const def = this.defs.get(name);
    if (def) {
      if (def.kind === "alias") pushName(def.name);
      else if (def.kind === "compose") {
        for (const it of def.items) {
          for (const c of this.chain(it.font, seen).items)
            items.push({ ...c, ranges: it.ranges ?? c.ranges, scale: (it.scale ?? 1) * c.scale, baselineShift: (it.baselineShift ?? 0) + c.baselineShift });
        }
        for (const f of def.fallback ?? []) pushName(f);
      } else {
        const p = this.physOf(def, name);
        if (p) items.push({ phys: p, scale: 1, baselineShift: 0 });
        for (const f of def.fallback ?? []) pushName(f);
      }
    } else if (name.startsWith("catalog:")) {
      items.push({ phys: this.catalogPhys(name), scale: 1, baselineShift: 0 });
    } else if (name === "ui") {
      items.push({ phys: { key: `file:${UI_FONT}`, label: "Lato", index: 0, load: async () => readFileSync(UI_FONT) }, scale: 1, baselineShift: 0 });
    } else {
      // role chain through registered defs
      let found = false;
      for (const r of ROLE_CHAINS[name] ?? []) {
        if (this.defs.has(r)) {
          pushName(r);
          found = true;
          break;
        }
      }
      if (!found && (ROLE_CHAINS[name] || name === "default")) this.pushSetRole(name, items, false);
    }
    if (top) {
      for (const g of this.globalFallback) if (g !== name) pushName(g);
      // user-defined fonts still fall back to the font set (CJK coverage, emphasis marks etc.)
      if (name !== "ui") this.pushSetRole(ROLE_CHAINS[name] ? name : "dialogue", items, true);
      items.push({ phys: { key: `file:${UI_FONT}`, label: "Lato", index: 0, load: async () => readFileSync(UI_FONT) }, scale: 1, baselineShift: 0 });
    }
    const ch = { items };
    if (top) this.chains.set(name, ch);
    return ch;
  }

  /** Load fonts needed to render `text` with `name`. */
  async prepare(name: string, text: string): Promise<void> {
    const ch = this.chain(name);
    const cps = new Set<number>();
    for (const ch2 of text) cps.add(ch2.codePointAt(0)!);
    const need = new Set<string>();
    const pending: Phys[] = [];
    for (const cp of cps) {
      if (cp < 0x20 || cp === 0x200b) continue;
      for (const it of ch.items) {
        if (it.ranges && !it.ranges.some((r) => inRange(r, cp))) continue;
        const lf = this.loaded.get(it.phys.key);
        const ok = lf ? lf.has(cp) : it.phys.coverage ? it.phys.coverage(cp) : true;
        if (!lf && !it.phys.coverage) {
          // must load to know
          if (!need.has(it.phys.key)) {
            need.add(it.phys.key);
            pending.push(it.phys);
          }
          await this.loadPending(pending);
          pending.length = 0;
          if (!this.loaded.get(it.phys.key)?.has(cp)) continue;
          break;
        }
        if (ok) {
          if (!lf && !need.has(it.phys.key)) {
            need.add(it.phys.key);
            pending.push(it.phys);
          }
          break;
        }
      }
    }
    // always load the primary (first unrestricted) font for metrics
    const primary = ch.items.find((i) => !i.ranges) ?? ch.items[0];
    if (primary && !this.loaded.has(primary.phys.key) && !need.has(primary.phys.key)) pending.push(primary.phys);
    await this.loadPending(pending);
  }

  private async loadPending(list: Phys[]): Promise<void> {
    await Promise.all(
      list.map(async (p) => {
        if (this.loaded.has(p.key)) return;
        const shareable = p.key.startsWith("cat:") || p.key === `file:${UI_FONT}`;
        const hit = shareable ? this.shared?.get(p.key) : undefined;
        if (hit) {
          this.loaded.set(p.key, hit);
          return;
        }
        if (this.failed.has(p.key)) return;
        let lf: LoadedFont;
        try {
          lf = makeLoaded(p, await p.load());
        } catch (e) {
          this.failed.add(p.key);
          const err = e as Error & { code?: string };
          const code = e instanceof FontFetchError ? e.code : err.code === "ENOENT" ? "FONT_NOT_FOUND" : err.code === "EACCES" ? "FONT_LOAD_FAILED" : "FONT_UNSUPPORTED_FORMAT";
          this.fetchOpts.onError?.(code, `${p.label}: ${err.message}`);
          if (!this.fetchOpts.onError) throw e;
          return;
        }
        this.loaded.set(p.key, lf);
        if (shareable) this.shared?.set(p.key, lf);
      }),
    );
  }

  /** Pick a loaded font for codepoint (sync; call prepare first). */
  pick(name: string, cp: number): FontPick | null {
    const ch = this.chain(name);
    let firstLoaded: FontPick | null = null;
    for (const it of ch.items) {
      if (it.ranges && !it.ranges.some((r) => inRange(r, cp))) continue;
      const lf = this.loaded.get(it.phys.key);
      if (!lf) continue;
      if (!firstLoaded) firstLoaded = { font: lf, scale: it.scale, baselineShift: it.baselineShift };
      if (lf.has(cp)) return { font: lf, scale: it.scale, baselineShift: it.baselineShift };
    }
    return null;
  }

  /** primary font for metrics */
  primary(name: string): LoadedFont | null {
    const ch = this.chain(name);
    for (const it of ch.items) {
      if (it.ranges) continue;
      const lf = this.loaded.get(it.phys.key);
      if (lf) return lf;
    }
    for (const it of ch.items) {
      const lf = this.loaded.get(it.phys.key);
      if (lf) return lf;
    }
    return null;
  }

  boldName(name: string): string | undefined {
    const d = this.defs.get(name);
    if (d && "bold" in d && d.bold) return d.bold;
    if (d && d.kind === "alias") return this.boldName(d.name);
    return undefined;
  }
}

function makeLoaded(p: Phys, data: Uint8Array): LoadedFont {
  const face = new hb.Face(new hb.Blob(data), p.index);
  const font = new hb.Font(face);
  if (p.variations) font.setVariations(Object.entries(p.variations).map(([t, v]) => new hb.Variation(t, v)));
  const ext = font.hExtents();
  const cps = new Set(face.collectUnicodes());
  let hasVert = false;
  try {
    hasVert = face.getTableFeatureTags("GSUB").includes("vert");
  } catch {
    hasVert = false;
  }
  // Without VORG HarfBuzz uses hhea ascender as the vertical origin, which pushes glyphs down
  // in fonts with tall line metrics. Use the OS/2 typo ascender (ideographic em box) instead.
  let vOriginFix = 0;
  const vorg = face.referenceTable("VORG");
  if (!vorg?.length) {
    const os2 = face.referenceTable("OS/2");
    let top = face.upem * 0.88;
    if (os2 && os2.byteLength >= 72) {
      const dv = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
      const ta = dv.getInt16(68);
      const td = dv.getInt16(70);
      if (Math.abs(ta - td - face.upem) <= face.upem * 0.1) top = ta;
    }
    vOriginFix = ext.ascender - top;
  }
  return {
    key: p.key,
    label: p.label,
    face,
    font,
    upem: face.upem,
    ascender: ext.ascender,
    descender: ext.descender,
    hasVert,
    vOriginFix,
    has: (cp) => cps.has(cp),
  };
}
