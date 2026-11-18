// Run: npx tsx --test lib/loop-csv.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { batchDays, ImportFileError, isoDay, loopMark, parseLoopExport } from "./loop-csv";
import { habitEntries, HABIT_AS } from "./day-imports";

const DIR = join(import.meta.dirname, "fixtures/backfill/loop");
/** The fixture folder as the zip's entries ("001 Meditate/Checkmarks.csv"). */
function zip(dir = DIR, prefix = ""): Array<{ name: string; text: string }> {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? zip(join(dir, n), `${prefix}${n}/`) : [{ name: `${prefix}${n}`, text: readFileSync(join(dir, n), "utf8") }]));
}

test("values: 2 done; 0, 1 and 3 skipped; amounts done with a note; -1 adds nothing", () => {
  assert.deepEqual(loopMark("Meditate", "2"), { name: "Meditate", done: true });
  for (const v of ["0", "1", "3"]) assert.deepEqual(loopMark("Meditate", v), { name: "Meditate", done: false, note: "skipped" });
  assert.deepEqual(loopMark("Run", "5200", "km"), { name: "Run", done: true, note: "5.2 km" });
  for (const v of ["-1", "", "x"]) assert.equal(loopMark("Meditate", v), null);
});

test("the zip: habit folders, units from Habits.csv, oldest first", () => {
  const p = parseLoopExport(zip(), { today: "2026-11-07" });
  assert.deepEqual(p.habits, ["Meditate", "Read", "Run"]);
  assert.deepEqual(p.days.map((d) => d.day), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  const nov2 = p.days.find((d) => d.day === "2026-11-02")!;
  assert.deepEqual(nov2.habits, [
    { name: "Meditate", done: false, note: "skipped" },
    { name: "Read", done: true },
    { name: "Run", done: true, note: "5.2 km" },
  ]);
  assert.equal(p.marks, 14, "every answered day: 6 done, 8 skipped");
});

test("the wide Checkmarks.csv alone reads the same", () => {
  const wide = parseLoopExport([{ name: "Checkmarks.csv", text: readFileSync(join(DIR, "Checkmarks.csv"), "utf8") }]);
  const folders = parseLoopExport(zip().filter((f) => f.name.includes("/")));
  assert.deepEqual(
    wide.days.map((d) => [d.day, d.habits.map((h) => `${h.name}:${h.done}`)]),
    folders.days.map((d) => [d.day, d.habits.map((h) => `${h.name}:${h.done}`)]),
  );
});

test("odd files: future and bad dates counted, wrong and empty files refused", () => {
  const p = parseLoopExport([{ name: "007 Walk/Checkmarks.csv", text: "2026-12-01,2\r\n2026-02-30,2\n2026-11-01,2\n" }], { today: "2026-11-07" });
  assert.deepEqual(p.days, [{ day: "2026-11-01", habits: [{ name: "Walk", done: true }] }]);
  assert.deepEqual(p.skipped, { undated: 1, future: 1 });
  assert.equal(isoDay("1999-01-01"), null);
  assert.throws(() => parseLoopExport([{ name: "notes.csv", text: "Title,Date\nx,y" }]), (e: unknown) => e instanceof ImportFileError && e.reason === "unreadable");
  assert.throws(() => parseLoopExport([{ name: "001 Walk/Checkmarks.csv", text: "" }]), (e: unknown) => e instanceof ImportFileError && e.reason === "empty");
});

test("entries: one per habit a day, skipped as count 0, ids stable", () => {
  const [d] = parseLoopExport(zip()).days.filter((x) => x.day === "2026-11-02");
  const e = habitEntries("loop")(d);
  assert.equal(e.length, 3);
  assert.deepEqual(e[0], { ...HABIT_AS, source: "loop", external_id: "2026-11-02:meditate", title: "Meditate", count: 0, note: "skipped" });
  assert.equal(e[1].count, undefined);
  assert.deepEqual(habitEntries("loop")(d), e, "the same day gives the same ids");
});

test("batches: whole days, capped by items", () => {
  const days = Array.from({ length: 10 }, (_, i) => ({ day: `2026-01-${String(i + 1).padStart(2, "0")}`, habits: Array.from({ length: 50 }, (_, j) => ({ name: `H${j}`, done: true })) }));
  const b = batchDays(days, (d) => d.habits.length, 90, 120);
  assert.equal(b.length, 5);
  assert.ok(b.every((x) => x.length === 2));
});
