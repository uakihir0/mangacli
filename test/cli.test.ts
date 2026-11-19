import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(root, "src/cli/index.ts"), ...args, "--no-config"], { cwd: root, encoding: "utf8" });

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
  it("exports print dimensions and rejects unknown output sizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    const file = join(dir, "print.yaml");
    writeFileSync(file, "mangacli: 1\npage: { size: [100mm, 150mm], printScale: 0.8 }\npages: [{}]\n");
    const r = cli("render", file, "-p", "preview", "--output-size", "print", "--format", "svg", "-o", dir, "--name", "print", "-q");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "print.svg"), "utf8")).toContain('width="80mm" height="120mm"');
    expect(cli("render", file, "--output-size", "unknown").status).toBe(3);
  });
});
