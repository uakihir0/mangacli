import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
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
const groupedYaml = yaml().replace(/    layers:[\s\S]*/, `    layers:
      - type: group
        id: outer
        size: [40mm, 40mm]
        at: [10mm, 10mm]
        anchor: top-left
        children:
          - type: group
            id: inner
            size: [20mm, 20mm]
            at: [3mm, 4mm]
            anchor: top-left
            scale: 2
            children:
              - {text: Hello, id: child, size: [2mm, 2mm], overflow: clip, fontSize: 4mm, writing: horizontal, at: [2mm, 5mm], anchor: top-left}
`);
const rotatedYaml = yaml("spread").replace(/    layers:[\s\S]*/, `    layers:
      - type: group
        id: outer
        size: [160mm, 60mm]
        at: [0mm, 0mm]
        anchor: top-left
        rotate: 45deg
        children:
          - type: group
            id: inner
            size: [160mm, 60mm]
            at: [0mm, 0mm]
            anchor: top-left
            rotate: -45deg
            children:
              - {text: Hello, id: child, size: [2mm, 8mm], overflow: clip, fontSize: 12mm, writing: horizontal, at: [77mm, 20mm], anchor: top-left}
`);

it("does not inflate child bounds when nested rotations cancel across a split fold", async () => {
  const result = await renderer.render({ yaml: rotatedYaml }, { format: "png", dpi: 254, spread: "split" });
  const left = result.pages.find((p) => p.side === "left")!;
  const right = result.pages.find((p) => p.side === "right")!;
  const box = left.elements.find((e) => e.id === "child")!;
  expect(box.x).toBeCloseTo(770);
  expect(box.y).toBeCloseTo(200);
  expect(box.width).toBeCloseTo(20);
  expect(box.height).toBeCloseTo(80);
  expect(right.elements.some((e) => e.id === "child")).toBe(false);
});

it("registers nested children in page coordinates and supplies their diagnostic page", async () => {
  const result = await renderer.render({ yaml: groupedYaml }, { format: "png", dpi: 254 });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TEXT_CLIPPED", elementId: "child", pageId: "page-one" }));
  expect(result.pages[0]!.elements).toContainEqual({ id: "child", x: 170, y: 240, width: 40, height: 40 });
  expect(result.pages[0]!.elements.map((e) => e.id).sort()).toEqual(["child", "inner", "outer"]);
});

it("does not register phantom boxes for group children with empty draw results", async () => {
  const source = groupedYaml.replace("            children:\n", `            children:
              - {image: missing.png, id: ghost}
              - {type: group, id: empty, children: [{image: missing.png, id: nested-ghost}]}
`);
  const result = await renderer.render({ yaml: source }, { format: "svg" });
  expect(result.pages[0]!.elements.map((e) => e.id).sort()).toEqual(["child", "inner", "outer"]);
});

it("validates mask references on groups whose children draw nothing", async () => {
  const source = yaml().replace(/    layers:[\s\S]*/, `    layers:
      - {type: group, id: empty, mask: {element: absent}, children: []}
`);
  const result = await renderer.validate({ yaml: source });
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "REF_NOT_FOUND", path: ["pages", 0, "layers", 0, "mask"] }));
});

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

it.each(["png", "svg"] as const)("keeps %s boxes aligned with print-scaled output and marks", async (format) => {
  const input = { yaml: yaml().replace("bleed: 3mm", "bleed: 3mm, printScale: 0.5"), filename: "/v/print-highlight.yaml" };
  const base = await renderer.render(input, { format, crop: "trim", dpi: 254 });
  const printed = await renderer.render(input, { format, crop: "trim", dpi: 254, output: "print" });
  const b = base.pages[0]!.elements[0]!;
  const p = printed.pages[0]!.elements[0]!;
  expect(p).toEqual({ id: b.id, x: b.x / 2, y: b.y / 2, width: b.width / 2, height: b.height / 2 });
  const marked = await renderer.render(input, { format, crop: "marks", dpi: 254, output: "print" });
  expect(marked.pages[0]!.elements[0]).toEqual({ ...p, x: p.x + 115, y: p.y + 115 });
});

it.each([
  { format: "png", source: yaml(), code: "TEXT_OUTSIDE_SAFE_AREA", id: "lettering", hasBox: true, pageIndex: 0 },
  { format: "svg", source: yaml(), code: "TEXT_OUTSIDE_SAFE_AREA", id: "lettering", hasBox: true, pageIndex: 0 },
  { format: "png", source: groupedYaml, code: "TEXT_CLIPPED", id: "child", hasBox: true, pageIndex: 0 },
  { format: "png", source: groupedYaml.replace("at: [10mm, 10mm]", "at: [100mm, 100mm]"), code: "TEXT_CLIPPED", id: "child", hasBox: false, pageIndex: 0 },
  { format: "png", source: rotatedYaml, code: "TEXT_CLIPPED", id: "child", hasBox: true, pageIndex: 1 },
  { format: "png", source: rotatedYaml.replace("size: [2mm, 8mm]", "size: [4mm, 8mm]"), code: "TEXT_CLIPPED", id: "child", hasBox: true, pageIndex: 1 },
])("serves $format $id warning rows (box: $hasBox, page: $pageIndex)", async ({ format, source, code, id, hasBox, pageIndex }) => {
  const root = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(tmpdir(), "mc-highlight-"));
  const file = join(dir, "warning.yaml");
  writeFileSync(file, source);
  const port = 44000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, ["--import", "tsx", join(root, "src/cli/index.ts"), "preview", file, "--port", String(port), "--format", format, "--spread", "split", "--dpi", "254", "--no-config"], { cwd: root });
  try {
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("preview did not start")), 60_000);
      const ready = (b: Buffer) => { if (b.toString().includes(`:${port}/`)) { clearTimeout(timer); ok(); } };
      proc.stdout.on("data", ready);
      proc.stderr.on("data", ready);
      proc.on("exit", () => { clearTimeout(timer); fail(new Error("preview exited")); });
    });
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const row = html.match(new RegExp(`<div class="d warning"[^>]*>${code}[^<]*<\\/div>`))![0];
    expect(row).toContain(`data-page="${pageIndex}"`);
    expect(row).toContain('role="button"');
    if (!hasBox) {
      expect(row).not.toContain("data-box");
      return;
    }
    const box = JSON.parse(row.match(/data-box="([^"]+)"/)![1]!.replaceAll("&quot;", '"'));
    const rendered = await renderer.render(file, { format: format as "png" | "svg", dpi: 254, spread: "split" });
    expect(box).toEqual(rendered.pages[pageIndex]!.elements.find((e) => e.id === id));
    const page = rendered.pages[pageIndex]!;
    expect(html).toContain(`data-width="${page.width}" data-height="${page.height}"`);
    const img = { naturalWidth: format === "svg" ? 302 : page.width, naturalHeight: format === "svg" ? 227 : page.height, clientWidth: 400, clientHeight: 300, offsetLeft: 0, offsetTop: 0, dataset: { width: String(page.width), height: String(page.height) } };
    const frame = { style: {} as Record<string, string>, hidden: false };
    const position = html.match(/const position=\(\)=>\{[^\n]+/)![0];
    runInNewContext(`${position};position()`, { box: { checked: false }, guideBoxes: {}, selected: { dataset: { box: JSON.stringify(box), page: "0" } }, figures: [{ querySelector: () => img }], frame });
    expect(parseFloat(frame.style.left!)).toBeCloseTo(box.x * img.clientWidth / page.width - 3);
    expect(parseFloat(frame.style.top!)).toBeCloseTo(box.y * img.clientHeight / page.height - 3);
    expect(parseFloat(frame.style.width!)).toBeCloseTo(box.width * img.clientWidth / page.width + 6);
    if (format === "png") {
      // with Guides on, the boxes come from the guided image, which also holds the bleed (3mm = 30px at 254dpi)
      const gw = page.width + 60;
      const guideBoxes = { 0: { width: gw, height: page.height + 60, elements: [{ ...box, id, x: box.x + 30, y: box.y + 30 }] } };
      runInNewContext(`${position};position()`, { box: { checked: true }, guideBoxes, selected: { dataset: { box: JSON.stringify(box), key: JSON.stringify([code, id]), page: "0" } }, figures: [{ querySelector: () => img }], frame });
      expect(parseFloat(frame.style.left!)).toBeCloseTo((box.x + 30) * img.clientWidth / gw - 3);
      expect(parseFloat(frame.style.width!)).toBeCloseTo(box.width * img.clientWidth / gw + 6);
    }
    expect(html).toContain("mangacli-selection");
  } finally { proc.kill(); }
}, 90_000);
