// Files a document depends on, for `watch` and `preview` (spec 12.3.4–12.3.5).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EXT = "ya?ml|json|png|jpe?g|webp|avif|tiff?|svg|ttf|otf|ttc|otc|woff2?";
const VALUE = String.raw`["']?([^\s"',}\]#]+\.(?:${EXT}))["']?`;
const KEYED = new RegExp(String.raw`(?:^|[\s,{[])(?:[\w-]+|"[^"\n]*"|'[^'\n]*')\s*:\s*${VALUE}`, "gim");
const LISTED = new RegExp(String.raw`^\s*-\s+${VALUE}\s*$`, "gim");
const REMOTE = /^(?:[a-z][\w+.-]*:\/\/|data:|catalog:)/i;
const COMMENT = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*')|(^|\s)#.*$/gm;

/** Every file referenced by `entry` (imports, includes, assets, inline images, fonts), including ones that do not exist yet. */
export function collectDeps(entry: string): string[] {
  const out = new Set<string>();
  const visit = (f: string, depth: number) => {
    if (depth > 8 || out.has(f)) return;
    out.add(f);
    if (!/\.(?:ya?ml|json)$/i.test(f) || !existsSync(f)) return;
    const text = readFileSync(f, "utf8").replace(COMMENT, (_, quoted: string | undefined, lead: string | undefined) => quoted ?? lead ?? "");
    const base = dirname(f);
    for (const re of [KEYED, LISTED]) {
      for (const m of text.matchAll(re)) if (!REMOTE.test(m[1])) visit(resolve(base, m[1]), depth + 1);
    }
  };
  visit(entry, 0);
  return [...out];
}
