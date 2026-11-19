// Sogni へ画像の生成を流し続けるデーモン（既定は Relaxed）
//   node sample/tools/daemon.mjs            （sample/gen/queue/*.json を順に処理する）
//   while :; do node sample/tools/daemon.mjs; sleep 5; done   （接続が切れたら終了するので、ループで動かす）
// ジョブ: { out, model, prompt, negative?, w, h, steps?, guidance?, context?: [画像], seed? }（パスは sample/ から）
// 処理中は running/、終わると done/（失敗は failed/）へ移す。接続は 1 本（同じ appId の接続は 1 つまで）
import { readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SogniClient } from "@sogni-ai/sogni-client";
import { waitForImage } from "./result.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { SOGNI_API_KEY, SOGNI_APP_ID } = process.env;
if (!SOGNI_API_KEY || !SOGNI_APP_ID) throw new Error("Set SOGNI_API_KEY and SOGNI_APP_ID in the environment.");
const network = process.env.SOGNI_NETWORK ?? "relaxed";
if (network !== "relaxed" && network !== "fast") throw new Error("SOGNI_NETWORK must be relaxed or fast.");
const Q = join(root, "gen");
for (const d of ["queue", "running", "done", "failed"]) mkdirSync(join(Q, d), { recursive: true });
// a crashed run leaves jobs in running/: put them back
for (const f of readdirSync(join(Q, "running"))) renameSync(join(Q, "running", f), join(Q, "queue", f));
const CONC = +(process.env.CONC ?? 4);
const TIMEOUT = 45 * 60e3;
const log = (s) => { const line = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(line); appendFileSync(join(Q, "log.txt"), line + "\n"); };

const sogni = await SogniClient.createInstance({ appId: SOGNI_APP_ID, appSource: "mangacli-sample", network, apiKey: SOGNI_API_KEY });
await sogni.projects.waitForModels();
log("connected");

async function run(name) {
  const job = JSON.parse(readFileSync(join(Q, "running", name), "utf8"));
  const t0 = Date.now();
  try {
    const context = (job.context ?? []).map((f) => readFileSync(resolve(root, f)));
    const project = await sogni.projects.create({
      type: "image", modelId: job.model, positivePrompt: job.prompt, negativePrompt: job.negative,
      numberOfMedia: 1, steps: job.steps, guidance: job.guidance, seed: job.seed,
      sizePreset: "custom", width: job.w, height: job.h, outputFormat: "png", network,
      ...(context.length ? { contextImages: context } : {}),
    });
    let last = -1;
    project.on("progress", (pr) => { const b = Math.floor(pr / 25); if (b !== last) { last = b; log(`.. ${job.out} ${Math.round(pr)}% ${((Date.now() - t0) / 1000) | 0}s`); } });
    const url = await waitForImage(project, () => sogni.projects.getResult(project.id, { kind: "image" }), { timeout: TIMEOUT });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
    const img = Buffer.from(await response.arrayBuffer());
    const out = resolve(root, job.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, img);
    renameSync(join(Q, "running", name), join(Q, "done", name));
    log(`ok ${job.out} ${job.model} ${((Date.now() - t0) / 1000) | 0}s`);
  } catch (e) {
    const msg = e?.message ?? String(e);
    // a connection that went stale (long idle, or another client took the app id): put the job
    // back and exit so the wrapper loop reconnects
    if (/WebSocket|account changed|SWITCH_CONNECTION|not connected/i.test(msg)) {
      renameSync(join(Q, "running", name), join(Q, "queue", name));
      log(`RETRY ${job.out} ${msg}`);
      process.exit(3);
    }
    renameSync(join(Q, "running", name), join(Q, "failed", name));
    log(`FAIL ${job.out} ${job.model} ${msg}`);
  }
}

const active = new Set();
for (;;) {
  if (active.size < CONC) {
    const next = readdirSync(join(Q, "queue")).filter((f) => f.endsWith(".json")).sort()[0];
    if (next) {
      renameSync(join(Q, "queue", next), join(Q, "running", next));
      const p = run(next).finally(() => active.delete(p));
      active.add(p);
      continue;
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
}
