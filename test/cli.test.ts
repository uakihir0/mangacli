import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) => spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli/index.ts"), ...args, "--no-config"], { cwd: root, encoding: "utf8" });

describe("cli", () => {
  it("validates an example (exit 0)", () => {
    expect(cli("validate", "docs/examples/minimal.yaml", "-q").status).toBe(0);
  });
  it("reports errors with exit 1 and JSON diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    const f = join(dir, "bad.yaml");
    writeFileSync(f, "mangacli: 1\npages:\n  - panels:\n      - layers:\n          - { balloon: x, fontsize: 3mm }\n");
    const r = cli("validate", f, "--reporter", "json");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('"code":"SCHEMA_UNKNOWN_KEY"');
  });
  it("rejects bad option values with exit 3", () => {
    expect(cli("render", "docs/examples/minimal.yaml", "--crop", "nope").status).toBe(3);
  });
  it("renders files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    const r = cli("render", "docs/examples/minimal.yaml", "-p", "preview", "-o", dir, "--name", "001", "-q");
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "001.png"))).toBe(true);
  });
});
