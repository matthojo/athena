// The owner's own habits: due days (weekdays and N a week), streaks that skip days a habit isn't due, targets, undo and Shortcut names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDone, isDueOn, matchHabit, pickDue, shortWeek, nameKey, needsToday, nextTap, progressNote, progressOf, scheduleWords, showsOn, streakOf, WEEKDAYS_ONLY } from "./habit-rules";
import { eveningPrompt } from "./nudges";

// 2 Nov 2026 is a Monday; 8 Nov a Sunday.
const MWF = 1 | 4 | 16;
const set = (...d: string[]) => new Set(d);

test("due days: chosen weekdays, never before the start", () => {
  const h = { days: MWF, per_week: null, starts_on: "2026-11-02" };
  assert.deepEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((d) => isDueOn(h, d)), [true, false, true, false, true]);
  assert.equal(isDueOn(h, "2026-10-30"), false, "a Friday before it started");
  assert.equal(scheduleWords(h), "Mon, Wed, Fri");
  assert.equal(scheduleWords({ days: WEEKDAYS_ONLY, per_week: null }), "Weekdays");
  assert.equal(scheduleWords({ days: 127, per_week: 3 }), "3 times a week");
});

test("N a week: shows until the week's count is met, nudges only when today can't be spared", () => {
  const h = { days: 127, per_week: 3, starts_on: "2026-10-01" };
  const done = set("2026-11-02", "2026-11-03");
  assert.equal(showsOn(h, "2026-11-04", done), true, "2 of 3 so far");
  assert.equal(showsOn(h, "2026-11-05", set(...done, "2026-11-04")), false, "met on Wednesday");
  assert.equal(showsOn(h, "2026-11-04", set(...done, "2026-11-04")), true, "still shown on the day it was ticked");
  // Thursday with 0 of 3: four days left, so it can wait. Friday with 0 of 3: only three left.
  assert.equal(needsToday(h, "2026-11-05", set()), false);
  assert.equal(needsToday(h, "2026-11-06", set()), true);
  assert.equal(needsToday(h, "2026-11-08", set("2026-11-02", "2026-11-03")), true, "Sunday, one short");
  assert.equal(needsToday(h, "2026-11-08", set("2026-11-02", "2026-11-03", "2026-11-04")), false, "already met");
});

test("streaks skip days the habit isn't due, and today not done yet doesn't break them", () => {
  const h = { days: MWF, per_week: null, starts_on: "2026-10-01" };
  // Mon 26 Oct, Wed 28, Fri 30, Mon 2 Nov, Wed 4: five due days in a row, the Tuesdays and weekends between not ticked.
  const done = set("2026-10-26", "2026-10-28", "2026-10-30", "2026-11-02", "2026-11-04");
  assert.deepEqual(streakOf(h, done, "2026-11-05"), { streak: 5, longest: 5, unit: "day" }, "Thursday isn't due");
  assert.equal(streakOf(h, done, "2026-11-06").streak, 5, "Friday not ticked yet is still open");
  assert.equal(streakOf(h, done, "2026-11-07").streak, 0, "Friday missed breaks it");
  assert.equal(streakOf(h, done, "2026-11-07").longest, 5);
  // A tick on a day it isn't due adds one.
  assert.equal(streakOf(h, set(...done, "2026-11-05"), "2026-11-05").streak, 6);
  // Every day: a missed day breaks it.
  const daily = { days: 127, per_week: null, starts_on: "2026-11-01" };
  assert.equal(streakOf(daily, set("2026-11-01", "2026-11-03", "2026-11-04"), "2026-11-04").streak, 2);
});

test("weekly streaks count weeks that met the number; the week in progress only once it's met", () => {
  const h = { days: 127, per_week: 2, starts_on: "2026-10-12" };
  const done = set("2026-10-12", "2026-10-14", "2026-10-20", "2026-10-25", "2026-10-27", "2026-10-29", "2026-11-03");
  assert.deepEqual(streakOf(h, done, "2026-11-04"), { streak: 3, longest: 3, unit: "week" }, "this week has 1 of 2: not counted, not broken");
  assert.equal(streakOf(h, set(...done, "2026-11-04"), "2026-11-04").streak, 4);
});

test("targets count up, a full one clears on the next tap, and the note carries the count", () => {
  assert.equal(progressNote(3, 8, "glasses"), "3 of 8 glasses");
  assert.equal(progressOf({ count: 0, note: "3 of 8 glasses" }, 8), 3);
  assert.equal(progressOf({ count: 1, note: "8 of 8 glasses" }, 8), 8);
  assert.equal(progressOf({ count: 1 }, null), 1);
  assert.equal(progressOf(null, 8), 0);
  assert.equal(isDone(7, 8), false);
  assert.equal(isDone(9, 8), true, "past the target is still done");
  assert.deepEqual([0, 1, 7, 8].map((p) => nextTap(p, 8)), [1, 2, 8, 0]);
  assert.deepEqual([0, 1].map((p) => nextTap(p, null)), [1, 0]);
});

test("undo is setting the day back: tap then tap again restores the count", () => {
  let p = 3;
  const before = p;
  p = nextTap(p, 8);
  assert.equal(p, 4);
  p = before;
  assert.equal(progressOf({ count: 0, note: progressNote(p, 8, "glasses") }, 8), 3);
});

test("the Shortcut matches a name in any case, then a unique start, then a word", () => {
  const hs = [{ name: "Read 20 pages" }, { name: "Drink water" }, { name: "Stretch" }, { name: "Read the news" }];
  assert.equal(nameKey("  Drink   WATER! "), "drink water");
  assert.deepEqual(matchHabit(hs, "drink water"), { habit: hs[1] });
  assert.deepEqual(matchHabit(hs, "STRETCH"), { habit: hs[2] });
  assert.deepEqual(matchHabit(hs, "water"), { habit: hs[1] });
  const r = matchHabit(hs, "read");
  assert.ok("error" in r && r.error === "many" && r.candidates.length === 2);
  assert.deepEqual(matchHabit(hs, "read 20"), { habit: hs[0] });
  assert.ok("error" in matchHabit(hs, "meditate"));
  assert.deepEqual(matchHabit([{ name: "Café" }], "cafe"), { habit: { name: "Café" } });
});

test("the evening nudge never names an Athena habit still owed (night F1)", () => {
  const owed = { entries: [{ title: "Read 20 pages", source: "athena", kind: "habit", count: 0 }] };
  assert.equal(eveningPrompt("2026-11-07", owed).body, "Add a mood or a line before the day ends.");
});

test("a whole week below its number is missed; the week in progress isn't yet", () => {
  const h = { days: 127, per_week: 3, starts_on: "2026-10-01" };
  const done = set("2026-10-26", "2026-10-28", "2026-11-03");
  assert.equal(shortWeek(h, "2026-10-27", done, "2026-11-04"), true, "2 of 3 in the week of 26 Oct");
  assert.equal(shortWeek(h, "2026-11-04", done, "2026-11-04"), false, "this week isn't over");
  assert.equal(shortWeek(h, "2026-10-27", set(...done, "2026-10-30"), "2026-11-04"), false, "met");
  assert.equal(shortWeek({ ...h, per_week: null }, "2026-10-27", done, "2026-11-04"), false);
});

test("several matches: the Shortcut picks the one due today, and asks when both or neither are", () => {
  const hs = [{ name: "Read 20 pages", due: true }, { name: "Read the news", due: false }];
  assert.equal(pickDue(hs, (h) => h.due)?.name, "Read 20 pages");
  assert.equal(pickDue(hs, () => true), null);
  assert.equal(pickDue(hs, () => false), null);
});
