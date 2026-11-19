import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForImage } from "./result.mjs";

const image = { status: "completed", jobs: [{ status: "completed", url: "https://example.test/image.png" }] };
const timings = { timeout: 250, checkAfter: 10, retryAfter: 10, progressDelay: 0 };

function project(completion = new Promise(() => {}), progress = 0) {
  return Object.assign(new EventEmitter(), { progress, waitForCompletion: () => completion });
}

test("uses the socket without an HTTP lookup when the result arrives", async () => {
  const job = project(Promise.resolve([image.jobs[0].url]));
  assert.equal(await waitForImage(job, () => assert.fail("unexpected HTTP lookup"), timings), image.jobs[0].url);
  assert.equal(job.listenerCount("progress"), 0);
});

test("recovers a missed result even if persistence is delayed", async () => {
  let calls = 0;
  const job = project(undefined, 100);
  assert.equal(await waitForImage(job, async () => {
    if (++calls === 1) throw new Error("not persisted");
    return image;
  }, timings), image.jobs[0].url);
  assert.equal(calls, 2);
  assert.equal(job.listenerCount("progress"), 0);
});

test("looks up a completed result when the socket omits its URL", async () => {
  assert.equal(await waitForImage(project(Promise.resolve([])), async () => image, timings), image.jobs[0].url);
});

test("reports a terminal REST failure", async () => {
  await assert.rejects(waitForImage(project(), async () => ({ status: "failed", jobs: [], failure: { message: "generation failed" } }), timings), /generation failed/);
});

test("cleans up when a result remains unavailable", async () => {
  const job = project();
  await assert.rejects(waitForImage(job, () => new Promise(() => {}), { ...timings, timeout: 30 }), /timeout/);
  assert.equal(job.listenerCount("progress"), 0);
});
