import { test } from "node:test";
import assert from "node:assert/strict";
import type { Step, StepSink } from "../../../lib/steps";
import type { TextSink } from "../../../lib/ask-stream";
import { RateLimited } from "../../../lib/ai";
import { createRuns, RunUnchecked, CUT_OFF_ACTING, CUT_OFF_ANSWER, CUT_OFF_WITH_CHANGES, STALE_MS, type RunRecord, type RunStore } from "./runs";

const ID = "11111111-1111-4111-8111-111111111111";

function memoryStore(): RunStore & { records: Map<string, RunRecord>; puts: number } {
  const records = new Map<string, RunRecord>();
  return {
    records,
    puts: 0,
    async get(id) {
      return records.has(id) ? structuredClone(records.get(id)!) : null;
    },
    async put(record) {
      this.puts++;
      records.set(record.id, structuredClone(record));
    },
  };
}

/** Every event of a stream, read to its end. */
async function events(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(stream).text();
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Work that waits to be told to go on, counting how often it was started. */
function gated() {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sinks: { onStep: StepSink; onText: TextSink } | null = null;
  const work = async (onStep: StepSink, onText: TextSink) => {
    started++;
    sinks = { onStep, onText };
    onStep({ id: "a", text: "Looking for Rowan", done: false });
    await gate;
    onStep({ id: "a", text: "Found Rowan Hart", done: true });
    onText({ delta: "Done." });
    return { text: "Done.", changes: [], choices: [] };
  };
  return { work, release, started: () => started, sinks: () => sinks! };
}

test("a run finishes with nobody listening, and is replayed to whoever asks afterwards", async () => {
  const store = memoryStore();
  const runs = createRuns({ store });
  const g = gated();
  const first = await runs.open(ID, "act", g.work);
  assert.ok(first?.background, "the caller gets the run itself for waitUntil");
  // The app goes away.
  await first.stream.cancel();
  g.release();
  await first.background;
  assert.equal(store.records.get(ID)?.status, "done");

  const again = await runs.open(ID, "act", async () => assert.fail("a known run is never started again"));
  assert.equal(again?.background, undefined);
  const seen = await events(again!.stream);
  assert.deepEqual(seen.map((e) => e.type), ["step", "text", "text", "done"]);
  assert.equal(seen[0].text, "Found Rowan Hart");
  assert.deepEqual(seen[2], { type: "text", delta: "Done." });
  assert.deepEqual(seen[3].reply, { text: "Done.", changes: [], choices: [] });
  assert.equal(g.started(), 1);
});

test("the same request sent twice at once starts the work once, and both follow it", async () => {
  const runs = createRuns({ store: memoryStore() });
  const g = gated();
  const [a, b] = await Promise.all([runs.open(ID, "act", g.work), runs.open(ID, "act", g.work)]);
  g.release();
  const [ea, eb] = await Promise.all([events(a!.stream), events(b!.stream)]);
  assert.equal(g.started(), 1);
  assert.equal(ea.at(-1)?.type, "done");
  assert.equal(eb.at(-1)?.type, "done");
  assert.equal([a, b].filter((o) => o?.background).length, 1);
});

test("a follower that joins part-way gets the steps and words so far, then the rest", async () => {
  const runs = createRuns({ store: null });
  const g = gated();
  const first = await runs.open(ID, "answer", g.work);
  g.sinks().onText({ delta: "Rowan" });
  const late = await runs.open(ID, null, null);
  g.release();
  const seen = await events(late!.stream);
  assert.deepEqual(seen.slice(0, 3), [
    { type: "step", id: "a", text: "Looking for Rowan", done: false },
    { type: "text", reset: true },
    { type: "text", delta: "Rowan" },
  ]);
  assert.equal(seen.at(-1)?.type, "done");
  await first!.background;
});

test("an instruction is on record before it starts, and again before its first change", async () => {
  const store = memoryStore();
  const runs = createRuns({ store, saveEveryMs: 60_000 });
  let atStart: RunRecord | undefined;
  let beforeChange = 0;
  const opened = await runs.open(ID, "act", async (onStep) => {
    atStart = store.records.get(ID);
    beforeChange = store.puts;
    onStep({ id: "w", text: "Adding a to-do", done: false, acts: true });
    // The write is queued before the change itself is made.
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    assert.equal(store.records.get(ID)?.acted, true);
    return { text: "Added.", changes: [], choices: [] };
  });
  await opened!.background;
  assert.equal(atStart?.status, "running");
  assert.ok(store.puts > beforeChange);
});

test("stop ends the run before its next step starts", async () => {
  const store = memoryStore();
  const runs = createRuns({ store });
  const g = gated();
  const opened = await runs.open(ID, "act", g.work);
  assert.equal(runs.stop(ID), true);
  g.release();
  const seen = await events(opened!.stream);
  // The step in hand finishes (done: true is let through); the words after it aren't written.
  assert.deepEqual(seen.at(-1), { type: "error", status: 499, message: "Stopped" });
  assert.equal(store.records.get(ID)?.status, "error");
  assert.equal(runs.stop(ID), false);
});

test("an error reaches the app as the stream's error event, with the status the route would give", async () => {
  const { AthenaInputError } = await import("../../../lib/db");
  const runs = createRuns({ store: null });
  const opened = await runs.open(ID, "act", async () => {
    throw new AthenaInputError("Say which email account");
  });
  const seen = await events(opened!.stream);
  assert.equal(seen.at(-1)?.type, "error");
  assert.equal(seen.at(-1)?.message, "Say which email account");
});

const lost = (over: Partial<RunRecord>): RunRecord => ({ id: ID, kind: "act", status: "interrupted", started: 1, updated: 1, steps: [], draft: "", acted: false, ...over });

test("a new instance never repeats an instruction that had started a change: it says what was changed", async () => {
  const store = memoryStore();
  const change = { kind: "todo", id: "t1", title: "Call the bank", detail: "Added", undo: {} };
  const steps: Step[] = [{ id: "w", text: "Added a to-do", done: true, acts: true, changes: [change as never] }];
  store.records.set(ID, lost({ acted: true, steps }));
  const runs = createRuns({ store });
  const opened = await runs.open(ID, "act", async () => assert.fail("must not run again"));
  const seen = await events(opened!.stream);
  // In Ask's one reply shape, so the app draws it like any other: no sources, the changes it had made.
  assert.deepEqual(seen.at(-1)?.reply, { text: CUT_OFF_WITH_CHANGES, sources: [], related: [], searched: "", skipped: [], found: false, flagged: false, changes: [change], choices: [] });

  // Started a change, and nothing came back from it.
  store.records.set(ID, lost({ acted: true, steps: [{ id: "w", text: "Adding a to-do", done: false, acts: true }] }));
  const second = await events((await createRuns({ store }).open(ID, "act", async () => assert.fail("must not run again")))!.stream);
  assert.equal((second.at(-1)?.reply as { text: string }).text, CUT_OFF_ACTING);
});

test("a run whose instance vanished without a word (no shutdown) isn't repeated either, unless it only reads", async () => {
  const store = memoryStore();
  const t = 1_000_000;
  store.records.set(ID, lost({ status: "running", updated: t - STALE_MS - 1 }));
  const runs = createRuns({ store, now: () => t });
  const opened = await runs.open(ID, "act", async () => assert.fail("must not run again"));
  assert.equal(((await events(opened!.stream)).at(-1)?.reply as { text: string }).text, CUT_OFF_ACTING);

  store.records.set(ID, lost({ kind: "answer", status: "running", updated: t - STALE_MS - 1 }));
  let ran = 0;
  const answer = await createRuns({ store, now: () => t }).open(ID, "answer", async () => (ran++, { text: "It's on Friday." }));
  assert.equal((await events(answer!.stream)).at(-1)?.type, "done");
  assert.equal(ran, 1, "an answer only reads, so it's written again");
});

test("an instruction stopped cleanly at shutdown before any change is run again by the next instance", async () => {
  const store = memoryStore();
  const old = createRuns({ store });
  const g = gated();
  const opened = await old.open(ID, "act", g.work);
  await old.interruptAll();
  assert.equal(store.records.get(ID)?.status, "interrupted");
  assert.equal(store.records.get(ID)?.acted, false);
  // The old instance's work is told to stop at its next step.
  g.release();
  await opened!.background;
  assert.equal(store.records.get(ID)?.status, "interrupted");

  let ran = 0;
  const next = await createRuns({ store }).open(ID, "act", async () => (ran++, { text: "Done.", changes: [], choices: [] }));
  assert.equal((await events(next!.stream)).at(-1)?.type, "done");
  assert.equal(ran, 1);
});

test("with only the id (the app reopened): a lost answer fails plainly, and an unknown run is nothing", async () => {
  const store = memoryStore();
  store.records.set(ID, lost({ kind: "answer" }));
  const runs = createRuns({ store });
  const seen = await events((await runs.open(ID, null, null))!.stream);
  assert.deepEqual(seen.at(-1), { type: "error", status: 500, message: CUT_OFF_ANSWER });
  assert.equal(await runs.open("22222222-2222-4222-8222-222222222222", null, null), null);
});

test("a run another instance still has is followed through its record", async () => {
  const store = memoryStore();
  let t = 1_000_000;
  store.records.set(ID, lost({ status: "running", updated: t, steps: [{ id: "a", text: "Looking", done: false }] }));
  const runs = createRuns({ store, now: () => t, pollMs: 5 });
  const opened = await runs.open(ID, "act", async () => assert.fail("another instance has it"));
  setTimeout(() => {
    t += 1000;
    store.records.set(ID, lost({ status: "done", updated: t, steps: [{ id: "a", text: "Found", done: true }], reply: { text: "Done.", changes: [], choices: [] } }));
  }, 20);
  const seen = await events(opened!.stream);
  assert.equal(seen[0].text, "Looking");
  assert.equal(seen.at(-1)?.type, "done");
  assert.ok(seen.some((e) => e.text === "Found"));
});

test("when the store can't be read, an instruction isn't started (it may have run before); an answer is", async () => {
  const down: RunStore = { get: async () => Promise.reject(new Error("blobs are down")), put: async () => undefined };
  let ran = 0;
  await assert.rejects(createRuns({ store: down }).open(ID, "act", async () => ran++), RunUnchecked);
  assert.equal(ran, 0);
  const answer = await createRuns({ store: down }).open(ID, "answer", async () => (ran++, { text: "Friday." }));
  assert.equal((await events(answer!.stream)).at(-1)?.type, "done");
});

test("a quiet stream gets a blank line as its heartbeat", async () => {
  const runs = createRuns({ store: null, beatMs: 5 });
  const g = gated();
  const opened = await runs.open(ID, "answer", g.work);
  setTimeout(g.release, 30);
  const text = await new Response(opened!.stream).text();
  assert.match(text, /\n\n/);
});

// ---------- "ask": one loop that reads first and makes its one change last ----------

test("ask: a run lost before its change is run again; one lost after it never is", async () => {
  const store = memoryStore();
  const t = 1_000_000;
  // Its instance vanished while it was still reading: nothing was changed, so it's safe to ask again.
  store.records.set(ID, lost({ kind: "ask", status: "running", updated: t - STALE_MS - 1 }));
  let ran = 0;
  const again = await createRuns({ store, now: () => t }).open(ID, "ask", async () => (ran++, { text: "It's on Friday." }));
  assert.equal((await events(again!.stream)).at(-1)?.type, "done");
  assert.equal(ran, 1);

  // It had said it was about to change something: never started again, whatever became of the change.
  const change = { kind: "todo", id: "t1", title: "Call the bank", detail: "Added", undo: {} };
  store.records.set(ID, lost({ kind: "ask", status: "running", updated: t - STALE_MS - 1, acted: true, steps: [{ id: "w", text: "Added a to-do", done: true, acts: true, changes: [change as never] }] }));
  const opened = await createRuns({ store, now: () => t }).open(ID, "ask", async () => assert.fail("must not run again"));
  const reply = (await events(opened!.stream)).at(-1)?.reply as { text: string; changes: unknown[] };
  assert.equal(reply.text, CUT_OFF_WITH_CHANGES);
  assert.deepEqual(reply.changes, [change]);

  // With only the id, a run lost while reading fails plainly.
  store.records.set(ID, lost({ kind: "ask" }));
  assert.deepEqual((await events((await createRuns({ store }).open(ID, null, null))!.stream)).at(-1), { type: "error", status: 500, message: CUT_OFF_ANSWER });
});

test("ask: the record says a change is coming, and is written, before the change is made", async () => {
  const store = memoryStore();
  const runs = createRuns({ store });
  const order: string[] = [];
  const opened = await runs.open(ID, "ask", async (onStep, _onText, care) => {
    assert.notEqual(store.records.get(ID)?.acted, true, "reading changes nothing, and the record doesn't say otherwise");
    await care!.beforeChange!();
    // By now the store has it: a crash from here on can't lead to the change being made twice.
    order.push(`stored acted=${store.records.get(ID)?.acted}`);
    order.push("change");
    onStep({ id: "w", text: "Added a to-do", done: true, acts: true });
    return { text: "Added.", changes: [], choices: [] };
  });
  await opened!.background;
  assert.deepEqual(order, ["stored acted=true", "change"]);
  assert.equal(store.records.get(ID)?.status, "done");
});

test("ask: Stop before the change means the change isn't made", async () => {
  const runs = createRuns({ store: memoryStore() });
  let changed = false;
  let go!: () => void;
  const waiting = new Promise<void>((r) => (go = r));
  const opened = await runs.open(ID, "ask", async (_onStep, _onText, care) => {
    await waiting;
    await care!.beforeChange!();
    changed = true;
    return { text: "Added." };
  });
  assert.equal(runs.stop(ID), true);
  go();
  const seen = await events(opened!.stream);
  assert.equal(changed, false);
  assert.deepEqual(seen.at(-1), { type: "error", status: 499, message: "Stopped" });
});

test("ask: when the store can't be read the run goes ahead, told to plan any change and make none", async () => {
  const down: RunStore = { get: async () => Promise.reject(new Error("blobs are down")), put: async () => undefined };
  let told: unknown;
  const opened = await createRuns({ store: down }).open(ID, "ask", async (_s, _t, care) => ((told = care?.careful), { text: "Friday." }));
  assert.equal((await events(opened!.stream)).at(-1)?.type, "done");
  assert.equal(told, true);
  // With the store answering, it isn't.
  const fine = await createRuns({ store: memoryStore() }).open(ID, "ask", async (_s, _t, care) => ((told = care?.careful), { text: "Friday." }));
  await events(fine!.stream);
  assert.equal(told, false);
});

test("busy: the streamed error carries the gateway's wait in seconds when it gave one, and nothing when it didn't", async () => {
  const known = await createRuns({ store: memoryStore() }).open(ID, "ask", async () => {
    throw new RateLimited(42);
  });
  const last = (await events(known!.stream)).at(-1)!;
  assert.deepEqual([last.type, last.status, last.retry_after], ["error", 429, 42]);
  // Kept on the record too, so a replay says the same.
  const store = memoryStore();
  const first = await createRuns({ store }).open(ID, "ask", async () => {
    throw new RateLimited(7.2);
  });
  await events(first!.stream);
  assert.equal(store.records.get(ID)?.error?.retry_after, 8);
  const replayed = (await events((await createRuns({ store }).open(ID, null, null))!.stream)).at(-1)!;
  assert.equal(replayed.retry_after, 8);
  const unknown = await createRuns({ store: memoryStore() }).open("22222222-2222-4222-8222-222222222222", "ask", async () => {
    throw new RateLimited();
  });
  const bare = (await events(unknown!.stream)).at(-1)!;
  assert.equal(bare.status, 429);
  assert.equal("retry_after" in bare, false);
});
