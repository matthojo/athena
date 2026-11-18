// What Ask did (lib/ask-activity.ts): one row per change, from every source (a reply, a plan's Go,
// a routine's plan, a nudge card), each keeping its receipt and Undo.
// Run: npx tsx --test lib/ask-activity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_SOURCES, activityRow, nudgeActionChange, presentActivity } from "./ask-activity";
import { runSteps } from "./ask-plans";
import type { Change } from "./assistant";

const T = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const N = "44444444-4444-4444-8444-444444444444";
const todo: Change = { kind: "commitment", id: "c1", action: "created", title: "Book the venue", detail: "To do", label: "Book the venue: To do", open: { kind: "commitment", id: "c1" }, undo: { op: "archive", kind: "commitment", id: "c1" } as never };

test("every source makes a row, with its links and the receipt", () => {
  assert.deepEqual([...ACTIVITY_SOURCES], ["ask", "plan", "routine", "nudge", "team"]);
  const ask = activityRow(todo, { source: "ask", thread_id: T });
  const plan = activityRow(todo, { source: "plan", thread_id: T, plan_id: P });
  const routine = activityRow(todo, { source: "routine", plan_id: P, routine_id: R });
  const nudge = activityRow(todo, { source: "nudge", nudge_id: N });
  assert.deepEqual([ask.source, plan.source, routine.source, nudge.source], ["ask", "plan", "routine", "nudge"]);
  assert.equal(ask.thread_id, T);
  assert.equal(plan.plan_id, P);
  assert.equal(routine.routine_id, R);
  assert.equal(nudge.nudge_id, N);
  assert.deepEqual(JSON.parse(ask.payload).undo, todo.undo);
  assert.throws(() => activityRow(todo, { source: "elsewhere" as never }), /source/);
  // Anything that isn't an id is dropped, not stored.
  assert.equal(activityRow(todo, { source: "ask", thread_id: "not an id" }).thread_id, null);
});

test("a row reads back as the entry, its own id on the change for Undo", () => {
  const row = activityRow({ ...todo, activity_id: "old" }, { source: "plan", plan_id: P });
  assert.equal(JSON.parse(row.payload).activity_id, undefined);
  const e = presentActivity({ id: "a1", created_at: "2026-11-10T10:00:00Z", source: "plan", thread_id: null, plan_id: P, routine_id: null, nudge_id: null, state: "done", state_at: null, payload: row.payload })!;
  assert.equal(e.change.activity_id, "a1");
  assert.equal(e.change.title, "Book the venue");
  assert.equal(presentActivity({ id: "a2", created_at: "2026-11-10T10:00:00Z", source: "ask", thread_id: null, plan_id: null, routine_id: null, nudge_id: null, state: "done", state_at: null, payload: "enc:locked" }), null);
});

test("a nudge card's parts: a move keeps its own Undo, a to-do's day goes back to what it was", () => {
  const move = nudgeActionChange({ kind: "move", label: "Move to 14:00", event_id: "e1", title: "Design review", from: "a", start: "b" }, { op: "move_event", id: "e1", start: "a", end: "c", expect: "b" });
  assert.equal(move.kind, "event");
  assert.equal(move.title, "Design review");
  assert.deepEqual(move.undo, { op: "move_event", id: "e1", start: "a", end: "c", expect: "b" });
  // Anything that isn't a move's undo is ignored: the words and the op come from Athena's own nudge.
  assert.equal(nudgeActionChange({ kind: "move", label: "x", event_id: "e1", title: "t", from: "a", start: "b" }, { op: "archive", kind: "note", id: "n" }).undo, null);
  const part = nudgeActionChange({ kind: "plan_todo", label: "Tue", commitment_id: "c9", title: "Renew insurance", due_on: "2026-11-17", was: null }, undefined);
  assert.deepEqual(part.undo, { op: "set_due", id: "c9", due_on: null });
});

test("a plan's Go logs each step's changes as they're made, under the plan or routine", async () => {
  const logged: Array<{ source: string; ids: string[] }> = [];
  for (const source of ["plan", "routine"] as const) {
    await runSteps(
      [{ label: "a", tool: "add_todo", input: {}, stands_for: "X" }, { label: "b", tool: "add_reminder", input: {}, stands_for: "Y" }],
      new Set([0, 1]),
      async (tool) => {
        const made = [{ ...todo, id: tool }];
        logged.push({ source, ids: made.map((c) => c.id) });
        return made.map((c) => ({ ...c, activity_id: `${source}-${c.id}` }));
      },
    );
  }
  assert.deepEqual(logged, [
    { source: "plan", ids: ["add_todo"] },
    { source: "plan", ids: ["add_reminder"] },
    { source: "routine", ids: ["add_todo"] },
    { source: "routine", ids: ["add_reminder"] },
  ]);
});
