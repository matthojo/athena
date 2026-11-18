// A conversation keeps what an answer saved to Athena (its receipt, Undo ops and what was undone) through the server and back.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/ask-threads.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const ID = "5a5a5a5a-0000-4000-8000-000000000001";
const OLD = "5a5a5a5a-0000-4000-8000-000000000002";
const AT = "2026-11-08T10:00:00.000Z";

const receipt = {
  saved: [
    { kind: "trip", title: "Lisbon, 14–18 Jan", href: "#/trips/t1", from: "Gmail", undo: [{ op: "archive", kind: "booking", id: "b1" }, { op: "archive", kind: "trip", id: "t1" }] },
    { kind: "day", title: "Past Lives", href: "#/days/2026-01-16", from: "Trakt", undo: [{ op: "archive_day_import", run_id: "33333333-0000-4000-8000-000000000003" }] },
  ],
  review: 1,
  already: 0,
  failed: [],
  over_cap: 0,
  undone: [1],
};

const answer = (extra: Record<string, unknown> = {}) => ({
  role: "answer", at: AT, question: "When did I fly to Lisbon in January?", text: "You flew on 14 January [1].",
  sources: [], related: [], searched: "Searched Gmail", skipped: [], found: true, flagged: false, sample: false, note: null, fallback: null, ...extra,
});

beforeEach(async () => {
  if (!url) return;
  const { q } = await import("./db");
  await q(`TRUNCATE ask_threads`);
});

test("An answer's receipt is kept with the conversation and comes back as it was, undone lines and all", { skip }, async () => {
  const { saveAskThread, listAskThreads } = await import("./ask-threads");
  const messages = [{ role: "me", text: "When did I fly to Lisbon in January?", at: AT }, answer({ receipt })];
  await saveAskThread(ID, { title: "", messages, updated_at: AT });
  const { threads } = await listAskThreads();
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].messages, messages);
});

test("A conversation saved before receipts loads as it was", { skip }, async () => {
  const { saveAskThread, listAskThreads } = await import("./ask-threads");
  const messages = [{ role: "me", text: "Where did I stay?", at: AT }, answer()];
  await saveAskThread(OLD, { title: "", messages, updated_at: AT });
  const { threads } = await listAskThreads();
  assert.deepEqual(threads[0].messages, messages);
  assert.equal("receipt" in (threads[0].messages[1] as object), false);
});

test("Something that isn't a receipt is dropped, and the conversation still saves", { skip }, async () => {
  const { saveAskThread } = await import("./ask-threads");
  const saved = await saveAskThread(ID, { title: "", messages: [answer({ receipt: { saved: "nope" } }), { role: "me", text: "hi", at: AT, receipt }], updated_at: AT });
  assert.deepEqual(saved.messages, [answer(), { role: "me", text: "hi", at: AT }]);
});
