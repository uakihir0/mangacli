// Font registry: definitions, roles, composite fonts, fallback (spec 7.3).
import * as hb from "harfbuzzjs";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKAGE_ROOT, type SetRole, catalogCoverage, coverageHas, findCatalogFont, loadCatalog, parseCatalogRef } from "./catalog.js";
import { type FontFetchOptions, FontFetchError, ensureCatalogFont } from "./download.js";
import { inRange } from "./ranges.js";
import { findSystemFont, listSystemFonts, type SystemFontFace } from "./system.js";

export type FontDef =
  | { kind: "file"; path: string; index?: number; variations?: Record<string, number>; bold?: string; fallback?: string[] }
  | { kind: "system"; name: string; index?: number; variations?: Record<string, number>; bold?: string; fallback?: string[] }
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
  /** `scale` enlarges the face inside the cell and keeps the character pitch (compose items) */
  face?: boolean;
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
  load: () => Promise<Uint8Array | { data: Uint8Array; index: number; label: string; path: string }>;
  index: number;
  variations?: Record<string, number>;
  /** cheap coverage check before loading */
  coverage?: (cp: number) => boolean;
  label: string;
  /** a missing font is skipped without a diagnostic */
  optional?: boolean;
}

interface Chain {
  /** ordered candidates with optional range predicates */
  items: { phys: Phys; ranges?: string[]; scale: number; baselineShift: number; face?: boolean }[];
}

export class FontRegistry {
  private loaded = new Map<string, LoadedFont>();
  private failed = new Set<string>();
  private chains = new Map<string, Chain>();
  private systemFonts?: Promise<SystemFontFace[]>;
  readonly diagnostics: { code: string; message: string; severity: "error" | "warning" | "info" }[] = [];

  constructor(
    private defs: Map<string, FontDef>,
    private fontSet: string | "none",
    private globalFallback: string[],
    private fetchOpts: FontFetchOptions & { onSystemFont?: (path: string) => void },
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
      case "system":
        return {
          key: `system:${name}`, label: name, index: def.index ?? 0, variations: def.variations,
          load: async () => {
            const query = JSON.stringify(def.name) + (def.index === undefined ? "" : ` (face ${def.index})`);
            const face = findSystemFont(await (this.systemFonts ??= listSystemFonts()), def.name, def.index);
            if (!face) throw Object.assign(new Error(`system font ${query} not found`), { code: "ENOENT" });
            const label = face.postScriptNames[0] ?? face.fullNames[0] ?? face.families[0];
            return { data: await readFile(face.path), index: face.index, label, path: face.path };
          },
        };
      case "bytes":
        return { key: `bytes:${name}`, label: name, index: def.index ?? 0, load: async () => def.data };
      case "catalog":
        return this.catalogPhys(`${def.id}${def.weight ? "@" + def.weight : ""}`);
      default:
        return null;
    }
  }

  /** the first installed font of `names` (font set entries such as commercial faces) */
  private optionalSystemPhys(names: string[]): Phys {
    const label = names[0];
    return {
      key: `system?:${names.join("|")}`, label, index: 0, optional: true,
      load: async () => {
        const faces = await (this.systemFonts ??= listSystemFonts());
        for (const n of names) {
          const face = findSystemFont(faces, n);
          if (face) return { data: await readFile(face.path), index: face.index, label: face.postScriptNames[0] ?? face.fullNames[0] ?? n, path: face.path };
        }
        throw Object.assign(new Error(`none of ${names.join(", ")} is installed`), { code: "ENOENT" });
      },
    };
  }

  private pushSetRole(name: string, items: Chain["items"], part: "all" | "primary" | "fallback") {
    let role: SetRole | undefined;
    try {
      role = this.setRole(name) ?? this.setRole("dialogue");
    } catch (e) {
      this.fetchOpts.onError?.("FONT_CATALOG_UNKNOWN", (e as Error).message.replace(/^FONT_CATALOG_UNKNOWN: /, ""));
      return;
    }
    if (!role || typeof role === "string") return;
    const add = (font: string, ranges?: Chain["items"][number]["ranges"], scale = 1, face = false) => {
      const phys = this.catalogPhys(font);
      if (!items.some((i) => i.phys.key === phys.key && !i.ranges)) items.push({ phys, ranges, scale, baselineShift: 0, face });
    };
    if (part !== "fallback") {
      if (role.compose) for (const it of role.compose) {
        if (it.font) add(it.font, it.ranges, it.scale ?? 1, true);
        else if (it.system?.length) items.push({ phys: this.optionalSystemPhys(it.system), ranges: it.ranges, scale: it.scale ?? 1, baselineShift: 0, face: true });
      }
      if (role.font) add(role.font, undefined, role.scale ?? 1);
    }
    if (part !== "primary") for (const f of role.fallback ?? []) add(f);
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
            items.push({ ...c, ranges: it.ranges ?? c.ranges, scale: (it.scale ?? 1) * c.scale, baselineShift: (it.baselineShift ?? 0) + c.baselineShift, face: true });
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
      if (name === "sfx") this.pushSetRole(name, items, "primary");
      // role chain through registered defs
      let found = false;
      for (const r of ROLE_CHAINS[name] ?? []) {
        if (this.defs.has(r)) {
          pushName(r);
          found = true;
          break;
        }
      }
      if (name === "sfx") {
        if (!top) this.pushSetRole(name, items, "fallback");
      } else if (!found && (ROLE_CHAINS[name] || name === "default")) this.pushSetRole(name, items, "all");
    }
    if (top) {
      for (const g of this.globalFallback) if (g !== name) pushName(g);
      // user-defined fonts still fall back to the font set (CJK coverage, emphasis marks etc.)
      if (name !== "ui") this.pushSetRole(ROLE_CHAINS[name] ? name : "dialogue", items, "fallback");
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
    // a font that fails to load (offline, not installed) hands its characters to the next candidate
    for (let failed = -1; failed !== this.failed.size; ) {
      failed = this.failed.size;
      await this.prepareRound(ch, cps);
    }
  }

  private async prepareRound(ch: Chain, cps: Set<number>): Promise<void> {
    const need = new Set<string>();
    const pending: Phys[] = [];
    for (const cp of cps) {
      if (cp < 0x20 || cp === 0x200b) continue;
      for (const it of ch.items) {
        if (it.ranges && !it.ranges.some((r) => inRange(r, cp))) continue;
        if (this.failed.has(it.phys.key)) continue;
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
    const primary = ch.items.find((i) => !i.ranges && !this.failed.has(i.phys.key)) ?? ch.items[0];
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
        let system: { index: number; path: string } | undefined;
        try {
          const loaded = await p.load();
          if (loaded instanceof Uint8Array) lf = makeLoaded(p, loaded);
          else {
            system = loaded;
            lf = makeLoaded({ ...p, index: loaded.index, label: loaded.label }, loaded.data);
          }
        } catch (e) {
          this.failed.add(p.key);
          if (p.optional) return;
          const err = e as Error & { code?: string };
          const code = e instanceof FontFetchError ? e.code : err.code === "ENOENT" ? "FONT_NOT_FOUND" : err.code === "EACCES" ? "FONT_LOAD_FAILED" : "FONT_UNSUPPORTED_FORMAT";
          this.fetchOpts.onError?.(code, `${p.label}: ${err.message}`);
          if (!this.fetchOpts.onError) throw e;
          return;
        }
        this.loaded.set(p.key, lf);
        if (system) {
          this.fetchOpts.onInfo?.("FONT_SYSTEM_USED", `${p.label}: using installed font ${JSON.stringify(lf.label)} (face ${system.index})`);
          this.fetchOpts.onSystemFont?.(system.path);
        }
        if (shareable) this.shared?.set(p.key, lf);
      }),
    );
  }

  private weighted = new Map<string, LoadedFont>();

  /** the same face at another weight of its `wght` axis (variable fonts; others are returned as is) */
  atWeight(lf: LoadedFont, weight: number): LoadedFont {
    const key = `${lf.key}#wght=${weight}`;
    const hit = this.weighted.get(key);
    if (hit) return hit;
    let out = lf;
    try {
      const axes = lf.face.getAxisInfos();
      if ("wght" in axes) {
        const font = new hb.Font(lf.face);
        font.setVariations([new hb.Variation("wght", weight)]);
        out = { ...lf, key, font };
      }
    } catch {
      out = lf;
    }
    this.weighted.set(key, out);
    return out;
  }

  /** Pick a loaded font for codepoint (sync; call prepare first). */
  pick(name: string, cp: number): FontPick | null {
    const ch = this.chain(name);
    let firstLoaded: FontPick | null = null;
    for (const it of ch.items) {
      if (it.ranges && !it.ranges.some((r) => inRange(r, cp))) continue;
      const lf = this.loaded.get(it.phys.key);
      if (!lf) continue;
      if (!firstLoaded) firstLoaded = { font: lf, scale: it.scale, baselineShift: it.baselineShift, face: it.face };
      if (lf.has(cp)) return { font: lf, scale: it.scale, baselineShift: it.baselineShift, face: it.face };
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
