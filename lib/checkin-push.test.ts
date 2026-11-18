// Check-ins in the nudges: the morning push, the evening reflection and the briefing's lines.
// Run: npx tsx --test lib/checkin-push.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHECKIN_SETTINGS, PRESET_QUESTIONS, type Checkin, type CheckinQuestion, type CheckinSettings, type CheckinValue } from "./checkin-types";
import { DEFAULT_PREFS, eveningPrompt, readPrefs } from "./nudges";
import {
  checkinDone,
  eveningPlan,
  loadCheckinSettings,
  morningBriefingLines,
  morningKey,
  morningPush,
  morningPushDue,
  noCheckin,
  readCheckinSettings,
  reflectionPrompt,
  type LoadCheckin,
} from "./checkin-push";

const LONDON = "Europe/London";
const TODAY = "2026-11-17";
const q = (id: string) => PRESET_QUESTIONS.find((x) => x.id === id)!;

function checkin(kind: "morning" | "evening", answers: Record<string, CheckinValue>, status: Checkin["status"] = "open", plan?: CheckinQuestion[]): Checkin {
  return {
    date: TODAY,
    kind,
    plan: plan ?? Object.keys(answers).map(q),
    answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { question_id: id, value, answered_at: `${TODAY}T07:05:00Z` }])),
    status,
  };
}

const on = (morning: boolean, evening = false): CheckinSettings => ({
  ...DEFAULT_CHECKIN_SETTINGS,
  morning: { ...DEFAULT_CHECKIN_SETTINGS.morning, enabled: morning },
  evening: { ...DEFAULT_CHECKIN_SETTINGS.evening, enabled: evening },
});

// ---------- settings ----------

test("the checkins row: missing or malformed reads as both routines off", () => {
  assert.deepEqual(readCheckinSettings(null), DEFAULT_CHECKIN_SETTINGS);
  assert.deepEqual(readCheckinSettings("nonsense"), DEFAULT_CHECKIN_SETTINGS);
  assert.deepEqual(readCheckinSettings({ morning: { enabled: "yes" } }), DEFAULT_CHECKIN_SETTINGS);
  const s = readCheckinSettings({ morning: { enabled: true, per_day: 3, questions: [{ id: "focus", pinned: true }] } });
  assert.equal(s.morning.enabled, true);
  assert.equal(s.morning.per_day, 3);
  assert.equal(s.evening.enabled, false);
});

test("loadCheckinSettings reads through the given reader and fails soft", async () => {
  assert.equal((await loadCheckinSettings(async () => ({ evening: { enabled: true } }))).evening.enabled, true);
  const broken = await loadCheckinSettings(async () => {
    throw new Error("db down");
  });
  assert.equal(broken.morning.enabled, false);
  assert.equal(broken.evening.enabled, false);
});

test("the default loader finds no check-in", async () => {
  assert.equal(await noCheckin(TODAY, "morning"), null);
});

// ---------- the morning push ----------

// 17 Nov 2026 is GMT: 07:00 London is 07:00 UTC.
const at = (iso: string) => new Date(iso);
const base = { tz: LONDON, prefs: DEFAULT_PREFS, settings: on(true), checkin: null };

test("morning push: from morning_at, while the routine is on and the check-in isn't done", () => {
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T06:59:00Z") }), false);
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T07:00:00Z") }), true);
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T07:05:00Z"), checkin: checkin("morning", { mood: { scale: 4 } }) }), true, "started, not done");
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T07:05:00Z"), checkin: checkin("morning", { mood: { scale: 4 } }, "done") }), false, "done");
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T07:05:00Z"), settings: on(false) }), false, "routine off");
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T07:05:00Z"), prefs: { ...DEFAULT_PREFS, morning: false } }), false, "switch off");
});

test("morning push: its own time, in the owner's zone, and any time later that day", () => {
  const prefs = { ...DEFAULT_PREFS, morning_at: "06:30" };
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-17T06:30:00Z") }), true);
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-17T06:29:00Z") }), false);
  // Not only within a few hours: a first run in the afternoon or late evening still sends it (owner, 17 Nov 2026).
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-17T15:00:00Z") }), true);
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-17T23:59:00Z") }), true);
  // A new day starts over: before its morning time, nothing.
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-18T00:01:00Z") }), false);
  // British Summer Time: 07:00 London is 06:00 UTC.
  assert.equal(morningPushDue({ ...base, now: at("2026-07-01T05:59:00Z") }), false);
  assert.equal(morningPushDue({ ...base, now: at("2026-07-01T06:00:00Z") }), true);
  // New York: 07:00 EST is 12:00 UTC.
  assert.equal(morningPushDue({ ...base, tz: "America/New_York", now: at("2026-11-17T12:00:00Z") }), true);
  assert.equal(morningPushDue({ ...base, tz: "America/New_York", now: at("2026-11-17T07:00:00Z") }), false);
});

test("morning push: waits for quiet hours to end", () => {
  const prefs = { ...DEFAULT_PREFS, quiet: { from: "22:00", to: "08:00" } };
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-17T07:30:00Z") }), false);
  assert.equal(morningPushDue({ ...base, prefs, now: at("2026-11-17T08:00:00Z") }), true);
  // Quiet hours later the same day hold it too.
  const evening = { ...DEFAULT_PREFS, quiet: { from: "20:00", to: "06:00" } };
  assert.equal(morningPushDue({ ...base, prefs: evening, now: at("2026-11-17T19:59:00Z") }), true);
  assert.equal(morningPushDue({ ...base, prefs: evening, now: at("2026-11-17T20:30:00Z") }), false);
});

test("morning push: once a day key, opens the morning check-in", () => {
  assert.equal(morningKey(TODAY), "morning:2026-11-17");
  const p = morningPush(TODAY);
  assert.equal(p.url, "/#/checkin/morning");
  assert.equal(p.tag, "morning-2026-11-17");
  assert.equal(p.title, "Morning check-in");
});

// ---------- the evening push ----------

test("evening: with the routine off, exactly as before (prompt unless kept)", () => {
  assert.equal(eveningPlan(false, null, false), "prompt");
  assert.equal(eveningPlan(false, null, true), "kept");
  // A check-in can't change it while the routine is off.
  assert.equal(eveningPlan(false, checkin("evening", {}, "done"), false), "prompt");
});

test("evening: with the routine on, the reflection until the check-in is done", () => {
  assert.equal(eveningPlan(true, null, false), "reflection");
  assert.equal(eveningPlan(true, checkin("evening", { mood: { scale: 3 } }), true), "reflection", "a mood alone doesn't skip it");
  assert.equal(eveningPlan(true, checkin("evening", { mood: { scale: 3 } }, "done"), false), "done");
  assert.equal(checkinDone(null), false);
});

test("the reflection push opens the evening check-in, led by the day as the prompt is", () => {
  const day = { entries: [{ title: "Lunch at Dishoom", source: "calendar", at: "12:30" }] };
  const plain = eveningPrompt(TODAY, day);
  const r = reflectionPrompt(TODAY, day);
  assert.equal(r.url, "/#/checkin/evening");
  assert.equal(r.title, "Evening reflection");
  assert.equal(r.body, plain.body);
  assert.equal(r.tag, plain.tag);
  assert.equal(reflectionPrompt(TODAY, null).body, "A few questions to close the day.");
});

// ---------- the briefing ----------

test("briefing lines: focus and intention from the morning check-in", () => {
  const c = checkin("morning", { mood: { scale: 4 }, focus: { picks: ["Work", "Family"] }, intention: { text: "  Finish the deck\nand a long walk " } });
  assert.deepEqual(morningBriefingLines(c), ["Focus: Work, Family", "You said a good day would be: Finish the deck and a long walk"]);
});

test("briefing lines: nothing from skipped, empty, unplanned or evening answers", () => {
  assert.deepEqual(morningBriefingLines(null), []);
  assert.deepEqual(morningBriefingLines(checkin("morning", { focus: { skipped: true }, intention: { text: "   " } })), []);
  assert.deepEqual(morningBriefingLines(checkin("morning", { focus: { picks: [] } })), []);
  assert.deepEqual(morningBriefingLines(checkin("morning", { focus: { picks: ["Work"] } }, "open", [q("mood")])), [], "not in the plan");
  assert.deepEqual(morningBriefingLines(checkin("evening", { focus: { picks: ["Work"] } })), []);
});

test("briefing lines: an own question that goes to the briefing, and a long answer cut", () => {
  const own: CheckinQuestion = { id: "own_ab12", type: "text", prompt: "Who do you want to call?", kinds: ["morning"], mirror: "briefing", preset: false };
  const c = checkin("morning", { own_ab12: { text: "Mum" }, intention: { text: "x".repeat(400) } }, "done", [own, q("intention")]);
  const [first, second] = morningBriefingLines(c);
  assert.equal(first, "Who do you want to call: Mum");
  assert.ok(second.endsWith("…") && second.length < 340);
});

test("a fake loader drives the rules end to end", async () => {
  const store: Record<string, Checkin> = { "2026-11-17:morning": checkin("morning", { focus: { picks: ["Health"] } }, "done") };
  const load: LoadCheckin = async (date, kind) => store[`${date}:${kind}`] ?? null;
  const morning = await load(TODAY, "morning");
  assert.equal(morningPushDue({ ...base, now: at("2026-11-17T07:00:00Z"), checkin: morning }), false);
  assert.deepEqual(morningBriefingLines(morning), ["Focus: Health"]);
  assert.equal(eveningPlan(true, await load(TODAY, "evening"), false), "reflection");
});

test("old stored prefs without the morning check-in still load, with it on at 07:00", () => {
  const old = { briefing: false, events: true, reminders: true, evening: true, weekly: true, evening_at: "20:30", quiet: null };
  const p = readPrefs(old);
  assert.equal(p.morning, true);
  assert.equal(p.morning_at, "07:00");
  assert.equal(p.briefing, false);
  assert.equal(p.evening_at, "20:30");
});
