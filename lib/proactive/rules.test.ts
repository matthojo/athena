// Athena speaks first: each rule fires, doesn't fire, and is held by the cap, quiet hours, dedupe and a mute.
// Run: npx tsx --test lib/proactive/rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROACTIVE,
  afterMeeting,
  automatedThread,
  awaitingReply,
  dayPlan,
  drift,
  gate,
  leaveBy,
  meetingPrep,
  mergeProactive,
  preppedEventIds,
  prepWillSpeak,
  proactiveNudges,
  readProactive,
  weeklyPlan,
  workingDaysBetween,
  type GateState,
  type InputEvent,
  type Nudge,
  type ProactiveInput,
  type RuleId,
  type SentThread,
} from "./index";

const TZ = "Europe/London"; // GMT in November: local time is UTC.
const WORK = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

function input(now: string, over: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    now: new Date(now),
    tz: TZ,
    today: now.slice(0, 10),
    working: WORK,
    events: [],
    sent: [],
    todos: [],
    goals: [],
    sleep: null,
    habits: [],
    travel: {},
    closed: new Set(),
    ...over,
  };
}

const priya = { id: "p-priya", name: "Priya Shah", last_summary: { at: "2026-11-02T15:00:00Z", text: "Agreed Athena sends the Q3 deck by Friday" }, recent_mail: [{ at: "2026-11-06T10:00:00Z", channel: "email" as const, text: "Re: Q3 deck, a few comments" }] };
const meeting: InputEvent = { id: "e-q3", title: "Q3 review", starts_at: "2026-11-09T14:00:00Z", ends_at: "2026-11-09T14:30:00Z", people: [priya], place: null };

function state(over: Partial<GateState> = {}, rules: Partial<Record<RuleId, boolean>> = {}): GateState {
  return {
    now: new Date("2026-11-09T13:50:00Z"),
    tz: TZ,
    prefs: { ...DEFAULT_PROACTIVE, rules: { meeting_prep: true, after_meeting: true, awaiting_reply: true, leave_by: true, day_plan: true, weekly_plan: true, drift: true, routine: true, watch_tonight: true, car: true, team: true, flow: true, ...rules } },
    working: WORK,
    quiet: null,
    mutes: new Map(),
    madeToday: 0,
    seen: new Set(),
    ...over,
  };
}

/** The four shared checks for one rule's nudge, made at `now`: cap, quiet hours, dedupe, mute. */
function sharedChecks(nudge: Nudge, now: string, quietAt: string, quietWith: Partial<GateState> = {}) {
  const at = new Date(now);
  assert.equal(gate([nudge], state({ now: at })).pass.length, 1, "passes the gate");
  assert.deepEqual(gate([nudge], state({ now: at, madeToday: 4 })).held.map((h) => h.reason), ["cap"]);
  assert.deepEqual(gate([nudge], state({ now: new Date(quietAt), ...quietWith })).held.map((h) => h.reason), ["quiet"]);
  assert.deepEqual(gate([nudge], state({ now: at, seen: new Set([nudge.key]) })).held.map((h) => h.reason), ["seen"]);
  assert.deepEqual(gate([nudge, nudge], state({ now: at })).held.map((h) => h.reason), ["seen"], "the same key twice in one run");
  assert.deepEqual(gate([nudge], state({ now: at, mutes: new Map([[nudge.rule, "2026-12-31T00:00:00Z"]]) })).held.map((h) => h.reason), ["muted"]);
  assert.equal(gate([nudge], state({ now: at, mutes: new Map([[nudge.rule, "2026-11-01T00:00:00Z"]]) })).pass.length, 1, "a lapsed mute");
  assert.deepEqual(gate([nudge], state({ now: at }, { [nudge.rule]: false })).held.map((h) => h.reason), ["off"]);
  assert.ok(nudge.why.length >= 2, "has evidence");
  assert.ok(nudge.prompt.length > 10, "has a first reply");
}

// ---------- meeting prep ----------

test("meeting prep: 15 minutes before, with what was agreed, the mail and open to-dos", () => {
  const i = input("2026-11-09T13:46:00Z", {
    events: [meeting],
    todos: [
      { id: "c1", title: "Send Priya the Q3 deck", kind: "i_owe", due_on: "2026-11-13", person_id: "p-priya", person_name: "Priya Shah" },
      { id: "c2", title: "Budget sign-off", kind: "waiting_on", due_on: null, person_id: "p-priya", person_name: "Priya Shah" },
      { id: "c3", title: "Unrelated", kind: "todo", due_on: null, person_id: null, person_name: null },
    ],
  });
  const [n] = meetingPrep(i);
  assert.equal(n.title, "2pm with Priya");
  assert.equal(n.body, "1 open to-do, 1 you're waiting on, 1 recent email. Tap for the notes from last time.");
  assert.ok(n.why.some((w) => w.includes("Agreed Athena sends the Q3 deck")));
  assert.ok(n.why.some((w) => w.startsWith("Email with Priya")));
  assert.ok(n.why.some((w) => w === "Open to-do: Send Priya the Q3 deck."));
  assert.ok(!n.why.some((w) => w.includes("Unrelated")));
  assert.equal(n.prompt, "What should I know before my 2pm with Priya?");
  // The push never carries what was said.
  assert.ok(!`${n.title} ${n.body}`.includes("Q3 deck"));
  sharedChecks(n, "2026-11-09T13:46:00Z", "2026-11-09T13:46:00Z", { working: { ...WORK, days: [2, 3, 4, 5] } }); // Monday off: outside working hours
});

test("meeting prep: not too early, not for a solo block, a backfill or after it starts", () => {
  assert.equal(meetingPrep(input("2026-11-09T13:40:00Z", { events: [meeting] })).length, 0);
  assert.equal(meetingPrep(input("2026-11-09T14:00:00Z", { events: [meeting] })).length, 0);
  assert.equal(meetingPrep(input("2026-11-09T13:50:00Z", { events: [{ ...meeting, people: [] }] })).length, 0);
  assert.equal(meetingPrep(input("2026-11-09T13:50:00Z", { events: [{ ...meeting, solo: true }] })).length, 0);
  assert.equal(meetingPrep(input("2026-11-09T13:50:00Z", { events: [{ ...meeting, backfilled: true }] })).length, 0);
  // It speaks for meetings with people, so the bare 30-minute push skips them.
  assert.deepEqual([...preppedEventIds({ events: [meeting, { ...meeting, id: "solo", people: [] }] })], ["e-q3"]);
});

// ---------- after a meeting ----------

test("after a meeting: asks how it went, once it ends, and promises drafts only", () => {
  const call = { ...meeting, title: "Call with Priya" };
  const [n] = afterMeeting(input("2026-11-09T14:35:00Z", { events: [call] }));
  assert.equal(n.title, "How did the call with Priya go?");
  assert.ok(n.why.some((w) => w.includes("stays a draft")));
  assert.equal(n.prompt, "Notes from the call with Priya: ");
  assert.equal(afterMeeting(input("2026-11-09T14:35:00Z", { events: [meeting] }))[0].title, "How did your meeting with Priya go?");
  sharedChecks(n, "2026-11-09T14:35:00Z", "2026-11-09T18:30:00Z"); // after the working day ends
});

test("after a meeting: not before it ends, not an hour later, not alone", () => {
  assert.equal(afterMeeting(input("2026-11-09T14:20:00Z", { events: [meeting] })).length, 0);
  assert.equal(afterMeeting(input("2026-11-09T15:31:00Z", { events: [meeting] })).length, 0);
  assert.equal(afterMeeting(input("2026-11-09T14:35:00Z", { events: [{ ...meeting, people: [] }] })).length, 0);
  assert.equal(afterMeeting(input("2026-11-09T14:35:00Z", { events: [{ ...meeting, backfilled: true }] })).length, 0);
});

// ---------- awaiting reply ----------

const tom: SentThread = { id: "t1", connector_id: "gm", subject: "Q3 budget", to: { id: "p-tom", name: "Tom Reed", email: "tom@example.com" }, sent_at: "2026-11-03T10:00:00Z", snippet: "Could you confirm the numbers by Friday?", unanswered: true, labels: ["SENT"] };

test("awaiting reply: a question sent Tuesday, no answer after three working days", () => {
  const [n] = awaitingReply(input("2026-11-09T10:00:00Z", { sent: [tom] }), 3);
  assert.equal(n.title, "No reply from Tom yet");
  assert.equal(n.body, "You emailed Tom on Tuesday and haven't heard back. Draft a nudge?");
  assert.ok(n.prompt.startsWith("Draft a short, friendly follow-up to Tom Reed"));
  assert.ok(n.why.some((w) => w.includes("four working days")));
  sharedChecks(n, "2026-11-09T10:00:00Z", "2026-11-09T08:00:00Z"); // before work starts
});

test("awaiting reply: not too soon, answered, closed, no question, automated or backfilled", () => {
  const at = input("2026-11-09T10:00:00Z");
  const none = (t: SentThread, extra: Partial<ProactiveInput> = {}) => assert.equal(awaitingReply({ ...at, sent: [t], ...extra }, 3).length, 0);
  none({ ...tom, sent_at: "2026-11-05T10:00:00Z" }); // Thursday: two working days
  none({ ...tom, unanswered: false });
  none(tom, { closed: new Set(["thread:t1"]) });
  none({ ...tom, snippet: "Here are the slides from today." });
  none({ ...tom, snippet: "Thanks again, no need to reply?" });
  none({ ...tom, to: { ...tom.to, email: "no-reply@billing.example.com" } });
  none({ ...tom, labels: ["SENT", "CATEGORY_PROMOTIONS"] });
  none({ ...tom, backfilled: true });
  none({ ...tom, sent_at: "2026-10-20T10:00:00Z" }); // older than a fortnight: stale
  assert.ok(automatedThread({ to: { id: null, name: "News", email: "newsletter@shop.example" }, labels: [] }));
  // N is the owner's: five working days holds it.
  assert.equal(awaitingReply({ ...at, sent: [tom] }, 5).length, 0);
  assert.equal(workingDaysBetween("2026-11-06", "2026-11-09", [1, 2, 3, 4, 5]), 1); // Fri → Mon
});

// ---------- leave by ----------

const lunch: InputEvent = { id: "e-lunch", title: "Lunch with Priya", starts_at: "2026-11-09T13:00:00Z", ends_at: null, people: [priya], place: { id: "pl1", name: "Dishoom" } };
const travel = { "e-lunch": { minutes: 25, mode: "transit" as const, from: "where you've been this morning" } };

test("leave by: ten minutes before leaving time, with the estimate", () => {
  // Leave at 12:30 (25 minutes + 5 spare): at 12:20 it's 10 minutes.
  const [n] = leaveBy(input("2026-11-09T12:20:00Z", { events: [lunch], travel }));
  assert.equal(n.title, "Leave in 10 minutes for the 1pm");
  assert.equal(n.body, "Lunch with Priya at Dishoom. About 25 minutes by public transport.");
  assert.ok(n.why.some((w) => w.includes("distance between the two places")));
  sharedChecks(n, "2026-11-09T12:20:00Z", "2026-11-09T12:20:00Z", { quiet: { from: "12:00", to: "14:00" } });
  // Without quiet hours set, it keeps out of the night (22:00 to 07:00).
  const late = leaveBy(input("2026-11-09T22:20:00Z", { events: [{ ...lunch, starts_at: "2026-11-09T23:00:00Z" }], travel }));
  assert.deepEqual(gate(late, state({ now: new Date("2026-11-09T22:20:00Z") })).held.map((h) => h.reason), ["quiet"]);
});

test("leave by: disruption on the usual lines means leaving ten minutes earlier", () => {
  const slow = { "e-lunch": { ...travel["e-lunch"], disruption: "Elizabeth line: part suspended" } };
  // Leave at 12:20 now (25 + 5 + 10): at 12:10 it's 10 minutes.
  const [n] = leaveBy(input("2026-11-09T12:10:00Z", { events: [lunch], travel: slow }));
  assert.equal(n.title, "Leave in 10 minutes for the 1pm");
  assert.equal(n.body, "Lunch with Priya at Dishoom. About 25 minutes by public transport, plus 10 for delays on your usual lines.");
  assert.ok(n.why.some((w) => w.includes("Elizabeth line: part suspended")));
  // On foot, a tube delay doesn't matter.
  const walk = { "e-lunch": { minutes: 15, mode: "walk" as const, from: "here", disruption: "Elizabeth line: part suspended" } };
  assert.equal(leaveBy(input("2026-11-09T12:30:00Z", { events: [lunch], travel: walk }))[0].title, "Leave in 10 minutes for the 1pm");
});

test("leave by: a live planner's time, and \"Why am I seeing this?\" names it", () => {
  const tfl = { "e-lunch": { minutes: 25, mode: "transit" as const, from: "around Islington, where you've been today", source: "tfl" as const, disruption: "Elizabeth line: part suspended" } };
  const [n] = leaveBy(input("2026-11-09T12:20:00Z", { events: [lunch], travel: tfl }));
  assert.equal(n.title, "Leave in 10 minutes for the 1pm", "the planner allows for delays: no extra 10");
  assert.ok(n.why.some((w) => w.startsWith("TfL's Journey Planner gives 25 minutes by public transport")));
  assert.ok(!n.why.some((w) => w.includes("estimate")));
  const g = { "e-lunch": { ...tfl["e-lunch"], source: "google" as const } };
  assert.ok(leaveBy(input("2026-11-09T12:20:00Z", { events: [lunch], travel: g }))[0].why.some((w) => w.startsWith("Google Maps gives 25 minutes")));
  // The estimate says it's one.
  assert.ok(leaveBy(input("2026-11-09T12:20:00Z", { events: [lunch], travel }))[0].why.some((w) => w.startsWith("This is an estimate")));
});

test("leave by: not without a place or an estimate, not too early, not long after", () => {
  assert.equal(leaveBy(input("2026-11-09T12:20:00Z", { events: [{ ...lunch, place: null }], travel })).length, 0);
  assert.equal(leaveBy(input("2026-11-09T12:20:00Z", { events: [lunch] })).length, 0);
  assert.equal(leaveBy(input("2026-11-09T12:00:00Z", { events: [lunch], travel })).length, 0);
  assert.equal(leaveBy(input("2026-11-09T12:40:00Z", { events: [lunch], travel })).length, 0);
  assert.equal(leaveBy(input("2026-11-09T12:20:00Z", { events: [{ ...lunch, backfilled: true }], travel })).length, 0);
  assert.equal(leaveBy(input("2026-11-09T12:30:00Z", { events: [lunch], travel }))[0].title, "Time to leave for the 1pm");
});

// ---------- day plan by energy ----------

const nights = Array.from({ length: 20 }, (_, i) => 420 + (i % 5) * 10);
const deep: InputEvent = { id: "e-deep", title: "Deep work", starts_at: "2026-11-09T09:00:00Z", ends_at: "2026-11-09T11:00:00Z", people: [], place: null, solo: true };
const standup: InputEvent = { id: "e-standup", title: "Team sync", starts_at: "2026-11-09T13:00:00Z", ends_at: "2026-11-09T14:00:00Z", people: [priya], place: null };

test("day plan: after a short night, offers to move the morning's heavy work after the afternoon's meetings", () => {
  const i = input("2026-11-09T07:35:00Z", { events: [deep, standup], sleep: { last_minutes: 290, last_recovery: null, nights, recoveries: [] } });
  const [n] = dayPlan(i);
  assert.equal(n.title, "An easier start today?");
  assert.deepEqual(n.actions.map((a) => a.kind === "move" && [a.event_id, a.start, a.end]), [["e-deep", "2026-11-09T14:00:00.000Z", "2026-11-09T16:00:00.000Z"]]);
  assert.equal(n.body, "Your 09:00 “Deep work” could move to 14:00. Tap to see the plan.");
  assert.ok(n.why[0].startsWith("You slept 4h 50m last night."));
  // Health stays off the lock screen.
  assert.ok(!/slept|sleep|recovery|4h/.test(`${n.title} ${n.body}`));
  sharedChecks(n, "2026-11-09T07:35:00Z", "2026-11-09T07:35:00Z", { quiet: { from: "22:00", to: "08:00" } });
});

test("day plan: not after a good night, not in the afternoon, and low recovery counts", () => {
  assert.equal(dayPlan(input("2026-11-09T07:35:00Z", { events: [deep], sleep: { last_minutes: 450, last_recovery: null, nights, recoveries: [] } })).length, 0);
  assert.equal(dayPlan(input("2026-11-09T07:35:00Z", { events: [deep], sleep: null })).length, 0);
  assert.equal(dayPlan(input("2026-11-09T12:00:00Z", { events: [deep], sleep: { last_minutes: 290, last_recovery: null, nights, recoveries: [] } })).length, 0);
  const low = dayPlan(input("2026-11-09T07:35:00Z", { events: [deep], sleep: { last_minutes: 450, last_recovery: 40, nights, recoveries: [60, 62, 65, 70, 58, 66, 64, 61] } }));
  assert.equal(low.length, 1);
  assert.ok(low[0].why[0].includes("recovery is 40"));
});

// ---------- weekly plan ----------

test("weekly plan: Sunday evening, to-dos placed on the lightest days, each part its own Apply", () => {
  const busyMonday: InputEvent = { ...standup, id: "m", starts_at: "2026-11-16T10:00:00Z", ends_at: "2026-11-16T15:00:00Z" };
  const i = input("2026-11-15T18:10:00Z", {
    events: [busyMonday],
    todos: [
      { id: "a", title: "Write the offsite agenda", kind: "todo", due_on: null, person_id: null, person_name: null },
      { id: "b", title: "Send Priya the deck", kind: "i_owe", due_on: null, person_id: "p-priya", person_name: "Priya Shah" },
      { id: "c", title: "Waiting on Tom", kind: "waiting_on", due_on: null, person_id: "p-tom", person_name: "Tom Reed" },
    ],
    goals: [{ id: "g", title: "Run a half marathon", progress: 20, period: "quarter", due_on: null }],
  });
  const [n] = weeklyPlan(i);
  assert.equal(n.title, "A plan for next week");
  assert.deepEqual(n.actions.map((a) => a.kind === "plan_todo" && [a.commitment_id, a.due_on]), [["a", "2026-11-17"], ["b", "2026-11-18"]]);
  assert.ok(n.why.some((w) => w.includes("half marathon")));
  sharedChecks(n, "2026-11-15T18:10:00Z", "2026-11-15T18:10:00Z", { quiet: { from: "18:00", to: "07:00" } });
});

test("weekly plan: only on Sunday evening, and only with something to place", () => {
  const todo = { id: "a", title: "Agenda", kind: "todo" as const, due_on: null, person_id: null, person_name: null };
  assert.equal(weeklyPlan(input("2026-11-14T18:10:00Z", { todos: [todo] })).length, 0);
  assert.equal(weeklyPlan(input("2026-11-15T17:00:00Z", { todos: [todo] })).length, 0);
  assert.equal(weeklyPlan(input("2026-11-15T18:10:00Z")).length, 0);
  assert.equal(weeklyPlan(input("2026-11-15T18:10:00Z", { todos: [{ ...todo, backfilled: true }] })).length, 0);
});

// ---------- drift ----------

const thursdays = ["2026-10-15", "2026-10-22", "2026-10-29", "2026-11-05"];
const gym = { id: "h-gym", name: "Gym", marks: [{ date: "2026-10-13", done: true }, { date: "2026-10-15", done: true }, { date: "2026-10-20", done: true }, { date: "2026-10-22", done: false }, { date: "2026-10-27", done: true }, { date: "2026-10-29", done: false }, { date: "2026-11-03", done: true }, { date: "2026-11-05", done: false }] };

test("drift: three Thursdays running", () => {
  const [n] = drift(input("2026-11-09T10:00:00Z", { habits: [gym] }));
  assert.equal(n.body, "You've skipped the gym three Thursdays running. Want to find it a better day?");
  assert.equal(n.title, "Gym on Thursdays");
  assert.ok(n.why[0].includes("22 October, 29 October, 5 November"));
  assert.ok(thursdays.length);
  sharedChecks(n, "2026-11-09T10:00:00Z", "2026-11-08T10:00:00Z"); // a Sunday
});

test("drift: health, calendar and Patterns: a logged workout isn't a skip; the clash and the pattern are the evidence", () => {
  const evening = (title: string) => ({ workouts: [], events: [{ title, time: "18:00" }] });
  const past = { "2026-10-22": evening("Team drinks"), "2026-10-29": evening("Team drinks"), "2026-11-05": evening("Team drinks") };
  const [n] = drift(input("2026-11-09T10:00:00Z", { habits: [{ ...gym, pattern: "You sleep 30 min longer on days you go to the gym" }], past }));
  assert.ok(n.why.some((w) => w === "Your calendar had “Team drinks” at 18:00 on each of those Thursdays."));
  assert.ok(n.why.some((w) => w === "From Patterns: You sleep 30 min longer on days you go to the gym."));
  assert.ok(n.why[0].endsWith("and no workout was logged."));
  assert.equal(n.prompt, "I keep missing the gym on Thursdays, when “Team drinks” is on. Which day would suit it better?");
  // A workout logged on one of those Thursdays: the run is broken, no nudge.
  const worked = { ...past, "2026-10-29": { workouts: ["Strength training"], events: [] } };
  assert.equal(drift(input("2026-11-09T10:00:00Z", { habits: [gym], past: worked })).length, 0);
});

test("drift: two misses aren't a pattern, nor a gap, nor a habit never kept", () => {
  const two = { ...gym, marks: gym.marks.map((m) => (m.date === "2026-10-22" ? { ...m, done: true } : m)) };
  assert.equal(drift(input("2026-11-09T10:00:00Z", { habits: [two] })).length, 0);
  const gap = { ...gym, marks: gym.marks.filter((m) => m.date !== "2026-10-29") };
  assert.equal(drift(input("2026-11-09T10:00:00Z", { habits: [gap] })).length, 0);
  const never = { ...gym, marks: gym.marks.map((m) => ({ ...m, done: false })) };
  assert.equal(drift(input("2026-11-09T10:00:00Z", { habits: [never] })).length, 0);
});

// ---------- the gate across rules, and prefs ----------

test("meeting prep only takes over the 30-minute push when it will speak", () => {
  const s = (over: Partial<GateState> = {}) => ({ ...state(over) });
  assert.equal(prepWillSpeak(meeting.starts_at, s()), true);
  assert.equal(prepWillSpeak(meeting.starts_at, s({ madeToday: 4 })), false, "the cap is full: the push stays");
  assert.equal(prepWillSpeak(meeting.starts_at, s({ mutes: new Map([["meeting_prep", "2026-12-31T00:00:00Z"]]) })), false);
  assert.equal(prepWillSpeak("2026-11-09T18:15:00Z", s()), false, "prep time is after work");
  assert.equal(prepWillSpeak(meeting.starts_at, state({}, { meeting_prep: false })), false);
});

test("the daily cap counts across rules, in order", () => {
  const i = input("2026-11-09T13:46:00Z", { events: [meeting], sent: [tom] });
  const r = proactiveNudges(i, state({ now: i.now, madeToday: 3 }));
  assert.deepEqual(r.pass.map((n) => n.rule), ["meeting_prep"]);
  assert.deepEqual(r.held.map((h) => [h.nudge.rule, h.reason]), [["awaiting_reply", "cap"]]);
});

test("defaults: meeting prep, awaiting reply, the owner's own routines, Team, flows and the car on, the rest off (watch tonight too); prefs checked", () => {
  assert.deepEqual(Object.entries(DEFAULT_PROACTIVE.rules).filter(([, v]) => v).map(([k]) => k), ["meeting_prep", "awaiting_reply", "routine", "car", "team", "flow"]);
  assert.equal(mergeProactive(DEFAULT_PROACTIVE, { rules: { flow: false } }).rules.flow, false);
  assert.deepEqual(readProactive({ rules: { drift: true, nonsense: true }, cap: 99 }).rules.drift, true);
  assert.equal(readProactive({ cap: 99 }).cap, 4);
  assert.equal(mergeProactive(DEFAULT_PROACTIVE, { rules: { leave_by: true } }).rules.leave_by, true);
  assert.throws(() => mergeProactive(DEFAULT_PROACTIVE, { rules: { leave: true } }), /no rule called leave/);
  assert.throws(() => mergeProactive(DEFAULT_PROACTIVE, { cap: 0 }), /cap/);
});
