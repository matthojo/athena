// Run: npx tsx --test lib/bearable-csv.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBearable } from "./bearable-csv";
import { ImportFileError } from "./loop-csv";

const csv = readFileSync(join(import.meta.dirname, "fixtures/backfill/bearable.csv"), "utf8");

test("mood out of 10 halved, energy words, symptoms with severity, factors", () => {
  const p = parseBearable(csv, { today: "2026-11-07" });
  assert.deepEqual(p.days, [
    { day: "2026-11-02", habits: [{ name: "Alcohol", done: true }], mood: 2, symptoms: [{ name: "Irritability", severity: 3 }] },
    { day: "2026-11-03", habits: [{ name: "Caffeine", done: true }, { name: "Walk outside", done: true }], mood: 5, energy: 4, symptoms: [{ name: "Headache", severity: 2 }] },
  ]);
  assert.equal(p.health_days, 2);
  assert.equal(p.rows, 8, "sleep and sleep quality aren't read");
});

test("a 1–5 file stays as it is; columns found by name in any order", () => {
  const p = parseBearable("category,detail,date,rating/amount\nMood,,2026-01-02,4\nEnergy,,2026-01-02,2\nSymptoms,Nausea | Fatigue (Mild),2026-01-02,1\n");
  assert.deepEqual(p.days, [{ day: "2026-01-02", habits: [], mood: 4, energy: 2, symptoms: [{ name: "Nausea", severity: 1 }, { name: "Fatigue", severity: 1 }] }]);
});

test("dates day first, bad and future dates, wrong files", () => {
  const p = parseBearable("date formatted,category,rating/amount,detail\n14/03/2024,Factors,,Gym\n31/02/2024,Factors,,Gym\n01/01/2099,Mood,3,\n", { today: "2026-11-07" });
  assert.deepEqual(p.days, [{ day: "2024-03-14", habits: [{ name: "Gym", done: true }] }]);
  assert.deepEqual(p.skipped, { undated: 1, future: 1 });
  assert.throws(() => parseBearable("Title,Date\nx,2024-01-01\n"), (e: unknown) => e instanceof ImportFileError && e.reason === "unreadable");
  assert.throws(() => parseBearable("date,category,detail\n2024-01-01,Gratitude,Sun\n"), (e: unknown) => e instanceof ImportFileError && e.reason === "empty");
});
