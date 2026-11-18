// Real path: the same meeting under two calendar ids is one event, on Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/event-twins.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}

test("titles compare as a person reads them", async () => {
  const { sameMeeting, titleKey } = await import("./event-twins");
  assert.equal(titleKey("  Growth  Team Sync. "), "growth team sync");
  assert.ok(sameMeeting({ title: "Growth Team Sync", starts_at: "2026-11-13T16:00:00Z" }, { title: "growth team  sync", starts_at: "2026-11-13T16:00:00.000+00:00" }));
  assert.ok(!sameMeeting({ title: "Growth Team Sync", starts_at: "2026-11-13T16:00:00Z" }, { title: "Cyber Security Awareness", starts_at: "2026-11-13T16:00:00Z" }));
  assert.ok(!sameMeeting({ title: "Growth Team Sync", starts_at: "2026-11-13T16:00:00Z" }, { title: "Growth Team Sync", starts_at: "2026-11-20T16:00:00Z" }));
});

test("the same meeting under another id joins the event already saved; a pair saved before is merged; Home offers it once", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { AthenaWriter } = await import("../netlify/lib/connectors/runner");
  const { q, upsertPerson, linkEntities } = await import("./db");
  const { prepareSuggestions } = await import("./template-fill");
  await q(`DELETE FROM events WHERE source LIKE 'twins-%'`);
  await q(`DELETE FROM collected_items WHERE source LIKE 'twins-%'`);
  const now = new Date("2026-11-12T13:00:00Z");
  const writerFor = (source: string) => {
    const stats = { notes_created: 0, notes_updated: 0, people_created: 0, todos_created: 0, todos_review: 0, events_created: 0, events_updated: 0, restored: 0 } as never;
    return new AthenaWriter({ id: source, source, lookahead_days: 14, event_push: false, recipe: "calendar-meetings" } as never, "00000000-0000-4000-8000-000000000001", stats, now, "Europe/London");
  };
  const live = async () => (await q<{ id: string; title: string }>(`SELECT id, title FROM events WHERE source LIKE 'twins-%' AND archived_at IS NULL ORDER BY created_at`)).map((e) => e.title);

  const work = writerFor("twins-work");
  const first = JSON.parse(await work.run("athena_save_event", { external_id: "ev_series_1", title: "Growth Team Sync", start: "2026-11-13T16:00:00Z" }));
  assert.equal(first.action, "created");
  // The edited occurrence: a new id, the same meeting.
  const again = JSON.parse(await work.run("athena_save_event", { external_id: "ev_series_1_R20261113", title: "Growth Team Sync ", start: "2026-11-13T16:00:00+00:00" }));
  assert.deepEqual([again.action, again.id], ["updated", first.id]);
  // Another collection reading another calendar with the same meeting on it.
  const other = JSON.parse(await writerFor("twins-personal").run("athena_save_event", { external_id: "x9", title: "growth team sync", start: "2026-11-13T16:00:00Z" }));
  assert.equal(other.id, first.id);
  // A different meeting at the same time, and the same title a week later, are their own events.
  assert.equal(JSON.parse(await work.run("athena_save_event", { external_id: "ev_sec", title: "Cyber Security Awareness", start: "2026-11-13T16:00:00Z" })).action, "created");
  assert.equal(JSON.parse(await work.run("athena_save_event", { external_id: "ev_series_2", title: "Growth Team Sync", start: "2026-11-20T16:00:00Z" })).action, "created");
  assert.deepEqual(await live(), ["Growth Team Sync", "Cyber Security Awareness", "Growth Team Sync"]);
  // Run again: nothing new, each id still points where it did.
  assert.equal(JSON.parse(await work.run("athena_save_event", { external_id: "ev_series_1_R20261113", title: "Growth Team Sync", start: "2026-11-13T16:00:00Z" })).id, first.id);
  assert.equal((await live()).length, 3);

  // A pair saved before this rule (two rows for one meeting): the next run folds the later into the earlier.
  const { upsertEvent } = await import("./db");
  const { recordCollected } = await import("./connectors");
  const dup = await upsertEvent({ title: "Growth Team Sync", starts_at: "2026-11-13T16:00:00Z", source: "twins-work", kind: "appointment", recurrence: "none", remind_days_before: [0], tz: "Europe/London" } as never);
  await recordCollected({ source: "twins-work", kind: "event", externalId: "ev_old_dup", recordId: dup.id, title: "Growth Team Sync", itemDate: "2026-11-13" });
  assert.equal((await live()).length, 4);

  // Home, before any run: offered once, with the people from both.
  const [lauren, sam] = await Promise.all([upsertPerson({ name: "Lauren Twins" } as never), upsertPerson({ name: "Sam Twins" } as never)]);
  await linkEntities({ sourceType: "event", sourceId: first.id, targetType: "person", targetId: lauren.id } as never);
  await linkEntities({ sourceType: "event", sourceId: dup.id, targetType: "person", targetId: sam.id } as never);
  const offered = (await prepareSuggestions({ now, limit: 10 })).filter((s) => /growth team sync/i.test(s.title) && new Date(s.starts_at).toISOString().startsWith("2026-11-13"));
  assert.equal(offered.length, 1);
  assert.deepEqual(offered[0].people.map((p) => p.name).sort(), ["Lauren Twins", "Sam Twins"]);

  const merged = JSON.parse(await work.run("athena_save_event", { external_id: "ev_old_dup", title: "Growth Team Sync", start: "2026-11-13T16:00:00Z" }));
  assert.equal(merged.id, first.id);
  assert.equal((await live()).length, 3);
  // The earlier one, looked at again, stays as it is.
  assert.equal(JSON.parse(await work.run("athena_save_event", { external_id: "ev_series_1", title: "Growth Team Sync", start: "2026-11-13T16:00:00Z" })).id, first.id);
  assert.equal((await live()).length, 3);
  await q(`DELETE FROM people WHERE id = ANY($1::uuid[])`, [[lauren.id, sam.id]]);
});
