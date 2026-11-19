import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Update visual baselines on Linux x64 so PNG hashes are reproducible.");
}
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "test/visual-regression.test.ts",
], { stdio: "inherit", env: { ...process.env, UPDATE_VISUAL_BASELINES: "1" } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
