import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDeps } from "../src/cli/deps.js";

const root = join(import.meta.dirname, "..");
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "mc-deps-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};

describe("collectDeps", () => {
  it("includes inline image paths and asset shorthands, even before the files exist", () => {
    const dir = project({
      "manga.yaml": [
        "# yaml-language-server: $schema=./node_modules/mangacli/schema.json",
        "mangacli: 1",
        "assets:",
        "  taro: ./assets/taro.png",
        "  hana: { src: ./assets/hana.webp }",
        "pages:",
        "  - panels:",
        "      - layers: [{ image: assets/1.png, placeholder: 起 }]",
        "      - layers:",
        "          - image: taro",
        '          - { image: "./assets/2.jpg" }',
        "          - { image: https://example.com/remote.png }",
        "          - { text: '#fff.png' }  # comment: ./commented.png",
        '          - [{ text: "Chapter #1" }, { src: ./assets/3.png }, { text: \'it\'\'s #2\' }, { src: ./assets/4.png }]',
      ].join("\n"),
    });
    const deps = collectDeps(join(dir, "manga.yaml"));
    expect(deps.sort()).toEqual(
      ["manga.yaml", "assets/taro.png", "assets/hana.webp", "assets/1.png", "assets/2.jpg", "assets/3.png", "assets/4.png"].map((f) => join(dir, f)).sort(),
    );
  });

  it("follows imports and includes recursively", () => {
    const dir = project({
      "manga.yaml": "mangacli: 1\nimports:\n  - ./shared/characters.yaml\npages:\n  - include: ./chapters/ch01.yaml\n",
      "shared/characters.yaml": "assets:\n  taro: ../art/taro.png\n",
      "chapters/ch01.yaml": "- panels:\n    - layers: [{ image: ../art/bg.png }]\n",
    });
    const deps = collectDeps(join(dir, "manga.yaml"));
    for (const f of ["shared/characters.yaml", "chapters/ch01.yaml", "art/taro.png", "art/bg.png"]) expect(deps).toContain(join(dir, f));
  });
});

describe("preview", () => {
  it("re-renders when an inline image is added and when it changes", async () => {
    const dir = project({ "manga.yaml": "mangacli: 1\npages:\n  - panels:\n      - layers: [{ image: art/1.png }]\n" });
    const port = 41000 + Math.floor(Math.random() * 10000);
    const child = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli/index.ts"), "preview", join(dir, "manga.yaml"), "--port", String(port), "--no-config"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const page = async () => (await fetch(`http://127.0.0.1:${port}/`)).text();
    const until = async (ok: (html: string) => boolean) => {
      for (let i = 0; i < 300; i++) {
        if (log.includes("preview:")) {
          const html = await page();
          if (ok(html)) return html;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out\n${log}`);
    };
    try {
      await until((h) => h.includes("ASSET_NOT_FOUND"));
      await new Promise((r) => setTimeout(r, 500));
      mkdirSync(join(dir, "art"));
      copyFileSync(join(root, "sample/art/p1-1.png"), join(dir, "art/1.png"));
      const added = await until((h) => h.includes("1 page(s)"));
      const version = added.match(/\?v=(\d+)/)![1];
      copyFileSync(join(root, "sample/art/p1-2.png"), join(dir, "art/1.png"));
      await until((h) => /\?v=(\d+)/.test(h) && h.match(/\?v=(\d+)/)![1] !== version);
    } finally {
      child.kill();
    }
  });
});
