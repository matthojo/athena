// Run: npx tsx --test lib/places-visits.test.ts
// Merging Timeline, Swarm and visits added by hand, the naming order, the day's line, the note section and what the import accepts. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf,
  isPlacesQuestion,
  keepPlaces,
  knownPlaceFor,
  manualAsVisit,
  manualTimes,
  mergeManual,
  mergeVisits,
  metres,
  nameFor,
  placesLine,
  placesSectionIn,
  readManualVisit,
  readNominatim,
  readTimelineDays,
  withoutPlaces,
  withPlacesSection,
  type Checkin,
  type KnownPlace,
  type Visit,
} from "./places-visits";
import { keepImported } from "./youtube-takeout";
import type { TimelineVisit } from "./places-timeline";

const TZ = "Europe/London";
const DISHOOM = { lat: 51.5124, lng: -0.127 };
const lunch: TimelineVisit = { start: "2026-11-03T13:00:00.000Z", end: "2026-11-03T14:05:00.000Z", ...DISHOOM, place_id: "ChIJdishoom0000000001" };
const home: TimelineVisit = { start: "2026-11-03T00:00:00.000Z", end: "2026-11-03T08:40:00.000Z", lat: 51.556, lng: -0.147, kind: "home" };
const heath: TimelineVisit = { start: "2026-11-03T16:10:00.000Z", end: "2026-11-03T17:40:00.000Z", lat: 51.5608, lng: -0.1636, place_id: "ChIJheath00000000001" };
const checkin = (over: Partial<Checkin> = {}): Checkin => ({ id: "c1", at: "2026-11-03T13:08:00.000Z", lat: 51.51245, lng: -0.12705, venue: "Dishoom", venue_id: "4ac518cef964a520", category: "Indian Restaurant", town: "London", ...over });

test("merge: a check-in during a Timeline visit is that visit, with Swarm's name; others stand alone", () => {
  const v = mergeVisits([home, lunch, heath], [checkin(), checkin({ id: "c2", at: "2026-11-03T20:00:00.000Z", lat: 51.53, lng: -0.12, venue: "The Lexington", venue_id: "lex", category: "Pub" })]);
  assert.equal(v.length, 4);
  const l = v.find((x) => x.start === lunch.start)!;
  assert.equal(l.venue, "Dishoom");
  assert.equal(l.fsq, "4ac518cef964a520");
  assert.equal(l.gid, "ChIJdishoom0000000001");
  assert.equal(l.category, "food");
  assert.ok(l.timeline && l.swarm);
  const pub = v[v.length - 1];
  assert.deepEqual([pub.venue, pub.start, pub.end, pub.timeline], ["The Lexington", "2026-11-03T20:00:00.000Z", "2026-11-03T20:00:00.000Z", undefined]);
  // Too far (over 300 m) or outside the visit (plus 10 minutes): not merged.
  assert.equal(mergeVisits([lunch], [checkin({ lat: 51.52 })]).length, 2);
  assert.equal(mergeVisits([lunch], [checkin({ at: "2026-11-03T14:20:00.000Z" })]).length, 2);
  assert.equal(mergeVisits([lunch], [checkin({ at: "2026-11-03T14:12:00.000Z" })]).length, 1, "within the 10 minutes after");
  // Two check-ins in one visit: the nearer venue names it.
  const two = mergeVisits([lunch], [checkin({ id: "a", lat: 51.5135, venue: "Next door" }), checkin({ id: "b" })]);
  assert.equal(two.length, 1);
  assert.equal(two[0].venue, "Dishoom");
  assert.ok(metres(DISHOOM, { lat: 51.5135, lng: -0.127 }) > 100);
});

test("names, in the owner's order: Home and Work, a known Place, Swarm, the Takeout name, then the map", () => {
  const places: KnownPlace[] = [
    { id: "p-home", name: "Home" },
    { id: "p-mum", name: "Mum's", lat: 51.4, lng: -0.3 },
    { id: "p-dish", name: "Dishoom Covent Garden", lat: 51.51241, lng: -0.12702 },
    { id: "p-fsq", name: "The Lex", fsqs: ["lex"] },
    { id: "p-plain", name: "Gail's" },
  ];
  const v = (over: Partial<Visit>): Visit => ({ start: lunch.start, end: lunch.end, lat: 51.45, lng: -0.2, ...over });
  // Home stays Home, even with a café 50 m away.
  const h = v({ kind: "home", lat: 51.4, lng: -0.3 });
  assert.equal(knownPlaceFor(h, places)?.id, "p-home");
  assert.equal(nameFor(h, null, { name: "Café" }), "Home");
  // A known Place within 100 m beats Swarm's venue.
  const d = v({ ...DISHOOM, venue: "Dishoom" });
  assert.equal(knownPlaceFor(d, places)?.id, "p-dish");
  assert.equal(nameFor(d, knownPlaceFor(d, places), null), "Dishoom Covent Garden");
  // Same Foursquare id, wherever it is.
  assert.equal(knownPlaceFor(v({ fsq: "lex" }), places)?.id, "p-fsq");
  // A Place with the same name and no coordinates yet is taken.
  assert.equal(knownPlaceFor(v({ venue: "gail's" }), places)?.id, "p-plain");
  // No Place: Swarm, then the Takeout name, then a landmark, then an area.
  assert.equal(nameFor(v({ venue: "Dishoom", takeout: "Dishoom (old)" }), null, { name: "Map name" }), "Dishoom");
  assert.equal(nameFor(v({ takeout: "Hampstead Heath" }), null, { name: "Map name" }), "Hampstead Heath");
  assert.equal(nameFor(v({}), null, { name: "Primrose Hill", town: "London" }), "Primrose Hill");
  assert.equal(nameFor(v({}), null, { area: "Highgate" }), "Highgate");
  assert.equal(nameFor(v({}), null, null), null);
});

test("Nominatim's answer: a venue or park is a name, a street gives only its area", () => {
  assert.deepEqual(readNominatim({ category: "amenity", type: "restaurant", name: "Dishoom", address: { house_number: "12", road: "Upper St Martin's Lane", city: "London", postcode: "WC2H 9FB", suburb: "Covent Garden" } }), {
    name: "Dishoom",
    town: "London",
    address: "12 Upper St Martin's Lane, WC2H 9FB, London",
    category: "food",
  });
  assert.deepEqual(readNominatim({ category: "highway", type: "residential", name: "Elm Road", address: { road: "Elm Road", suburb: "Highgate", city: "London" } }), { area: "Highgate", town: "London", address: "Elm Road, London" });
  assert.equal(readNominatim({ error: "Unable to geocode" }), null);
  assert.equal(categoryOf("Coffee Shop"), "coffee");
  assert.equal(categoryOf("Cocktail Bar"), "drinks");
  assert.equal(categoryOf("Gastropub"), "food");
  assert.equal(categoryOf("Park"), undefined);
});

test("the line: meals by time, Home left out, repeats said once, long days shortened", () => {
  const at = (h: string, name: string, extra: Partial<Visit> = {}): Visit => ({ start: `2026-11-03T${h}:00.000Z`, end: `2026-11-03T${h}:00.000Z`, lat: 0, lng: 0, name, ...extra });
  assert.equal(placesLine([at("08:00", "Home", { kind: "home" }), at("13:00", "Dishoom", { category: "food" }), at("16:10", "Hampstead Heath"), at("19:00", "Home", { kind: "home" })], TZ), "Lunch at Dishoom, then Hampstead Heath");
  assert.equal(placesLine([at("08:00", "Gail's", { category: "coffee" }), at("09:30", "Work", { kind: "work" }), at("12:30", "Work", { kind: "work" }), at("19:30", "Dishoom", { category: "food" }), at("21:30", "The Lexington", { category: "drinks" })], TZ), "Coffee at Gail's, Work, dinner at Dishoom, then drinks at The Lexington");
  assert.equal(placesLine([at("00:00", "Home", { kind: "home" })], TZ), "Home all day");
  assert.equal(placesLine([at("16:00", "Dishoom", { category: "food" })], TZ), "Dishoom", "no meal at four");
  // BST: 12:30 UTC in July is 13:30 in London.
  assert.equal(placesLine([{ start: "2026-07-03T11:45:00.000Z", end: "2026-07-03T12:30:00.000Z", lat: 0, lng: 0, name: "Dishoom", category: "food" }], TZ), "Lunch at Dishoom");
  const many = ["A", "B", "C", "D", "E", "F", "G", "H"].map((n, i) => at(`1${i}:00`, n));
  assert.equal(placesLine(many, TZ), "A, B, C, D, E, F and 2 more");
  assert.equal(placesLine([at("10:00", "X"), { ...at("11:00", "unnamed"), name: undefined }], TZ), "X");
  assert.equal(placesLine([], TZ), null);
});

test("the note: Places goes under Health, comes back after a Life log rewrite, and Ask doesn't see it", () => {
  const lines = ["Lunch at Dishoom, then Hampstead Heath", "14° and rain in London"];
  const withHealth = withPlacesSection("## Health\n7h 40m sleep · 9,200 steps\n\n## Notes\nA good day.", lines);
  assert.equal(withHealth, "## Health\n7h 40m sleep · 9,200 steps\n\n## Places\nLunch at Dishoom, then Hampstead Heath\n14° and rain in London\n\n## Notes\nA good day.");
  assert.equal(withPlacesSection("A good day.", lines), "## Places\nLunch at Dishoom, then Hampstead Heath\n14° and rain in London\n\nA good day.");
  assert.deepEqual(placesSectionIn(withHealth), lines);
  assert.equal(withPlacesSection(withHealth, lines), withHealth, "unchanged when the same");
  assert.equal(withPlacesSection(withHealth, null), "## Health\n7h 40m sleep · 9,200 steps\n\n## Notes\nA good day.");
  // A Life log run rewrites the day: through the shared keepers, the section stays and a made-up one is replaced.
  const run = "## Places\nSomewhere the run made up\n\n## Watched\n- Severance";
  const saved = keepImported(withHealth, run);
  assert.deepEqual(placesSectionIn(saved), lines);
  assert.ok(!saved.includes("made up"));
  assert.equal(keepPlaces("No places here", "Run text"), "Run text");
  // Ask.
  assert.equal(withoutPlaces(withHealth), "## Health\n7h 40m sleep · 9,200 steps\n\n## Notes\nA good day.");
  assert.ok(isPlacesQuestion("Where did I have lunch last Tuesday?"));
  assert.ok(isPlacesQuestion("What was the weather like on my birthday?"));
  assert.ok(!isPlacesQuestion("What did I decide about the budget?"));
});

test("the import takes only visits, only these fields, each on its own day", () => {
  const ctx = { tz: TZ, today: "2026-11-07" };
  const ok = readTimelineDays({ days: [{ date: "2026-11-03", visits: [lunch, { ...lunch, start: "2026-11-03T15:00:00Z", end: "2026-11-03T15:02:00Z" }] }] }, ctx);
  assert.equal(ok[0].visits.length, 1, "a two-minute stop is dropped");
  assert.equal(ok[0].visits[0].lat, 51.5124);
  const refused = (body: unknown) => assert.throws(() => readTimelineDays(body, ctx), /./);
  refused({ days: [{ date: "2026-11-03", visits: [{ ...lunch, address: "12 Upper St Martin's Lane" }] }] });
  refused({ days: [{ date: "2026-11-04", visits: [lunch] }] });
  refused({ days: [{ date: "2026-11-09", visits: [] }] });
  refused({ days: [{ date: "2026-11-03", visits: [{ ...lunch, lat: 123 }] }] });
  refused({ days: [{ date: "2026-11-03", visits: [{ ...lunch, kind: "school" }] }] });
  refused({ days: Array.from({ length: 32 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, visits: [] })) });
  refused({});
});

test("a visit added by hand: a saved Place or an address, a day up to today, a time and minutes", () => {
  const ctx = { today: "2026-11-07" };
  const place = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  assert.deepEqual(readManualVisit({ date: "2026-11-03", time: "12:40", minutes: 75, place_id: place }, ctx), { date: "2026-11-03", time: "12:40", minutes: 75, place_id: place });
  assert.deepEqual(readManualVisit({ time: "09:05", minutes: "30", address: "  1 Silk Street,   London EC2Y 8DS ", name: " Barbican " }, ctx), { date: "2026-11-07", time: "09:05", minutes: 30, address: "1 Silk Street, London EC2Y 8DS", name: "Barbican" });
  const refused = (body: unknown, re: RegExp) => assert.throws(() => readManualVisit(body, ctx), re);
  refused({ date: "2026-11-08", time: "12:00", minutes: 30, place_id: place }, /hasn't happened/);
  refused({ date: "2026-11-03", time: "25:00", minutes: 30, place_id: place }, /time/);
  refused({ date: "2026-11-03", time: "12:00", minutes: 0, place_id: place }, /minutes/);
  refused({ date: "2026-11-03", time: "12:00", minutes: 1441, place_id: place }, /minutes/);
  refused({ date: "2026-11-03", time: "12:00", minutes: 30 }, /Pick a Place or type an address/);
  refused({ date: "2026-11-03", time: "12:00", minutes: 30, place_id: place, address: "1 Silk Street" }, /not both/);
  refused({ date: "2026-11-03", time: "12:00", minutes: 30, place_id: "dishoom" }, /isn't a Place/);
  refused({ date: "2026-11-03", time: "12:00", minutes: 30, address: "1 Silk Street", lat: 51.5 }, /Unknown field lat/);
  refused(null, /JSON/);
});

test("a visit added by hand: the arrival in the owner's zone, a stop of its own, named by its Place", () => {
  // 12:40 in London in November is 12:40 UTC; in June it's 11:40 UTC.
  assert.deepEqual(manualTimes({ date: "2026-11-03", time: "12:40", minutes: 75 }, TZ), { start: "2026-11-03T12:40:00.000Z", end: "2026-11-03T13:55:00.000Z" });
  assert.equal(manualTimes({ date: "2026-06-03", time: "12:40", minutes: 30 }, TZ).start, "2026-06-03T11:40:00.000Z");
  const v = manualAsVisit({ id: "m1", start: "2026-11-03T12:40:00.000Z", end: "2026-11-03T13:55:00.000Z", ...DISHOOM, place: "p-dishoom", name: "Dishoom" });
  assert.equal(v.manual, true);
  assert.equal(v.place, "p-dishoom");
  assert.equal("address" in v, false, "nothing undefined is kept");
  const places: KnownPlace[] = [{ id: "p-dishoom", name: "Dishoom", ...DISHOOM }];
  assert.equal(nameFor(v, knownPlaceFor(v, places), null), "Dishoom");
  // A typed address with a name, nowhere near a known Place: the name it was given.
  const typed = manualAsVisit({ id: "m2", start: "2026-11-03T16:00:00.000Z", end: "2026-11-03T17:00:00.000Z", lat: 51.52, lng: -0.094, name: "Barbican", address: "Silk Street" });
  assert.equal(knownPlaceFor(typed, places), null);
  assert.equal(nameFor(typed, null, null), "Barbican");
  assert.equal(placesLine([{ ...v, name: "Dishoom" }, { ...typed, name: "Barbican" }], TZ), "Dishoom, then Barbican");
});

test("a visit added by hand that overlaps a Timeline visit or a check-in there is that stop; otherwise a stop of its own", () => {
  const timeline = mergeVisits([{ start: "2026-11-03T12:30:00.000Z", end: "2026-11-03T14:00:00.000Z", lat: 51.5130, lng: -0.1270, name: "Somewhere" }], []);
  const byHand = { id: "m1", start: "2026-11-03T12:40:00.000Z", end: "2026-11-03T13:55:00.000Z", ...DISHOOM, place: "p-dishoom", name: "Dishoom" };
  // ~65 m and inside the Timeline visit: one stop, the Timeline's times, the Place it was added to.
  let stops = mergeManual(timeline, [byHand]);
  assert.equal(stops.length, 1);
  assert.deepEqual(
    { start: stops[0].start, end: stops[0].end, place: stops[0].place, venue: stops[0].venue, manual: stops[0].manual, ids: stops[0].manual_ids, timeline: stops[0].timeline },
    { start: "2026-11-03T12:30:00.000Z", end: "2026-11-03T14:00:00.000Z", place: "p-dishoom", venue: "Dishoom", manual: true, ids: ["m1"], timeline: true }
  );
  assert.equal(timeline[0].manual, undefined, "the stops given are left as they were");
  // Without it again, the Timeline visit is as it was.
  assert.deepEqual(mergeManual(timeline, []), timeline);
  // Ten minutes either side still counts; more doesn't.
  assert.equal(mergeManual(timeline, [{ ...byHand, start: "2026-11-03T14:08:00.000Z", end: "2026-11-03T15:00:00.000Z" }]).length, 1);
  assert.equal(mergeManual(timeline, [{ ...byHand, start: "2026-11-03T14:15:00.000Z", end: "2026-11-03T15:00:00.000Z" }]).length, 2);
  // Over 300 m away at the same time: two stops.
  stops = mergeManual(timeline, [{ ...byHand, lat: 51.52, lng: -0.094 }]);
  assert.equal(stops.length, 2);
  assert.equal(stops[1].manual_ids?.[0], "m1");
  // A check-in is a moment: the visit by hand gives the stop its length, and the venue keeps its name.
  const checkin = mergeVisits([], [{ id: "c1", at: "2026-11-03T13:00:00.000Z", ...DISHOOM, venue: "Dishoom Covent Garden", venue_id: "fsq1" }]);
  stops = mergeManual(checkin, [byHand]);
  assert.equal(stops.length, 1);
  assert.deepEqual([stops[0].start, stops[0].end, stops[0].venue, stops[0].place, stops[0].swarm], ["2026-11-03T12:40:00.000Z", "2026-11-03T13:55:00.000Z", "Dishoom Covent Garden", "p-dishoom", true]);
  // A typed address with a name merged into a Timeline visit with none: the name it was given, and the address kept.
  stops = mergeManual(timeline, [{ id: "m2", start: byHand.start, end: byHand.end, ...DISHOOM, name: "Lunch spot", address: "12 Upper St Martin's Lane" }]);
  assert.deepEqual([stops[0].venue, stops[0].address, "place" in stops[0]], ["Lunch spot", "12 Upper St Martin's Lane", false]);
});
