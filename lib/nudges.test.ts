// Settings → Notifications rules: times in the owner's zone, quiet hours, the evening Days prompt.
// Run: npx tsx --test lib/nudges.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, dayKept, eveningLine, eveningPrompt, firstHighlight, firstNameOf, inQuietHours, isEveningTime, keptLead, mergePrefs, privatePlace, publicPlaces, quoteOf, readPrefs, weekMonday } from "./nudges";

const LONDON = "Europe/London";

test("evening time is 21:00 on the owner's wall clock, either side of a clock change", () => {
  // Saturday 24 Oct 2026 is BST (UTC+1): 21:00 local is 20:00 UTC.
  assert.equal(isEveningTime(new Date("2026-10-24T19:59:00Z"), LONDON, "21:00"), false);
  assert.equal(isEveningTime(new Date("2026-10-24T20:00:00Z"), LONDON, "21:00"), true);
  // The clocks go back at 02:00 on Sunday 25 Oct: 21:00 local is now 21:00 UTC.
  assert.equal(isEveningTime(new Date("2026-10-25T20:30:00Z"), LONDON, "21:00"), false);
  assert.equal(isEveningTime(new Date("2026-10-25T21:00:00Z"), LONDON, "21:00"), true);
  // And forward again in March (29 Mar 2026, GMT → BST).
  assert.equal(isEveningTime(new Date("2026-03-28T21:00:00Z"), LONDON, "21:00"), true);
  assert.equal(isEveningTime(new Date("2026-03-29T19:59:00Z"), LONDON, "21:00"), false);
  assert.equal(isEveningTime(new Date("2026-03-29T20:00:00Z"), LONDON, "21:00"), true);
});

test("evening time follows the owner when they travel", () => {
  // 21:00 in New York (EST, UTC-5) is 02:00 UTC the next day.
  assert.equal(isEveningTime(new Date("2026-11-08T01:59:00Z"), "America/New_York", "21:00"), false);
  assert.equal(isEveningTime(new Date("2026-11-08T02:00:00Z"), "America/New_York", "21:00"), true);
  // A different time the owner picked.
  assert.equal(isEveningTime(new Date("2026-11-07T19:30:00Z"), LONDON, "19:30"), true);
  assert.equal(isEveningTime(new Date("2026-11-07T19:29:00Z"), LONDON, "19:30"), false);
});

test("quiet hours: across midnight, within a day, and off", () => {
  const night = { from: "22:00", to: "07:00" };
  assert.equal(inQuietHours(new Date("2026-11-07T21:59:00Z"), LONDON, night), false);
  assert.equal(inQuietHours(new Date("2026-11-07T22:00:00Z"), LONDON, night), true);
  assert.equal(inQuietHours(new Date("2026-11-08T03:00:00Z"), LONDON, night), true);
  assert.equal(inQuietHours(new Date("2026-11-08T06:59:00Z"), LONDON, night), true);
  assert.equal(inQuietHours(new Date("2026-11-08T07:00:00Z"), LONDON, night), false);
  // In BST the same wall-clock hours sit an hour earlier in UTC.
  assert.equal(inQuietHours(new Date("2026-07-01T21:30:00Z"), LONDON, night), true);
  assert.equal(inQuietHours(new Date("2026-07-01T06:30:00Z"), LONDON, night), false);
  const afternoon = { from: "13:00", to: "15:00" };
  assert.equal(inQuietHours(new Date("2026-11-07T14:00:00Z"), LONDON, afternoon), true);
  assert.equal(inQuietHours(new Date("2026-11-07T15:00:00Z"), LONDON, afternoon), false);
  assert.equal(inQuietHours(new Date("2026-11-07T03:00:00Z"), LONDON, null), false);
});

test("the evening prompt is skipped once the day is kept", () => {
  assert.equal(dayKept(null), false);
  assert.equal(dayKept({}), false);
  assert.equal(dayKept({ mood: 4 }), true);
  assert.equal(dayKept({ line: "Long walk by the river", line_by: "owner" }), true);
  assert.equal(dayKept({ journal: "Tired but good." }), true);
  // A line Athena wrote from the day's sources isn't the owner keeping it.
  assert.equal(dayKept({ line: "Watched Severance, 9,000 steps", line_by: "run" }), false);
  assert.equal(dayKept({ line: "  ", line_by: "owner" }), false);
});

test("the prompt names the day's first highlight, never health or places, and opens today's mood", () => {
  const day = {
    entries: [
      { title: "Morning run", source: "health", at: "2026-11-07T07:00:00Z" },
      { title: "Café Nero", source: "places", at: "2026-11-07T08:00:00Z" },
      { title: "Severance", source: "trakt", at: "2026-11-07T20:00:00Z" },
      { title: "Blackstar", source: "lastfm", at: "2026-11-07T09:00:00Z" },
    ],
    events: [{ title: "Lunch with Priya" }],
  };
  assert.equal(firstHighlight(day), "Blackstar");
  assert.equal(firstHighlight({ entries: [], events: [{ title: "Lunch with Priya" }] }), "Lunch with Priya");
  assert.equal(firstHighlight({}), null);
  const p = eveningPrompt("2026-11-07", day);
  assert.deepEqual(p, { title: "How was today?", body: "Blackstar. How was it?", url: "/#/days/2026-11-07?mood", tag: "evening-2026-11-07" });
  assert.equal(eveningPrompt("2026-11-07", null).body, "Add a mood or a line before the day ends.");
});

// ---------- The day handed back (moment 1) ----------

const priya = { name: "Priya Shah", in_person: true, place: "Dishoom" };

test("the evening line leads with a person seen, then a named place, then a highlight", () => {
  const day = {
    places_line: "Work, lunch at Dishoom, then Hampstead Heath",
    entries: [{ title: "Severance", source: "trakt", kind: "watched", at: "2026-11-10T20:00:00Z" }],
  };
  assert.equal(eveningLine(day, [priya]), "Lunch with Priya at Dishoom, then Hampstead Heath");
  // No places line (a push): the event's own place.
  assert.equal(eveningLine({ entries: day.entries }, [priya]), "Saw Priya at Dishoom");
  // Seen with nowhere public: just who.
  assert.equal(eveningLine({}, [{ name: "Priya Shah", in_person: true }, { name: "Tom Hale", in_person: true }]), "Time with Priya and Tom");
  assert.equal(eveningLine({}, [{ name: "Mum", in_person: false }]), "A call with Mum");
  // Nobody: the places.
  assert.equal(eveningLine(day), "Lunch at Dishoom, then Hampstead Heath");
  assert.equal(eveningLine({ places_line: "Barbican, Brick Lane, then Columbia Road" }), "Barbican, Brick Lane, then Columbia Road");
  // Nobody, nowhere: the highlight, with a verb.
  assert.equal(eveningLine({ entries: day.entries }), "Watched Severance");
  assert.equal(eveningLine({ events: [{ title: "Pottery class" }] }), "Pottery class");
  assert.equal(eveningLine({}), null);
  assert.equal(eveningLine(null), null);
});

test("the evening line groups who was met by place, says how, and leaves calls out when someone was seen", () => {
  const lunch = { name: "Priya Shah", in_person: true, place: "Dishoom", how: "Lunch" };
  const gallery = { name: "Tom Hale", in_person: true, place: "Barbican Centre", how: "Gallery" };
  const call = { name: "Marcus Webb", in_person: false, how: "Video call" };
  assert.equal(eveningLine({}, [lunch]), "Lunch with Priya at Dishoom");
  assert.equal(eveningLine({ places_line: "Hampstead Heath" }, [lunch, call, gallery]), "Lunch with Priya at Dishoom, Tom at the Barbican, then Hampstead Heath");
  assert.equal(eveningLine({}, [{ name: "Ana", in_person: true, place: "Dishoom" }, { ...lunch }]), "Saw Ana and Priya at Dishoom");
  // An event's title is its how.
  assert.equal(eveningLine({}, [{ name: "Priya Shah", in_person: true, place: "Dishoom", how: "Dinner with Priya" }]), "Dinner with Priya at Dishoom");
  // Seen without a place: never placed by the phone's location.
  assert.equal(eveningLine({ places_line: "Lunch at Dishoom, then Hampstead Heath" }, [{ name: "Priya", in_person: true }]), "Time with Priya, lunch at Dishoom, then Hampstead Heath");
});

test("the evening line never names home, health, money or an undone habit", () => {
  assert.equal(eveningLine({ places_line: "Home all day" }), null);
  assert.equal(eveningLine({ places_line: "St Thomas' Hospital, then Barclays Bank" }), null);
  assert.equal(eveningLine({ places_line: "Work, then Mum's house" }), null);
  // A person seen at a clinic: the person, never the clinic.
  assert.equal(eveningLine({}, [{ name: "Priya", in_person: true, place: "Harley Street Clinic" }]), "Time with Priya");
  // Workouts (health) and habits are never the highlight.
  const habitsOnly = { entries: [{ title: "Evening walk", source: "athena", kind: "habit", count: 0 }, { title: "5 km run", source: "health" }] };
  assert.equal(eveningLine(habitsOnly), null);
  assert.equal(eveningPrompt("2026-11-10", habitsOnly).body, "Add a mood or a line before the day ends.");
});

test("the push carries first names and public places only, never the places line", () => {
  const day = { places_line: "Lunch at Dishoom, then Hampstead Heath", entries: [] };
  assert.equal(eveningPrompt("2026-11-10", day, [priya]).body, "Saw Priya at Dishoom. How was it?");
  // Location history is sealed: without people, the push doesn't read it.
  assert.equal(eveningPrompt("2026-11-10", day).body, "Add a mood or a line before the day ends.");
  assert.ok(!eveningPrompt("2026-11-10", day, [priya]).body.includes("Shah"));
});

test("names and places: first names, private places spotted", () => {
  assert.equal(firstNameOf("Priya Shah"), "Priya");
  assert.equal(firstNameOf("Dr Ana Lopez"), "Ana");
  assert.equal(firstNameOf("Mum"), "Mum");
  for (const p of ["Home", "Work", "Mum's house", "The Riverside Clinic", "Boots Pharmacy", "NatWest Bank", "Guy's Hospital", "Ladbrokes Bookmakers"]) assert.ok(privatePlace(p), p);
  for (const p of ["Dishoom", "Hampstead Heath", "Barbican", "The Royal Oak"]) assert.ok(!privatePlace(p), p);
  assert.deepEqual(publicPlaces("Work, coffee at Monmouth, then Hampstead Heath and 2 more"), ["Coffee at Monmouth", "Hampstead Heath"]);
});

test("the Kept toast quotes the owner's first 60 characters and names the day", () => {
  assert.equal(quoteOf("Felt like myself again."), "Felt like myself again.");
  const long = "Walked all the way home along the canal and stopped for chips at the end";
  const q = quoteOf(long);
  assert.ok(q.length <= 60, q);
  assert.equal(q, "Walked all the way home along the canal and stopped for…");
  assert.equal(keptLead("2026-11-10", [priya], "Lunch at Dishoom, then Hampstead Heath"), "Kept. Tuesday has Priya, Hampstead Heath and");
  assert.equal(keptLead("2026-11-10", [], "Lunch at Dishoom, then Hampstead Heath"), "Kept. Tuesday has Dishoom and");
  assert.equal(keptLead("2026-11-10", [], null), "Kept for Tuesday:");
});

test("prefs: defaults, a partial change, and bad input refused", () => {
  assert.deepEqual(readPrefs(null), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.evening, true);
  assert.equal(DEFAULT_PREFS.evening_at, "21:00");
  assert.deepEqual(readPrefs({ evening: false, evening_at: "25:00", quiet: { from: "22:00", to: "22:00" } }), { ...DEFAULT_PREFS, evening: false });
  const next = mergePrefs(DEFAULT_PREFS, { evening: false, quiet: { from: "22:30", to: "06:45" } });
  assert.deepEqual(next, { ...DEFAULT_PREFS, evening: false, quiet: { from: "22:30", to: "06:45" } });
  assert.deepEqual(mergePrefs(next, { quiet: null }).quiet, null);
  assert.throws(() => mergePrefs(DEFAULT_PREFS, { briefing: "yes" }), /briefing/);
  assert.throws(() => mergePrefs(DEFAULT_PREFS, { evening_at: "9pm" }), /evening_at/);
  assert.equal(DEFAULT_PREFS.morning_at, "07:00");
  assert.equal(mergePrefs(DEFAULT_PREFS, { morning: false, morning_at: "06:15" }).morning_at, "06:15");
  assert.throws(() => mergePrefs(DEFAULT_PREFS, { morning_at: "7am" }), /morning_at/);
  assert.throws(() => mergePrefs(DEFAULT_PREFS, { morning: "on" }), /morning/);
  assert.equal(readPrefs({ morning_at: "25:00" }).morning_at, "07:00");
  assert.throws(() => mergePrefs(DEFAULT_PREFS, { quiet: { from: "22:00" } }), /quiet/);
});

test("the weekly review opens the week from its Monday", () => {
  assert.equal(weekMonday("2026-11-08"), "2026-11-02"); // Sunday
  assert.equal(weekMonday("2026-11-02"), "2026-11-02"); // Monday
  assert.equal(weekMonday("2026-11-07"), "2026-11-02"); // Saturday
});

test("the evening line says venues the way people do (lib/day-words.ts)", () => {
  assert.equal(eveningLine({ places_line: "Barbican Centre, then dinner at Dishoom" }), "The Barbican, then dinner at Dishoom");
  assert.equal(eveningLine({ places_line: "Lunch at Dishoom, then British Museum" }), "Lunch at Dishoom, then the British Museum");
  assert.equal(eveningLine(null, [{ name: "Tom Reid", in_person: true, place: "Barbican Centre" }]), "Saw Tom at the Barbican");
  assert.equal(eveningLine(null, [{ name: "Priya", in_person: true, place: "Dishoom", how: "Lunch" }]), "Lunch with Priya at Dishoom");
});
