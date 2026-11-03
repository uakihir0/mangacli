// Worker for `render --concurrency`: renders a subset of the pages and reports back (spec 2.10).
import { parentPort, workerData } from "node:worker_threads";
import { type RenderOptions, render } from "../api.js";
import { loadConfig } from "../config.js";

type Obj = Record<string, unknown>;

const { input, opts, configPath } = workerData as { input: unknown; opts: RenderOptions; configPath?: string };
const config = configPath ? ((await loadConfig(configPath)) as unknown as Obj) : undefined;
const r = await render(input as string, {
  ...opts,
  config,
  throwOnError: false,
  onProgress: (e) => parentPort?.postMessage({ type: "progress", e }),
});
parentPort?.postMessage({
  type: "done",
  files: r.files,
  pages: r.pages.map((p) => ({ id: p.id, path: p.path, width: p.width, height: p.height, format: p.format })),
  diagnostics: r.diagnostics,
  failures: r.failures.map((f) => ({ pageId: f.pageId, index: f.index, message: f.error.message })),
  timings: r.timings,
});
