// Run: npx tsx --test lib/tfl-csv.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTfl, readJourney, tflDate } from "./tfl-csv";
import { ImportFileError } from "./loop-csv";
import { tflEntries } from "./day-imports";

const csv = readFileSync(join(import.meta.dirname, "fixtures/backfill/tfl.csv"), "utf8");

test("journeys, buses and touch problems; top-ups left out; never a charge", () => {
  const p = parseTfl(csv, { today: "2026-11-07" });
  assert.equal(p.journeys, 5);
  assert.equal(p.skipped.other, 1);
  const nov3 = p.days.find((d) => d.day === "2026-11-03")!;
  assert.deepEqual(nov3.journeys, [
    { title: "Highbury & Islington → Old Street", start: "08:12", end: "08:31", minutes: 19 },
    { title: "Bus 73", bus: true, start: "13:02" },
    { title: "Old Street → Highbury & Islington", start: "18:05", end: "18:27", minutes: 22 },
  ]);
  const late = p.days.find((d) => d.day === "2026-11-02")!.journeys[0];
  assert.deepEqual(late, { title: "From King's Cross St. Pancras", note: "no touch-out", start: "23:50", end: "00:14", minutes: 24 }, "past midnight");
  assert.ok(!JSON.stringify(p).includes("2.80"), "charges never read");
  assert.deepEqual(p.top.slice(0, 2), ["Old Street", "Highbury & Islington"]);
});

test("dates and cells", () => {
  assert.equal(tflDate("03-Nov-2026"), "2026-11-03");
  assert.equal(tflDate("03/11/2026"), "2026-11-03");
  assert.equal(tflDate("2026-11-03"), "2026-11-03");
  assert.equal(tflDate("31-Feb-2026"), null);
  assert.equal(readJourney("Topped up, Old Street"), null);
  assert.equal(readJourney("Season ticket added on touch in, Old Street"), null);
  assert.deepEqual(readJourney("[No touch-in] to Bank"), { title: "To Bank", note: "no touch-in" });
});

test("missing columns: no end time means no minutes; wrong and empty files", () => {
  const p = parseTfl("Date,Journey/Action\n03/11/2026,Bank to Angel\n");
  assert.deepEqual(p.days, [{ day: "2026-11-03", journeys: [{ title: "Bank → Angel" }] }]);
  assert.throws(() => parseTfl("Title,Date\n"), (e: unknown) => e instanceof ImportFileError && e.reason === "unreadable");
  assert.throws(() => parseTfl("Date,Journey/Action\n03/11/2026,Topped up\n"), (e: unknown) => e instanceof ImportFileError && e.reason === "empty");
});

test("entries: other, group commute, times as subtitle, stable ids", () => {
  const [d] = parseTfl(csv).days.filter((x) => x.day === "2026-11-03");
  const e = tflEntries(d);
  assert.deepEqual(e[0], { kind: "other", source: "tfl", external_id: "2026-11-03:08:12:highbury-islington-old-street", title: "Highbury & Islington → Old Street", subtitle: "08:12–08:31", group: "commute", minutes: 19 });
  assert.equal(e[1].subtitle, "13:02");
});
