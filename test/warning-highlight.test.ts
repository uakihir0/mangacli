import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRenderer } from "../src/api.js";

const yaml = (type = "page", at = "2mm, 20mm") => `mangacli: 1
page: { size: [80mm, 60mm], bleed: 3mm }
pages:
  - id: page-one
    type: ${type}
    panels: []
    layers:
      - { text: Hello, id: lettering, fontSize: 4mm, writing: horizontal, at: [${at}], anchor: top-left }
`;
const renderer = createRenderer({ profile: "preview" });

it.each(["trim", "bleed"] as const)("returns element boxes in %s output pixels, including split spreads", async (crop) => {
  const input = { yaml: yaml("spread", "100mm, 20mm"), filename: "/v/highlight.yaml" };
  const joined = await renderer.render(input, { format: "png", crop, dpi: 254 });
  const split = await renderer.render(input, { format: "png", crop, dpi: 254, spread: "split" });
  const box = joined.pages[0]!.elements[0]!;
  const offset = crop === "bleed" ? 30 : 0;
  expect(box).toMatchObject({ id: "lettering", x: 1000 + offset, y: 200 + offset });
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(split.pages.find((p) => p.side === "left")!.elements).toEqual([]);
  expect(split.pages.find((p) => p.side === "right")!.elements[0]).toEqual({ ...box, x: box.x - 800 });
});

it("returns no boxes for an empty page", async () => {
  const r = await renderer.render({ yaml: yaml().replace(/    layers:[\s\S]*/, "    layers: []\n"), filename: "/v/empty.yaml" }, { format: "svg" });
  expect(r.pages[0]!.elements).toEqual([]);
});

it("serves warning rows with the matching page and pixel box", async () => {
  const root = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(tmpdir(), "mc-highlight-"));
  const file = join(dir, "warning.yaml");
  writeFileSync(file, yaml());
  const port = 44000 + Math.floor(Math.random() * 2000);
  const proc = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli/index.ts"), "preview", file, "--port", String(port), "--no-config"], { cwd: root });
  try {
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("preview did not start")), 60_000);
      const ready = (b: Buffer) => { if (b.toString().includes(`:${port}/`)) { clearTimeout(timer); ok(); } };
      proc.stdout.on("data", ready);
      proc.stderr.on("data", ready);
      proc.on("exit", () => { clearTimeout(timer); fail(new Error("preview exited")); });
    });
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const row = html.match(/<div class="d warning"[^>]*>TEXT_OUTSIDE_SAFE_AREA[^<]*<\/div>/)![0];
    expect(row).toContain('data-page="0"');
    expect(row).toContain('role="button"');
    const box = JSON.parse(row.match(/data-box="([^"]+)"/)![1]!.replaceAll("&quot;", '"'));
    const rendered = await renderer.render(file);
    expect(box).toEqual(rendered.pages[0]!.elements.find((e) => e.id === "lettering"));
    expect(html).toContain("mangacli-selection");
  } finally { proc.kill(); }
}, 90_000);
