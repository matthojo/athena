// Run: npx tsx --test lib/life-patterns.test.ts
// Patterns' newer factors: habit done, eating out and evenings at home (lib/patterns.ts), with their floor of 20 known days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, factorsOf, findPatterns, MIN_KNOWN, patternLabels, patternWords, type PatternDay } from "./patterns";

const TODAY = "2026-11-06";
const days = (n: number, f: (i: number, date: string) => Partial<PatternDay>): PatternDay[] =>
  Array.from({ length: n }, (_, i) => {
    const date = addDays(TODAY, -(n - 1 - i));
    return { date, ...f(i, date) };
  });

test("a habit is a factor only with 20 known days and 8 a side", () => {
  const enough = days(30, (i) => ({ habits: { Stretch: i % 2 === 0 } }));
  assert.ok(factorsOf(enough).some((f) => f.key === "habit:Stretch"));
  const few = days(MIN_KNOWN - 1, (i) => ({ habits: { Stretch: i % 2 === 0 } }));
  assert.ok(!factorsOf(few).some((f) => f.key === "habit:Stretch"), "under 20 known days: no claim");
  const lopsided = days(40, (i) => ({ habits: { Stretch: i > 4 } }));
  assert.ok(!factorsOf(lopsided).some((f) => f.key === "habit:Stretch"), "5 days without: no claim");
});

test("eating out and evenings at home only where they're known", () => {
  const none = days(60, () => ({}));
  assert.ok(!factorsOf(none).some((f) => f.kind === "eating_out" || f.kind === "home_evening"));
  const some = days(60, (i) => ({ eating_out: i % 3 === 0 ? 1800 : 0, home_evening: i % 2 ? 0.62 : 0.3 }));
  const fs = factorsOf(some);
  assert.ok(fs.some((f) => f.kind === "eating_out"));
  // Sleep only, that same night (not sameDayOnly, which would read the night before).
  assert.deepEqual(fs.find((f) => f.kind === "home_evening")?.pairs, { sleep: [0] });
});

test("a habit that goes with better mood is found and said plainly", () => {
  const ds = days(90, (i) => {
    const done = i % 2 === 0;
    return { habits: { Stretch: done }, mood: done ? 4 + (i % 4 === 0 ? 1 : 0) : 2 + (i % 3 === 0 ? 1 : 0) };
  });
  const ps = findPatterns(ds, { today: TODAY, window: 90, outcomes: ["mood"] });
  const p = ps.find((x) => x.factor_kind === "habit");
  assert.ok(p, JSON.stringify(ps.map((x) => x.id)));
  assert.equal(p!.line, p!.lag ? "Your mood is better the day after you tick off “Stretch”" : "Your mood is better on days you tick off “Stretch”");
  assert.deepEqual(patternLabels(p!).factor, "Stretch");
  const w = patternWords({ factor_kind: "eating_out", outcome: "sleep", lag: 0, diff: -34, beat: 14, beat_without: 0, n_with: 21, n_without: 40 });
  assert.equal(w.line, "You sleep 35 min less on days you eat out or get a takeaway");
  assert.equal(w.evidence, "Shorter than usual on 14 of 21 days you eat out");
  assert.equal(patternWords({ factor_kind: "home_evening", outcome: "sleep", lag: 0, diff: 25, beat: 12, beat_without: 0, n_with: 20, n_without: 30 }).line, "You sleep 25 min longer on evenings at home");
});
