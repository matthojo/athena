// Run: npx tsx --test lib/habits.test.ts
// Habit summaries for the Library (lib/habits.ts) and the evening prompt's unticked habit (lib/nudges.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarise } from "./habits";
import { eveningPrompt, firstHighlight } from "./nudges";

test("a habit's streak runs to today or yesterday; the longest run and the weekday split count logged days", () => {
  const marks = [
    { date: "2026-11-01", done: true },
    { date: "2026-11-02", done: true },
    { date: "2026-11-03", done: false, note: "skipped" },
    { date: "2026-11-04", done: true },
    { date: "2026-11-05", done: true },
    { date: "2026-11-06", done: true },
  ];
  const s = summarise("Read", "habitify", marks, "2026-11-07");
  assert.equal(s.streak, 3, "today isn't ticked yet, so the run counts to yesterday");
  assert.equal(s.longest, 3);
  assert.equal(s.done, 5);
  assert.equal(s.weekdays[1], 0, "Tuesday 3 Nov was skipped");
  assert.equal(summarise("Read", "habitify", marks, "2026-11-09").streak, 0, "a gap ends the run");
});

test("the evening prompt never names an unticked habit (night F1), and a habit is never the day's highlight", () => {
  const day = { entries: [{ title: "Reading", source: "habitify", kind: "habit", count: 0 }, { title: "Severance", source: "trakt", at: "2026-11-07T20:00:00Z" }] };
  assert.equal(eveningPrompt("2026-11-07", day).body, "Severance. How was it?");
  assert.equal(firstHighlight({ entries: [{ title: "Reading", source: "habitify", kind: "habit", count: 1 }] }), null);
  assert.equal(eveningPrompt("2026-11-07", { entries: [{ title: "Severance", source: "trakt" }] }).body, "Severance. How was it?");
});
