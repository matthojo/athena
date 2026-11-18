import { test } from "node:test";
import assert from "node:assert/strict";
import { blobRunStore, probeBlobs } from "./store";
import type { RunRecord } from "./runs";

const KEY = "2222222222222222222222222222222222222222222222222222222222222222";
const record: RunRecord = { id: "11111111-1111-4111-8111-111111111111", kind: "act", status: "done", started: Date.UTC(2026, 10, 11, 23, 59), updated: 0, steps: [{ id: "a", text: "Found Rowan Hart", done: true }], draft: "", acted: false, reply: { text: "Moved it to Friday." } };

function fakeBlobs() {
  const blobs = new Map<string, ArrayBuffer>();
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async set(key: string, value: ArrayBuffer) {
      blobs.set(key, value);
    },
    async delete(key: string) {
      blobs.delete(key);
    },
    async list() {
      return { blobs: [...blobs.keys()].map((key) => ({ key, etag: "" })), directories: [] };
    },
  };
}

test("a run is kept sealed, and found again by a new instance the next day", async () => {
  process.env.ATHENA_DATA_KEY = KEY;
  const blobs = fakeBlobs();
  const store = blobRunStore(() => blobs as never, () => record.started)!;
  await store.put(record);
  const [[key, sealed]] = [...blobs.blobs];
  assert.equal(key, `2026-11-11/${record.id}`);
  const raw = Buffer.from(sealed).toString("latin1");
  assert.ok(!raw.includes("Rowan") && !raw.includes("Friday"), "nothing of the reply is readable in the store");

  const nextDay = blobRunStore(() => blobs as never, () => record.started + 120_000)!;
  assert.deepEqual(await nextDay.get(record.id), record);
  assert.equal(await nextDay.get("22222222-2222-4222-8222-222222222222"), null);
});

test("records from before yesterday are deleted", async () => {
  process.env.ATHENA_DATA_KEY = KEY;
  const blobs = fakeBlobs();
  blobs.blobs.set("2026-11-08/old", new ArrayBuffer(1));
  const store = blobRunStore(() => blobs as never, () => record.started)!;
  await store.put(record);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...blobs.blobs.keys()], [`2026-11-11/${record.id}`]);
});

test("the probe writes, reads back and deletes, leaving nothing", async () => {
  const blobs = fakeBlobs();
  const text = { ...blobs, get: async (key: string) => (blobs.blobs.has(key) ? String(blobs.blobs.get(key)) : null) };
  assert.equal((await probeBlobs(() => text as never)).ok, true);
  assert.equal(blobs.blobs.size, 0);
});

test("without a data key nothing is written: runs live in memory only", () => {
  delete process.env.ATHENA_DATA_KEY;
  assert.equal(blobRunStore(() => assert.fail("no store is opened") as never), null);
});
