// Package entry (spec 11).
import type { z } from "zod";
import type { Document } from "./schema/schema.js";

export {
  createRenderer,
  layout,
  load,
  load as loadDocument,
  render,
  renderPage,
  validate,
  type MangaInput,
  type Project,
  type RenderOptions,
  type RenderResult,
  type RenderedPage,
  type Renderer,
  type ValidateResult,
} from "./api.js";
export { defineConfig, findConfig, loadConfig, type MangaConfig } from "./config.js";
export { type Diagnostic, type Severity, type SourceLocation, MangaError, MangaValidationError, formatDiagnostic } from "./core/diagnostics.js";
export { installFonts, catalogStatus, setFontRefs, type InstallFontsOptions, type InstalledFont } from "./fonts/install.js";
export { loadCatalog, type CatalogFont } from "./fonts/catalog.js";
export { defaultFontCacheDir } from "./fonts/download.js";
export { PROFILES, type Profile } from "./output/profiles.js";
export { jsonSchema } from "./schema/jsonschema.js";
export type { DisplayList, Node, GroupNode, PathNode, ImageNode, Paint, ToneSpec } from "./render/ir.js";
export type { PageLayoutInfo } from "./render/compose.js";

/** canonical (normalized) document shape */
export type MangaDocument = z.input<typeof Document>;

/** identity helper for writing documents in TypeScript (shorthand forms are accepted at runtime) */
export function defineManga<T extends { mangacli: 1 } & Record<string, unknown>>(doc: T): T {
  return doc;
}
