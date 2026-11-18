// Run: npx tsx --test lib/daylio-csv.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clock, dayMood, parseDaylio, plainNote } from "./daylio-csv";
import { ImportFileError } from "./loop-csv";
import { habitEntries } from "./day-imports";

const read = (n: string) => readFileSync(join(import.meta.dirname, "fixtures/backfill", n), "utf8");

test("current export: moods averaged, activities as habits, notes in time order", () => {
  const p = parseDaylio(read("daylio.csv"), { today: "2026-11-07" });
  assert.equal(p.rows, 5);
  const nov3 = p.days.find((d) => d.day === "2026-11-03")!;
  assert.equal(nov3.mood, 4, "good (4) and meh (3) round to 4");
  assert.deepEqual(nov3.habits.map((h) => h.name), ["coffee", "reading", "walk", "family"]);
  assert.equal(nov3.journal, "21:40 · A slow evening\nMade soup.\nCalled Mum.");
  assert.equal(p.days.find((d) => d.day === "2026-11-02")!.mood, 5);
  assert.equal(p.days.find((d) => d.day === "2026-11-01")!.mood, 1);
  assert.equal(p.days.find((d) => d.day === "2026-11-01")!.journal, "19:30\nMigraine, stayed in.");
  // A renamed mood isn't guessed.
  const oct31 = p.days.find((d) => d.day === "2026-10-31")!;
  assert.equal(oct31.mood, undefined);
  assert.equal(oct31.journal, "21:15 · Halloween party");
  assert.deepEqual(p.skipped.unknown_moods, ["fine"]);
  assert.equal(p.moods, 3);
});

test("older headers: no note_title, and year + 'March 14'", () => {
  const noTitle = parseDaylio("full_date,date,weekday,time,mood,activities,note\n2024-03-14,March 14,Thursday,20:00,good,reading,On the train\n");
  assert.deepEqual(noTitle.days, [{ day: "2024-03-14", habits: [{ name: "reading", done: true }], mood: 4, journal: "20:00\nOn the train" }]);
  const old = parseDaylio(read("daylio-old.csv"));
  assert.equal(old.days.length, 1);
  assert.equal(old.days[0].day, "2019-03-14");
  assert.equal(old.days[0].mood, 3, "good and bad average to meh");
  assert.deepEqual(old.days[0].habits.map((h) => h.name), ["coffee", "reading", "walk"]);
});

test("missing columns, empty and future rows", () => {
  assert.throws(() => parseDaylio("date,time,activities\n"), (e: unknown) => e instanceof ImportFileError && e.reason === "unreadable");
  assert.throws(() => parseDaylio("full_date,date,weekday,time,mood,activities,note\n"), (e: unknown) => e instanceof ImportFileError && e.reason === "empty");
  const p = parseDaylio("full_date,time,mood\n2030-01-01,10:00,rad\nnot a date,10:00,rad\n2026-01-01,10:00,RAD\n", { today: "2026-11-07" });
  assert.deepEqual(p.skipped, { undated: 1, future: 1, unknown_moods: [] });
  assert.equal(p.days[0].mood, 5);
});

test("helpers: clock, notes, moods", () => {
  assert.equal(clock("9:15 pm"), "21:15");
  assert.equal(clock("12:05 AM"), "00:05");
  assert.equal(clock("25:00"), "");
  assert.equal(plainNote("a &amp; b<br/><b>c</b>"), "a & b\nc");
  assert.equal(dayMood([]), undefined);
  assert.equal(dayMood([5, 4, 4]), 4);
});

test("activities become daylio habit entries", () => {
  const p = parseDaylio(read("daylio.csv"));
  const e = habitEntries("daylio")(p.days.find((d) => d.day === "2026-11-02")!);
  assert.deepEqual(e.map((x) => [x.source, x.external_id, x.title]), [
    ["daylio", "2026-11-02:gym", "gym"],
    ["daylio", "2026-11-02:reading", "reading"],
  ]);
});
