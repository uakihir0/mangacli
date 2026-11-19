import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("terminates for zero and non-positive dash steps on open and closed contours", async () => {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { inkShape } from "./src/ink/shape.ts";
    import { HAND_PRESETS, PEN_PRESETS } from "./src/ink/presets.ts";
    import { Rng } from "./src/core/random.ts";
    for (const closed of [false, true]) {
      for (const dash of [[0, 0], [-1, -1], [0, 2], [2, 0], [-1, 2], [2, -1], [2, 2]]) {
        const result = inkShape({ pts: [{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}], closed }, {
          hand: HAND_PRESETS.clean, rng: new Rng(42),
          line: { width: 0.3, pen: PEN_PRESETS["g-pen"], style: "dashed", dash },
        });
        if (!result.inks.length || result.inks.some(k => k.pts.some(p => !Number.isFinite(p.x + p.y)))) throw new Error("invalid ink");
      }
    }
    console.log("all dash patterns completed");
  `], { cwd: new URL("..", import.meta.url), timeout: 3000, killSignal: "SIGKILL" });
  expect(stdout.trim()).toBe("all dash patterns completed");
}, 5000);
