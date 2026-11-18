// Run: npx tsx --test app/src/lib/first-week.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATHENA_HELLO, FIRST_WEEK_DAYS, NAME_QUESTION, firstWeekCard, firstWeekDay, firstWeekRange, firstWeekReviewLine, firstWeekStart, yesterdayPage } from "./first-week";
import { styleProblems } from "../../../lib/writing-style";

test("the first week is days 1 to 7 from when Athena first opened", () => {
  const started = "2026-11-09T08:10:00.000Z";
  assert.equal(firstWeekDay(started, "2026-11-09"), 1);
  assert.equal(firstWeekDay(started, "2026-11-10"), 2);
  assert.equal(firstWeekDay(started, "2026-11-15"), 7);
  assert.equal(firstWeekDay(started, "2026-11-16"), null);
  assert.equal(firstWeekDay(started, "2026-11-08"), null);
  assert.equal(FIRST_WEEK_DAYS, 7);
});

test("no start, or a start that isn't a date, means no first week", () => {
  assert.equal(firstWeekDay(null, "2026-11-09"), null);
  assert.equal(firstWeekDay(undefined, "2026-11-09"), null);
  assert.equal(firstWeekDay("not a date", "2026-11-09"), null);
  assert.equal(firstWeekDay("2026-11-09T08:00:00Z", "soon"), null);
});

test("a date works as a start too, and the range is the seven days", () => {
  assert.equal(firstWeekStart("2026-11-09"), "2026-11-09");
  assert.equal(firstWeekDay("2026-11-09", "2026-11-11"), 3);
  assert.deepEqual(firstWeekRange("2026-11-09T08:10:00Z"), { from: "2026-11-09", to: "2026-11-15" });
  // Across a month end.
  assert.deepEqual(firstWeekRange("2026-11-28"), { from: "2026-11-28", to: "2026-12-04" });
  assert.equal(firstWeekDay("2026-11-28", "2026-12-04"), 7);
});

test("day one with nothing connected asks for one app, or a mood", () => {
  const c = firstWeekCard(1, { sources: 0, daysKept: 0, people: 0 });
  assert.equal(c.title, "Your first week");
  assert.equal(c.body, "Connect one app tonight and tomorrow's page will have something in it. Or tap a mood now.");
  assert.equal(c.action?.kind, "connect");
});

test("day one with an app connected says tomorrow will have something, and offers a mood", () => {
  assert.match(firstWeekCard(1, { sources: 1, daysKept: 0, people: 0 }).body, /^One app is connected/);
  assert.match(firstWeekCard(1, { sources: 3, daysKept: 0, people: 0 }).body, /^Three apps are connected/);
  assert.equal(firstWeekCard(1, { sources: 1, daysKept: 0, people: 0 }).action?.kind, "mood");
});

test("the middle days ask for what's missing next: an app, then people, then a line", () => {
  assert.equal(firstWeekCard(3, { sources: 0, daysKept: 2, people: 4 }).action?.kind, "connect");
  assert.equal(firstWeekCard(3, { sources: 2, daysKept: 2, people: 0 }).action?.kind, "people");
  const all = firstWeekCard(4, { sources: 2, daysKept: 3, people: 5 });
  assert.equal(all.action?.kind, "write");
  assert.equal(all.kicker, "Day 4 of 7");
});

test("day seven links the first-week review with what was kept", () => {
  const c = firstWeekCard(7, { sources: 2, daysKept: 5, people: 2, places: 3 });
  assert.equal(c.title, "Your first week with Athena");
  assert.equal(c.body, "Five days kept, two people and three places. Here's what I picked up, if you want to keep it.");
  assert.equal(c.action?.kind, "review");
  assert.equal(firstWeekReviewLine({ daysKept: 1, people: 1 }), "One day kept and one person. Here's what I picked up, if you want to keep it.");
  assert.equal(firstWeekReviewLine({ daysKept: 0, people: 0 }), "A quiet first week. Here's what I picked up, if you want to keep it.");
  // With nothing waiting to keep, it doesn't promise any.
  assert.equal(firstWeekReviewLine({ daysKept: 3, people: 0, picked: false }), "Three days kept.");
});

test("day two opens with yesterday as a small page", () => {
  assert.equal(yesterdayPage({ mood: 4, line: "Lunch with Priya", steps: 4120 }), "Your first day: a mood, one line and 4,100 steps.");
  assert.equal(yesterdayPage({ photos: 2, entries: 2 }), "Your first day: two photos.");
  assert.equal(yesterdayPage({ entries: 3 }), "Your first day: three things from your apps.");
  assert.equal(yesterdayPage(null), "Your first day was a quiet one. Today's page fills in as your apps send things.");
  assert.equal(yesterdayPage({}), yesterdayPage(null));
});

test("every line passes the house style", () => {
  const facts = [
    { sources: 0, daysKept: 0, people: 0 },
    { sources: 1, daysKept: 1, people: 0 },
    { sources: 2, daysKept: 4, people: 3, places: 2 },
  ];
  const lines = [ATHENA_HELLO, NAME_QUESTION, yesterdayPage({ mood: 3, line: "x", steps: 5000, photos: 1, entries: 2 }), yesterdayPage(null)];
  for (const f of facts) for (let d = 1; d <= 7; d++) {
    const c = firstWeekCard(d, f);
    lines.push(c.title, c.body, c.kicker, c.action?.label ?? "");
  }
  for (const l of lines) assert.deepEqual(styleProblems(l), [], l);
  // No counting the owner's effort back, no streaks, no "nothing".
  for (const l of lines) assert.doesNotMatch(l, /streak|in a row|nothing/i, l);
});
