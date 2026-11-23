// Run: npx tsx --test lib/proactive/travel-modes.test.ts
// Leave by's ways of travelling: the usual and each journey's own, which planner times each, and a drive with no Google key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROACTIVE, MAX_TRAVEL_CHOICES, mergeProactive, readProactive } from "./gate";
import { leaveBy } from "./rules";
import { estimateFor, plannerFor, travelModeFor } from "./travel";
import { NO_DRIVE_TIME, type InputEvent, type ProactiveInput } from "./types";

test("the usual way, and a journey's own choice over it", () => {
  assert.equal(DEFAULT_PROACTIVE.travel_mode, "transit");
  const prefs = mergeProactive(DEFAULT_PROACTIVE, { travel_mode: "drive", travel_by_event: { e1: "walk" } });
  assert.equal(travelModeFor(prefs, "e1"), "walk");
  assert.equal(travelModeFor(prefs, "e2"), "drive");
  const back = mergeProactive(prefs, { travel_by_event: { e1: null } });
  assert.equal(travelModeFor(back, "e1"), "drive", "null goes back to the usual");
  assert.throws(() => mergeProactive(DEFAULT_PROACTIVE, { travel_mode: "hovercraft" }), /travel_mode: one of transit, drive, walk, cycle/);
  assert.throws(() => mergeProactive(DEFAULT_PROACTIVE, { travel_by_event: { "../x": "walk" } }), /event ids only/);
  // Stored values that don't make sense are dropped on read.
  assert.deepEqual(readProactive({ travel_mode: "boat", travel_by_event: { e1: "cycle", e2: "boat" } }).travel_by_event, { e1: "cycle" });
  assert.equal(readProactive({ travel_mode: "boat" }).travel_mode, "transit");
  // Only the newest choices are kept.
  let p = DEFAULT_PROACTIVE;
  for (let i = 0; i < MAX_TRAVEL_CHOICES + 5; i++) p = mergeProactive(p, { travel_by_event: { [`e${i}`]: "cycle" } });
  assert.equal(Object.keys(p.travel_by_event).length, MAX_TRAVEL_CHOICES);
  assert.ok(!("e0" in p.travel_by_event) && `e${MAX_TRAVEL_CHOICES + 4}` in p.travel_by_event);
});

test("which planner: a drive is Google's or nothing, never TfL; the rest TfL in London, else Google", () => {
  const all = { london: true, tfl: true, google: true };
  assert.equal(plannerFor("drive", all), "google");
  assert.equal(plannerFor("drive", { ...all, google: false }), "no_key");
  assert.equal(plannerFor("transit", all), "tfl");
  assert.equal(plannerFor("walk", all), "tfl");
  assert.equal(plannerFor("cycle", { ...all, london: false }), "google");
  assert.equal(plannerFor("transit", { london: false, tfl: true, google: false }), null);
});

test("estimates: on foot and by bike from the distance, public transport as before, and no estimate for a drive", () => {
  const a = { lat: 51.4545, lng: -2.5879 };
  const b = { lat: 51.4645, lng: -2.6177 };
  assert.equal(estimateFor("drive", a, b), null);
  assert.equal(estimateFor("walk", a, b)!.mode, "walk");
  assert.equal(estimateFor("cycle", a, b)!.mode, "cycle");
  assert.ok(estimateFor("cycle", a, b)!.minutes < estimateFor("walk", a, b)!.minutes);
  assert.equal(estimateFor("transit", a, b)!.mode, "transit");
});

const TZ = "Europe/London";
const lunch: InputEvent = { id: "e-lunch", title: "Lunch with Priya", starts_at: "2026-11-09T13:00:00Z", ends_at: null, people: [], place: { id: "pl1", name: "Dishoom" } };
const input = (now: string, travel: ProactiveInput["travel"]): ProactiveInput => ({
  now: new Date(now),
  tz: TZ,
  today: now.slice(0, 10),
  working: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  events: [lunch],
  sent: [],
  todos: [],
  goals: [],
  sleep: null,
  habits: [],
  travel,
  closed: new Set(),
});

test("leave by, driving with Google: by car, in the traffic now", () => {
  const [n] = leaveBy(input("2026-11-09T12:20:00Z", { "e-lunch": { minutes: 25, mode: "drive", from: "around Bristol", source: "google" } }));
  assert.equal(n.title, "Leave in 10 minutes: drive to Dishoom by 13:00");
  assert.equal(n.body, "Lunch with Priya at Dishoom. About 25 minutes by car.");
  assert.ok(n.why.some((w) => w.startsWith("Google Maps gives 25 minutes by car in the traffic now")));
});

test("leave by, driving with no Google key: no time, an hour ahead, and how to add one; never public transport", () => {
  const travel = { "e-lunch": { minutes: 0, mode: "drive" as const, from: "around Bristol", source: "none" as const } };
  const [n] = leaveBy(input("2026-11-09T12:00:00Z", travel));
  assert.equal(n.title, "Drive to Dishoom by 13:00");
  assert.equal(n.body, "Lunch with Priya. Athena can't time a drive without Google Maps, so allow for traffic.");
  assert.ok(n.why.some((w) => w.startsWith(NO_DRIVE_TIME) && /Google Maps key in Sources/.test(w)));
  assert.ok(!`${n.title} ${n.body} ${n.why.join(" ")}`.includes("public transport"));
  assert.equal(leaveBy(input("2026-11-09T11:50:00Z", travel)).length, 0, "more than an hour ahead");
  assert.equal(leaveBy(input("2026-11-09T12:50:00Z", travel)).length, 0, "too late to help");
});

test("leave by, on foot and by bike", () => {
  assert.match(leaveBy(input("2026-11-09T12:20:00Z", { "e-lunch": { minutes: 25, mode: "cycle", from: "home", source: "estimate" } }))[0].body, /25 minutes by bike/);
  assert.match(leaveBy(input("2026-11-09T12:20:00Z", { "e-lunch": { minutes: 25, mode: "walk", from: "home", source: "google" } }))[0].body, /25 minutes on foot/);
});

test("a drive's traffic recheck: once, 30 to 15 minutes before leaving, on an answer at least 15 minutes old", async () => {
  const { recheckDue } = await import("./travel");
  const MIN = 60_000;
  const start = Date.parse("2026-11-09T13:00:00Z");
  // 25 minutes by car + 5 spare: leave at 12:30.
  const hit = { at: start - 90 * MIN, route: { minutes: 25, mode: "drive" as const, source: "google" } };
  const at = (hhmm: string) => Date.parse(`2026-11-09T${hhmm}:00Z`);
  assert.equal(recheckDue(hit, start, at("11:55"), 5), false, "35 minutes before leaving: too early");
  assert.equal(recheckDue(hit, start, at("12:00"), 5), true, "30 minutes before leaving");
  assert.equal(recheckDue(hit, start, at("12:10"), 5), true);
  assert.equal(recheckDue(hit, start, at("12:15"), 5), false, "15 minutes before: the nudge's own time, too late");
  assert.equal(recheckDue({ ...hit, at: at("11:50") }, start, at("12:00"), 5), false, "answer only 10 minutes old");
  assert.equal(recheckDue({ ...hit, rechecked: true }, start, at("12:05"), 5), false, "only one recheck");
  assert.equal(recheckDue({ ...hit, route: { ...hit.route, mode: "transit" as const } }, start, at("12:05"), 5), false, "drives only");
  assert.equal(recheckDue({ ...hit, route: { ...hit.route, source: "tfl" } }, start, at("12:05"), 5), false, "Google only");
  assert.equal(recheckDue({ ...hit, route: null }, start, at("12:05"), 5), false);
});

test("leave by after a recheck: the why says the traffic was checked again", () => {
  const [n] = leaveBy(input("2026-11-09T12:20:00Z", { "e-lunch": { minutes: 30, mode: "drive", from: "around Bristol", source: "google", rechecked: true } }));
  assert.equal(n.title, "Leave in 5 minutes: drive to Dishoom by 13:00");
  assert.ok(n.why.includes("Athena asked Google Maps again for the traffic close to when you'd leave."));
});
