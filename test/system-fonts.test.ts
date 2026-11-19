import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { stringify as yaml } from "yaml";
import { render, validate } from "../src/api.js";
import { findSystemFont, readSystemFontFaces } from "../src/fonts/system.js";

const manga = (font: Record<string, unknown>) => ({
  mangacli: 1,
  fontSet: "none",
  book: { pageNumbers: { enabled: false } },
  page: { size: ["55mm", "45mm"], bleed: 0, baseFrame: "trim" },
  fonts: { lettering: font },
  pages: [{ layers: [{ text: "写植の見本。", font: "lettering", fontSize: "5mm", at: ["50%", "50%"] }] }],
});
const options = { dpi: 144, fontDownload: "never" } as const;

async function writeNamedFont(path: string, records: { id: number; language: number; name: string }[]) {
  const strings = records.map(({ name }) => Buffer.from(name, "utf16le").swap16());
  const storage = 6 + records.length * 12;
  const name = Buffer.alloc(storage);
  name.writeUInt16BE(records.length, 2);
  name.writeUInt16BE(storage, 4);
  let offset = 0;
  records.forEach(({ id, language }, i) => {
    const record = 6 + i * 12;
    [3, 1, language, id, strings[i].length, offset].forEach((n, j) => name.writeUInt16BE(n, record + j * 2));
    offset += strings[i].length;
  });
  const sfnt = Buffer.alloc(28);
  sfnt.write("OTTO");
  sfnt.writeUInt16BE(1, 4);
  sfnt.write("name", 12);
  sfnt.writeUInt32BE(sfnt.length, 20);
  sfnt.writeUInt32BE(storage + offset, 24);
  await writeFile(path, Buffer.concat([sfnt, name, ...strings]));
}

it("reads localized Unicode names and resolves normalized family and PostScript names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-font-"));
  try {
    const path = join(dir, "names.otf");
    await writeNamedFont(path, [
      { id: 1, language: 0x0409, name: "Example Gothic" },
      { id: 1, language: 0x0411, name: "見本ゴシック" },
      { id: 2, language: 0x0409, name: "Regular" },
      { id: 6, language: 0x0409, name: "ExampleGothic-Regular" },
    ]);
    const faces = await readSystemFontFaces(path);
    expect(faces).toMatchObject([{ families: ["Example Gothic", "見本ゴシック"], index: 0, regular: true }]);
    expect(findSystemFont(faces, "見本ゴシック")).toBe(faces[0]);
    expect(findSystemFont(faces, "examplegothic-regular", 0)).toBe(faces[0]);
    expect(findSystemFont(faces, "Example Gothic", 1)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("prefers the regular family face over a heavier face with a legacy Regular subfamily", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-font-"));
  try {
    const heavy = join(dir, "ExtraBold.otf"), regular = join(dir, "Regular.otf");
    const name = (id: number, name: string) => ({ id, language: 0x0409, name });
    await writeNamedFont(heavy, [name(1, "Example Gothic ExtraBold"), name(2, "Regular"), name(16, "Example Gothic"), name(17, "ExtraBold")]);
    await writeNamedFont(regular, [name(1, "Example Gothic"), name(2, "Regular")]);
    const faces = [...await readSystemFontFaces(heavy), ...await readSystemFontFaces(regular)];
    expect(findSystemFont(faces, "Example Gothic")?.path).toBe(regular);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports an unresolved system font as an error", async () => {
  const result = await validate(manga({ system: "Mangacli Missing Font 002cf333" }), { ...options, diagnostics: { FONT_NOT_FOUND: "off" } });
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "FONT_NOT_FOUND", severity: "error", message: expect.stringContaining("Mangacli Missing Font") }),
  ]));
  expect(result.diagnostics.some(({ code }) => code === "FONT_SYSTEM_USED")).toBe(false);
});

describe.runIf(process.env.MANGACLI_TEST_SYSTEM_FONTS === "1")("installed Linux Noto CJK", () => {
  it("renders Japanese by family name using the regular CFF face", async () => {
    const result = await render(manga({ system: "Noto Sans CJK JP" }), { ...options, format: "png" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FONT_SYSTEM_USED", severity: "info", message: expect.stringContaining("NotoSansCJKjp-Regular") }),
    ]));
    expect(result.layout[0].text[0]).toMatchObject({ fonts: ["NotoSansCJKjp-Regular"], missing: [] });
    expect(result.pages[0].data.byteLength).toBeGreaterThan(1000);
  });

  it("lists collection faces and renders the nonzero face by PostScript name and index", async () => {
    const postScript = "NotoSansCJKsc-Regular";
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "fonts", "list", "--system", "--json"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    const rows = output.trim().split("\n").map((line) => JSON.parse(line));
    const face = rows.find((row) => row.postScriptNames.includes(postScript));
    expect(face).toMatchObject({ source: "system", index: 2, families: ["Noto Sans CJK SC"], path: expect.stringMatching(/\.ttc$/i) });
    const result = await render(manga({ system: postScript, index: face.index }), { ...options, format: "png" });
    const fromFile = await render(manga({ src: face.path, index: face.index }), { ...options, format: "png" });
    expect(result.layout[0].text[0]).toMatchObject({ fonts: [postScript], missing: [] });
    const pixels = (data: Uint8Array) => sharp(data).raw().toBuffer();
    expect(await pixels(result.pages[0].data)).toEqual(await pixels(fromFile.pages[0].data));
    const missing = await validate(manga({ system: postScript, index: 0 }), options);
    expect(missing.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FONT_NOT_FOUND" })]));
  });

  it("watch re-renders when a system font used by parallel workers changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-font-watch-"));
    const root = join(import.meta.dirname, "..");
    const fontDir = join(dir, "fonts");
    const path = join(fontDir, "Lato-Regular.ttf");
    const config = join(dir, "fonts.conf");
    const document = join(dir, "manga.yaml");
    await mkdir(fontDir);
    await copyFile(join(root, "assets/fonts/Lato-Regular.ttf"), path);
    await writeFile(config, `<fontconfig><dir>${fontDir}</dir><cachedir>${join(dir, "cache")}</cachedir></fontconfig>`);
    const doc = manga({ system: "Lato-Regular" });
    const page = { layers: [{ text: "Lettering", font: "lettering", fontSize: "5mm", at: ["50%", "50%"], writing: "horizontal" }] };
    await writeFile(document, yaml({ ...doc, pages: [page, { layers: [{ ...page.layers[0], text: "Page two" }] }] }));
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "watch", document, "--out", join(dir, "out"), "--concurrency", "2", "--no-config", "--no-download", "--json"], {
      cwd: root,
      env: { ...process.env, FONTCONFIG_FILE: config },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    const waitForRenders = async (count: number) => {
      for (let i = 0; i < 160 && child.exitCode === null; i++) {
        if ((output.match(/"type":"result"/g) ?? []).length >= count) return;
        await delay(100);
      }
      throw new Error(`Expected ${count} watch render(s):\n${output}\n${errors}`);
    };
    try {
      await waitForRenders(1);
      expect(output).toContain('"code":"FONT_SYSTEM_USED"');
      const later = new Date(Date.now() + 2000);
      await utimes(path, later, later);
      await waitForRenders(2);
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
