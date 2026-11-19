import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { type PdfXOptions, type RenderOptions, render } from "../src/index.js";
import { PdfWriter } from "../src/output/pdf.js";

// Minimal ICC header and tag table for testing embedding and header validation,
// not an actual printer profile.
function icc(major = 2, color = "CMYK"): Buffer {
  const b = Buffer.alloc(152);
  b.writeUInt32BE(b.length);
  b[8] = major;
  b.write(`prtr${color}Lab `, 12);
  b.write("acsp", 36);
  b.writeUInt32BE(1, 128);
  b.write("test", 132);
  b.writeUInt32BE(144, 136);
  b.writeUInt32BE(8, 140);
  return b;
}

const pdfX: PdfXOptions = { version: "4", iccProfile: icc(), outputCondition: "Printer (coated) \\ standard" };
const source = `mangacli: 1
meta: { title: "漫画 & <Ink> 🎨", author: "作家 > test" }
page: { size: [40mm, 50mm], bleed: 3mm }
pages:
  - id: single
    panels: [{}]
  - id: spread
    type: spread
    panels: [{}]
`;
const options = { format: "pdf", profile: "print-mono", crop: "marks", spread: "split", dpi: 254 } as const;
const getPdf = async (overrides: RenderOptions = {}) => {
  const r = await render({ yaml: source }, { ...options, ...overrides });
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(r.pages).toHaveLength(1);
  return Buffer.from(r.pages[0].data).toString("latin1");
};

function stream(pdf: string, pattern: RegExp): Buffer {
  const m = pattern.exec(pdf);
  expect(m).not.toBeNull();
  const start = m!.index + m![0].length;
  return Buffer.from(pdf.slice(start, start + Number(m![1])), "latin1");
}

describe("PDF/X", () => {
  it.each([["1a", "1.3"], ["4", "1.6"]] as const)("writes PDF/X-%s with an embedded CMYK intent and unchanged page streams/boxes", async (version, syntax) => {
    const plain = await getPdf();
    const pdf = await getPdf({ pdfX: { ...pdfX, version } });
    expect(plain).not.toMatch(/\/OutputIntents|\/GTS_PDFX|\/Metadata/);
    expect(pdf.startsWith(`%PDF-${syntax}\n`)).toBe(true);
    expect(pdf).toMatch(/\/Type \/Catalog \/Pages 2 0 R \/OutputIntents \[\d+ 0 R\]/);
    expect(pdf).toMatch(/\/Type \/OutputIntent \/S \/GTS_PDFX \/OutputConditionIdentifier \(Custom\)/);
    expect(pdf).toContain(String.raw`/Info (Printer \(coated\) \\ standard)`);
    const profile = stream(pdf, /\/N 4 \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/);
    expect(inflateSync(profile).equals(icc())).toBe(true);
    expect(pdf).toMatch(/\/ID \[<[a-f0-9]{32}><[a-f0-9]{32}>\]/);
    expect(pdf).toContain("/Trapped /False");
    const pageBoxes = /\/MediaBox \[[^\]]+\] \/TrimBox \[[^\]]+\] \/BleedBox \[[^\]]+\]/g;
    expect(pdf.match(pageBoxes)).toHaveLength(3);
    expect(pdf.match(pageBoxes)).toEqual(plain.match(pageBoxes));
    const rasterData = (s: string, colorSpace: string) => [...s.matchAll(/\/Width \d+ \/Height \d+ \/ColorSpace (.*?) \/BitsPerComponent 1 \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g)].map((m) => {
      expect(m[1]).toBe(colorSpace);
      const start = m.index + m[0].length;
      return inflateSync(Buffer.from(s.slice(start, start + Number(m[2])), "latin1"));
    });
    const rasters = rasterData(pdf, "[/Indexed /DeviceCMYK 1 <000000FF00000000>]");
    expect(rasters).toHaveLength(3);
    expect(rasters).toEqual(rasterData(plain, "/DeviceGray"));
    expect(pdf).not.toContain("/SMask");
    if (version === "1a") {
      expect(pdf).toContain("/GTS_PDFXVersion (PDF/X-1:2001) /GTS_PDFXConformance (PDF/X-1a:2001)");
      expect(pdf).not.toContain("/Metadata");
    } else {
      const xmp = stream(pdf, /\/Type \/Metadata \/Subtype \/XML \/Length (\d+) >>\nstream\n/).toString("utf8");
      expect(xmp).toContain('xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"');
      expect(xmp).toContain("<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>");
      expect(xmp).toContain("漫画 &amp; &lt;Ink&gt; 🎨");
      expect(xmp).toContain("作家 &gt; test");
    }
  });

  it("supports ICC v4 in PDF/X-4 and synchronizes deterministic timestamps", async () => {
    vi.stubEnv("SOURCE_DATE_EPOCH", "1700000000");
    try {
      const opts = { pdfX: { ...pdfX, iccProfile: icc(4) } };
      const pdf = await getPdf(opts);
      expect(pdf).toContain("/CreationDate (D:20231114221320Z) /ModDate (D:20231114221320Z)");
      expect(pdf).toContain("<xmp:CreateDate>2023-11-14T22:13:20.000Z</xmp:CreateDate>");
      expect(await getPdf(opts)).toBe(pdf);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["wrong format", { format: "png" }, /requires PDF output/],
    ["wrong color mode", { colorMode: "color" }, /opaque 1-bit monochrome/],
    ["debug", { debug: true }, /debug overlays/],
    ["transparent", { background: "transparent" }, /opaque 1-bit monochrome/],
    ["separations", { separate: "all" }, /without separations/],
    ["missing name", { pdfX: { ...pdfX, outputCondition: " " } }, /requires an output condition/],
    ["bad ICC", { pdfX: { ...pdfX, iccProfile: Buffer.from("invalid") } }, /valid CMYK printer ICC/],
    ["RGB ICC", { pdfX: { ...pdfX, iccProfile: icc(2, "RGB ") } }, /valid CMYK printer ICC/],
    ["ICC v4 for 1a", { pdfX: { ...pdfX, version: "1a", iccProfile: icc(4) } }, /requires an ICC v2/],
  ] satisfies [string, RenderOptions, RegExp][])("refuses %s without emitting a PDF", async (_title, overrides, message) => {
    const r = await render({ yaml: source }, { ...options, pdfX, ...overrides, throwOnError: false });
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "OUTPUT_MODE_UNSUPPORTED", message: expect.stringMatching(message) }));
    expect(r.pages).toEqual([]);
  });

  it("does not emit a partial submission document after a page fails", async () => {
    const r = await render({ yaml: source.replace("type: spread", "type: spread\n    size: [80mm, 50mm]") }, { ...options, pdfX, crop: "trim", limits: { maxOutputBytes: 40 * 1024 * 1024 }, throwOnError: false });
    expect(r.failures.map((f) => f.pageId)).toEqual(["spread", "spread"]);
    expect(r.pages).toEqual([]);
  });

  it("bounds rounded bleed by the raster without changing trim", () => {
    const w = new PdfWriter({}, { ...pdfX, iccProfile: icc() });
    w.addPage({ width: 9, height: 10, rgba: new Uint8ClampedArray(9 * 10 * 4).fill(255), colorMode: "mono", dpi: 72,
      trim: { x: 1, y: 1, w: 7, h: 8 }, bleed: { x: -1, y: 0, w: 11, h: 10 } });
    expect(w.build().toString("latin1")).toContain("/MediaBox [0 0 9 10] /TrimBox [1 1 8 9] /BleedBox [0 0 9 10]");
  });

  it("accepts CLI PDF/X arguments, including when the PDF format comes from YAML", () => {
    const root = join(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "mc-pdfx-"));
    try {
      const doc = join(dir, "input.yaml");
      const profile = join(dir, "test.icc");
      const output = join(dir, "input.pdf");
      writeFileSync(doc, source + "output: { format: pdf }\n");
      writeFileSync(profile, icc());
      const cli = (...args: string[]) => spawnSync(join(root, "node_modules/.bin/tsx"), [
        join(root, "src/cli/index.ts"), "render", doc, "--no-config", "-o", dir, "-p", "print-mono", "--dpi", "100", "--concurrency", "2", ...args,
      ], { cwd: root, encoding: "utf8" });
      expect(cli("--pdf-x", "4").status).toBe(3);
      expect(existsSync(output)).toBe(false);
      const result = cli("--pdf-x", "4", "--pdf-x-icc", profile, "--pdf-x-condition", "0007");
      expect(result.status, result.stderr).toBe(0);
      const pdf = readFileSync(output, "latin1");
      expect(pdf).toMatch(/\/Count 3\b/);
      expect(pdf).toContain("/Info (0007)");
      expect(pdf).toContain("<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
