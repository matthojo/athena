// The live hub: streams, the poll that runs only while someone listens, heartbeats and shutdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHub } from "./hub";
import { LIVE_KINDS, type LiveKind, type Reading } from "./watch";

const reading = (marks: Partial<Record<LiveKind, string>> = {}): Reading => ({
  marks: [],
  kinds: Object.fromEntries(LIVE_KINDS.map((k) => [k, marks[k] ?? "0"])) as Record<LiveKind, string>,
});

const decoder = new TextDecoder();
async function next(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  return done ? "<end>" : decoder.decode(value);
}

function fakeDb(first: Reading) {
  const db = { now: first, reads: 0 };
  return {
    db,
    read: async () => {
      db.reads += 1;
      return db.now;
    },
    changes: async (prev: Reading, now: Reading) => LIVE_KINDS.filter((k) => prev.kinds[k] !== now.kinds[k]).map((kind) => ({ kind, ids: [`${kind}-1`] })),
  };
}

test("a stream opens with ready, hears a change once, and the poll stops with the last client", async () => {
  const { db, read, changes } = fakeDb(reading({ note: "a" }));
  const hub = createHub({ read, changes, pollMs: 60_000, heartbeatMs: 60_000 });
  assert.equal(hub.polling, false);

  const res = hub.open()!;
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  assert.equal(hub.polling, true);
  const ready = await next(reader);
  assert.match(ready, /^event: ready\ndata: /);
  assert.equal(JSON.parse(ready.split("data: ")[1]).marks.note, "a");

  await hub.tick();
  db.now = reading({ note: "b", nudge: "n" });
  await hub.tick();
  assert.equal(await next(reader), 'event: change\ndata: {"kind":"note","ids":["note-1"],"mark":"b"}\n\n');
  assert.equal(await next(reader), 'event: change\ndata: {"kind":"nudge","ids":["nudge-1"],"mark":"n"}\n\n');

  // A second client gets the reading already held, with no extra query.
  const reads = db.reads;
  const second = hub.open()!.body!.getReader();
  assert.equal(JSON.parse((await next(second)).split("data: ")[1]).marks.note, "b");
  assert.equal(db.reads, reads);
  assert.equal(hub.size, 2);

  await second.cancel();
  assert.equal(hub.polling, true);
  await reader.cancel();
  assert.equal(hub.size, 0);
  assert.equal(hub.polling, false);
});

test("a heartbeat comment goes out on the timer, and nothing is read when nobody listens", async () => {
  const { db, read, changes } = fakeDb(reading());
  const hub = createHub({ read, changes, pollMs: 15, heartbeatMs: 20 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.reads, 0);

  // The hub's timers don't hold the process open (the streams do, on the server); this one does, for the test.
  const hold = setTimeout(() => {}, 5000);
  const reader = hub.open()!.body!.getReader();
  await next(reader);
  assert.equal(await next(reader), ": hb\n\n");
  assert.ok(db.reads >= 2);
  await reader.cancel();
  clearTimeout(hold);
  const after = db.reads;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(db.reads <= after + 1);
});

test("closeAll ends every stream, an aborted request leaves, and a full hub refuses", async () => {
  const { read, changes } = fakeDb(reading());
  const hub = createHub({ read, changes, pollMs: 60_000, heartbeatMs: 60_000, maxClients: 2 });
  const gone = new AbortController();
  const a = hub.open()!.body!.getReader();
  const b = hub.open(gone.signal)!.body!.getReader();
  assert.equal(hub.open(), null);
  await next(a);
  await next(b);

  gone.abort();
  assert.equal(hub.size, 1);
  assert.equal(await next(b), "<end>");

  hub.closeAll();
  assert.equal(await next(a), "<end>");
  assert.equal(hub.size, 0);
  assert.equal(hub.polling, false);
});

test("a failed read is survived: the stream still opens and the next poll carries on", async () => {
  let fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const hub = createHub({
      read: async () => {
        if (fail) throw new Error("db down");
        return reading({ note: "x" });
      },
      changes: async () => [],
      pollMs: 60_000,
      heartbeatMs: 60_000,
    });
    const reader = hub.open()!.body!.getReader();
    assert.deepEqual(JSON.parse((await next(reader)).split("data: ")[1]).marks, {});
    fail = false;
    await hub.tick();
    await reader.cancel();
  } finally {
    console.warn = warn;
  }
});
