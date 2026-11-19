import { describe, expect, it } from "vitest";
import sharp from "sharp";
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
});

describe("rendering", () => {
  const doc = "mangacli: 1\npage: { size: [60mm, 40mm], bleed: 0 }\npages:\n  - panels:\n      - layers:\n          - effect: focus-lines\n          - balloon: こんにちは\n";
  async function renderMonoToneLayers(...tones: string[]) {
    const probe = `mangacli: 1
meta: { lang: en }
page: { size: [25.4mm, 25.4mm], bleed: 0, baseFrame: trim, color: mono }
book: { pageNumbers: { show: never } }
pages:
  - panels:
      - border: none
        layers:
${tones.map(tone => `          - { type: fill, paint: { tone: ${tone} } }`).join("\n")}
`;
    const r = await render(yaml(probe), { profile: "print-mono", crop: "trim" });
    return sharp(r.pages[0].data).extract({ left: 25, top: 25, width: 550, height: 550 }).greyscale().raw().toBuffer();
  }
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
  it("keeps 600 dpi round screens at nominal density and limits 30-degree banding", async () => {
    const screens = [
      { lpi: 60, angle: 45 },
      { lpi: 60, angle: 30, maxTileSpread: 1.8 },
      { lpi: 85, angle: 45 },
      { lpi: 85, angle: 30, maxTileSpread: 1.1 },
    ];
    const probe = `mangacli: 1
meta: { title: Print probe, lang: en }
page: { size: B5, color: mono }
pages:
  - id: screens
    layout: { rows: [{cols: [1, 1]}, {cols: [1, 1]}] }
    panels:
${screens.map(({ lpi, angle }) => `      - background: { tone: { density: 35%, lpi: ${lpi}, angle: ${angle}deg } }`).join("\n")}
`;
    const r = await render(yaml(probe), { profile: "print-mono", crop: "marks" });
    const png = Buffer.from(r.pages[0].data);
    expect(png[24]).toBe(1);
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    for (const [i, { lpi, angle, maxTileSpread }] of screens.entries()) {
      const x0 = i % 2 ? 2857 : 1056;
      const y0 = i >= 2 ? 4171 : 1514;
      const tiles = new Uint16Array(400);
      let black = 0;
      for (let y = 0; y < 1000; y++) {
        for (let x = 0; x < 1000; x++) {
          if (data[(y0 + y) * info.width + x0 + x] === 0) {
            black++;
            tiles[Math.floor(y / 50) * 20 + Math.floor(x / 50)]++;
          }
        }
      }
      const label = `${lpi} LPI at ${angle} degrees`;
      expect(Math.abs(black / 10000 - 35), label).toBeLessThan(0.1);
      if (maxTileSpread !== undefined) {
        const tileSpread = (Math.max(...tiles) - Math.min(...tiles)) / 25;
        expect(tileSpread, label).toBeLessThan(maxTileSpread);
      }
    }
  }, 15000);
  it("nests lighter round tones inside darker tones across the midtone", async () => {
    const light = "{ density: 50%, lpi: 60, angle: 45deg }";
    const dark = "{ density: 50.1%, lpi: 60, angle: 45deg }";
    const [nested, darker] = await Promise.all([renderMonoToneLayers(light, dark), renderMonoToneLayers(dark)]);
    expect(nested.equals(darker)).toBe(true);
  });
  it("uses the same 1-bit round screen for uniform and graduated tone fills", async () => {
    const common = "density: 35%, lpi: 65, angle: 45deg";
    const [uniform, gradient] = await Promise.all([
      renderMonoToneLayers(`{ ${common} }`),
      renderMonoToneLayers(`{ ${common}, gradient: { stops: [[0%, 35%], [100%, 35%]] } }`),
    ]);
    expect(uniform.equals(gradient)).toBe(true);
  });
  it("keeps the 85 LPI, 30-degree midtone checker cells from merging along pixel edges", async () => {
    const tone = "density: 50%, lpi: 85, angle: 30deg";
    const [uniform, gradient] = await Promise.all([
      renderMonoToneLayers(`{ ${tone} }`),
      renderMonoToneLayers(`{ ${tone}, gradient: { stops: [[0%, 50%], [100%, 50%]] } }`),
    ]);
    expect(uniform.equals(gradient)).toBe(true);
    expect(Math.abs(uniform.filter(p => p === 0).length / uniform.length - 0.5)).toBeLessThan(0.001);
    const width = 550;
    const visited = new Uint8Array(uniform.length);
    let largest = 0;
    for (let i = 0; i < uniform.length; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const component = [i];
      for (let j = 0; j < component.length; j++) {
        const p = component[j];
        const col = p % width;
        for (const q of [col > 0 ? p - 1 : -1, col < width - 1 ? p + 1 : -1, p - width, p + width]) {
          if (q < 0 || q >= uniform.length || visited[q] || uniform[q] !== uniform[p]) continue;
          visited[q] = 1;
          component.push(q);
        }
      }
      largest = Math.max(largest, component.length);
    }
    expect(largest).toBeLessThan(32);
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
  it.each(["marks", "bleed", "trim"] as const)("preserves per-side PDF boxes with %s crop", async (crop) => {
    const source = "mangacli: 1\npage: { size: B5, bleed: 3mm }\npages:\n  - id: single\n    panels: [{}]\n  - id: spread\n    type: spread\n    panels: [{}]\n";
    for (const spread of ["split", "joined"] as const) {
      const r = await render(yaml(source), { profile: "print-mono", dpi: 254, format: "pdf", crop, spread });
      const pdf = Buffer.from(r.pages[0].data).toString("latin1");
      const pages = [...pdf.matchAll(/\/MediaBox \[([^\]]+)\] \/TrimBox \[([^\]]+)\] \/BleedBox \[([^\]]+)\]/g)];
      const images = [...pdf.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)];
      expect(pages).toHaveLength(spread === "split" ? 3 : 2);
      expect(images).toHaveLength(pages.length);
      const bleed = crop === "trim" ? 0 : 3;
      const outer = bleed + (crop === "marks" ? 10 : 0);
      pages.forEach((page, i) => {
        const media = page[1].split(" ").map(Number);
        const trim = page[2].split(" ").map(Number);
        const box = page[3].split(" ").map(Number);
        const width = spread === "joined" && i === 1 ? 364 : 182;
        const left = spread === "split" && i === 1 ? bleed : outer;
        const right = spread === "split" && i === 2 ? bleed : outer;
        const pt = (mm: number) => mm * 72 / 25.4;
        const expected = [left, outer, left + width, outer + 257];
        expected.forEach((v, j) => expect(trim[j]).toBeCloseTo(pt(v), 2));
        [left - bleed, outer - bleed, left + width + bleed, outer + 257 + bleed]
          .forEach((v, j) => expect(box[j]).toBeCloseTo(pt(v), 2));
        [0, 0, left + width + right, 257 + 2 * outer]
          .forEach((v, j) => expect(media[j]).toBeCloseTo(pt(v), 2));
        expect(media[2]).toBeCloseTo(Number(images[i][1]) * 72 / 254, 2);
        expect(media[3]).toBeCloseTo(Number(images[i][2]) * 72 / 254, 2);
      });
    }
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
