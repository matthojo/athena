// Run: npx tsx --test lib/day-hours.test.ts
// Plays per hour on a Days entry (lib/day-hours.ts): only 24 whole counts with a play are kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPlay, emptyHours, hourOf, readHours, sameHours } from "./day-hours";

test("hours: 24 whole counts with at least one play, as an array or its JSON", () => {
  const h = emptyHours();
  h[20] = 3;
  assert.deepEqual(readHours(h), h);
  assert.deepEqual(readHours(JSON.stringify(h)), h);
  for (const bad of [emptyHours(), h.slice(0, 23), [...h, 0], h.map((v, i) => (i === 2 ? -1 : v)), h.map((v, i) => (i === 2 ? 1.5 : v)), "nope", null, undefined, 7]) assert.equal(readHours(bad), undefined, JSON.stringify(bad));
});

test("a play's hour from its local time", () => {
  assert.equal(hourOf("08:15"), 8);
  assert.equal(hourOf("23:59:10"), 23);
  assert.equal(hourOf("0:05"), 0);
  for (const bad of ["24:00", "8pm", "", undefined, 8]) assert.equal(hourOf(bad), undefined, String(bad));
  const h = addPlay(addPlay(addPlay(emptyHours(), 8), 8), undefined);
  assert.equal(h[8], 2);
  assert.ok(sameHours(h, [...h]));
  assert.ok(!sameHours(h, null));
});

test("foldHours: local times or instants in the owner's zone", async () => {
  const { foldHours, playHour } = await import("./day-hours");
  assert.equal(playHour("2026-07-01T19:30:00Z", "Europe/London"), 20, "BST");
  assert.equal(playHour("2026-12-01T19:30:00Z", "Europe/London"), 19, "GMT");
  assert.equal(playHour(Date.parse("2026-12-01T23:10:00Z"), "Asia/Tokyo"), 8);
  assert.equal(playHour("21:05"), 21);
  const h = foldHours(["08:01", "2026-12-01T08:59:00Z", null, "nonsense"], "Europe/London")!;
  assert.equal(h[8], 2);
  assert.equal(h.reduce((a, b) => a + b, 0), 2);
  assert.equal(foldHours([null, "x"]), undefined);
});
