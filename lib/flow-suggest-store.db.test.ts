// Flow suggestions on real Postgres with every migration (0082 included): the signals read back from the
// tables the owner's habits live in (sealed text opened), a collection's own to-dos left out, end to end to
// a Delivery day suggestion; and a dismissal kept for good.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/flow-suggest-store.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the tables it reads first.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const NOW = new Date("2026-11-20T12:00:00Z");
const daysAgo = (n: number, hhmm = "08:30") => `${new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)}T${hhmm}:00Z`;
const plusHours = (at: string, h: number) => new Date(Date.parse(at) + h * 3_600_000).toISOString();

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE flow_suggestion_dismissals, team_events, purchases, reminders, commitments, ask_activity, saved_items CASCADE`);
});

test("habits read back from the tables become a Delivery day suggestion", { skip }, async () => {
  const { qRaw, saveReminder } = await import("./db");
  const { upsertCommitment } = await import("./memory");
  const { readSignals } = await import("./flow-suggest-store");
  const { detectAll } = await import("./flow-suggest");

  const shops = ["Hollowbrook Books", "Parcelwise Garden Supplies", "Fernlea Kitchenware", "Quillstone Stationers"];
  for (const [i, shop] of shops.entries()) {
    const seen = daysAgo(2 + i * 6);
    const [p] = await qRaw<{ id: string }>(`INSERT INTO purchases (retailer, status, created_at, status_at) VALUES ($1, 'dispatched', $2, $2) RETURNING id`, [shop, seen]);
    const r = await saveReminder({ text: `${shop.split(" ")[0]} parcel arriving`, at: new Date(plusHours(seen, 48)) });
    await qRaw(`UPDATE reminders SET created_at = $2 WHERE id = $1`, [r.id, plusHours(seen, 1)]);
    if (i === 0) await qRaw(`INSERT INTO team_events (kind, ref_id, ref_kind, facets, created_at) VALUES ('collected', $1, 'purchase', $2::jsonb, $3)`, [p.id, JSON.stringify({ kind: "delivery", title: `Dispatched: ${shop}`, email: true }), plusHours(seen, -1)]);
  }
  // Text is sealed at rest.
  const [raw] = await qRaw<{ text: string }>(`SELECT text FROM reminders LIMIT 1`);
  assert.match(raw.text, /^enc:/);

  const mine = await upsertCommitment({ title: "Water the plants", kind: "todo", source: "manual" });
  const filed = await upsertCommitment({ title: "Reply to the newsletter", kind: "todo", source: "email-digest" });

  const signals = await readSignals(NOW);
  assert.equal(signals.collected.length, 4, "one item per order, the event and the purchase merged");
  const first = signals.collected.find((c) => c.times.length > 1);
  assert.ok(first, "the order's event time joins its purchase");
  assert.equal(signals.reminders.length, 4);
  assert.match(signals.reminders[0].text, /parcel arriving$/, "opened");
  assert.deepEqual(signals.todos.map((t) => t.id), [mine.id], "a collection's to-do isn't the owner's habit");
  assert.ok(!signals.todos.some((t) => t.id === filed.id));
  assert.equal(signals.collectedDays.delivery, 30);

  const found = detectAll(signals, { now: NOW, tz: "Europe/London" });
  assert.deepEqual(found.map((f) => f.suggestion.id), ["follow-delivery-reminder"]);
  assert.equal(found[0].suggestion.why, "All four delivery emails in the last 30 days.");
});

test("What Ask did and saved filings read back", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { logChanges } = await import("./ask-activity");
  const { sealText } = await import("./data-box");
  const { readSignals } = await import("./flow-suggest-store");

  await logChanges([{ kind: "note", id: "00000000-0000-4000-8000-000000000001", action: "updated", title: "Trips", detail: "Added Gullhaven Hotel", label: "Trips: Added Gullhaven Hotel", open: null, undo: null }], { source: "ask" });
  await qRaw(
    `INSERT INTO saved_items (kind, url, title, thing, saved_at, filed_at, filed_to) VALUES ('link', 'https://books.example.com/1', 'A made-up novel', 'book', $1, $2, $3)`,
    [daysAgo(3), daysAgo(3, "10:00"), sealText(JSON.stringify({ action: "watch_read", label: "Watch & read", href: null, undo: null }))],
  );
  const s = await readSignals(NOW);
  assert.deepEqual(s.activity.map((a) => a.change.detail), ["Added Gullhaven Hotel"]);
  assert.deepEqual(s.saved.map((x) => [x.thing, x.action]), [["book", "watch_read"]]);
});

test("a dismissal is kept for good, twice is fine, and a bad id is refused", { skip }, async () => {
  const { dismissSuggestion, listDismissed } = await import("./flow-suggest-store");
  await dismissSuggestion("follow-delivery-reminder");
  await dismissSuggestion("follow-delivery-reminder");
  assert.deepEqual([...(await listDismissed())], ["follow-delivery-reminder"]);
  await assert.rejects(dismissSuggestion("Put the bins out"));
});
