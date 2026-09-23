import assert from "node:assert/strict";
import test from "node:test";
import { createSerialQueue, runRepeatedAction } from "../src/serial-queue.mjs";

test("concurrent browser operations run FIFO without interleaving action batches", async () => {
  const enqueue = createSerialQueue();
  const events = [];
  const firstBatch = enqueue(async () => {
    events.push("batch-1-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("batch-1-second-click");
  });
  const secondCall = enqueue(async () => {
    events.push("keyboard-press");
  });
  const thirdBatch = enqueue(async () => {
    events.push("batch-2-start");
    events.push("batch-2-second-key");
  });

  await Promise.all([firstBatch, secondCall, thirdBatch]);
  assert.deepEqual(events, [
    "batch-1-start",
    "batch-1-second-click",
    "keyboard-press",
    "batch-2-start",
    "batch-2-second-key",
  ]);
});

test("a failed browser operation does not block later input", async () => {
  const enqueue = createSerialQueue();
  const events = [];
  const failed = enqueue(async () => {
    events.push("failed-action");
    throw new Error("simulated input failure");
  });
  const recovered = enqueue(async () => {
    events.push("next-action");
    return "ok";
  });

  await assert.rejects(failed, /simulated input failure/);
  assert.equal(await recovered, "ok");
  assert.deepEqual(events, ["failed-action", "next-action"]);
});

test("repeated actions execute each click/key press in order", async () => {
  const events = [];
  await runRepeatedAction(5, 0, async (index) => events.push(`press-${index + 1}`));
  assert.deepEqual(events, ["press-1", "press-2", "press-3", "press-4", "press-5"]);
});

test("a repeat failure reports the failing repetition and stops the batch", async () => {
  const events = [];
  await assert.rejects(
    runRepeatedAction(5, 0, async (index) => {
      events.push(index + 1);
      if (index === 2) throw new Error("simulated click failure");
    }),
    (error) => error.message === "simulated click failure" && error.repeatIndex === 3,
  );
  assert.deepEqual(events, [1, 2, 3]);
});
