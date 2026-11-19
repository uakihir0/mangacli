import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";

const fixtures = join(import.meta.dirname, "fixtures");
const baselines = join(fixtures, "baselines");
const update = process.env.UPDATE_VISUAL_BASELINES === "1";
const linuxX64 = process.platform === "linux" && process.arch === "x64";
const renderer = createRenderer({ profile: "preview", seed: 12345, dpi: 72 });

function compare(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof actual === "number" && typeof expected === "number") {
    expect(Number.isFinite(actual), path).toBe(true);
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(0.001 + Number.EPSILON);
  } else if (Array.isArray(actual) && Array.isArray(expected)) {
    expect(actual.length, path).toBe(expected.length);
    actual.forEach((value, i) => compare(value, expected[i], `${path}[${i}]`));
  } else if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    expect(Object.keys(actual).sort(), path).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(actual)) {
      compare((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

function baseline(name: string, value: unknown): unknown {
  const file = join(baselines, name);
  if (update) {
    mkdirSync(baselines, { recursive: true });
    writeFileSync(file, JSON.stringify(value, (_key, v: unknown) => typeof v === "number" ? Number(v.toFixed(5)) : v) + "\n");
  }
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

describe("display-list comparison", () => {
  it("allows numeric drift up to 0.001 mm", () => {
    compare({ coordinates: [1, 2] }, { coordinates: [1.001, 1.999] });
  });
  it("compares empty collections and null", () => {
    compare({ children: [], paint: null }, { children: [], paint: null });
  });
  it("rejects numeric, structural and nonnumeric regressions", () => {
    for (const [a, b] of [[1.002, 1], [NaN, 1], [[], [1]], [{ a: 1 }, {}], ["ink", "fill"], [null, {}]]) {
      expect(() => compare(a, b)).toThrow();
    }
  });
});

describe("feature catalogs (docs/14 §14.3.1)", () => {
  for (const file of readdirSync(fixtures).filter((f) => f.endsWith(".yaml")).sort()) {
    const input = join(fixtures, file);
    it(`${file}: deterministic display-list snapshot (±0.001 mm)`, async () => {
      const result = await renderer.render(input, { layoutOnly: true, keepLists: true });
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.lists).toHaveLength(1);
      const actual = JSON.parse(JSON.stringify(result.lists![0])) as unknown;
      expect(await renderer.displayList(input, 1)).toEqual(result.lists![0]);
      compare(actual, baseline(`${file}.display-list.json`, actual));
    });
    it.skipIf(!linuxX64)(`${file}: Linux x64 PNG SHA-256`, async () => {
      const result = await renderer.render(input);
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].format).toBe("png");
      const hash = createHash("sha256").update(result.pages[0].data).digest("hex");
      expect(hash).toBe(baseline(`${file}.png.sha256.json`, hash));
    });
  }
});
