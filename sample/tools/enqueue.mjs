// spec のコマをジョブとして sample/gen/queue/ に積む
//   node sample/tools/enqueue.mjs <spec.json> [id...] [--n 3] [--force]
// spec: { style, negative?（コマの style にキーを書くとその文体を使う）, model, editModel?, steps?, guidance?, <キャラクター>: 説明, refs?: { <キャラクター>: 画像 },
//         panels: [{ id, w, h, chars, prompt, model?, context?, steps?, guidance? }] }
// 出力は spec と同じフォルダ。--n が 2 以上なら候補 <id>.<k>.png を作る（既にあるものは飛ばす）
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const n = +opt("--n", "1");
const force = flag("--force");
const specPath = resolve(argv.shift());
const only = new Set(argv);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const dir = dirname(specPath);
const Q = join(root, "gen", "queue");
mkdirSync(Q, { recursive: true });
const pending = new Set(["queue", "running"].flatMap((d) => existsSync(join(root, "gen", d)) ? readdirSync(join(root, "gen", d)).map((f) => JSON.parse(readFileSync(join(root, "gen", d, f), "utf8")).out) : []));
let count = 0;
for (const p of spec.panels) {
  if (only.size && !only.has(p.id)) continue;
  const chars = p.chars ?? [];
  const context = (p.context ?? chars.map((c) => spec.refs?.[c]).filter(Boolean)).map((f) => relative(root, resolve(dir, f)));
  const model = p.model ?? (context.length ? spec.editModel ?? spec.model : spec.model);
  for (let k = 1; k <= n; k++) {
    const out = relative(root, join(dir, n > 1 ? `${p.id}.${k}.png` : `${p.id}.png`));
    if ((!force && existsSync(join(root, out))) || pending.has(out)) continue;
    const job = {
      out, model, w: p.w, h: p.h, steps: p.steps ?? spec.steps, guidance: p.guidance ?? spec.guidance,
      prompt: [p.style ? spec[p.style] : spec.style, ...chars.map((c) => spec[c]), p.prompt].filter(Boolean).join(" "),
      negative: p.negative ?? spec.negative, ...(context.length ? { context } : {}),
    };
    writeFileSync(join(Q, `${Date.now()}-${String(count).padStart(3, "0")}-${p.id}.${k}.json`), JSON.stringify(job, null, 1));
    count++;
  }
}
console.log(`queued ${count}`);
