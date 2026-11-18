import { test } from "node:test";
import assert from "node:assert/strict";
import { followRun } from "./ask-run";

class Dropped extends Error {}
const opts = { dropped: (e: unknown) => e instanceof Dropped, wait: async () => undefined, ready: async () => undefined };

test("a dropped connection is tried again until the reply comes", async () => {
  let n = 0;
  const reply = await followRun(async () => {
    if (++n < 3) throw new Dropped();
    return "done";
  }, opts);
  assert.equal(reply, "done");
  assert.equal(n, 3);
});

test("an answer from the server (an error) isn't tried again", async () => {
  let n = 0;
  await assert.rejects(
    followRun(async () => {
      n++;
      throw new Error("429");
    }, opts),
    /429/,
  );
  assert.equal(n, 1);
});

test("it gives up after six tries in a row that hear nothing, but a try that heard the server starts the count again", async () => {
  let n = 0;
  await assert.rejects(followRun(async () => {
    n++;
    throw new Dropped();
  }, opts), Dropped);
  assert.equal(n, 6);

  n = 0;
  const reply = await followRun(async (heard) => {
    n++;
    // A long run on a flaky connection: every try gets a little further.
    if (n < 20) {
      heard();
      throw new Dropped();
    }
    return "done";
  }, opts);
  assert.equal(reply, "done");
});

test("Stop ends it at once, without another try", async () => {
  const stop = new AbortController();
  let n = 0;
  await assert.rejects(
    followRun(async () => {
      n++;
      stop.abort();
      throw new Dropped();
    }, { ...opts, signal: stop.signal }),
  );
  assert.equal(n, 1);
});

test("it waits to be online and on screen before trying again", async () => {
  const order: string[] = [];
  let n = 0;
  await followRun(async () => {
    order.push("try");
    if (++n < 2) throw new Dropped();
    return 1;
  }, { ...opts, ready: async () => void order.push("ready") });
  assert.deepEqual(order, ["try", "ready", "try"]);
});
