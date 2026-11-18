import test from "node:test";
import assert from "node:assert/strict";
import { createQueue, nextDelay, BACKOFF } from "../src/lib/queue.js";

const SETTINGS = { origin: "https://athena.example.com", key: "athc_" + "k".repeat(43) };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness({ settings = SETTINGS } = {}) {
  let saved = null;
  const h = {
    time: 1_000_000,
    settings,
    calls: [],
    answers: [], // queue of functions or responses; empty → 201
    store: { load: async () => (saved ? structuredClone(saved) : null), save: async (s) => { saved = structuredClone(s); } },
    get saved() { return saved; },
  };
  let n = 0;
  h.queue = createQueue({
    store: h.store,
    getSettings: async () => h.settings,
    now: () => h.time,
    uuid: () => `id-${++n}`,
    fetch: async (url, init) => {
      h.calls.push({ url, init });
      const next = h.answers.shift();
      if (typeof next === "function") return next();
      return next || json(201, { id: `s${h.calls.length}`, url: `https://athena.example.com/#/saved/s${h.calls.length}` });
    },
  });
  return h;
}

const page = { kind: "page", payload: { url: "https://example.com", title: "Ex" } };
const offline = () => { throw new TypeError("Failed to fetch"); };

test("a save that goes through leaves the outbox and joins recent", async () => {
  const h = harness();
  const r = await h.queue.add(page);
  assert.equal(r.status, "saved");
  assert.equal(r.link, "https://athena.example.com/#/saved/s1");
  assert.equal(h.saved.queue.length, 0);
  assert.equal(h.saved.recent[0].savedId, "s1");
});

test("offline: kept, retried with backoff, then sent", async () => {
  const h = harness();
  h.answers.push(offline);
  const r = await h.queue.add(page);
  assert.equal(r.status, "queued");
  assert.equal(h.saved.queue.length, 1, "written before sending, still there");
  assert.equal(h.saved.queue[0].nextAt, h.time + BACKOFF[0]);

  await h.queue.flush(); // not due yet
  assert.equal(h.calls.length, 1);

  h.time += BACKOFF[0];
  h.answers.push(() => json(503, {}));
  await h.queue.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.saved.queue[0].attempts, 2);
  assert.equal(h.saved.queue[0].nextAt, h.time + BACKOFF[1]);

  h.time += BACKOFF[1];
  await h.queue.flush();
  assert.equal(h.saved.queue.length, 0);
  assert.equal(h.calls.length, 3);
  const ids = h.calls.map((c) => JSON.parse(c.init.body).client_id);
  assert.deepEqual(new Set(ids).size, 1, "the same client id on every try, so Athena can drop duplicates");
});

test("backoff grows and caps at an hour", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9, 50].map(nextDelay), [15e3, 60e3, 300e3, 900e3, 3600e3, 3600e3, 3600e3]);
});

test("transient failures never give up", async () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.answers.push(offline);
  await h.queue.add(page);
  for (let i = 0; i < 29; i++) {
    h.time += 3_600_000;
    await h.queue.flush();
  }
  assert.equal(h.saved.queue.length, 1);
  assert.equal(h.saved.queue[0].status, "pending");
  assert.equal(await h.queue.nextWake(), h.time + 3_600_000);
});

test("bad key: held, not retried on a timer, sent after new settings", async () => {
  const h = harness();
  h.answers.push(() => json(401, { error: "nope" }));
  const r = await h.queue.add(page);
  assert.equal(r.status, "held");
  assert.equal(r.reason, "auth");
  assert.match(r.message, /key/);
  h.time += 10 * 3_600_000;
  await h.queue.flush();
  assert.equal(h.calls.length, 1, "no timer retries while the key is wrong");
  assert.equal(await h.queue.nextWake(), null);

  h.settings = { ...SETTINGS, key: "athc_" + "n".repeat(43) };
  await h.queue.settingsChanged();
  assert.equal(h.saved.queue.length, 0);
  assert.equal(h.calls[1].init.headers.Authorization, `Bearer ${h.settings.key}`);
});

test("not set up: kept until settings arrive", async () => {
  const h = harness({ settings: null });
  const r = await h.queue.add(page);
  assert.deepEqual([r.status, r.reason], ["held", "setup"]);
  assert.equal(h.calls.length, 0);
  h.settings = SETTINGS;
  await h.queue.settingsChanged();
  assert.equal(h.saved.queue.length, 0);
});

test("refused save stays until the owner retries or removes it", async () => {
  const h = harness();
  h.answers.push(() => json(413, { error: "Too big" }));
  const r = await h.queue.add(page);
  assert.equal(r.message, "Too big");
  await h.queue.settingsChanged();
  assert.equal(h.saved.queue.length, 1, "new settings don't resend a refused save");
  await h.queue.retry(r.id);
  assert.equal(h.saved.queue.length, 0);

  h.answers.push(() => json(422, { error: "Bad" }));
  const r2 = await h.queue.add(page);
  await h.queue.dismiss(r2.id);
  assert.equal(h.saved.queue.length, 0);
});

test("note: rides along with a waiting save", async () => {
  const h = harness();
  h.answers.push(offline, offline);
  const r = await h.queue.add(page);
  const n = await h.queue.addNote(r.id, "  read later  ");
  assert.equal(n.status, "queued");
  assert.equal(h.saved.queue.length, 1);
  assert.equal(h.saved.queue[0].payload.note, "read later");
  h.time += BACKOFF[1];
  await h.queue.flush();
  assert.equal(JSON.parse(h.calls.at(-1).init.body).note, "read later");
});

test("note: after the save, the same save again with the note and client id", async () => {
  const h = harness();
  const r = await h.queue.add(page);
  h.answers.push(() => json(200, { id: "s1", url: "https://athena.example.com/#/saved/s1", item: { note: "why it matters" } }));
  const n = await h.queue.addNote(r.id, "why it matters");
  assert.equal(n.status, "saved");
  const body = JSON.parse(h.calls.at(-1).init.body);
  assert.equal(h.calls.at(-1).init.method, "POST");
  assert.equal(body.client_id, JSON.parse(h.calls[0].init.body).client_id);
  assert.deepEqual([body.url, body.note, body.kind], ["https://example.com", "why it matters", "page"]);
  assert.equal(h.saved.queue.length, 0);
});

test("note: offline after the save, it waits in the outbox", async () => {
  const h = harness();
  const r = await h.queue.add(page);
  h.answers.push(offline);
  const n = await h.queue.addNote(r.id, "later");
  assert.equal(n.status, "queued");
  assert.equal(h.saved.queue[0].payload.note, "later");
});

test("force flush sends held and not-yet-due jobs", async () => {
  const h = harness();
  h.answers.push(offline, () => json(401, {}));
  await h.queue.add(page);
  await h.queue.add(page);
  assert.equal(h.saved.queue.length, 2);
  await h.queue.flush({ force: true });
  assert.equal(h.saved.queue.length, 0);
});

test("concurrent adds don't lose each other", async () => {
  const h = harness();
  h.answers.push(offline, offline, offline);
  await Promise.all([h.queue.add(page), h.queue.add(page), h.queue.add(page)]);
  assert.equal(h.saved.queue.length, 3);
});
