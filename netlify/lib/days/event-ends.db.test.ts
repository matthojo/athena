// Event end times (0065) and the Day's calendar labels: a synced event keeps its end, from what the model passes or
// from the calendar result the run read; an event saved before 0065 keeps no end until it's synced again; the Day
// carries the owner's full label list in colour order.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/days/event-ends.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties events, collections, connectors and collected items first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

const DAY = "2026-11-06";
const RUN = "00000000-0000-4000-8000-0000000000e1";

test("events keep their end from a calendar sync, older ones gain it on the next, and the Day lists every calendar label", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { AthenaWriter } = await import("../connectors/runner");
  const { qRaw } = await import("../../../lib/db");
  const D = await import("../../../lib/days");

  for (const t of ["collected_items", "events", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"UTC"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  // The owner's calendars: a work and a family collection that sync events, an email one that doesn't, and a personal iCloud account.
  await qRaw(
    `INSERT INTO collections (name, recipe, label, source, lookahead_days) VALUES
       ('Meetings', 'calendar-meetings', 'work', 'calendar-meetings-work', 14),
       ('Family', 'calendar-meetings', 'Family', 'calendar-meetings-family', 14),
       ('Mail', 'email-digest', 'finance', 'email-digest-finance', 0)`,
  );
  const [ical] = await qRaw<{ id: string }>(`INSERT INTO connectors (name, provider, account_label, url) VALUES ('iCloud', 'icloud-calendar', 'personal', 'https://caldav.icloud.com') RETURNING id`);

  const collection = { id: "c1", name: "Meetings", recipe: "calendar-meetings", connector_ids: [], label: "work", source: "calendar-meetings-work", instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 14, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
  const stats = () => ({ turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 }) as never;
  const now = new Date(`${DAY}T07:00:00Z`);

  // ---- before 0065: a sync that knew no end, and an event added by hand ----
  const first = new AthenaWriter(collection, RUN, stats(), now, "UTC");
  JSON.parse(await first.run("athena_save_event", { external_id: "ev1", title: "Standup", start: `${DAY}T09:00:00Z`, attendees: [] }));
  await qRaw(`INSERT INTO events (title, kind, date, starts_at) VALUES ('Dentist', 'appointment', $1::date, $2::timestamptz)`, [DAY, `${DAY}T15:00:00Z`]);

  let day = (await D.getDay(DAY, { tz: "UTC" }))!;
  const timed = (title: string) => day.events.find((e) => e.title === title)!;
  assert.equal(timed("Standup").ends_at, undefined, "no end yet");
  assert.equal(timed("Standup").label, "work");
  assert.equal(timed("Dentist").ends_at, undefined);
  assert.equal(timed("Dentist").label, undefined);
  assert.deepEqual(day.calendar_labels, ["work", "personal", "family"], "every calendar label, in colour order; the email collection's isn't one");

  // ---- the next sync: the calendar's listing gives the end, though the model leaves it out; a new event passes its own ----
  const next = new AthenaWriter(collection, RUN, stats(), now, "UTC");
  next.noteCalendarResult({ id: ical.id, provider: "icloud-calendar" }, {}, JSON.stringify({ events: [{ id: "ev1", summary: "Standup", start: `${DAY}T09:00:00Z`, end: `${DAY}T09:30:00Z` }] }));
  await next.run("athena_save_event", { external_id: "ev1", title: "Standup", start: `${DAY}T09:00:00Z`, attendees: [] });
  await next.run("athena_save_event", { external_id: "ev2", title: "Design review", start: `${DAY}T11:00:00+00:00`, end: `${DAY}T13:15:00+01:00`, attendees: [] });

  day = (await D.getDay(DAY, { tz: "UTC" }))!;
  assert.equal(timed("Standup").ends_at, `${DAY}T09:30:00.000Z`, "gained on resync, from the calendar's own result");
  assert.equal(timed("Design review").ends_at, `${DAY}T12:15:00.000Z`, "stored in UTC");
  assert.equal(timed("Dentist").ends_at, undefined, "an event nobody synced is left as it was");

  // A later sync without an end keeps the one it has.
  await new AthenaWriter(collection, RUN, stats(), now, "UTC").run("athena_save_event", { external_id: "ev2", title: "Design review", start: `${DAY}T11:00:00Z`, attendees: [] });
  day = (await D.getDay(DAY, { tz: "UTC" }))!;
  assert.equal(timed("Design review").ends_at, `${DAY}T12:15:00.000Z`);
});
