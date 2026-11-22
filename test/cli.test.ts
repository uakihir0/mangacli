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
  it("does not show a green summary when there are warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-warn-"));
    const f = join(dir, "warn.yaml");
    writeFileSync(f, 'mangacli: 1\npages:\n  - panels:\n      - layers:\n          - { balloon: "そんなことってあるわけないだろうそんなことってあるわけないだろう", size: [5mm, 5mm] }\n');
    const env = { ...process.env, MANGACLI_LOCALE: "en", NO_COLOR: "1" };
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(root, "src/cli/index.ts"), ...args, "--no-config"], { cwd: root, encoding: "utf8", env });
    const v = run("validate", f);
    expect(v.status).toBe(0);
    expect(v.stderr).toContain("⚠ 1 warning(s)");
    expect(v.stderr).not.toContain("✔");
    const r = run("render", f, "-p", "preview", "-o", join(dir, "out"));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/⚠ wrote 1 file\(s\)/);
    expect(r.stderr).toContain("  1 warning(s)");
    expect(r.stderr).not.toContain("✔");
    expect(cli("validate", "docs/examples/minimal.yaml").stderr).toContain("✔");
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
  it.each([1, 2])("reports one-bit raster bands with concurrency %d", (concurrency) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-bands-"));
    const f = join(dir, "bands.yaml");
    writeFileSync(f, "mangacli: 1\npage: { size: [25.4mm, 25.4mm], bleed: 0 }\npages: [{ id: spread, type: spread }, { id: single }]\n");
    const args = ["render", f, "-p", "print-mono", "--dpi", "100", "--spread", "split", "-o", join(dir, "out"), "--concurrency", String(concurrency)];
    const r = cli(...args, "--json");
    expect(r.status, r.stderr).toBe(0);
    const events = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const bands = events.filter((e) => e.phase === "raster-band");
    for (const [pageId, side] of [["spread", "left"], ["spread", "right"], ["single", undefined]]) {
      expect(bands.filter((e) => e.pageId === pageId && e.side === side)).toEqual(
        [0, 1].map((done) => ({ type: "progress", phase: "raster-band", pageId, ...(side && { side }), done, total: 1 })),
      );
      expect(events.findIndex((e) => e.phase === "render" && e.pageId === pageId)).toBeGreaterThan(events.lastIndexOf(bands.find((e) => e.pageId === pageId && e.side === side && e.done === 1)));
    }
    expect(bands).toHaveLength(6);
    if (concurrency === 1) {
      const human = cli(...args, "--locale", "en");
      expect(human.stderr).toContain("spread/right: raster bands 0/1");
      expect(human.stderr).toContain("spread/right: raster bands 1/1");
    }
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
