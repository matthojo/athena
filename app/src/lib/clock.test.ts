// One clock-time format for the app (app/src/lib/clock.ts): the 12/24 choice is passed in, never the machine's.
// Run: npx tsx --test app/src/lib/clock.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clockInText, clockOfDay, clockSpan, clockTime, setUses12Hour, uses12Hour } from "./clock";

test("clockOfDay: 24-hour keeps HH:MM, padded", () => {
  assert.equal(clockOfDay("16:00", false), "16:00");
  assert.equal(clockOfDay("9:05", false), "09:05");
  assert.equal(clockOfDay("00:00", false), "00:00");
  assert.equal(clockOfDay("22:43:10", false), "22:43");
});

test("clockOfDay: 12-hour is lowercase am/pm after one plain space, no leading zero", () => {
  assert.equal(clockOfDay("21:58", true), "9:58 pm");
  assert.equal(clockOfDay("23:30", true), "11:30 pm");
  assert.equal(clockOfDay("08:00", true), "8:00 am");
  assert.equal(clockOfDay("00:05", true), "12:05 am");
  assert.equal(clockOfDay("12:00", true), "12:00 pm");
  assert.doesNotMatch(clockOfDay("21:58", true), /PM| | |\dpm/);
});

test("clockOfDay: what isn't a time of day comes back as it was", () => {
  assert.equal(clockOfDay(null, true), "");
  assert.equal(clockOfDay(undefined, false), "");
  assert.equal(clockOfDay("All day", true), "All day");
  assert.equal(clockOfDay("25:00", true), "25:00");
});

test("clockTime: an instant in a named zone, both clocks", () => {
  const at = "2026-11-23T22:43:00Z";
  assert.equal(clockTime(at, { hour12: false, timeZone: "Europe/London" }), "22:43");
  assert.equal(clockTime(at, { hour12: true, timeZone: "Europe/London" }), "10:43 pm");
  assert.equal(clockTime(at, { hour12: false, timeZone: "Europe/Paris" }), "23:43");
  assert.equal(clockTime(at, { hour12: true, timeZone: "America/New_York" }), "5:43 pm");
  assert.equal(clockTime(new Date(at), { hour12: false, timeZone: "UTC" }), "22:43");
  assert.equal(clockTime(Date.parse(at), { hour12: true, timeZone: "UTC" }), "10:43 pm");
  assert.equal(clockTime("2026-11-23T00:07:00Z", { hour12: false, timeZone: "UTC" }), "00:07");
});

test("clockTime: without a zone it reads the device's own hours", () => {
  const d = new Date(2026, 10, 23, 21, 58);
  assert.equal(clockTime(d, { hour12: false }), "21:58");
  assert.equal(clockTime(d, { hour12: true }), "9:58 pm");
  assert.equal(clockTime("not a date", { hour12: true }), "");
});

test("clockSpan: both ends the same way", () => {
  assert.equal(clockSpan("09:00", "10:30", false), "09:00–10:30");
  assert.equal(clockSpan("09:00", "13:30", true), "9:00 am–1:30 pm");
});

test("uses12Hour: can be pinned, and every default follows it", () => {
  try {
    setUses12Hour(true);
    assert.equal(uses12Hour(), true);
    assert.equal(clockOfDay("16:00"), "4:00 pm");
    assert.equal(clockTime("2026-11-23T16:00:00Z", { timeZone: "UTC" }), "4:00 pm");
    setUses12Hour(false);
    assert.equal(uses12Hour(), false);
    assert.equal(clockOfDay("16:00"), "16:00");
    assert.equal(clockTime("2026-11-23T16:00:00Z", { timeZone: "UTC" }), "16:00");
  } finally {
    setUses12Hour(null);
  }
  assert.equal(typeof uses12Hour(), "boolean");
});

test("clockInText: the 24-hour times in a shared sentence, the device's way", () => {
  assert.equal(clockInText("Lands 14:10", true), "Lands 2:10 pm");
  assert.equal(clockInText("Tue 3 Nov 07:10, not 06:55", true), "Tue 3 Nov 7:10 am, not 6:55 am");
  assert.equal(clockInText("National Rail, checked at 09:41", false), "National Rail, checked at 09:41");
  assert.equal(clockInText("Ran for 1:05:30 at 2:1", true), "Ran for 1:05:30 at 2:1", "not a clock time: left alone");
});
