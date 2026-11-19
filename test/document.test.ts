import { describe, expect, it } from "vitest";
import { load, render, validate } from "../src/api.js";

const yaml = (s: string) => ({ yaml: s, filename: "/virtual/test.yaml" });

describe("loading and validation", () => {
  it("requires the version marker", () => {
    const p = load(yaml("pages: []\n"));
    expect(p.bag.items[0]?.code).toBe("SCHEMA_UNSUPPORTED_VERSION");
  });
  it("reports unknown keys with location and suggestion", () => {
    const p = load(yaml("mangacli: 1\npages:\n  - panels:\n      - layers:\n          - balloon: やあ\n            fontsize: 5mm\n"));
    const d = p.bag.items.find((x) => x.code === "SCHEMA_UNKNOWN_KEY");
    expect(d).toBeDefined();
    expect(d!.location?.line).toBe(6);
    expect(d!.hint).toContain("fontSize");
  });
  it("expands shorthands", () => {
    const p = load(yaml("mangacli: 1\npages:\n  - panels:\n      - layers:\n          - balloon: やあ\n          - sfx: ドン\n"));
    expect(p.bag.hasErrors).toBe(false);
    const layers = ((p.doc.pages as any)[0].panels[0].layers as any[]).map((e) => e.type);
    expect(layers).toEqual(["balloon", "sfx"]);
  });
  it("reads text keys verbatim", () => {
    const p = load(yaml("mangacli: 1\npages:\n  - panels:\n      - layers:\n          - balloon: 0123\n"));
    expect((p.doc.pages as any)[0].panels[0].layers[0].text).toBe("0123");
  });
  it("detects duplicate ids", async () => {
    const r = await validate(yaml("mangacli: 1\npages:\n  - panels:\n      - layers:\n          - { balloon: a, id: x }\n          - { balloon: b, id: x }\n"));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "ID_DUPLICATE")).toBe(true);
  });
});

describe("layout", () => {
  it("lays out yonkoma with a title slot", async () => {
    const r = await validate(
      yaml("mangacli: 1\nmeta: { title: テスト }\npages:\n  - layout: { template: yonkoma, params: { title: true } }\n    panels:\n      - {}\n      - {}\n      - {}\n      - {}\n"),
    );
    expect(r.ok).toBe(true);
    const panels = r.layout[0].panels;
    expect(panels.length).toBe(5);
    expect(panels.some((p) => p.id.endsWith("-title"))).toBe(true);
  });
  it("warns about overflowing fixed-size balloons", async () => {
    const r = await validate(yaml("mangacli: 1\npages:\n  - panels:\n      - layers:\n          - balloon: とても長いセリフがここに入りますがとても入りきりません\n            size: [8mm, 8mm]\n"));
    expect(r.diagnostics.some((d) => d.code === "TEXT_OVERFLOW" || d.code === "TEXT_SHRUNK")).toBe(true);
  });
  it("grows auto-sized balloons before shrinking phrase-wrapped text", async () => {
    const r = await validate(yaml(`mangacli: 1
page: { size: B6, color: mono }
defaults:
  balloon: { fontSize: 5mm, wrap: auto }
pages:
  - layout:
      rows:
        - { cols: [1] }
        - { cols: [1] }
        - { cols: [1] }
    panels:
      - layers:
          - { balloon: "ねえ…聞いてる？", id: ellipsis, maxChars: 5 }
      - layers:
          - { balloon: "さすがにひどいんじゃないですか", maxChars: 7 }
      - {}
`));
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => ["TEXT_SHRUNK", "TEXT_OVERFLOW", "BALLOON_TOO_LARGE"].includes(d.code))).toEqual([]);
  });
});

describe("rendering", () => {
  const doc = "mangacli: 1\npage: { size: [60mm, 40mm], bleed: 0 }\npages:\n  - panels:\n      - layers:\n          - effect: focus-lines\n          - balloon: こんにちは\n";
  it("is deterministic", async () => {
    const a = await render(yaml(doc), { profile: "preview" });
    const b = await render(yaml(doc), { profile: "preview" });
    expect(a.pages.length).toBe(1);
    expect(Buffer.from(a.pages[0].data).equals(Buffer.from(b.pages[0].data))).toBe(true);
  });
  it("changes with the seed", async () => {
    const a = await render(yaml(doc), { profile: "preview", seed: 1 });
    const b = await render(yaml(doc), { profile: "preview", seed: 2 });
    expect(Buffer.from(a.pages[0].data).equals(Buffer.from(b.pages[0].data))).toBe(false);
  });
  it("encodes 1-bit PNG for print-mono", async () => {
    const r = await render(yaml(doc), { profile: "print-mono", dpi: 150 });
    const png = Buffer.from(r.pages[0].data);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // IHDR bit depth
    expect(png[24]).toBe(1);
  });
  it("writes PDF with trim and bleed boxes", async () => {
    const r = await render(yaml(doc.replace("bleed: 0", "bleed: 3mm")), { profile: "print-mono", dpi: 100, format: "pdf" });
    const pdf = Buffer.from(r.pages[0].data).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toMatch(/\/TrimBox \[8\.64 8\.64/);
  });
  it("writes SVG", async () => {
    const r = await render(yaml(doc), { profile: "preview", format: "svg" });
    const svg = Buffer.from(r.pages[0].data).toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="60mm"');
  });
  it("throws on errors by default", async () => {
    await expect(render(yaml("mangacli: 1\npages:\n  - panels:\n      - layers:\n          - balloon: x\n            at: nowhere\n"))).rejects.toThrow();
  });
});

describe("renderer", () => {
  it("shares fonts and renders a project repeatedly", async () => {
    const { createRenderer } = await import("../src/api.js");
    const r = createRenderer({ profile: "preview" });
    const project = r.load(yaml("mangacli: 1\npage: { size: [60mm, 40mm], bleed: 0 }\npages:\n  - panels:\n      - layers:\n          - balloon: やあ\n"));
    const v = await r.validate(project);
    expect(v.ok).toBe(true);
    const a = await r.renderPage(project, 1);
    const b = await r.renderPage(project, 1);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    const list = await r.displayList(project, 1);
    expect(list.root.children.length).toBeGreaterThan(0);
  });
});
