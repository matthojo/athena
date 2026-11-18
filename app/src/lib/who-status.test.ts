// Run: npx tsx --test app/src/lib/who-status.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusLine, stepLine } from "./who-status";
import type { TeamTrigger } from "../../../lib/team-types";

const now = new Date(2026, 10, 12, 15, 0);
const at = (h: number, m = 0, daysAgo = 0) => new Date(2026, 10, 12 - daysAgo, h, m).toISOString();
const event = (e: TeamTrigger["event"]): TeamTrigger => ({ id: "t", assistant_id: "a", kind: "event", days: [], time: null, event: e, paused: false, last_slot: null, last_fired_at: null, created_at: at(9) });
const base = { paused: false, last_run_at: null as string | null, triggers: [] as TeamTrigger[], job: "Sums up the week" };

test("A run today says when", () => {
  assert.equal(statusLine({ ...base, last_run_at: at(9, 12) }, now), "Last ran 9:12");
});

test("Otherwise it says what it watches", () => {
  assert.equal(statusLine({ ...base, triggers: [event({ source: "collected", connector: "linear" })] }, now), "Watching Linear");
  assert.equal(statusLine({ ...base, triggers: [event({ source: "saved", savedAction: "gift-idea" })] }, now), "Watching gift ideas");
  assert.equal(statusLine({ ...base, last_run_at: at(9, 0, 1), triggers: [event({ source: "note" })] }, now), "Watching new notes");
});

test("Paused wins; with nothing else, an older run or the job", () => {
  assert.equal(statusLine({ ...base, paused: true, last_run_at: at(9) }, now), "Paused");
  assert.equal(statusLine({ ...base, last_run_at: at(17, 0, 1) }, now), "Last ran yesterday");
  assert.equal(statusLine(base, now), "Sums up the week");
});

test("The pill's step drops the running dots", () => {
  assert.equal(stepLine("Creating shopping list…"), "Creating shopping list");
  assert.equal(stepLine(null), null);
});
