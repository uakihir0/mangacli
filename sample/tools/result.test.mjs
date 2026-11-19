import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForImage } from "./result.mjs";

const image = { status: "completed", jobs: [{ status: "completed", url: "https://example.test/image.png" }] };
const timings = { timeout: 250, checkAfter: 10, retryAfter: 10, progressDelay: 0 };

function project(completion = new Promise(() => {}), progress = 0) {
  return Object.assign(new EventEmitter(), { progress, resultUrls: [], waitForCompletion: () => completion });
}

test("uses a job URL already received before waiting for project completion", async () => {
  const job = project();
  job.resultUrls = [image.jobs[0].url];
  assert.equal(await waitForImage(job, () => assert.fail("unexpected HTTP lookup"), timings), image.jobs[0].url);
});

test("uses a job event without waiting for the project completion event", async () => {
  const job = project();
  const result = waitForImage(job, () => assert.fail("unexpected HTTP lookup"), timings);
  job.emit("jobCompleted", { resultUrl: image.jobs[0].url });
  assert.equal(await result, image.jobs[0].url);
  assert.equal(job.listenerCount("jobCompleted"), 0);
});

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

test("honors the SDK retry delay even when socket progress reaches 100%", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const job = project();
  let calls = 0;
  const result = waitForImage(job, async () => {
    if (++calls === 1) throw Object.assign(new Error("rate limited"), { retryAfter: 60 });
    return image;
  }, { ...timings, timeout: 120_000 });
  t.mock.timers.tick(timings.checkAfter);
  await Promise.resolve();
  job.emit("progress", 100);
  t.mock.timers.tick(59_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(await result, image.jobs[0].url);
  assert.equal(calls, 2);
});

test("cleans up when a result remains unavailable", async () => {
  const job = project();
  await assert.rejects(waitForImage(job, () => new Promise(() => {}), { ...timings, timeout: 30 }), /timeout/);
  assert.equal(job.listenerCount("progress"), 0);
});
