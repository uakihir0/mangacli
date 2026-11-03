// Builds catalog/fonts.json from pinned google/fonts commit (spec 7.3.10).
import * as hb from "harfbuzzjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT = "2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc";
const BASE = `https://raw.githubusercontent.com/google/fonts/${COMMIT}/ofl`;
const ENTRIES: { id: string; family: string; dir: string; files: Record<number, string>; variable?: boolean; copyright: string }[] = [
  { id: "zen-antique", family: "Zen Antique", dir: "zenantique", files: { 400: "ZenAntique-Regular.ttf" }, copyright: "Copyright 2021 The Zen Project Authors" },
  { id: "zen-kaku-gothic-new", family: "Zen Kaku Gothic New", dir: "zenkakugothicnew", files: { 400: "ZenKakuGothicNew-Regular.ttf", 500: "ZenKakuGothicNew-Medium.ttf", 700: "ZenKakuGothicNew-Bold.ttf", 900: "ZenKakuGothicNew-Black.ttf" }, copyright: "Copyright 2021 The Zen Project Authors" },
  { id: "shippori-mincho", family: "Shippori Mincho", dir: "shipporimincho", files: { 400: "ShipporiMincho-Regular.ttf", 500: "ShipporiMincho-Medium.ttf", 700: "ShipporiMincho-Bold.ttf" }, copyright: "Copyright 2020 The Shippori Mincho Project Authors" },
  { id: "dela-gothic-one", family: "Dela Gothic One", dir: "delagothicone", files: { 400: "DelaGothicOne-Regular.ttf" }, copyright: "Copyright 2020 The Dela Gothic One Project Authors" },
  { id: "zen-maru-gothic", family: "Zen Maru Gothic", dir: "zenmarugothic", files: { 500: "ZenMaruGothic-Medium.ttf", 700: "ZenMaruGothic-Bold.ttf", 900: "ZenMaruGothic-Black.ttf" }, copyright: "Copyright 2021 The Zen Project Authors" },
  { id: "rampart-one", family: "Rampart One", dir: "rampartone", files: { 400: "RampartOne-Regular.ttf" }, copyright: "Copyright 2021 The Rampart Project Authors" },
  { id: "yomogi", family: "Yomogi", dir: "yomogi", files: { 400: "Yomogi-Regular.ttf" }, copyright: "Copyright 2020 The Yomogi Project Authors" },
  { id: "klee-one", family: "Klee One", dir: "kleeone", files: { 400: "KleeOne-Regular.ttf", 600: "KleeOne-SemiBold.ttf" }, copyright: "Copyright 2020 The Klee Project Authors" },
  { id: "yusei-magic", family: "Yusei Magic", dir: "yuseimagic", files: { 400: "YuseiMagic-Regular.ttf" }, copyright: "Copyright 2020 The Yusei Magic Project Authors" },
  { id: "comic-neue", family: "Comic Neue", dir: "comicneue", files: { 400: "ComicNeue-Regular.ttf", 700: "ComicNeue-Bold.ttf" }, copyright: "Copyright 2014 The Comic Neue Project Authors" },
  { id: "bangers", family: "Bangers", dir: "bangers", files: { 400: "Bangers-Regular.ttf" }, copyright: "Copyright 2010 The Bangers Project Authors" },
  { id: "noto-sans-jp", family: "Noto Sans JP", dir: "notosansjp", files: { 400: "NotoSansJP[wght].ttf", 700: "NotoSansJP[wght].ttf" }, variable: true, copyright: "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'" },
];

const cache = ".cache/catalog-build";
mkdirSync(cache, { recursive: true });

async function fetchCached(url: string, name: string): Promise<Buffer> {
  const p = join(cache, name.replace(/[^\w.-]/g, "_"));
  if (existsSync(p)) return readFileSync(p);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(p, b);
  return b;
}

function ranges(cps: Uint32Array): [number, number][] {
  const s = Array.from(cps).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const c of s) {
    const last = out[out.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else if (!last || c > last[1]) out.push([c, c]);
  }
  return out;
}

const fonts: unknown[] = [];
const coverages: Record<string, string> = {};
function encodeRanges(r: [number, number][]): string {
  let prev = 0;
  return r.map(([a, b]) => { const s = (a - prev).toString(36) + (b > a ? ":" + (b - a).toString(36) : ""); prev = b; return s; }).join(",");
}
for (const e of ENTRIES) {
  const licUrl = `${BASE}/${e.dir}/OFL.txt`;
  const lic = await fetchCached(licUrl, `${e.dir}-OFL.txt`);
  for (const [w, file] of Object.entries(e.files)) {
    const url = `${BASE}/${e.dir}/${encodeURIComponent(file)}`;
    const data = await fetchCached(url, file);
    const face = new hb.Face(new hb.Blob(data));
    const cov = ranges(face.collectUnicodes());
    const vert = face.getTableFeatureTags("GSUB").includes("vert");
    fonts.push({
      id: e.id,
      family: e.family,
      weight: Number(w),
      file,
      url,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
      variations: e.variable ? { wght: Number(w) } : undefined,
      vertical: vert,
      license: { id: "OFL-1.1", url: licUrl, sha256: createHash("sha256").update(lic).digest("hex"), copyright: e.copyright },
      coverage: e.id,
      revision: 1,
    });
    coverages[e.id] = encodeRanges(cov);
    console.log(e.id, w, data.length, "ranges", cov.length, "vert", vert);
  }
}

const catalog = {
  version: 1,
  source: { repository: "https://github.com/google/fonts", commit: COMMIT },
  allowedHosts: ["raw.githubusercontent.com", "github.com", "objects.githubusercontent.com"],
  fonts,
  coverage: coverages,
  sets: {
    "manga-basic": {
      dialogue: { compose: [{ font: "zen-antique@400", ranges: ["kana", "punct"] }, { font: "zen-kaku-gothic-new@700" }], fallback: ["noto-sans-jp@700"] },
      thought: "dialogue",
      whisper: "dialogue",
      narration: { font: "shippori-mincho@500", fallback: ["noto-sans-jp@400"] },
      shout: { font: "dela-gothic-one@400", fallback: ["noto-sans-jp@700"] },
      sfx: { font: "dela-gothic-one@400", fallback: ["noto-sans-jp@700"] },
      hand: { font: "yomogi@400", fallback: ["noto-sans-jp@400"] },
      title: { font: "zen-maru-gothic@900", fallback: ["noto-sans-jp@700"] },
    },
    // western comic lettering (spec 7.3.10): used by default for documents whose language is not CJK
    "comic-basic": {
      dialogue: { font: "comic-neue@700", fallback: ["noto-sans-jp@700"] },
      thought: "dialogue",
      whisper: "dialogue",
      narration: { font: "comic-neue@400", fallback: ["noto-sans-jp@400"] },
      shout: { font: "bangers@400", fallback: ["noto-sans-jp@700"] },
      sfx: { font: "bangers@400", fallback: ["noto-sans-jp@700"] },
      hand: { font: "comic-neue@400", fallback: ["noto-sans-jp@400"] },
      title: { font: "bangers@400", fallback: ["noto-sans-jp@700"] },
    },
  },
};
mkdirSync("catalog", { recursive: true });
writeFileSync("catalog/fonts.json", JSON.stringify(catalog));
console.log("written", fonts.length);
