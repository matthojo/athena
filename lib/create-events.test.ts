// Run: npx tsx --test lib/create-events.test.ts
// Adding events in lib/: what's refused before any account (or the database) is touched. Ask's
// create_event never adds anything itself; createEvent never invites anyone to a booking or a
// focus block; Undo takes only a create_event undo for one row of calendar_creates. The full path,
// with the database, is lib/create-events.db.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCreateUndo, createEvent, isCreateUndo, isMoveUndo, prepareCreate, type SchedulingPort } from "./scheduling";
import { runSchedulingTool, SCHEDULING_TOOLS } from "./assistant-scheduling";

/** A port that fails the test if anything reaches a calendar. */
const untouched: SchedulingPort = {
  events: async () => assert.fail("no calendar read"),
  freeBusy: async () => assert.fail("no calendar read"),
  move: async () => assert.fail("nothing moved"),
  calendars: async () => assert.fail("no calendar read"),
  create: async () => assert.fail("nothing added"),
  removeCreated: async () => assert.fail("nothing deleted"),
};

const NOW = new Date("2026-11-09T12:00:00Z");

test("Ask's create_event proposes; it has no way to add, and a time gone by is refused", async () => {
  const tool = SCHEDULING_TOOLS.find((t) => t.name === "create_event")!;
  assert.ok(tool, "offered to the assistant");
  assert.match(tool.description ?? "", /only when the owner taps Add/);
  assert.deepEqual((tool.input_schema as { required: string[] }).required, ["title", "start"]);
  const props = Object.keys((tool.input_schema as { properties: object }).properties).sort();
  assert.deepEqual(props, ["description", "location", "minutes", "start", "title", "who"], "no calendar, account or anything to skip the sheet");
  const shown: unknown[] = [];
  await assert.rejects(
    runSchedulingTool("create_event", { title: "Lunch with Priya", start: "2026-11-08T13:00", who: [{ name: "Priya" }] }, { scheduling: untouched, tz: "Europe/London", now: NOW, show: (c) => shown.push(c) }),
    /That time has passed/
  );
  await assert.rejects(runSchedulingTool("create_event", { title: "Lunch", start: "Thursday" }, { scheduling: untouched, tz: "Europe/London", now: NOW, show: (c) => shown.push(c) }), /YYYY-MM-DDTHH:MM/);
  await assert.rejects(runSchedulingTool("create_event", { title: "Lunch", start: "2026-11-12T13:00", calendar: "x" }, { scheduling: untouched, tz: "Europe/London", now: NOW, show: (c) => shown.push(c) }), /Unrecognized key/);
  assert.deepEqual(shown, []);
  await assert.rejects(runSchedulingTool("create_event", { title: "x", start: "2026-11-12T13:00" }, { tz: "Europe/London", now: NOW, show: () => undefined }), /isn't available here/);
});

test("createEvent: a booking or a focus block never invites anyone, and bad input is refused before any account is read", async () => {
  const base = { account_id: "00000000-0000-4000-8000-0000000000c1", calendar_id: "primary", title: "Dinner at Dishoom", start: "2026-11-13T19:30:00Z", end: "2026-11-13T21:00:00Z" };
  await assert.rejects(createEvent({ ...base, kind: "booking", attendees: [{ email: "x@example.com" }] }, { scheduling: untouched, tz: "Europe/London" }), /doesn't invite anyone/);
  await assert.rejects(createEvent({ ...base, kind: "focus", attendees: [{ email: "x@example.com" }] }, { scheduling: untouched, tz: "Europe/London" }), /no guests/);
  await assert.rejects(createEvent({ ...base, account_id: "not-an-id" }, { scheduling: untouched }), /account_id/);
  await assert.rejects(createEvent({ ...base, title: "  " }, { scheduling: untouched }), /called/);
  await assert.rejects(createEvent({ ...base, end: base.start }, { scheduling: untouched }), /end after it starts/);
  await assert.rejects(createEvent({ ...base, end: "2026-11-15T21:00:00Z" }, { scheduling: untouched }), /within a day/);
  await assert.rejects(createEvent({ ...base, start: "Friday" }, { scheduling: untouched }), /ISO 8601/);
  await assert.rejects(createEvent({ ...base, attendees: [{ email: "not an address" }] }, { scheduling: untouched }), /email addresses/);
  await assert.rejects(createEvent({ ...base, attendees: Array.from({ length: 51 }, (_, i) => ({ email: `p${i}@example.com` })) }, { scheduling: untouched }), /up to 50/);
});

test("prepareCreate refuses an event with no title or a backwards time before reading anything", async () => {
  await assert.rejects(prepareCreate({ title: " ", start: "2026-11-13T19:30:00Z" }, { scheduling: untouched, tz: "UTC" }), /called/);
  await assert.rejects(prepareCreate({ title: "x", start: "2026-11-13T19:30:00Z", end: "2026-11-13T19:00:00Z" }, { scheduling: untouched, tz: "UTC" }), /end after it starts/);
  await assert.rejects(prepareCreate({ title: "x", start: "next Friday" }, { scheduling: untouched, tz: "UTC" }), /ISO 8601/);
});

test("Undo takes only a create_event undo naming one row, and never reaches a calendar otherwise", async () => {
  assert.equal(isCreateUndo({ op: "create_event", id: "x" }), true);
  assert.equal(isCreateUndo({ op: "move_event", id: "x" }), false);
  assert.equal(isMoveUndo({ op: "create_event", id: "x" }), false, "a create's undo is never taken for a move's");
  for (const bad of [null, {}, { op: "delete_event", id: "00000000-0000-4000-8000-000000000001" }, { op: "create_event" }, { op: "create_event", id: "ev_1" }, { op: "create_event", id: "../../events/ev_1" }]) {
    await assert.rejects(applyCreateUndo(bad, { scheduling: untouched }), /can't be undone/, JSON.stringify(bad));
  }
  await assert.rejects(applyCreateUndo({ op: "create_event", id: "00000000-0000-4000-8000-000000000001" }, {}), /can't be undone here/);
});
