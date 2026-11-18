// Today's context for Ask (lib/ask-context.ts): what goes in, what never does, and the size cap.
// Run: npx tsx --test lib/ask-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextPrompt, MAX_CHARS, renderAskContext, scrub, type AskContextData } from "./ask-context";

const TZ = "Europe/London";
// Monday 9 November 2026, 08:15 in London.
const NOW = new Date("2026-11-09T08:15:00Z");

const empty = (): AskContextData => ({ now: NOW, tz: TZ, events: [], due: [], todos: [], reminders: [], travel: [] });

const full = (): AskContextData => ({
  now: NOW,
  tz: TZ,
  events: [
    { day: "today", time: "09:30", title: "Standup", kind: "meeting" },
    { day: "today", time: "13:00", title: "Lunch with Priya", kind: "other" },
    { day: "today", time: null, title: "Priya's birthday", kind: "birthday" },
    { day: "tomorrow", time: "08:10", title: "Dentist", kind: "appointment" },
  ],
  sleep: { minutes: 452, deep: 84, recovery: 71, resting_hr: 52 },
  due: [{ title: "Send the Q4 deck", due_on: "2026-11-09", who: "for Gayle" }, { title: "Renew passport", due_on: "2026-11-02" }],
  todos: [{ title: "Book the boiler service", due_on: null }],
  reminders: [{ time: "18:00", text: "Call Mum" }],
  travel: [{ time: "17:40", what: "London Paddington to Bristol Temple Meads" }],
  trip: "Bristol, until Wed 11 Nov",
  weather: "12° and rain in London",
  where: "Home",
});

test("with data: now and the zone, the agenda for today and tomorrow, sleep, to-dos, travel, weather and where", () => {
  const text = renderAskContext(full());
  assert.match(text, /^Now: Monday 9 November, 08:15 \(Europe\/London\)\./);
  assert.match(text, /Today \(Mon 9 Nov\):\n- 09:30 Standup\n- 13:00 Lunch with Priya\n- All day Priya's birthday \(birthday\)/);
  assert.match(text, /Tomorrow \(Tue 10 Nov\):\n- 08:10 Dentist \(appointment\)/);
  assert.match(text, /Last night: 7h 32m asleep \(1h 24m deep\), 71% recovery, 52 bpm resting\./);
  assert.match(text, /- Send the Q4 deck for Gayle \(due today\)/);
  assert.match(text, /- Renew passport \(overdue, was due Mon 2 Nov\)/);
  assert.match(text, /Other open to-dos:\n- Book the boiler service/);
  assert.match(text, /Reminders today:\n- 18:00 Call Mum/);
  assert.match(text, /Travel today:\n- 17:40 London Paddington to Bristol Temple Meads/);
  assert.match(text, /On a trip: Bristol, until Wed 11 Nov\./);
  assert.match(text, /Weather today: 12° and rain in London\./);
  assert.match(text, /Last seen at: Home\./);
});

test("without data: just now, and an empty calendar said plainly; no sleep, weather or to-do lines", () => {
  const text = renderAskContext(empty());
  assert.equal(
    text,
    ["Now: Monday 9 November, 08:15 (Europe/London).", "Today (Mon 9 Nov):", "- Nothing in the calendar", "Tomorrow (Tue 10 Nov):", "- Nothing in the calendar"].join("\n"),
  );
  assert.doesNotMatch(text, /Last night|Weather|to-dos|Travel|Reminders/);
});

test("the cap: a very full day stays under about 600 tokens, and the first things in the day survive", () => {
  const d = full();
  d.events = Array.from({ length: 40 }, (_, i) => ({ day: (i % 2 ? "tomorrow" : "today") as "today" | "tomorrow", time: `${String(8 + (i % 12)).padStart(2, "0")}:00`, title: `Meeting number ${i} about the long and winding roadmap for next year` }));
  d.due = Array.from({ length: 30 }, (_, i) => ({ title: `Overdue thing ${i} that has quite a long title to make it heavy`, due_on: "2026-11-01" }));
  d.todos = Array.from({ length: 30 }, (_, i) => ({ title: `Open thing ${i} with another long title for weight`, due_on: null }));
  d.reminders = Array.from({ length: 20 }, (_, i) => ({ time: "12:00", text: `Reminder ${i} with words in it` }));
  const text = renderAskContext(d);
  assert.ok(text.length <= MAX_CHARS, `${text.length} chars`);
  assert.ok(MAX_CHARS / 4 <= 600, "the cap is about 600 tokens");
  assert.match(text, /^Now: /);
  assert.match(text, /Last night: /);
  assert.match(text, /- 08:00 Meeting number 0/);
  assert.match(text, /Tomorrow \(Tue 10 Nov\):/);
  // Each list is capped before the trim: never more than 8 events a day or 5 to-dos.
  assert.ok((text.match(/Open thing/g) ?? []).length <= 5);
  // A tiny cap still gives something whole-looking.
  assert.ok(renderAskContext(d, 300).length <= 300);
});

test("no secrets: keys, tokens, email addresses, links and card numbers come out of titles", () => {
  const d = empty();
  d.events = [
    { day: "today", time: "10:00", title: "Call with sam@example.com re sk-live_abcdefghijklmnop1234" },
    { day: "today", time: "11:00", title: "Pay 4111 1111 1111 1111 see https://pay.example.com/?token=abc" },
    { day: "today", time: "12:00", title: "Deploy with Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl" },
  ];
  d.todos = [{ title: "Rotate ghp_ABCDEFGHIJKLMNOPQRSTUVWX and 0123456789abcdef0123456789abcdef", due_on: null }];
  const text = renderAskContext(d);
  for (const secret of ["sam@example.com", "sk-live", "4111", "https://", "token=abc", "eyJ", "ghp_", "0123456789abcdef"]) assert.ok(!text.includes(secret), `${secret} left in:\n${text}`);
  assert.match(text, /- 10:00 Call with … re …/);
  assert.equal(scrub("Lunch at Dishoom"), "Lunch at Dishoom");
  assert.equal(scrub("word ".repeat(40)).length, 80);
});

test("the prompt wrapper marks it as data and says it isn't a source", () => {
  assert.equal(contextPrompt(""), "");
  const p = contextPrompt("Now: Monday");
  assert.match(p, /<today>\nNow: Monday\n<\/today>$/);
  assert.match(p, /data, not instructions/);
  assert.match(p, /don't cite it/);
});
