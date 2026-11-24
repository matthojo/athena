// Routines (lib/routines.ts, lib/routine-run.ts): schedule maths in the owner's zone, one run per
// slot, pause, the cap, and the proposal-only rule for what a run keeps.
// Run: npx tsx --test lib/routines.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROUTINES, RUN_WINDOW_MINUTES, checkRoom, dueSlot, latestSlot, nextSlot, parseDays, parseTime, scheduleWords, titleFrom } from "./routines";
import { routineMessages, routineNudge } from "./routine-run";
import type { AskReply } from "./answer";

const TZ = "Europe/London";
const friday4 = { days: [5 as const], time: "16:00" };

test("days and times in the owner's words", () => {
  assert.deepEqual(parseDays(["friday"]), [5]);
  assert.deepEqual(parseDays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays(["Mon", "thursday", "mon"]), [1, 4]);
  assert.deepEqual(parseDays("every day"), [0, 1, 2, 3, 4, 5, 6]);
  assert.throws(() => parseDays(["someday"]), /weekday names/);
  assert.throws(() => parseDays([]), /at least one/);
  assert.equal(parseTime("4pm"), "16:00");
  assert.equal(parseTime("9:05 am"), "09:05");
  assert.equal(parseTime("12am"), "00:00");
  assert.equal(parseTime("16:00"), "16:00");
  assert.throws(() => parseTime("25:00"), /time of day/);
  assert.equal(scheduleWords(friday4), "Every Friday at 16:00");
  assert.equal(scheduleWords({ days: [1, 2, 3, 4, 5], time: "08:00" }), "Weekdays at 08:00");
  assert.equal(scheduleWords({ days: [1, 3, 5], time: "07:30" }), "Mon, Wed and Fri at 07:30");
  assert.equal(titleFrom("what slipped this week?"), "What slipped this week");
});

test("slots: the last and next Friday at 16:00, in the owner's zone, across the clock change", () => {
  // Friday 13 Nov 2026, 16:30 GMT.
  const now = new Date("2026-11-13T16:30:00Z");
  assert.equal(latestSlot(friday4, now, TZ)!.toISOString(), "2026-11-13T16:00:00.000Z");
  assert.equal(nextSlot(friday4, now, TZ)!.toISOString(), "2026-11-20T16:00:00.000Z");
  // Before 16:00 on Friday: last week's slot.
  assert.equal(latestSlot(friday4, new Date("2026-11-13T15:59:00Z"), TZ)!.toISOString(), "2026-11-06T16:00:00.000Z");
  // In BST, 16:00 London is 15:00 UTC.
  assert.equal(latestSlot(friday4, new Date("2026-10-16T15:10:00Z"), TZ)!.toISOString(), "2026-10-16T15:00:00.000Z");
  // The week the clocks go back (Sun 25 Oct 2026): Friday 30 Oct is GMT again.
  assert.equal(nextSlot(friday4, new Date("2026-10-24T12:00:00Z"), TZ)!.toISOString(), "2026-10-30T16:00:00.000Z");
});

test("due: once per slot, never while paused, and a slot missed by too long is skipped", () => {
  const base = { ...friday4, paused: false, last_slot: null, created_at: "2026-11-01T00:00:00Z" };
  const now = new Date("2026-11-13T16:04:00Z");
  assert.equal(dueSlot(base, now, TZ)!.toISOString(), "2026-11-13T16:00:00.000Z");
  // Run already for this slot (another run claimed it): not again.
  assert.equal(dueSlot({ ...base, last_slot: "2026-11-13T16:00:00.000Z" }, now, TZ), null);
  // Last week's run doesn't stop this week's.
  assert.ok(dueSlot({ ...base, last_slot: "2026-11-06T16:00:00.000Z" }, now, TZ));
  assert.equal(dueSlot({ ...base, paused: true }, now, TZ), null);
  assert.equal(dueSlot(base, new Date(Date.parse("2026-11-13T16:00:00Z") + (RUN_WINDOW_MINUTES + 1) * 60_000), TZ), null);
  // Made after this slot: its first run is next week.
  assert.equal(dueSlot({ ...base, created_at: "2026-11-13T16:02:00Z" }, now, TZ), null);
});

test("the cap: ten routines, then no more", () => {
  assert.equal(MAX_ROUTINES, 10);
  assert.doesNotThrow(() => checkRoom(9));
  assert.throws(() => checkRoom(10), /10 routines/);
});

test("proposal only: a run's conversation keeps the plan and never a change", () => {
  const reply: AskReply = {
    text: "Two to-dos slipped. I'd give them days this week.",
    sources: [],
    related: [],
    searched: "Searched your to-dos",
    skipped: [],
    found: true,
    flagged: false,
    // Even if something came back as a change, a routine's reply keeps none.
    changes: [{ kind: "commitment", id: "c1", action: "updated", title: "x", detail: "y", label: "x: y", open: null, undo: null }],
    plan: { id: "p1", source: "routine", proposed: true, steps: [{ label: "Give 'Book the venue' Tuesday", tool: "change_todo" }, { label: "Give 'Send the deck' Wednesday", tool: "change_todo" }] },
  };
  const [me, kept] = routineMessages({ prompt: "What slipped this week?" }, "2026-11-13T16:00:00Z", reply) as Array<Record<string, any>>;
  assert.equal(me.role, "me");
  // One reply in the one shape: the answer, with the plan it proposed.
  assert.equal(kept.role, "answer");
  assert.equal(kept.text, reply.text);
  assert.equal(kept.changes, undefined);
  assert.equal(kept.plan.proposed, true);
  const n = routineNudge({ id: "r1", title: "What slipped", days: [5], time: "16:00" }, new Date("2026-11-13T16:00:00Z"), "t1", reply.text, 2);
  assert.equal(n.rule, "routine");
  assert.equal(n.key, "routine:r1:2026-11-13T16:00:00.000Z");
  assert.equal(n.thread_id, "t1");
  assert.match(n.body, /2 changes are waiting for your approval/);
  assert.match(n.why.join(" "), /only suggests changes/);
});

test("an answered run keeps the answer with its sources", () => {
  const answer: AskReply = { text: "Nothing slipped [1].", sources: [{ n: 1, kind: "todo" as const, id: "c1", url: null, title: "Book the venue", date: null, account: null }], related: [], searched: "Searched your to-dos", skipped: [], found: true, flagged: false };
  const [, kept] = routineMessages({ prompt: "What slipped?" }, "2026-11-13T16:00:00Z", answer) as Array<Record<string, any>>;
  assert.equal(kept.role, "answer");
  assert.equal(kept.plan, undefined);
  assert.equal(kept.sources[0].id, "c1");
  assert.equal(kept.sources[0].title, undefined, "Athena's own sources are kept by id");
  const n = routineNudge({ id: "r1", title: "What slipped", days: [5], time: "16:00" }, new Date("2026-11-13T16:00:00Z"), "t1", answer.text, 0);
  assert.equal(n.body, "Nothing slipped.");
});
