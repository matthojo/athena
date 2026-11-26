/**
 * Small fixes that can be pinned without a browser: a mention in a
 * capture's title reads as the name (components/note-row.ts), and the sample's
 * busy day names its own weekday (db/sample-days.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteParts, plainTitle } from "../components/note-row";
import { sampleDayNow, setSampleToday } from "../db/sample-days";

const ID = "5a3e0000-0000-4000-8000-000000000101";

test("a whole mention in a title reads as the name", () => {
  assert.equal(plainTitle(`[@Priya Shah](athena://person/${ID}) wants a lighter cadence`), "Priya Shah wants a lighter cadence");
  assert.equal(plainTitle(`Lunch at [@Dishoom King's Cross](athena://place/${ID})`), "Lunch at Dishoom King's Cross");
});

test("a mention cut off at 77 characters reads as the name, dots kept", () => {
  assert.equal(plainTitle("Lunch with [@Priya Shah](athena://person/5a3e0000-00..."), "Lunch with Priya Shah...");
  assert.equal(plainTitle("Lunch with [@Priya Sh..."), "Lunch with Priya Sh...");
});

test("ordinary titles are left alone", () => {
  assert.equal(plainTitle("Design review: decisions on the new onboarding"), "Design review: decisions on the new onboarding");
  assert.equal(plainTitle("Email bob@example.com about [the deck]"), "Email bob@example.com about [the deck]");
});

test("a capture titled from a mention still drops the repeated opening", () => {
  const body = `[@Priya Shah](athena://person/${ID}) wants a lighter cadence, biweekly instead of weekly.`;
  const parts = noteParts({ id: "n", title: `${body.slice(0, 77)}...`, body, type: "capture", source: "manual", tags: [], created_at: "", updated_at: "" } as never);
  assert.ok(!parts.title.includes("@") && !parts.title.includes("athena://"), parts.title);
  assert.equal(parts.derived, true);
});

test("the busy sample day names its own weekday", () => {
  // Today a Sunday, so the busy day (yesterday) is a Saturday; then a Saturday, so it's a Friday.
  for (const [today, day] of [["2026-11-08", "Saturday"], ["2026-11-07", "Friday"], ["2026-11-10", "Monday"]]) {
    setSampleToday(today);
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const line = sampleDayNow(d.toISOString().slice(0, 10)).line ?? "";
    assert.match(line, new RegExp(`^A full ${day}:`), line);
  }
  setSampleToday(null);
});
