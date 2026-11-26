// Run: npx tsx --test app/src/lib/owner-offline.test.ts
// A real owner (a token, not sample mode) whose server can't be reached sees
// this device's copy or nothing, marked offline: never the sample owner's
// briefing and notes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------- the browser, as little of it as data.ts needs ----------

const stores = new Map<string, Map<IDBValidKey, unknown>>();
const store = (name: string) => stores.get(name) ?? stores.set(name, new Map()).get(name)!;
const keyOf = (name: string, v: Record<string, unknown>) => (name === "metrics" ? v.metric : name === "meta" ? v.key : v.id) as IDBValidKey;

/** Requests answer on the next turn and the transaction completes after them, as IndexedDB's do. */
function request<T>(result: () => T) {
  const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
  setTimeout(() => {
    req.result = result();
    req.onsuccess?.();
  }, 0);
  return req;
}

const fakeDb = {
  objectStoreNames: { contains: () => true },
  transaction(names: string | string[]) {
    const t: Record<string, unknown> & { oncomplete?: () => void } = {
      objectStore: (name: string) => ({
        getAll: () => request(() => [...store(name).values()]),
        get: (key: IDBValidKey) => request(() => store(name).get(key)),
        put: (v: Record<string, unknown>) => store(name).set(keyOf(name, v), v),
        delete: (key: IDBValidKey) => store(name).delete(key),
      }),
    };
    void names;
    setTimeout(() => t.oncomplete?.(), 5);
    return t;
  },
};

const local = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  indexedDB: {
    open: () => {
      const req: { result?: unknown; onsuccess?: () => void } = {};
      setTimeout(() => {
        req.result = fakeDb;
        req.onsuccess?.();
      }, 0);
      return req;
    },
  },
  // The server is down.
  fetch: async () => {
    throw new TypeError("Failed to fetch");
  },
});

const data = await import("../db/data");
const { sampleNotes } = await import("../db/sample-data");

beforeEach(() => {
  stores.clear();
  local.clear();
});

const owner = () => local.set("athena.token", "a-real-token");

test("an owner's first fetch failing with nothing cached shows nothing, offline, not sample notes", async () => {
  owner();
  await data.refreshNotes();
  const snap = data.notesSnapshot();
  const sampleIds = new Set(sampleNotes().map((n) => n.id));
  assert.ok(!snap.notes.some((n) => sampleIds.has(n.id)));
  assert.deepEqual(snap.notes, []);
  assert.equal(snap.state, "offline");
});

test("an owner offline with a cache sees their own notes", async () => {
  owner();
  const mine = { id: "n1", title: "My note", body: "Mine", type: "note", tags: [], source: null, created_at: "2026-11-09T08:00:00Z", updated_at: "2026-11-09T08:00:00Z" };
  store("notes").set("n1", mine);
  await data.refreshNotes();
  assert.deepEqual(data.notesSnapshot().notes.map((n) => n.id), ["n1"]);
  assert.equal(data.notesSnapshot().state, "offline");
});

test("search, people and metrics for an offline owner come back empty, never sample", async () => {
  owner();
  const search = await data.searchNotes("Priya");
  assert.deepEqual(search, { notes: [], state: "offline" });
  assert.deepEqual(await data.loadPeople(), { people: [], state: "offline" });
  assert.deepEqual(await data.loadMetric("steps"), { points: [], state: "offline" });
  assert.equal(await data.findNote(sampleNotes()[0].id), null);
});

test("sample mode keeps the sample owner's notes", async () => {
  local.set("athena.mode", "sample");
  await data.refreshNotes();
  assert.equal(data.notesSnapshot().state, "sample");
  assert.ok(data.notesSnapshot().notes.length > 0);
});
