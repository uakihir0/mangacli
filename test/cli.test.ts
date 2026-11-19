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
  it("raises the per-page pixel limit and rejects invalid limits", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-limit-"));
    const f = join(dir, "spread.yaml");
    writeFileSync(f, "mangacli: 1\npage: { size: [12mm, 15mm], bleed: 0 }\npages: [{ id: spread, type: spread }]\n");
    const args = ["render", f, "-p", "print-gray", "--dpi", "100", "--spread", "split", "-f", "png", "-o", join(dir, "out"), "-q"];
    expect(cli(...args, "--max-output-pixels", "100").status).toBe(2);
    expect(existsSync(join(dir, "out"))).toBe(false);
    expect(cli(...args, "--max-output-pixels", "3000").status).toBe(0);
    expect(cli(...args, "--max-output-pixels", "bad").status).toBe(3);
    expect(cli(...args, "--max-output-pixels", "0").status).toBe(3);
    const mono = [...args];
    mono[mono.indexOf("print-gray")] = "print-mono";
    expect(cli(...mono, "--max-output-bytes", "100").status).toBe(2);
    expect(cli(...mono, "--max-output-bytes", "40000000", "--max-output-pixels", "1").status).toBe(0);
    expect(cli(...mono, "--max-output-bytes", "nope").status).toBe(3);
    expect(cli(...mono, "--max-output-bytes", "0").status).toBe(3);
  });
});
