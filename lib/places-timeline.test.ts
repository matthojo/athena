// Run: npx tsx --test lib/places-timeline.test.ts
// The Google Maps Timeline parser on synthetic files in lib/fixtures/: the phone export (Android and iPhone shapes) and Takeout's Semantic Location History.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { batchVisitDays, groupVisitsByDay, mergeParses, parseTimeline, readLatLng, TAKEOUT_MONTH, TimelineError } from "./places-timeline";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("phone export (Android): visits only, Home and Work, no routes, no places inside places, no short stops", () => {
  const p = parseTimeline(fixture("timeline-android.json"));
  assert.equal(p.format, "phone");
  assert.equal(p.visits.length, 4, "home, work, lunch, heath (the level-1 child and the 3-minute stop are left out)");
  assert.deepEqual(p.visits[0], { start: "2026-11-03T00:00:00.000Z", end: "2026-11-03T08:40:00.000Z", lat: 51.556, lng: -0.147, place_id: "ChIJhome0000000000001", kind: "home" });
  assert.equal(p.visits[1].kind, "work", "INFERRED_WORK is Work");
  assert.equal(p.visits[2].kind, undefined);
  assert.equal(p.visits[2].name, undefined, "the phone export has no names");
  assert.equal(p.other, 2, "the activity and the route are counted, not kept");
  for (const v of p.visits) assert.deepEqual(Object.keys(v).filter((k) => !["start", "end", "lat", "lng", "place_id", "kind", "name"].includes(k)), []);
});

test("phone export (iPhone): a bare array, placeID, geo: strings and numbers as text", () => {
  const p = parseTimeline(fixture("timeline-ios.json"));
  assert.equal(p.format, "phone");
  assert.equal(p.visits.length, 2);
  assert.deepEqual(p.visits[0], { start: "2026-11-04T08:12:00.000Z", end: "2026-11-04T12:30:00.000Z", lat: 51.5136, lng: -0.1366, place_id: "ChIJwork0000000000001", kind: "work" });
  assert.equal(p.visits[1].place_id, "ChIJdishoom0000000001");
});

test("Takeout's Semantic Location History: E7 coordinates, millisecond and ISO times, names, TYPE_HOME", () => {
  const p = parseTimeline(fixture("timeline-takeout-2019_JULY.json"));
  assert.equal(p.format, "takeout");
  assert.equal(p.visits.length, 2);
  assert.deepEqual(p.visits[0], { start: "2019-07-06T09:00:00.000Z", end: "2019-07-06T11:00:00.000Z", lat: 51.5608, lng: -0.1636, place_id: "ChIJheath00000000001", name: "Hampstead Heath" });
  assert.equal(p.visits[1].kind, "home");
  assert.equal(p.visits[1].name, undefined, "no address is ever kept");
  assert.ok(TAKEOUT_MONTH.test("Takeout/Location History (Timeline)/Semantic Location History/2019/2019_JULY.json"));
});

test("files that aren't a Timeline say which mistake it is", () => {
  const code = (text: string) => {
    try {
      parseTimeline(text);
      return "parsed";
    } catch (e) {
      return e instanceof TimelineError ? e.code : "other";
    }
  };
  assert.equal(code(fixture("timeline-records.json")), "raw_records");
  assert.equal(code("{}"), "not_timeline");
  assert.equal(code("[1,2,3]"), "not_timeline");
  assert.equal(code("not json"), "bad_json");
});

test("coordinates: degree strings, geo: URIs and E7, checked and rounded", () => {
  assert.deepEqual(readLatLng("51.5073219°, -0.1276474°"), [51.50732, -0.12765]);
  assert.deepEqual(readLatLng("geo:51.5,-0.12"), [51.5, -0.12]);
  assert.deepEqual(readLatLng({ latitudeE7: 515073219, longitudeE7: -1276474 }), [51.50732, -0.12765]);
  assert.equal(readLatLng("91°, 0°"), null);
  assert.equal(readLatLng("0°, 0°"), null, "null island is a missing fix");
  assert.equal(readLatLng(42), null);
});

test("several files: one list, the same visit twice kept once; days in the owner's zone; whole days per batch", () => {
  const a = parseTimeline(fixture("timeline-android.json"));
  const merged = mergeParses([a, a, parseTimeline(fixture("timeline-ios.json"))]);
  assert.equal(merged.visits.length, 6);
  const days = groupVisitsByDay(merged.visits, "Europe/London");
  assert.deepEqual(days.map((d) => [d.date, d.visits.length]), [["2026-11-03", 4], ["2026-11-04", 2]]);
  // Midnight UTC on 3 Nov is still 2 Nov in New York.
  assert.equal(groupVisitsByDay(merged.visits, "America/New_York")[0].date, "2026-11-02");
  const batches = batchVisitDays([...days, ...days.map((d) => ({ ...d, date: d.date.replace("11-0", "11-1") }))], 3, 100);
  assert.deepEqual(batches.map((b) => b.length), [3, 1]);
  assert.deepEqual(batchVisitDays(days, 31, 5).map((b) => b.length), [1, 1], "a batch never splits a day, and stays under the visit cap");
});
