// Run: npx tsx --test app/src/lib/memories.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { anniversary, firstSentence, memorySentence, namesTopic, pickMemory, placeClauses, remembered, seedOf, whatHappened, type MemoryCandidate } from "./memories";
import { styleProblems } from "../../../lib/writing-style";

const TODAY = "2026-11-09";
const pick = (candidates: MemoryCandidate[], extra: { hidden?: string[]; neverTopics?: string[]; today?: string } = {}) =>
  pickMemory({ today: extra.today ?? TODAY, candidates, hidden: extra.hidden ?? [], neverTopics: extra.neverTopics ?? [] });

test("anniversary: on the day, within three days, across the new year, and not this year", () => {
  assert.deepEqual(anniversary("2025-11-09", TODAY), { gap: 0, years: 1 });
  assert.deepEqual(anniversary("2024-11-12", TODAY), { gap: -3, years: 2 });
  assert.deepEqual(anniversary("2025-11-06", TODAY), { gap: 3, years: 1 });
  assert.equal(anniversary("2025-11-13", TODAY), null);
  // A week ago this year isn't a memory.
  assert.equal(anniversary("2026-11-07", TODAY), null);
  // 30 December remembered on 1 January.
  assert.deepEqual(anniversary("2024-12-30", "2026-01-01"), { gap: 2, years: 1 });
  // 29 February is remembered on the 28th.
  assert.deepEqual(anniversary("2024-02-29", "2025-02-28"), { gap: 0, years: 1 });
});

test("the exact date beats the same week, and own words beat a person, a place and media", () => {
  const exact: MemoryCandidate = { date: "2025-11-09", places: ["Hampstead Heath"] };
  const week: MemoryCandidate = { date: "2025-11-08", words: true, people: [{ name: "Priya Shah" }] };
  assert.equal(pick([week, exact])?.candidate, exact);
  assert.equal(pick([week, exact])?.tier, "date");
  // Within the same tier, richer wins.
  const a: MemoryCandidate = { date: "2024-11-09", media: true, places: ["Dishoom"] };
  const b: MemoryCandidate = { date: "2023-11-09", people: [{ name: "Tom Ellis" }] };
  const c: MemoryCandidate = { date: "2022-11-09", words: true };
  assert.equal(pick([a, b])?.candidate, b);
  assert.equal(pick([a, b, c])?.candidate, c);
});

test("a day with only media waits for anything richer, even in a later tier", () => {
  const mediaToday: MemoryCandidate = { date: "2025-11-09", media: true };
  const placeThisWeek: MemoryCandidate = { date: "2025-11-07", places: ["Barbican Centre"] };
  assert.equal(pick([mediaToday, placeThisWeek])?.candidate, placeThisWeek);
  assert.equal(pick([mediaToday])?.candidate, mediaToday);
});

test("a first on its anniversary beats the same week; a first in the week comes last", () => {
  const firstToday: MemoryCandidate = { date: "2024-11-09", first: { kind: "run", name: "run", km: 5.4 } };
  const week: MemoryCandidate = { date: "2025-11-10", words: true };
  const firstWeek: MemoryCandidate = { date: "2024-11-11", first: { kind: "place", name: "Barbican Centre", since: 4 } };
  assert.equal(pick([week, firstToday, firstWeek])?.tier, "first-day");
  assert.equal(pick([week, firstWeek])?.candidate, week);
  assert.equal(pick([firstWeek])?.tier, "first-week");
  assert.equal(pick([firstWeek])?.years, 2);
});

test("stable for a day: the same answer every open, in any order; another day can differ", () => {
  const xs: MemoryCandidate[] = ["2025-11-07", "2025-11-08", "2025-11-10", "2025-11-11", "2024-11-06", "2024-11-12"].map((date) => ({ date, places: ["Monmouth Coffee"] }));
  const first = pick(xs)?.candidate.date;
  for (let i = 0; i < 5; i++) assert.equal(pick([...xs].sort(() => (seedOf(String(i)) % 3) - 1))?.candidate.date, first);
  // Over a fortnight, the same kind of week gives different days.
  const picks = new Set<number>();
  for (let i = 0; i < 14; i++) {
    const today = `2026-11-${String(10 + i).padStart(2, "0")}`;
    const ys = [-3, -2, -1, 1, 2, 3].map((off) => {
      const d = new Date(`2025-${today.slice(5)}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + off);
      return { date: d.toISOString().slice(0, 10), places: ["Monmouth Coffee"] };
    });
    const got = pick(ys, { today })!;
    picks.add(Math.round((Date.parse(`2025-${today.slice(5)}`) - Date.parse(got.candidate.date)) / 86_400_000));
  }
  assert.ok(picks.size >= 3, [...picks].join(","));
});

test("never: Rough or Low days, someone since archived, a never-nudge topic, or a day hidden", () => {
  const good: MemoryCandidate = { date: "2025-11-09", mood: 4, words: true, people: [{ name: "Priya Shah" }], places: ["Dishoom"] };
  assert.ok(remembered(good, [], []));
  assert.ok(!remembered({ ...good, mood: 2 }, [], []), "Low");
  assert.ok(!remembered({ ...good, mood: 1 }, [], []), "Rough");
  assert.ok(remembered({ ...good, mood: 3 }, [], []), "Okay is fine");
  assert.ok(!remembered({ ...good, people: [{ name: "Sam Okafor", archived: true }] }, [], []));
  assert.ok(!remembered({ ...good, places: ["Royal Free Hospital"] }, [], ["hospital"]));
  assert.ok(!remembered({ ...good, text: ["Weigh-in at the gym"] }, [], ["weigh"]));
  assert.ok(remembered(good, [], ["weight"]), "a topic that isn't there");
  assert.ok(!remembered(good, ["2025-11-09"], []));
  // And pickMemory falls through to the next.
  const next: MemoryCandidate = { date: "2025-11-08", places: ["Hampstead Heath"] };
  assert.equal(pick([{ ...good, mood: 2 }, next])?.candidate, next);
  assert.equal(pick([good, next], { hidden: ["2025-11-09"] })?.candidate, next);
  assert.equal(pick([{ ...good, mood: 1 }]), null);
  assert.equal(pick([]), null);
});

test("namesTopic: at a word start, any case, not inside another word", () => {
  assert.ok(namesTopic("Money talk with Tom", ["money"]));
  assert.ok(namesTopic("weighing in", ["weigh"]));
  assert.ok(!namesTopic("Harmony Hall", ["money"]));
  assert.ok(!namesTopic("anything", [" "]));
});

test("firstSentence: the first sentence, trimmed at 90 characters at a word", () => {
  assert.equal(firstSentence("First proper sunny day in ages. Walked home the long way."), "First proper sunny day in ages.");
  assert.equal(firstSentence("Felt like myself again"), "Felt like myself again.");
  assert.equal(firstSentence("Is it Friday yet? Nope."), "Is it Friday yet?");
  const long = firstSentence("We walked from Kentish Town all the way up through the Heath and down the other side to Highgate, then back again.")!;
  assert.ok(long.length <= 90, String(long.length));
  assert.ok(long.endsWith("…"));
  assert.ok(!/\s…$/.test(long));
  assert.equal(firstSentence("   "), null);
  // "3.5 km" isn't a sentence end.
  assert.equal(firstSentence("Ran 3.5 km before work. Then coffee."), "Ran 3.5 km before work.");
});

test("placeClauses and whatHappened: lunch with Priya at Dishoom", () => {
  assert.deepEqual(placeClauses("Work, lunch at Dishoom, then Hampstead Heath"), ["lunch at Dishoom", "Hampstead Heath"]);
  assert.deepEqual(placeClauses("Lunch at Dishoom"), ["lunch at Dishoom"]);
  assert.deepEqual(placeClauses("Home"), []);
  assert.equal(whatHappened({ people: ["Priya"], place: "lunch at Dishoom" }), "lunch with Priya at Dishoom");
  assert.equal(whatHappened({ people: ["Tom", "Ana"], place: "Barbican Centre" }), "Barbican Centre with Tom and Ana");
  assert.equal(whatHappened({ people: ["Ana"] }), "time with Ana");
  assert.equal(whatHappened({ people: ["Ana"], call: true }), "a call with Ana");
  assert.equal(whatHappened({ media: "watching Northern Lines" }), "watching Northern Lines");
  assert.equal(whatHappened({}), null);
});

const SENTENCES: Array<[string, Parameters<typeof memorySentence>]> = [
  ['A year ago today: lunch with Priya at Dishoom. You wrote "First proper sunny day in ages."', [{ candidate: { date: "2025-11-09" }, tier: "date", years: 1 }, { words: "First proper sunny day in ages. Long walk after.", people: ["Priya"], place: "lunch at Dishoom" }]],
  ["Two years ago this week: Hampstead Heath.", [{ candidate: { date: "2024-11-07" }, tier: "week", years: 2 }, { place: "Hampstead Heath" }]],
  ['A year ago today, you wrote "Tired but good."', [{ candidate: { date: "2025-11-09" }, tier: "date", years: 1 }, { words: "Tired but good." }]],
  ["A year ago this week, you and Tom went to Barbican Centre for the first time. You've been back four times since.", [{ candidate: { date: "2025-11-07", first: { kind: "place", name: "Barbican Centre", since: 4 } }, tier: "first-week", years: 1 }, { people: ["Tom"] }]],
  ["Two years since your first run over 5 km. That one was 5.4 km.", [{ candidate: { date: "2024-11-09", first: { kind: "run", name: "run", km: 5.4 } }, tier: "first-day", years: 2 }, {}]],
  ["Three years since your first catch-up with Ana. You've caught up twice since.", [{ candidate: { date: "2023-11-09", first: { kind: "person", name: "Ana Ruiz", since: 2 } }, tier: "first-day", years: 3 }, {}]],
  ["A year ago this week, you finished Small Hours, the first book you logged.", [{ candidate: { date: "2025-11-10", first: { kind: "book", name: "Small Hours" } }, tier: "first-week", years: 1 }, {}]],
  ["A year since you first went to Monmouth Coffee.", [{ candidate: { date: "2025-11-09", first: { kind: "place", name: "Monmouth Coffee", since: 0 } }, tier: "first-day", years: 1 }, {}]],
];

test("memorySentence: one sentence, plus the owner's words when there are some", () => {
  for (const [want, args] of SENTENCES) assert.equal(memorySentence(...args), want);
});

test("memorySentence: every shape passes the writing style, with quotes taken off", () => {
  for (const [s] of SENTENCES) assert.deepEqual(styleProblems(s.replace(/"/g, "")), [], s);
});
