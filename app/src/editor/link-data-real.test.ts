// The editor's LinkData from the real data layer (link-data-real.ts): 2S's cards mapped per kind, and, in sample mode on a
// stand-in browser, a live to-do card ticking the real store.
// Run: npx tsx --test app/src/editor/link-data-real.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type * as Rich from "../db/rich-links";

// ----- a stand-in browser: localStorage, the connection, and an IndexedDB that keeps rows in memory -----
const store = new Map<string, string>([["athena.mode", "sample"]]);
(globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true, userAgent: "Mozilla/5.0 (Windows NT 10.0)" }, configurable: true });
const events = new EventTarget();
Object.assign(globalThis, { window: globalThis, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });

const later = (fn: () => void) => setTimeout(fn, 0);
const stores = new Map<string, Map<unknown, unknown>>();
function request<T>(value: () => T) {
  const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
  later(() => {
    req.result = value();
    req.onsuccess?.();
  });
  return req;
}
const db = {
  objectStoreNames: { contains: (n: string) => stores.has(n) },
  createObjectStore(name: string, opts: { keyPath: string }) {
    stores.set(name, new Map());
    (stores.get(name) as Map<unknown, unknown> & { keyPath?: string }).keyPath = opts.keyPath;
    return { createIndex: () => undefined };
  },
  transaction() {
    const t: { oncomplete?: () => void; objectStore: (n: string) => unknown } = {
      objectStore(name: string) {
        const rows = stores.get(name) as Map<unknown, unknown> & { keyPath: string };
        return {
          get: (k: unknown) => request(() => rows.get(k)),
          getAll: () => request(() => [...rows.values()]),
          put: (row: Record<string, unknown>) => request(() => void rows.set(row[rows.keyPath], structuredClone(row))),
          delete: (k: unknown) => request(() => void rows.delete(k)),
          clear: () => request(() => rows.clear()),
        };
      },
    };
    setTimeout(() => t.oncomplete?.(), 5);
    return t;
  },
};
(globalThis as Record<string, unknown>).indexedDB = {
  open() {
    const req: { result: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: db };
    later(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

const { toEditorCard, realLinkData } = await import("./link-data-real");
const { loadCommitments } = await import("../db/memory");

const base = { id: "x1", title: "A thing", archived: false, stale: false };
/** The editor's cards don't carry the id: the link has it. */
const drawn = { title: "A thing", archived: false, stale: false };

test("2S's live cards map to the editor's, kind by kind", () => {
  const cards: Array<[Rich.LiveCard, unknown]> = [
    [
      { ...base, kind: "person", photo: { src: "blob:face", w: 1, h: 1, tone: null }, relationship: "Friend", lastCatchUp: "2026-11-01", nextBirthday: { date: "2026-12-14", inDays: 36, turns: 40 } },
      { ...drawn, kind: "person", photo: "blob:face", relation: "Friend", lastCatchUp: "2026-11-01", birthday: "2026-12-14" },
    ],
    [
      { ...base, kind: "place", name: "Dishoom", area: "King's Cross", address: "5 Stable St", mapUrl: "blob:map", openMapUrl: "https://www.openstreetmap.org/search?query=5+Stable+St", lastVisit: "2026-11-02" },
      { ...drawn, kind: "place", area: "King's Cross", lastVisit: "2026-11-02", map: "blob:map", openMap: "https://www.openstreetmap.org/search?query=5+Stable+St" },
    ],
    [
      { ...base, kind: "todo", due: "2026-11-12", done: false, overdue: false },
      { ...drawn, kind: "todo", due: "2026-11-12", done: false },
    ],
    [
      { ...base, kind: "watch", cover: null, readingKind: "book", kindLabel: "Book", status: "reading", statusLabel: "Reading", progress: 84 / 136, progressText: "Page 84 of 136" },
      { ...drawn, kind: "watch", type: "Book", status: "Reading", progress: 84 / 136, progressText: "Page 84 of 136", cover: null },
    ],
    [
      { ...base, kind: "saved", image: null, price: "£89", shop: "Hay", url: "https://hay.dk/x" },
      { ...drawn, kind: "saved", price: "£89", shop: "Hay", image: null },
    ],
    [
      { ...base, kind: "event", date: "2026-11-21", time: "19:30", place: { id: "p1", name: "Ottolenghi" } },
      { ...drawn, kind: "event", startsAt: "2026-11-21T19:30", where: "Ottolenghi" },
    ],
    [
      { ...base, kind: "event", date: "2026-11-21", time: null, place: null },
      { ...drawn, kind: "event", startsAt: "2026-11-21", where: null },
    ],
    [
      { ...base, kind: "note", firstLines: "Fly Fri evening.\n\nEat at the market.", updated: "2026-11-06T10:00:00Z" },
      { ...drawn, kind: "note", lines: ["Fly Fri evening.", "Eat at the market."], editedAt: "2026-11-06T10:00:00Z" },
    ],
    [
      { ...base, kind: "organisation", subtitle: "acme.com" },
      { ...drawn, kind: "organisation", subtitle: "acme.com" },
    ],
    [
      { ...base, kind: "project", subtitle: "" },
      { ...drawn, kind: "project", subtitle: null },
    ],
  ];
  for (const [from, to] of cards) assert.deepEqual(toEditorCard(from), to, from.kind);
  // Archived and kept-on-this-device carry over for the struck-through card and "Not updated".
  const old = toEditorCard({ ...base, archived: true, stale: true, kind: "record", subtitle: "Wine" });
  assert.equal(old.archived, true);
  assert.equal(old.stale, true);
});

test("a live to-do card ticks the real store (sample mode), and the editor is told to redraw it", async () => {
  const todo = (await loadCommitments()).items.find((c) => c.status === "open");
  assert.ok(todo, "the sample data has an open to-do");
  const first = await realLinkData.liveCard("todo", todo.id);
  assert.equal(first?.kind, "todo");
  assert.equal(first?.kind === "todo" && first.done, false);

  const told: string[] = [];
  const off = realLinkData.onLiveChange((kind, id) => told.push(`${kind}:${id}`));
  assert.equal(await realLinkData.toggleTodo(todo.id), true);
  assert.equal((await loadCommitments()).items.find((c) => c.id === todo.id)?.status, "done", "the store has it ticked");
  const after = await realLinkData.liveCard("todo", todo.id);
  assert.equal(after?.kind === "todo" && after.done, true, "the card reads it back");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(told.includes(`todo:${todo.id}`), "the card is redrawn");

  assert.equal(await realLinkData.toggleTodo(todo.id), false, "and unticks");
  assert.equal((await loadCommitments()).items.find((c) => c.id === todo.id)?.status, "open");
  off();
});

test("Log a catch-up's Undo puts the last catch-up date back (sample mode)", async () => {
  const { loadRecords, findRecord } = await import("../db/records");
  const people = (await loadRecords("person")).items;
  const person = people.find((p) => p.last_contacted_at && !p.last_contacted_at.startsWith(new Date().toISOString().slice(0, 10))) ?? people[0];
  assert.ok(person, "the sample data has a person");
  // Untouched sample dates are worked out from the clock on each read, so compare the day (what the card shows).
  const day = (iso?: string | null) => iso?.slice(0, 10) ?? null;
  const before = day(person.last_contacted_at);
  const { undo } = await realLinkData.logCatchUp(person.id);
  assert.notEqual(day((await findRecord("person", person.id))?.last_contacted_at), before, "the catch-up moved the date");
  assert.ok(undo, "the toast gets an Undo");
  await undo();
  assert.equal(day((await findRecord("person", person.id))?.last_contacted_at), before, "Undo puts it back");
});

test("Mark as finished's Undo puts the Watch & read status back (sample mode)", async () => {
  const { loadReading } = await import("../db/memory");
  const item = (await loadReading()).items.find((r) => r.status !== "done");
  assert.ok(item, "the sample data has an unfinished title");
  const before = item.status;
  const { undo } = await realLinkData.markWatched(item.id);
  assert.equal((await loadReading()).items.find((r) => r.id === item.id)?.status, "done");
  assert.ok(undo, "the toast gets an Undo");
  await undo();
  assert.equal((await loadReading()).items.find((r) => r.id === item.id)?.status, before, "Undo puts it back");
  // Already finished: nothing to undo, so no Undo.
  await realLinkData.markWatched(item.id);
  assert.equal((await realLinkData.markWatched(item.id)).undo, undefined);
  await saveBack(item.id, before);
});

async function saveBack(id: string, status: string) {
  const { saveReading } = await import("../db/memory");
  await saveReading({ status } as Parameters<typeof saveReading>[0], id);
}
