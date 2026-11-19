import { execFile } from "node:child_process";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fontFile = /\.(ttf|otf|ttc|otc)$/i;
const sfntTags = new Set(["\x00\x01\x00\x00", "OTTO", "true"]);

export interface SystemFontFace {
  path: string;
  index: number;
  families: string[];
  fullNames: string[];
  postScriptNames: string[];
  regular: boolean;
}

async function fontFilesIn(roots: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  const visit = async (dir: string) => {
    try {
      const canonical = await realpath(dir);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if ((entry.isFile() || entry.isSymbolicLink()) && fontFile.test(entry.name)) files.push(path);
      }
    } catch {
      // The directory may not exist or be readable for this user.
    }
  };
  for (const dir of roots) await visit(dir);
  return files;
}

async function installedFontFiles(): Promise<string[]> {
  if (process.platform === "linux") {
    try {
      const { stdout } = await exec("fc-list", ["-f", "%{file}\\n"], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
      return stdout.split("\n").filter((path) => isAbsolute(path) && fontFile.test(path));
    } catch {
      return [];
    }
  }
  if (process.platform === "darwin") return fontFilesIn([join(homedir(), "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts"]);
  if (process.platform === "win32") {
    const { LOCALAPPDATA, WINDIR, SystemRoot } = process.env;
    return fontFilesIn([
      join(LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
      join(WINDIR || SystemRoot || "C:\\Windows", "Fonts"),
    ]);
  }
  return [];
}

async function read(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const { bytesRead } = await file.read(buf, n, length - n, offset + n);
    if (!bytesRead) throw new Error("truncated font table");
    n += bytesRead;
  }
  return buf;
}

function parseNames(table: Buffer) {
  const names = new Map<number, Set<string>>();
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  if (storage < 6 + count * 12 || storage > table.length) return names;
  for (let i = 0; i < count; i++) {
    const pos = 6 + i * 12;
    const platform = table.readUInt16BE(pos);
    const encoding = table.readUInt16BE(pos + 2);
    const id = table.readUInt16BE(pos + 6);
    if (![1, 2, 4, 6, 16, 17, 21, 22].includes(id)) continue;
    const len = table.readUInt16BE(pos + 8);
    const off = storage + table.readUInt16BE(pos + 10);
    if (off + len > table.length) continue;
    const codec = platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding)) ? "utf-16be"
      : platform === 3 && encoding === 2 ? "shift_jis"
      : platform === 1 && encoding === 0 ? "macintosh"
      : undefined;
    if (!codec) continue;
    let name: string;
    try {
      name = new TextDecoder(codec, { fatal: true }).decode(table.subarray(off, off + len)).trim();
    } catch {
      continue;
    }
    if (!name || /[\x00-\x1f\x7f]/.test(name)) continue;
    if (!names.has(id)) names.set(id, new Set());
    names.get(id)!.add(name);
  }
  return names;
}

/** Read only directories and name tables, not the outlines (CJK collections can be large). */
export async function readSystemFontFaces(path: string): Promise<SystemFontFace[]> {
  const faces: SystemFontFace[] = [];
  try {
    const file = await open(path);
    try {
      const head = await read(file, 0, 12);
      let offsets = [0];
      if (head.toString("ascii", 0, 4) === "ttcf") {
        const count = head.readUInt32BE(8);
        if (count > 0x10000) return [];
        const directory = await read(file, 12, count * 4);
        offsets = Array.from({ length: count }, (_, i) => directory.readUInt32BE(i * 4));
      }
      for (const [index, offset] of offsets.entries()) {
        try {
          const header = offset === 0 ? head : await read(file, offset, 12);
          if (!sfntTags.has(header.toString("latin1", 0, 4))) continue;
          const tables = await read(file, offset + 12, header.readUInt16BE(4) * 16);
          for (let pos = 0; pos < tables.length; pos += 16) {
            if (tables.toString("latin1", pos, pos + 4) !== "name") continue;
            const length = tables.readUInt32BE(pos + 12);
            if (length >= 6 && length <= 1024 * 1024) {
              const names = parseNames(await read(file, tables.readUInt32BE(pos + 8), length));
              const get = (...ids: number[]) => [...new Set(ids.flatMap((id) => [...(names.get(id) ?? [])]))];
              const families = get(16, 1, 21), fullNames = get(4), postScriptNames = get(6);
              const modernStyles = get(17, 22);
              const regular = (modernStyles.length ? modernStyles : get(2)).some((name) => /^(regular|normal|roman|book|標準)$/i.test(name));
              if (families.length || fullNames.length || postScriptNames.length)
                faces.push({ path, index, families, fullNames, postScriptNames, regular });
            }
            break;
          }
        } catch {
          // A broken face need not hide the rest of the collection.
        }
      }
    } finally {
      await file.close();
    }
  } catch {
    // Fonts can be removed or inaccessible between enumeration and reading.
  }
  return faces;
}

export async function listSystemFonts(): Promise<SystemFontFace[]> {
  const files = [...new Set(await installedFontFiles())];
  if (process.platform === "linux") files.sort();
  const faces: SystemFontFace[] = [];
  for (const path of files) faces.push(...await readSystemFontFaces(path));
  return faces;
}

const normalizedName = (value: string) => value.trim().normalize("NFC").toLowerCase();

export function findSystemFont(faces: SystemFontFace[], name: string, index?: number): SystemFontFace | undefined {
  const query = normalizedName(name);
  const matches = (names: string[]) => names.some((value) => normalizedName(value) === query);
  let best: SystemFontFace | undefined;
  let bestScore = 0;
  for (const face of faces) {
    if (index !== undefined && face.index !== index) continue;
    const priority = matches(face.postScriptNames) ? 3 : matches(face.fullNames) ? 2 : matches(face.families) ? 1 : 0;
    if (!priority) continue;
    const score = priority * 2 + (face.regular ? 1 : 0);
    if (score > bestScore) {
      best = face;
      bestScore = score;
    }
  }
  return best;
}
