// Diagnostics (spec 13).

export type Severity = "error" | "warning" | "info";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  location?: SourceLocation;
  path?: (string | number)[];
  elementId?: string;
  pageId?: string;
  hint?: string;
}

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];
  constructor(
    private locate?: (path: (string | number)[]) => SourceLocation | undefined,
    private overrides: Record<string, Severity | "off"> = {},
  ) {}

  /** a new bag with the same settings and a copy of the current items */
  fork(): DiagnosticBag {
    const b = new DiagnosticBag(this.locate, this.overrides);
    b.items.push(...this.items);
    return b;
  }

  setLocator(fn: (path: (string | number)[]) => SourceLocation | undefined) {
    this.locate = fn;
  }

  add(d: Omit<Diagnostic, "location"> & { location?: SourceLocation }): void {
    const o = FIXED_ERRORS.has(d.code) ? undefined : this.overrides[d.code];
    if (o === "off") return;
    const sev = o ?? d.severity;
    const loc = d.location ?? (d.path && this.locate ? this.locate(d.path) : undefined);
    const pk = d.path ? d.path.join(".") : "";
    if (this.items.some((x) => x.code === d.code && x.message === d.message && x.elementId === d.elementId && x.pageId === d.pageId && (x.path ? x.path.join(".") : "") === pk)) return;
    if (this.items.length >= 200) return;
    this.items.push({ ...d, severity: sev, location: loc });
  }

  error(code: string, message: string, extra: Partial<Diagnostic> = {}) {
    this.add({ code, severity: "error", message, ...extra });
  }
  warn(code: string, message: string, extra: Partial<Diagnostic> = {}) {
    this.add({ code, severity: "warning", message, ...extra });
  }
  info(code: string, message: string, extra: Partial<Diagnostic> = {}) {
    this.add({ code, severity: "info", message, ...extra });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

const FIXED_ERRORS = new Set([
  "YAML_SYNTAX", "YAML_DUPLICATE_KEY", "YAML_UNKNOWN_TAG", "SCHEMA_UNKNOWN_KEY", "SCHEMA_TYPE", "SCHEMA_REQUIRED",
  "REF_NOT_FOUND", "ID_DUPLICATE", "ASSET_NOT_FOUND", "FONT_NOT_CONFIGURED", "FONT_NOT_FOUND", "INTERNAL_ERROR",
]);

export class MangaError extends Error {
  constructor(public code: string, message: string, public diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "MangaError";
  }
}

export class MangaValidationError extends MangaError {
  constructor(diagnostics: Diagnostic[]) {
    const errs = diagnostics.filter((d) => d.severity === "error");
    // code: the first error's diagnostic code
    super(errs[0]?.code ?? "VALIDATION", `${errs.length} error(s):\n` + errs.slice(0, 10).map(formatDiagnostic).join("\n"), diagnostics);
    this.name = "MangaValidationError";
  }
}

/** assets or fonts that cannot be read */
export class MangaResourceError extends MangaError {
  constructor(code: string, message: string, diagnostics: Diagnostic[] = []) {
    super(code, message, diagnostics);
    this.name = "MangaResourceError";
  }
}

/** backend / encoder failures, and partial failures of a multi-page render */
export class MangaRenderError extends MangaError {
  constructor(code: string, message: string, diagnostics: Diagnostic[] = [], public failures: { pageId: string; index: number; error: Error }[] = []) {
    super(code, message, diagnostics);
    this.name = "MangaRenderError";
  }
}

/** violations found while processing (limits, network) */
export class MangaSecurityError extends MangaError {
  constructor(code: string, message: string, diagnostics: Diagnostic[] = []) {
    super(code, message, diagnostics);
    this.name = "MangaSecurityError";
  }
}

/** aborted through `signal`; `name` is "AbortError" like DOM aborts */
export class MangaAbortError extends MangaError {
  constructor(message = "aborted") {
    super("ABORTED", message);
    this.name = "AbortError";
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const loc = d.location ? `${d.location.file}:${d.location.line}:${d.location.column} ` : "";
  const mark = d.severity === "error" ? "✖" : d.severity === "warning" ? "⚠" : "ℹ";
  return `${mark} ${d.code} ${loc}${d.message}${d.hint ? `\n  hint: ${d.hint}` : ""}`;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

export function suggest(word: string, cands: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bd = 3;
  for (const c of cands) {
    const d = levenshtein(word, c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
