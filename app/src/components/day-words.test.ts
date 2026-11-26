// Run: npx tsx --test app/src/components/day-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  alsoSummary,
  count,
  dayFigures,
  fallbackLine,
  groupEntries,
  healthSentences,
  heatLevel,
  hoursMinutes,
  kindSummary,
  lifeLogDate,
  list,
  longDate,
  monthGrid,
  moodWord,
  nextMonth,
  relativeDay,
  sameDayEarlier,
  weekStart,
  workoutPhrase,
  yearsAgo,
} from "./day-words";
import { glance, kindTotal, summaryFigures, addCounts, phaseAt, dayHighlight, listLine } from "./day-words";
import type { Day, DayCounts, DayEntry, DaySummary } from "../db/days-app";

const counts = (more: Partial<DayCounts> = {}): DayCounts => ({ entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0, ...more });
const blank = (date: string, more: Partial<Day> = {}): Day => ({ date, photos: [], places: [], entries: [], notes: [], events: [], counts: counts(), ...more });
const entry = (over: Partial<DayEntry>): DayEntry => ({ id: Math.random().toString(36), kind: "watched", source: "netflix", title: "X", ...over });

test("dates in words", () => {
  assert.equal(longDate("2026-11-06", "2026-11-07"), "Friday 6 November");
  assert.equal(longDate("2025-11-06", "2026-11-07"), "Thursday 6 November 2025");
  assert.equal(relativeDay("2026-11-07", "2026-11-07"), "Today");
  assert.equal(relativeDay("2026-11-06", "2026-11-07"), "Yesterday");
  assert.equal(relativeDay("2026-11-03", "2026-11-07"), "Tuesday");
  assert.equal(relativeDay("2026-10-20", "2026-11-07"), null);
  assert.equal(yearsAgo("2025-11-07", "2026-11-07"), "A year ago");
  assert.equal(yearsAgo("2023-11-07", "2026-11-07"), "3 years ago");
  assert.equal(weekStart("2026-11-08"), "2026-11-02");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
});

test("numbers and lists", () => {
  assert.equal(count(2), "two");
  assert.equal(count(14), "14");
  assert.equal(count(9412), "9,412");
  assert.equal(list(["a", "b", "c"]), "a, b and c");
  assert.equal(list(["a"]), "a");
  assert.equal(hoursMinutes(460), "7h 40m");
  assert.equal(hoursMinutes(45), "45 min");
  assert.equal(moodWord(4), "Good");
  assert.equal(moodWord(undefined), null);
});

test("watched in words: films and episodes of one show", () => {
  const es = [entry({ group: "Northern Lines" }), entry({ group: "Northern Lines" }), entry({ title: "Northbound", source: "letterboxd" })];
  assert.equal(kindSummary("watched", es), "One film and two episodes of Northern Lines");
  assert.equal(kindSummary("watched", [entry({ group: "A" }), entry({ group: "B" })]), "Two episodes across two shows");
});

test("listened in words, grouped by album with plays added up", () => {
  const es = [
    entry({ kind: "listened", group: "Tidal Hours", subtitle: "Mara Vell", count: 3 }),
    entry({ kind: "listened", group: "Tidal Hours", subtitle: "Mara Vell", count: 2 }),
    entry({ kind: "listened", group: "Soft Neon", subtitle: "Kaito Rhee", count: 1 }),
  ];
  assert.equal(kindSummary("listened", es), "Six plays across two artists");
  const groups = groupEntries(es);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].lead.group, "Tidal Hours");
  assert.equal(groups[0].total, 5);
});

test("figures for a card, most telling first", () => {
  const day = blank("2026-11-06", {
    health: { line: null, sleep_minutes: 460, steps: 9412, workouts: [{ type: "Running", minutes: 41, distance_m: 8240 }] },
    entries: [entry({ title: "Northbound", source: "letterboxd" })],
    photos: [{ id: "p", w: 4, h: 3, thumb: true, added_at: "2026-11-06T10:00:00Z" }],
  });
  assert.deepEqual(dayFigures(day), ["Slept 7h 40m", "ran 8.2 km", "one film", "one photo"]);
  assert.equal(workoutPhrase({ type: "Yoga", minutes: 40 }), "Yoga for 40 min");
});

test("a day without a line gets one from its things; a health-only day from its figures", () => {
  const busy = blank("2026-11-06", { entries: [entry({ group: "Northern Lines" }), entry({ kind: "read", title: "Small Hours" })], places: [{ name: "Home" }, { name: "Dishoom", minutes: 70 }] });
  assert.equal(fallbackLine(busy), "A quiet Friday: Dishoom, an episode of Northern Lines and reading Small Hours");
  // People and places lead, before media.
  const out = blank("2026-11-10", { places_line: "Lunch at Dishoom, then Hampstead Heath", entries: [entry({ group: "Harbour Street", count: 2 }), entry({ title: "Northbound", source: "letterboxd" })] });
  assert.equal(fallbackLine(out), "Lunch at Dishoom, then Hampstead Heath");
  assert.equal(fallbackLine(out, [{ name: "Priya Shah", in_person: true, place: "Dishoom" }]), "Lunch with Priya at Dishoom, then Hampstead Heath");
  assert.equal(fallbackLine(blank("2026-11-10", { entries: [entry({ title: "Northbound", source: "letterboxd" })] }), [{ name: "Tom Hale", in_person: true }]), "Time with Tom, and Northbound");
  assert.equal(fallbackLine(blank("2026-11-04", { health: { line: null, sleep_minutes: 512, steps: 3120 } })), "A quiet Wednesday: 8h 32m of sleep and 3,100 steps");
  const sat = blank("2026-11-07", {
    entries: [entry({ group: "The Glasshouse" }), entry({ kind: "read", title: "On Making Things Slowly" }), entry({ kind: "played", title: "Hollow Peaks", minutes: 124 })],
  });
  assert.equal(fallbackLine(sat), "A slow Saturday: an episode of The Glasshouse, reading On Making Things Slowly and two hours of Hollow Peaks");
  const run = blank("2026-11-06", { health: { line: null, workouts: [{ type: "Running", minutes: 41, distance_m: 8240 }] }, entries: Array.from({ length: 20 }, () => entry({ kind: "listened", subtitle: "Ostra" })) });
  assert.equal(fallbackLine(run), "A full Friday: an 8 km run and a lot of Ostra");
  const mid = blank("2026-11-03", { entries: Array.from({ length: 6 }, () => entry({ kind: "listened", subtitle: "Ostra" })) });
  assert.equal(fallbackLine(mid), "Tuesday: music by Ostra");
  assert.equal(listLine("A full Friday: a long run and Dishoom"), "A long run and Dishoom");
  assert.equal(listLine("Tuesday: music by Ostra"), "Music by Ostra");
  assert.equal(listLine("Lunch with Ana, then the Heath"), "Lunch with Ana, then the Heath");
  assert.equal(fallbackLine(blank("2026-11-04")), null);
});

test("health compared with the two weeks before", () => {
  const before = Array.from({ length: 10 }, () => ({ sleep_minutes: 420, steps: 8000, resting_hr: 58 }));
  const s = healthSentences({ sleep_minutes: 470, steps: 15000, resting_hr: 58 }, before);
  assert.deepEqual(
    s.map((x) => [x.text, x.aside]),
    [
      ["Slept 7h 50m", "50 min more than usual"],
      ["Walked 15,000 steps", "One of your busier days"],
      ["Resting heart rate 58", "Steady"],
    ]
  );
  // Too little history: no comparison.
  assert.equal(healthSentences({ sleep_minutes: 400 }, before.slice(0, 2))[0].aside, undefined);
});

test("sleep names deep sleep when the night has it (owner, 7 Nov)", () => {
  assert.equal(healthSentences({ sleep_minutes: 460, sleep_stages: { deep: 85, rem: 110, core: 265 } }, [])[0].text.replace(/\u00a0/g, " "), "Slept 7h 40m (1h 25m deep)");
  // Held together: a narrow row breaks before the bracket, never inside it.
  assert.match(healthSentences({ sleep_minutes: 460, sleep_stages: { deep: 85 } }, [])[0].text, /^Slept 7h 40m \(1h\u00a025m\u00a0deep\)$/);
  assert.equal(healthSentences({ sleep_minutes: 460 }, [])[0].text, "Slept 7h 40m");
  assert.equal(healthSentences({ sleep_minutes: 460, sleep_stages: { rem: 110 } }, [])[0].text, "Slept 7h 40m");
});

test("calendar: heat steps and month grids, Monday first", () => {
  assert.deepEqual([0, 1, 5, 12, 40].map(heatLevel), [0, 1, 2, 3, 4]);
  const nov = monthGrid("2026-11");
  assert.equal(nov[0].filter(Boolean)[0], "2026-11-01");
  assert.equal(nov[0].indexOf("2026-11-01"), 6); // 1 Nov 2026 is a Sunday
  assert.equal(nov.flat().filter(Boolean).length, 30);
  assert.ok(nov.every((w) => w.length === 7));
  assert.equal(nextMonth("2026-12"), "2027-01");
  assert.equal(nextMonth("2026-01", -1), "2025-12");
});

test("On this day: earlier years, 29 February falls back", () => {
  assert.deepEqual(sameDayEarlier("2026-11-07", 2), ["2025-11-07", "2024-11-07"]);
  assert.deepEqual(sameDayEarlier("2028-02-29", 1), ["2027-02-28"]);
});

test("an old Life log note opens its day", () => {
  const zone = (iso: string) => iso.slice(0, 10);
  assert.equal(lifeLogDate({ source: "life-log", tags: [], created_at: "2026-11-06T23:00:00Z", title: "Friday 6 November" }, zone), "2026-11-06");
  assert.equal(lifeLogDate({ source: null, tags: ["life-log"], created_at: "2026-11-05T10:00:00Z", title: "" }, zone), "2026-11-05");
  assert.equal(lifeLogDate({ source: "manual", tags: [], created_at: "2026-11-05T10:00:00Z", title: "" }, zone), null);
});

test("a summary's figures, from its counts", () => {
  const c = counts({ steps: 9412, by_kind: { watched: 3, listened: 41, read: 1, workout: 1 }, minutes: { watched: 156, listened: 140 }, photos: 2 });
  assert.deepEqual(summaryFigures(c), ["9,400 steps", "one workout", "2h 36m of watching", "2h 20m of music"]);
  assert.equal(kindTotal("listened", 12, 40), "12 plays");
  assert.equal(kindTotal("played", 1, 200, true), "3 hours of games");
  assert.equal(kindTotal("saved", 2, undefined), "two links saved");
  assert.deepEqual(summaryFigures(counts()), []);
});

test("a week at a glance, from summaries", () => {
  const s = (date: string, more: Partial<DaySummary>): DaySummary => ({ date, counts: counts(), art: [], journal: false, ...more });
  const days = [
    s("2026-11-02", { mood: 4, art: [{ id: "a", w: 2, h: 3 }], counts: counts({ by_kind: { watched: 2 }, minutes: { watched: 104 } }) }),
    s("2026-11-04", { mood: 4, art: [{ id: "a", w: 2, h: 3 }, { id: "b", w: 1, h: 1 }], counts: counts({ by_kind: { listened: 30, read: 1 }, minutes: { watched: 200 } }) }),
    s("2026-11-12", { mood: 1 }),
  ];
  const g = glance(days, "2026-11-02", "2026-11-08");
  assert.equal(g.days, 2);
  assert.deepEqual(g.moods, [4, null, 4, null, null, null, null]);
  assert.deepEqual(g.art.map((a) => a.id), ["a", "b"]);
  assert.equal(g.headline, "Mostly good days: 5 hours of watching, 30 plays and some reading");
  assert.equal(glance([], "2026-11-02", "2026-11-08").headline, "A quiet stretch");
  assert.equal(addCounts([counts({ steps: 10 }), counts({ steps: 5, photos: 1 })]).steps, 15);
});

test("Today's phase follows the clock", () => {
  const at = (h: number, m = 0) => phaseAt(new Date(2026, 10, 7, h, m));
  assert.deepEqual([at(6), at(10, 59), at(11), at(17, 59), at(18), at(23, 30)], ["morning", "morning", "day", "day", "evening", "evening"]);
});

test("the day's highlight: a well-rated film, then a binge, a long game or an album on repeat", () => {
  const art = { id: "x", w: 2, h: 3 };
  assert.equal(dayHighlight({ entries: [entry({ title: "Northbound", source: "letterboxd", rating: 4.5, art }), entry({ group: "S", art }), entry({ group: "S", art }), entry({ group: "S", art })] })?.why, "The day's film, rated 4½");
  assert.equal(dayHighlight({ entries: [entry({ group: "Northern Lines", art }), entry({ group: "Northern Lines", art }), entry({ group: "Northern Lines", art })] })?.why, "Three episodes");
  assert.equal(dayHighlight({ entries: [entry({ kind: "played", title: "Hollow Peaks", minutes: 200, art })] })?.why, "3 hours of play");
  assert.equal(dayHighlight({ entries: Array.from({ length: 9 }, () => entry({ kind: "listened", group: "Tidal Hours", art })) })?.title, "Tidal Hours");
  assert.equal(dayHighlight({ entries: [entry({ group: "S", art }), entry({ kind: "played", title: "G", minutes: 30, art })] }), null);
  assert.equal(dayHighlight({ entries: [entry({ title: "No art", rating: 5 })] }), null);
});

test("Also: TfL journeys, rides and takeaways in words, and a takeaway on the card", () => {
  const e = (source: string, group?: string) => ({ source, group });
  assert.equal(alsoSummary([e("tfl", "commute"), e("tfl", "commute"), e("uber", "Rides"), e("deliveroo", "Takeaway")]), "Two journeys, a ride and a takeaway");
  assert.equal(alsoSummary([e("bolt"), e("uber")]), "Two rides");
  assert.equal(alsoSummary([e("justeat"), e("swarm")]), "A takeaway and one other thing");
  assert.equal(alsoSummary([e("swarm")]), "One thing");
  const entries = [
    { id: "a", kind: "other" as const, source: "uber", title: "Covent Garden → Home", group: "Rides" },
    { id: "b", kind: "other" as const, source: "deliveroo", title: "Takeaway from Rosa's Thai", group: "Takeaway" },
  ];
  assert.equal(kindSummary("other", entries), "A ride and a takeaway");
  const d = { date: "2026-11-06", photos: [], places: [], entries, notes: [], events: [], counts: { entries: 2, by_kind: { other: 2 }, minutes: {}, photos: 0, notes: 0, events: 0, heat: 1 } } as never;
  assert.deepEqual(dayFigures(d), ["A takeaway"]);
});
