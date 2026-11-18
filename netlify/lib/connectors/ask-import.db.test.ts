// Ask saves what it found, the real path: answerQuestion cites a booking email from before Athena collected,
// importAnswerItems saves it through collectOneItem (the email digest's recipe and write tools) into Postgres,
// and Undo goes through /api/assistant/undo's applyUndo. The account and both models are scripted (fixtures).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/ask-import.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { answerModel, collectorModel, gmailAccount, LINK, NOW, OUTBOUND, RETURN, scripted, THREAD, TZ, use } from "./ask-import.fixtures";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const EMAIL_DIGEST = { id: "c-email", name: "Email", recipe: "email-digest", connector_ids: [], label: "", source: "email-digest", instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 0, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
const STATS = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 };

async function db() {
  const { q } = await import("../../../lib/db");
  return q;
}

beforeEach(async () => {
  if (!url) return;
  const q = await db();
  await q(`TRUNCATE trips, trip_bookings, suggestions, collected_items, commitments, notes, purchases CASCADE`);
});

/** Ask the question, then save what the answer cited, as the app does once the answer is on screen. */
async function askAndSave(calls: string[], collector = collectorModel()) {
  const { answerQuestion } = await import("../../../lib/answer");
  const { answerSourcesWith } = await import("./answer-sources");
  const { importAnswerItems } = await import("./ask-import");
  const gmail = gmailAccount(calls);
  const sources = answerSourcesWith({ list: async () => [gmail.c], open: async () => gmail.open });
  const reply = await answerQuestion("When did I fly to Lisbon in January?", { sources, client: answerModel().client }, { now: NOW, tz: TZ });
  const receipt = await importAnswerItems(reply.imports ?? [], { client: collector.client, open: async () => gmail.open, now: NOW, accountName: async () => "Gmail", providerOf: async () => "gmail" });
  return { reply, receipt, collector };
}

const live = async () => {
  const q = await db();
  return {
    trips: await q<{ id: string }>(`SELECT id FROM trips WHERE archived_at IS NULL`),
    bookings: await q<{ id: string; source: string; source_ref: string; status: string }>(`SELECT id, source, source_ref, status FROM trip_bookings WHERE archived_at IS NULL ORDER BY start_date`),
  };
};

test("An old flight email the answer cited is saved as a trip with both legs, under the email digest", { skip }, async () => {
  const calls: string[] = [];
  const { reply, receipt } = await askAndSave(calls);
  assert.equal(reply.imports?.[0]?.url, LINK);
  assert.deepEqual(calls, ['search_threads {"query":"flight after:2026/01/01 before:2026/02/01"}', `get_thread {"threadId":"${THREAD}"}`]);

  const { trips, bookings } = await live();
  assert.equal(trips.length, 1);
  assert.deepEqual(bookings.map((b) => [b.source, b.source_ref, b.status]), [
    ["email-digest", `email-digest:${THREAD}`, "confirmed"],
    ["email-digest", `email-digest:${THREAD}`, "confirmed"],
  ]);
  assert.equal(receipt.saved.length, 1, "one line for the trip");
  const [line] = receipt.saved;
  assert.equal(line.kind, "trip");
  assert.match(line.title, /Lisbon/);
  assert.equal(line.href, `#/trips/${trips[0].id}`);
  assert.equal(line.from, "Gmail");
  assert.deepEqual(line.undo.map((u) => ("kind" in u ? u.kind : u.op)), ["booking", "booking", "trip"], "both legs, then the trip it started");
  assert.deepEqual({ already: receipt.already, review: receipt.review, failed: receipt.failed }, { already: 0, review: 0, failed: [] });
});

test("No duplicates: asking again saves nothing, and a later collection meeting the same email updates what's there", { skip }, async () => {
  const { AthenaWriter } = await import("./runner");
  await askAndSave([]);
  const before = await live();

  const again = await askAndSave([]);
  assert.equal(again.receipt.already, 1);
  assert.deepEqual(again.receipt.saved, []);
  assert.equal(again.collector.sent.length, 0, "the collector wasn't even asked");

  const writer = new AthenaWriter(EMAIL_DIGEST, "7a000000-0000-4000-8000-000000000001", { ...STATS } as never, NOW, TZ);
  const out = [JSON.parse(await writer.run("athena_trip_booking", OUTBOUND)), JSON.parse(await writer.run("athena_trip_booking", RETURN))];
  assert.deepEqual(out.map((o) => o.action), ["updated", "updated"]);
  const after = await live();
  assert.deepEqual(after.trips, before.trips);
  assert.deepEqual(after.bookings.map((b) => b.id), before.bookings.map((b) => b.id));
});

test("Finds under 0.8 go to the Review inbox, as in a collection, and the receipt counts them", { skip }, async () => {
  const q = await db();
  const { receipt } = await askAndSave([], collectorModel(0.5));
  assert.deepEqual(receipt.saved, []);
  assert.equal(receipt.review, 2);
  assert.equal((await live()).bookings.length, 0);
  const inbox = await q<{ op: string; source_ref: string }>(`SELECT op, source_ref FROM suggestions ORDER BY created_at`);
  assert.deepEqual(inbox.map((s) => [s.op, s.source_ref]), [["booking", `email-digest:${THREAD}`], ["booking", `email-digest:${THREAD}`]]);
  // Asked again: it's already waiting for a yes or no.
  assert.equal((await askAndSave([], collectorModel(0.5))).receipt.already, 1);
});

test("Undo archives what was saved; it isn't saved again, and a later collection leaves it alone", { skip }, async () => {
  const { applyUndo } = await import("../../../lib/assistant");
  const { AthenaWriter } = await import("./runner");
  const q = await db();
  const { receipt } = await askAndSave([]);
  for (const op of receipt.saved[0].undo) await applyUndo(op);

  const archived = await q<{ n: number }>(`SELECT (SELECT count(*) FROM trip_bookings WHERE archived_at IS NOT NULL) + (SELECT count(*) FROM trips WHERE archived_at IS NOT NULL) AS n`);
  assert.equal(Number(archived[0].n), 3, "both legs and the trip");
  assert.deepEqual(await live(), { trips: [], bookings: [] });

  assert.equal((await askAndSave([])).receipt.already, 1, "undone stays undone");
  const writer = new AthenaWriter(EMAIL_DIGEST, "7a000000-0000-4000-8000-000000000002", { ...STATS } as never, NOW, TZ);
  assert.equal(JSON.parse(await writer.run("athena_trip_booking", OUTBOUND)).action, "skipped");
  assert.deepEqual(await live(), { trips: [], bookings: [] });
});

test("Saving one item never sends: send and reply aren't offered to the collector, and a call to one isn't run", { skip }, async () => {
  const calls: string[] = [];
  const collector = scripted([
    (tools) => {
      assert.ok(!tools.some((t) => /send|reply/.test(t)), tools.join(", "));
      return [{ type: "tool_use", id: "s", name: "gmail__send_message", input: { to: "booking@flytap.com" } }, use(tools, "get_thread", { threadId: THREAD })];
    },
    (tools) => [use(tools, "athena_trip_booking", OUTBOUND)],
  ]);
  await askAndSave(calls, collector);
  assert.match(collector.sent[1].messages, /gmail__send_message isn't available/);
  assert.ok(!calls.some((c) => /send|reply/.test(c)), calls.join("\n"));
  assert.ok(!collector.sent[0].tools.includes("athena_metric") && !collector.sent[0].tools.includes("athena_archive_collected"), "one item writes no metric and archives nothing");
  assert.equal((await live()).bookings.length, 1);
});

test("Undo on a Life log line hides the day entries that import saved, and nothing else", { skip }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { applyUndo } = await import("../../../lib/assistant");
  await qRaw(`TRUNCATE day_entries CASCADE`);
  const importId = "33333333-0000-4000-8000-000000000003";
  const other = "44444444-0000-4000-8000-000000000004";
  const add = (key: string, runId: string | null) =>
    qRaw(`INSERT INTO day_entries (date, kind, source, external_id, ext_key, title, run_id) VALUES ('2025-01-16', 'watched', 'trakt', $1, $1, 'x', $2::uuid)`, [key, runId]);
  await add("film-1", importId);
  await add("film-2", other);
  await add("film-3", null);
  await applyUndo({ op: "archive_day_import", run_id: importId });
  const rows = await qRaw<{ ext_key: string; hidden: boolean }>(`SELECT ext_key, archived_at IS NOT NULL AS hidden FROM day_entries ORDER BY ext_key`);
  assert.deepEqual(rows, [{ ext_key: "film-1", hidden: true }, { ext_key: "film-2", hidden: false }, { ext_key: "film-3", hidden: false }]);
  const [day] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM days WHERE date = '2025-01-16'`);
  assert.equal(day.n, 1);
  // A second Undo (another device) changes nothing.
  await applyUndo({ op: "archive_day_import", run_id: importId });
  await assert.rejects(applyUndo({ op: "archive_day_import", run_id: "not-a-uuid" }));
});
