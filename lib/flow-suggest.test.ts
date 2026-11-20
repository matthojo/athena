// Run: npx tsx --test lib/flow-suggest.test.ts
// Flow suggestions on made-up habits (lib/flow-suggest.fixtures.ts): each detector finds its habit, and turns down near misses.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clip,
  count,
  detectAll,
  detectFollow,
  detectList,
  detectRepeat,
  detectSaved,
  flowTextPlain,
  followUps,
  listAddition,
  MAX_SUGGESTIONS,
  normalise,
  pickSuggestions,
  textKey,
  weeklyHabits,
  type Found,
} from "./flow-suggest";
import { alreadyAFlow, sameTrigger, suggestionProblems } from "./flow-suggest-check";
import { mergeCollected } from "./flow-suggest-store";
import { FLOW_LIMITS, type FlowStep, type FlowSuggestion } from "./flow-types";
import { at, binsHabit, deliveryHabit, empty, item, listAdd, NOW, reminder, saved, todo, TZ } from "./flow-suggest.fixtures";

const ctx = { now: NOW, tz: TZ };
const only = (found: Found[]) => {
  assert.equal(found.length, 1, `one suggestion, got ${found.map((f) => f.suggestion.id).join(", ") || "none"}`);
  return found[0].suggestion;
};
const tool = (s: FlowSuggestion) => s.flow.steps[0] as Extract<FlowStep, { kind: "tool" }>;

// ---------- follow ----------

test("delivery emails then a reminder: Delivery day, a reminder on the delivery date at the owner's usual time", () => {
  const s = only(detectFollow(deliveryHabit(4, 5), ctx));
  assert.equal(s.id, "follow-delivery-reminder");
  assert.equal(s.title, "You add a reminder after delivery emails");
  assert.equal(s.why, "Four of five delivery emails in the last 30 days.");
  assert.equal(s.flow.name, "Delivery day");
  assert.equal(s.flow.origin, "suggestion");
  assert.deepEqual(s.flow.trigger, { kind: "event", event: { source: "collected", kind: "delivery" } });
  const step = tool(s);
  assert.equal(step.tool, "add_reminder");
  assert.equal(step.go, "auto");
  assert.equal(flowTextPlain(step.input.text), "Delivery today: {title}");
  assert.deepEqual(step.input.date, [{ from: "trigger", key: "delivery_date" }]);
  assert.deepEqual(step.input.time, ["07:45"]);
  assert.deepEqual(suggestionProblems(s), []);
});

test("every one followed reads as all", () => {
  assert.equal(only(detectFollow(deliveryHabit(3, 3), ctx)).why, "All three delivery emails in the last 30 days.");
});

test("follow: too few, too rare, unrelated or too late is no suggestion", () => {
  assert.deepEqual(detectFollow(deliveryHabit(2, 2), ctx), [], "two isn't a habit");
  assert.deepEqual(detectFollow(deliveryHabit(3, 6), ctx), [], "half the time isn't most of the time");

  const unrelated = deliveryHabit(4, 5);
  unrelated.reminders = unrelated.reminders.map((r) => ({ ...r, text: "Call the dentist" }));
  assert.deepEqual(detectFollow(unrelated, ctx), [], "a reminder about something else");

  const late = deliveryHabit(4, 5);
  late.reminders = late.reminders.map((r) => ({ ...r, created_at: at.plusHours(r.created_at, 20) }));
  assert.deepEqual(detectFollow(late, ctx), [], "a day later isn't a follow-up");

  const before = deliveryHabit(4, 5);
  before.reminders = before.reminders.map((r) => ({ ...r, created_at: at.plusHours(r.created_at, -4) }));
  assert.deepEqual(detectFollow(before, ctx), [], "made before the email came");

  const repeating = deliveryHabit(4, 5);
  repeating.reminders = repeating.reminders.map((r) => ({ ...r, repeat: "weekly" }));
  assert.deepEqual(detectFollow(repeating, ctx), [], "a repeating reminder isn't a follow-up");
});

test("follow: items outside the kind's window don't count", () => {
  const s = deliveryHabit(4, 5);
  s.collectedDays.delivery = 7;
  assert.deepEqual(detectFollow(s, ctx), []);
});

test("one reminder can't follow two emails", () => {
  const a = item("delivery", "Hollowbrook Books order dispatched", at.day(2, "08:00"));
  const b = item("delivery", "Hollowbrook Books order out for delivery", at.day(2, "09:00"));
  const matched = followUps([a, b], [{ id: "r1", text: "Hollowbrook parcel", at: at.day(2, "10:00") }]);
  assert.equal(matched.size, 1);
  assert.ok(matched.has(a.id));
});

test("renewal emails then a to-do: a to-do due on the renewal date, never a reminder", () => {
  const s = empty();
  const firms = ["Kestrel Home Insurance", "Larkspur Broadband", "Brackenford Gym", "Oakhollow Breakdown Cover"];
  firms.forEach((f, i) => {
    const t = at.day(1 + i, "07:00");
    s.collected.push(item("renewal", `${f}: your renewal`, t));
    s.todos.push(todo(`Compare ${f.split(" ")[0]} quotes`, at.plusHours(t, 1)));
    s.reminders.push(reminder(`${f.split(" ")[0]} renews`, at.plusHours(t, 1.5), at.day(-20, "09:00")));
  });
  const found = only(detectFollow(s, ctx));
  assert.equal(found.id, "follow-renewal-todo");
  assert.equal(found.title, "You add a to-do after renewal emails");
  assert.equal(found.why, "All four renewal emails in the last week.");
  const step = tool(found);
  assert.equal(step.tool, "add_todo");
  assert.equal(flowTextPlain(step.input.title), "Decide on {title}");
  assert.deepEqual(step.input.due_on, [{ from: "trigger", key: "renewal_date" }]);
  assert.deepEqual(suggestionProblems(found), []);
});

// ---------- list (What Ask did) ----------

test("booking emails then Ask adds them to the same list: a flow that does it", () => {
  const s = empty();
  const hotels = ["Gullhaven Hotel", "Saltmarsh Inn", "Rookwood Lodge"];
  hotels.forEach((h, i) => {
    const t = at.day(1 + i, "10:00");
    s.collected.push(item("booking", `Booking confirmed: ${h}`, t));
    s.activity.push(listAdd("Trips", `${h}, 2 nights`, at.plusHours(t, 3), i === 0));
  });
  s.activity.push(listAdd("Shopping", "Oat milk", at.day(1, "12:00")));
  const found = only(detectList(s, ctx));
  assert.match(found.id, /^list-booking-[0-9a-f]{12}$/);
  assert.equal(found.title, "You add booking emails to Trips");
  assert.equal(found.why, "All three booking emails in the last week, through Ask.");
  assert.equal(found.flow.name, "Bookings to Trips");
  const step = tool(found);
  assert.equal(step.tool, "add_to_list");
  assert.deepEqual(step.input, { item: [{ from: "trigger", key: "title" }], list_title: ["Trips"] });
  assert.deepEqual(suggestionProblems(found), []);
});

test("a person's list, an undone change or a line about something else isn't a list habit", () => {
  assert.equal(listAddition(listAdd("Rowan · Gift ideas", "Kite", NOW.toISOString())), null);
  assert.equal(listAddition({ ...listAdd("Trips", "Gullhaven Hotel", NOW.toISOString()), state: "undone" }), null);
  assert.deepEqual(listAddition(listAdd("Trips", "Gullhaven Hotel", NOW.toISOString(), true)), { list: "Trips", item: "Gullhaven Hotel" });

  const s = empty();
  ["Gullhaven Hotel", "Saltmarsh Inn", "Rookwood Lodge"].forEach((h, i) => {
    const t = at.day(1 + i, "10:00");
    s.collected.push(item("booking", `Booking confirmed: ${h}`, t));
    s.activity.push(listAdd("Trips", "Pack the walking boots", at.plusHours(t, 3)));
  });
  assert.deepEqual(detectList(s, ctx), [], "the line has to be about the booking");
});

// ---------- repeat ----------

test("the same reminder set by hand every Tuesday: a flow on Tuesdays that tells you", () => {
  const s = only(detectRepeat(binsHabit(), ctx));
  assert.match(s.id, /^repeat-reminder-[0-9a-f]{12}$/);
  assert.equal(s.id, `repeat-reminder-${textKey("Put the bins out")}`, "the id doesn't hold the words, and doesn't change with case");
  assert.equal(s.title, "You set the same reminder every Tuesday");
  assert.equal(s.why, "“Put the bins out”: four times in eight weeks, each a Tuesday at about 19:00.");
  assert.equal(s.flow.name, "Put the bins out");
  assert.deepEqual(s.flow.trigger, { kind: "schedule", days: [2], time: "19:00" });
  assert.deepEqual(s.flow.steps, [{ id: "tell", title: null, kind: "notify", text: ["Put the bins out"] }]);
  assert.deepEqual(suggestionProblems(s), []);
});

test("repeat: mixed days, old habits, wandering times and ones already repeating aren't offered", () => {
  const mixed = binsHabit();
  mixed.reminders[1] = { ...mixed.reminders[1], remind_at: "2026-11-11T19:00:00.000Z" };
  assert.deepEqual(detectRepeat(mixed, ctx), [], "a Wednesday among the Tuesdays");

  const stale = binsHabit();
  stale.reminders = stale.reminders.slice(1).map((r) => ({ ...r }));
  stale.reminders.push({ ...stale.reminders[0], id: "rem-x", created_at: "2026-10-19T19:00:00.000Z", remind_at: "2026-10-20T19:00:00.000Z" });
  const old = { ...stale, reminders: stale.reminders.filter((r) => Date.parse(r.created_at) < Date.parse("2026-10-30T00:00:00Z")) };
  assert.deepEqual(detectRepeat(old, ctx), [], "nothing in the last three weeks");

  const wander = binsHabit();
  wander.reminders[0] = { ...wander.reminders[0], remind_at: "2026-11-17T21:30:00.000Z" };
  assert.deepEqual(detectRepeat(wander, ctx), [], "19:00 one week, 21:30 another");

  const automated = binsHabit();
  automated.reminders.push(reminder("Put the bins out", "2026-01-05T10:00:00.000Z", "2026-11-24T19:00:00.000Z", "weekly"));
  assert.deepEqual(detectRepeat(automated, ctx), [], "a weekly reminder already does it");

  const twoWeeks = binsHabit();
  twoWeeks.reminders = twoWeeks.reminders.slice(0, 2);
  assert.deepEqual(detectRepeat(twoWeeks, ctx), [], "twice isn't a habit");
});

test("the same to-do for every Monday: a Monday flow that adds it", () => {
  const s = empty();
  for (const due of ["2026-11-16", "2026-11-09", "2026-11-02"]) s.todos.push(todo("Water the plants", `${due}T06:00:00.000Z`, due));
  const found = only(detectRepeat(s, ctx));
  assert.equal(found.title, "You add the same to-do every Monday");
  assert.equal(found.why, "“Water the plants”: three times in eight weeks, each for a Monday.");
  assert.deepEqual(found.flow.trigger, { kind: "schedule", days: [1], time: "08:00" });
  assert.deepEqual(tool(found).input, { title: ["Water the plants"], kind: ["todo"] });
  assert.deepEqual(suggestionProblems(found), []);
});

test("weeklyHabits needs three different weeks", () => {
  const o = (date: string) => ({ text: "Ring Gran", date, time: "18:00", weekday: 0, at: `${date}T10:00:00.000Z` });
  assert.equal(weeklyHabits([o("2026-11-15"), o("2026-11-15"), o("2026-11-08")], NOW).length, 0);
  assert.equal(weeklyHabits([o("2026-11-15"), o("2026-11-08"), o("2026-11-01")], NOW).length, 1);
});

// ---------- saved ----------

test("books saved and moved to Watch & read straight away: a flow that files them", () => {
  const s = empty();
  s.saved.push(saved("book", at.day(2), 1, "watch_read"), saved("book", at.day(9), 3, "watch_read"), saved("book", at.day(20), 0.2, "watch_read"), saved("book", at.day(30), null, null));
  s.saved.push(saved("product", at.day(3), 1, "gift_idea"), saved("product", at.day(4), 1, "gift_idea"), saved("product", at.day(5), 1, "gift_idea"));
  const found = only(detectSaved(s, ctx));
  assert.equal(found.id, "saved-book-watch_read");
  assert.equal(found.title, "You move the books you save to Watch & read");
  assert.equal(found.why, "Three of four books you saved in the last 60 days.");
  assert.equal(found.flow.name, "Books to Watch & read");
  assert.deepEqual(found.flow.trigger, { kind: "event", event: { source: "saved", savedAction: "saved", kind: "book" } });
  assert.deepEqual(tool(found).input, { saved_id: [{ from: "trigger", key: "saved" }], action: ["watch_read"] });
  assert.deepEqual(suggestionProblems(found), []);
});

test("saved: filed days later, or by an action that needs a person, isn't offered", () => {
  const s = empty();
  s.saved.push(saved("film", at.day(2), 80, "watch_read"), saved("film", at.day(9), 90, "watch_read"), saved("film", at.day(20), 100, "watch_read"));
  assert.deepEqual(detectSaved(s, ctx), []);
});

// ---------- picking ----------

const allThree = () => {
  const s = deliveryHabit(4, 5);
  s.reminders.push(...binsHabit().reminders);
  s.saved.push(saved("book", at.day(2), 1, "watch_read"), saved("book", at.day(9), 3, "watch_read"), saved("book", at.day(20), 0.2, "watch_read"));
  for (const due of ["2026-11-16", "2026-11-09", "2026-11-02"]) s.todos.push(todo("Water the plants", `${due}T06:00:00.000Z`, due));
  return s;
};

test("at most three, best first, every one valid", () => {
  const found = detectAll(allThree(), ctx);
  assert.equal(found.length, 4);
  const picked = pickSuggestions(found, { dismissed: new Set(), flows: [], maxFlows: FLOW_LIMITS.flows });
  assert.equal(picked.length, MAX_SUGGESTIONS);
  assert.deepEqual(picked.map((p) => p.id), found.slice(0, 3).map((f) => f.suggestion.id));
  assert.ok(found[0].score >= found[1].score && found[1].score >= found[2].score);
  for (const p of picked) assert.deepEqual(suggestionProblems(p), [], p.id);
});

test("a dismissed suggestion doesn't come back, and the next one takes its place", () => {
  const found = detectAll(allThree(), ctx);
  const picked = pickSuggestions(found, { dismissed: new Set(["follow-delivery-reminder"]), flows: [], maxFlows: FLOW_LIMITS.flows });
  assert.equal(picked.length, 3);
  assert.ok(!picked.some((p) => p.id === "follow-delivery-reminder"));
});

test("one that's already a flow isn't offered, paused or not", () => {
  const found = detectAll(deliveryHabit(), ctx);
  const flow = {
    trigger: { kind: "event" as const, event: { source: "collected" as const, kind: "Delivery", match: "Hollowbrook" } },
    steps: [{ id: "a", title: null, kind: "notify" as const, text: ["Parcel"] }, { id: "b", title: null, kind: "tool" as const, tool: "add_reminder", input: {}, go: "ask" as const, gives: [] }],
  };
  assert.deepEqual(pickSuggestions(found, { dismissed: new Set(), flows: [flow], maxFlows: FLOW_LIMITS.flows }), []);
  // A delivery flow that only tells you is a different flow.
  assert.equal(pickSuggestions(found, { dismissed: new Set(), flows: [{ ...flow, steps: [flow.steps[0]] }], maxFlows: FLOW_LIMITS.flows }).length, 1);
});

test("a reminder inside a branch still counts as the flow doing it", () => {
  const s = only(detectRepeat(binsHabit(), ctx));
  const branched = {
    trigger: { kind: "schedule" as const, days: [2, 4] as Array<0 | 1 | 2 | 3 | 4 | 5 | 6>, time: "18:30" },
    steps: [{ id: "c", title: null, kind: "check" as const, condition: { left: { from: "trigger", key: "x" }, op: "exists" as const }, yes: [{ id: "n", title: null, kind: "notify" as const, text: ["Bins"] }], no: [] }],
  };
  assert.equal(alreadyAFlow(s, [branched]), true);
  assert.equal(alreadyAFlow(s, [{ ...branched, trigger: { ...branched.trigger, time: "07:00" } }]), false, "a morning flow is another habit");
});

test("no room for another flow: no suggestions", () => {
  const found = detectAll(deliveryHabit(), ctx);
  const filler = Array.from({ length: FLOW_LIMITS.flows }, () => ({ trigger: { kind: "manual" as const }, steps: [] }));
  assert.deepEqual(pickSuggestions(found, { dismissed: new Set(), flows: filler, maxFlows: FLOW_LIMITS.flows }), []);
});

test("two habits on one trigger: only the stronger is offered", () => {
  const s = deliveryHabit(4, 5);
  s.collected.forEach((c, i) => {
    if (i < 3) s.activity.push(listAdd("Parcels", c.title.replace("Your order from ", "").replace(" is on its way", ""), at.plusHours(c.times[0], 1)));
  });
  const found = detectAll(s, ctx);
  assert.equal(found.find((f) => f.suggestion.id.startsWith("list-delivery-"))?.suggestion.flow.name, "Deliveries to Parcels");
  const picked = pickSuggestions(found, { dismissed: new Set(), flows: [], maxFlows: FLOW_LIMITS.flows });
  assert.deepEqual(picked.map((p) => p.id), ["follow-delivery-reminder"]);
});

test("nothing to go on, nothing offered", () => {
  assert.deepEqual(detectAll(empty(), ctx), []);
});

// ---------- the checks ----------

test("suggestionProblems turns away what the engine would", () => {
  const good = only(detectFollow(deliveryHabit(), ctx));
  const withStep = (step: FlowStep) => ({ ...good, flow: { ...good.flow, steps: [step] } });
  assert.match(suggestionProblems(withStep({ ...tool(good), input: { ...tool(good).input, date: [{ from: "trigger", key: "nope" }] } })).join(), /isn't given/);
  assert.match(suggestionProblems(withStep({ ...tool(good), tool: "send_email" })).join(), /tool send_email/);
  assert.match(suggestionProblems(withStep({ id: "t", title: null, kind: "think", task: ["Why"], web: false, gives: [] })).join(), /assistant/);
  assert.match(suggestionProblems(withStep({ ...tool(good), input: { ...tool(good).input, time: ["7pm"] } })).join(), /time/);
  assert.match(suggestionProblems({ ...good, why: "Often." }).join(), /counts/);
  assert.match(suggestionProblems({ ...good, flow: { ...good.flow, name: "x".repeat(61) } }).join(), /name/);
  assert.match(suggestionProblems({ ...good, flow: { ...good.flow, trigger: { kind: "schedule", days: [], time: "25:00" } } }).join(), /days.*time|time.*days/);
  assert.match(suggestionProblems({ ...good, flow: { ...good.flow, steps: [tool(good), tool(good)] } }).join(), /ids/);
});

test("sameTrigger: kinds compare without case; schedules need a shared day within the hour", () => {
  assert.ok(sameTrigger({ kind: "event", event: { source: "collected", kind: "delivery" } }, { kind: "event", event: { source: "collected", kind: "DELIVERY", connector: "gmail" } }));
  assert.ok(!sameTrigger({ kind: "event", event: { source: "collected", kind: "delivery" } }, { kind: "event", event: { source: "saved", kind: "delivery" } }));
  assert.ok(!sameTrigger({ kind: "schedule", days: [2], time: "19:00" }, { kind: "schedule", days: [3], time: "19:00" }));
  assert.ok(!sameTrigger({ kind: "schedule", days: [2], time: "19:00" }, { kind: "manual" }));
});

// ---------- words and plumbing ----------

test("words: counts up to nine in words, clipping on a word, ids from a hash", () => {
  assert.equal(count(4), "four");
  assert.equal(count(12), "12");
  assert.equal(clip("Take the recycling to the tip on the way past", 20), "Take the recycling");
  assert.equal(normalise("Put the BINS out!! 2x"), "put the bins out x");
  assert.equal(textKey("Put the bins out"), textKey("put the bins out!"));
  assert.doesNotMatch(textKey("Put the bins out"), /bins/);
});

test("mergeCollected: one item per record with each time it moved on", () => {
  const merged = mergeCollected([
    { id: "p1", kind: "delivery", title: "", at: "2026-11-01T09:00:00.000Z" },
    { id: "p1", kind: "delivery", title: "Hollowbrook Books", at: "2026-11-02T09:00:00.000Z" },
    { id: "p1", kind: "delivery", title: "Hollowbrook Books", at: "2026-11-02T09:00:00.000Z" },
    { id: "b1", kind: "booking", title: "Saltmarsh Inn", at: "2026-11-03T09:00:00.000Z" },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { id: "p1", kind: "delivery", title: "Hollowbrook Books", times: ["2026-11-01T09:00:00.000Z", "2026-11-02T09:00:00.000Z"] });
});
