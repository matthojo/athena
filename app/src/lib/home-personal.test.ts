// Run: npx tsx --test app/src/lib/home-personal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askExamples,
  daysToBirthday,
  firstName,
  goalLine,
  goalMeasure,
  importantPeople,
  lastSeenBy,
  ownerName,
  personNotes,
  topicOf,
  whenPast,
} from "./home-personal";
import { dayPart, greeting } from "./format";
import { birthdaysToday, giftIdeas, keepingInTouch, personMoment, recordedPronoun, topicSentence, type SeenItem } from "./home-personal";
import { styleProblems } from "../../../lib/writing-style";

const MUM = "5a3e0000-0000-4000-8000-000000000001";
const PRIYA = "5a3e0000-0000-4000-8000-000000000002";
const TODAY = "2026-11-08"; // a Sunday

test("greeting: with the owner's name, and as before without one", () => {
  const evening = new Date(2026, 10, 8, 19, 30);
  assert.equal(greeting(evening, "Alex"), "Good evening, Alex");
  assert.equal(greeting(evening), "Good evening");
  assert.equal(greeting(evening, "  "), "Good evening");
  assert.equal(greeting(new Date(2026, 10, 8, 8), "Alex"), "Good morning, Alex");
  assert.equal(greeting(new Date(2026, 10, 8, 2), "Alex"), "Still up, Alex");
});

test("dayPart: morning, day and evening for the aurora", () => {
  assert.equal(dayPart(new Date(2026, 10, 8, 4)), "evening");
  assert.equal(dayPart(new Date(2026, 10, 8, 7)), "morning");
  assert.equal(dayPart(new Date(2026, 10, 8, 11)), "day");
  assert.equal(dayPart(new Date(2026, 10, 8, 18)), "evening");
});

test("ownerName and importantPeople read the profile", () => {
  const facts = [
    { key: "Name", value: " Alex " },
    { key: "important people", value: `[@Mum](athena://person/${MUM}), [@Priya Shah](athena://person/${PRIYA}), Gran` },
  ];
  assert.equal(ownerName(facts), "Alex");
  assert.equal(ownerName([]), null);
  assert.deepEqual(importantPeople(facts), [
    { id: MUM, name: "Mum" },
    { id: PRIYA, name: "Priya Shah" },
    { id: null, name: "Gran" },
  ]);
  assert.deepEqual(importantPeople([]), []);
});

test("firstName keeps Mum and drops titles", () => {
  assert.equal(firstName("Mum"), "Mum");
  assert.equal(firstName("Dr. Elena Osei"), "Elena");
  assert.equal(firstName("Priya Shah"), "Priya");
});

test("daysToBirthday: this year, next year, no year, 29 February", () => {
  assert.equal(daysToBirthday("1990-11-18", TODAY), 10);
  assert.equal(daysToBirthday("--11-08", TODAY), 0);
  assert.equal(daysToBirthday("--11-07", TODAY), 364);
  assert.equal(daysToBirthday("2000-02-29", "2027-02-27"), 1);
  assert.equal(daysToBirthday(null, TODAY), null);
  assert.equal(daysToBirthday("soon", TODAY), null);
});

test("whenPast reads like speech", () => {
  assert.equal(whenPast(TODAY, TODAY), "today");
  assert.equal(whenPast("2026-11-07", TODAY), "yesterday");
  assert.equal(whenPast("2026-11-04", TODAY), "on Wednesday");
  assert.equal(whenPast("2026-10-12", TODAY), "on 12 October");
  assert.equal(whenPast("2025-10-12", TODAY), "on 12 October 2025");
});

test("lastSeenBy prefers seeing someone over a later call", () => {
  const seen = lastSeenBy([
    { date: "2026-11-06", people: [{ id: PRIYA, name: "Priya Shah" }], inPerson: false, how: "Call" },
    { date: "2026-11-04", people: [{ id: PRIYA, name: "Priya Shah" }], inPerson: true, how: "Lunch", where: "Dishoom" },
    { date: "2026-10-20", people: [{ id: MUM, name: "Mum" }], inPerson: false },
  ]);
  assert.deepEqual(seen.get(PRIYA), { date: "2026-11-04", inPerson: true, how: "Lunch", where: "Dishoom", summary: undefined });
  assert.equal(seen.get(MUM)?.inPerson, false);
});

test("personNotes: a birthday soon leads, else the last time you saw them", () => {
  const notes = personNotes(
    [
      { id: MUM, name: "Mum" },
      { id: PRIYA, name: "Priya Shah" },
      { id: null, name: "Gran" },
    ],
    {
      today: TODAY,
      birthdays: new Map([
        [MUM, "--11-18"],
        [PRIYA, "1991-03-02"],
      ]),
      seen: new Map([
        [PRIYA, { date: "2026-11-04", inPerson: true, how: "Lunch", where: "Dishoom" }],
        [MUM, { date: "2026-10-18", inPerson: true, how: "Sunday lunch", where: "Mum's" }],
      ]),
    }
  );
  assert.equal(`${notes[0].before}${notes[0].name}${notes[0].after}`, "Mum's birthday is in 10 days.");
  assert.equal(notes[0].sub, "Sunday lunch at Mum's, 18 October");
  assert.equal(`${notes[1].before}${notes[1].name}${notes[1].after}`, "You last saw Priya on Wednesday, at Dishoom.");
  assert.equal(notes[1].sub, null);
  assert.equal(`${notes[2].before}${notes[2].name}${notes[2].after}`, "Nothing logged with Gran yet.");
  for (const n of notes) assert.ok(!/@/.test(`${n.before}${n.name}${n.after}${n.sub ?? ""}`));
});

test("personNotes: a birthday this week is soon, and says the day", () => {
  const [n] = personNotes([{ id: PRIYA, name: "Priya Shah" }], { today: TODAY, birthdays: new Map([[PRIYA, "1991-11-11"]]), seen: new Map() });
  assert.equal(n.after, "'s birthday is on Wednesday.");
  assert.equal(n.birthdaySoon, true);
});

test("goalMeasure and goalLine", () => {
  assert.deepEqual(goalMeasure("Run a half marathon"), { kind: "run", km: 21.1 });
  assert.deepEqual(goalMeasure("Run a 10k"), { kind: "run", km: 10 });
  assert.deepEqual(goalMeasure("Read 24 books"), { kind: "books", count: 24 });
  assert.equal(goalMeasure("Learn to cook five Sichuan dishes"), null);

  const goals = ["Run a half marathon", "Read 24 books", "Learn to cook five Sichuan dishes"];
  assert.deepEqual(goalLine(goals, { longestRunKm: 13.84, booksThisYear: 9, records: [] }), {
    title: "Run a half marathon",
    text: "Longest run lately: 13.8 km of 21.1 km",
    ratio: 13.84 / 21.1,
  });
  assert.equal(goalLine(goals, { longestRunKm: null, booksThisYear: 9, records: [] })?.text, "9 of 24 books so far this year");
  assert.equal(
    goalLine(["Learn to cook five Sichuan dishes"], { longestRunKm: null, booksThisYear: null, records: [{ title: "Cook five Sichuan dishes", progress: 40, status: "active" }] })?.text,
    "40% of the way"
  );
  assert.deepEqual(goalLine(["Learn Welsh"], { longestRunKm: null, booksThisYear: null, records: [] }), { title: "Learn Welsh", text: "One of this year's goals", ratio: null });
  assert.equal(goalLine([], { longestRunKm: 5, booksThisYear: 1, records: [] }), null);
});

test("topicOf finds what a catch-up was about", () => {
  assert.equal(topicOf("Lunch upstairs. She's weighing the Northwind offer and wants a second read of the contract.", ["Priya Shah"]), "the Northwind offer");
  assert.equal(topicOf("Workshop dates, and whether the pricing memo is ready."), null);
  assert.equal(topicOf("Talked about Lisbon on Tuesday."), "Lisbon");
  assert.equal(topicOf(undefined), null);
});

test("askExamples: the owner's people and days, and one thing to do with a real person", () => {
  const ex = askExamples({
    people: [
      { name: "Mum", birthdayIn: 10 },
      { name: "Priya Shah", topic: "the Northwind offer", birthdayIn: 115 },
    ],
    place: "Dishoom",
  });
  assert.deepEqual(ex.questions, ["What did Priya say about the Northwind offer?", "When did I last see Mum?", "When was I last at Dishoom?"]);
  assert.equal(ex.instruction, "Remind me to get something for Mum's birthday");

  const sample = askExamples({ people: [{ name: "Priya Shah", topic: "the Northwind offer" }], fixed: ["What did Elena say about pricing?", "What did I get up to last weekend?"] });
  assert.deepEqual(sample.questions, ["What did Priya say about the Northwind offer?", "What did Elena say about pricing?", "What did I get up to last weekend?"]);
  assert.equal(sample.instruction, "Remind me to ring Priya on Sunday");

  const none = askExamples({ people: [] });
  assert.deepEqual(none.questions, ["What did I get up to last weekend?"]);
  assert.equal(none.instruction, "Remind me to book the dentist next week");
});

test("askExamples: the soonest birthday names the instruction (sample order: Priya in 3 days, Mum in 10)", () => {
  const ex = askExamples({
    people: [
      { name: "Mum", birthdayIn: 10 },
      { name: "Priya Shah", topic: "the Northwind offer", birthdayIn: 3 },
    ],
    fixed: ["What did Elena say about pricing?", "What did I get up to last weekend?"],
  });
  assert.deepEqual(ex.questions, ["What did Priya say about the Northwind offer?", "What did Elena say about pricing?", "What did I get up to last weekend?"]);
  assert.equal(ex.instruction, "Remind me to get something for Priya's birthday");
});

// ---------- thinking of them (night F5) ----------

const PRIYA_P = { id: "p1", name: "Priya Shah", birthday: "1991-11-12" };
const MONDAY = "2026-11-09"; // a Monday; Priya turns 35 on Thursday
const priya = [{ id: "p1", name: "Priya Shah" }];
const lunch = (date: string, summary?: string): SeenItem => ({ date, people: priya, inPerson: true, how: "Lunch", where: "Dishoom", summary });
const NORTHWIND = "Lunch upstairs. She's weighing the Northwind offer and wants a second read of the contract.";

test("personMoment: the birthday sheet, as the note has it", () => {
  const m = personMoment(PRIYA_P, {
    today: MONDAY,
    seen: [lunch(MONDAY, NORTHWIND), { date: "2026-11-02", people: priya, inPerson: false, how: "Call" }],
    facts: [{ key: "Pronouns", value: "she/her" }, { key: "Kids", value: "Maya (7)" }],
    gifts: ["Château Musar 2017"],
  });
  assert.equal(m.birthday?.line, "Priya turns 35 on Thursday.");
  assert.equal(m.birthday?.days, 3);
  assert.equal(m.lastTime, "Last time: lunch at Dishoom today. She's weighing the Northwind offer.");
  assert.equal(m.giftLine, "Gift ideas you saved: Château Musar 2017.");
  assert.deepEqual(m.fact, { key: "Kids", value: "Maya (7)" });
  assert.deepEqual(m.remind, { on: "2026-11-11", label: "Remind me Wednesday", title: "Get something for Priya's birthday" });
  assert.equal(m.write, "Write to her");
});

test("personMoment: no pronoun recorded, so the name; no year, so no age", () => {
  const m = personMoment(
    { ...PRIYA_P, birthday: "--11-12" },
    { today: "2026-11-05", seen: [lunch("2026-11-02", NORTHWIND)], facts: [{ key: "Coffee order", value: "Oat flat white" }], gifts: [] }
  );
  assert.equal(m.birthday?.line, "It's Priya's birthday a week today.");
  assert.equal(m.lastTime, "Last time: lunch at Dishoom on Monday. Priya's weighing the Northwind offer.");
  assert.equal(m.write, "Write to Priya");
  assert.equal(m.giftLine, null);
  assert.equal(m.pronoun, null);
});

test("personMoment: tomorrow, and on the day", () => {
  const tomorrow = personMoment(PRIYA_P, { today: "2026-11-11", seen: [], facts: [], gifts: [] });
  assert.equal(tomorrow.birthday?.line, "Priya turns 35 tomorrow.");
  assert.equal(tomorrow.remind?.label, "Remind me today");
  assert.equal(tomorrow.lastTime, null);
  const day = personMoment(PRIYA_P, { today: "2026-11-12", seen: [], facts: [], gifts: [] });
  assert.equal(day.birthday?.line, "Priya turns 35 today.");
  assert.equal(day.remind, null, "nothing to remind on the day");
  assert.equal(personMoment(PRIYA_P, { today: "2026-11-10", seen: [], facts: [], gifts: [] }).remind?.label, "Remind me tomorrow");
});

test("personMoment: the again line counts this year's lunches at the same place", () => {
  const seen = [lunch("2026-11-09"), lunch("2026-10-16"), lunch("2026-03-02"), lunch("2025-12-12"), { ...lunch("2026-06-01"), where: "Hoppers" }, { ...lunch("2026-05-01"), how: "Dinner" }];
  assert.equal(personMoment(PRIYA_P, { today: MONDAY, seen, facts: [], gifts: [] }).again, "Third lunch with Priya at Dishoom this year.");
  // The same lunch logged twice (a catch-up and a calendar event) counts once.
  assert.equal(personMoment(PRIYA_P, { today: MONDAY, seen: [...seen, lunch("2026-11-09")], facts: [], gifts: [] }).again, "Third lunch with Priya at Dishoom this year.");
  // The first one isn't "again"; an old one isn't news; a call has no place.
  assert.equal(personMoment(PRIYA_P, { today: MONDAY, seen: [lunch("2026-11-09")], facts: [], gifts: [] }).again, null);
  assert.equal(personMoment(PRIYA_P, { today: "2026-12-20", seen, facts: [], gifts: [] }).again, null);
  assert.equal(personMoment(PRIYA_P, { today: MONDAY, seen: [...seen, { date: MONDAY, people: priya, inPerson: false, how: "Call" }], facts: [], gifts: [] }).again, "Third lunch with Priya at Dishoom this year.");
  // Something that isn't a thing you do together ("Gallery", a calendar title) isn't counted.
  const gallery = { date: MONDAY, people: priya, inPerson: true, how: "Gallery", where: "Barbican Centre" };
  assert.equal(personMoment(PRIYA_P, { today: MONDAY, seen: [gallery, { ...gallery, date: "2026-10-01" }], facts: [], gifts: [] }).again, null);
  // Someone else's lunches don't count.
  const tom = { ...lunch("2026-10-01"), people: [{ id: "t1", name: "Tom" }] };
  assert.equal(personMoment(PRIYA_P, { today: MONDAY, seen: [lunch(MONDAY), tom], facts: [], gifts: [] }).again, null);
});

test("topicSentence: pronouns only when recorded, and a safe fallback", () => {
  const she = recordedPronoun([{ key: "pronouns", value: "She/her" }]);
  assert.deepEqual(she, { subject: "She", object: "her" });
  assert.equal(recordedPronoun([{ key: "Pronouns", value: "xe/xem" }]), null);
  assert.equal(topicSentence(NORTHWIND, "the Northwind offer", "Priya", she), "She's weighing the Northwind offer.");
  assert.equal(topicSentence("He wants the Northwind offer, badly.", "the Northwind offer", "Sam", null), "Sam wants the Northwind offer.");
  assert.equal(topicSentence("They're weighing the Northwind offer.", "the Northwind offer", "Sam", null), "Sam's weighing the Northwind offer.");
  assert.equal(topicSentence("They want the Northwind offer.", "the Northwind offer", "Sam", null), "You talked about the Northwind offer.");
  assert.equal(topicSentence("They want the Northwind offer.", "the Northwind offer", "Sam", recordedPronoun([{ key: "Pronouns", value: "they/them" }])), "They want the Northwind offer.");
  assert.equal(topicSentence("Talked through the Northwind offer", "the Northwind offer", "Sam", null), "Talked through the Northwind offer.");
});

test("giftIdeas: open lines on their gift lists only", () => {
  const notes = [
    { title: "Priya Shah · Gift ideas", body: "For [@Priya Shah](athena://person/p1).\n\n- [ ] [Château Musar 2017](https://example.com) · £30\n- [x] Candle\n- [ ] Château Musar 2017 · £30" },
    { title: "Tom · Gift ideas", body: "For [@Tom](athena://person/t1).\n\n- [ ] Socks" },
    { title: "Shopping", body: "[@Priya Shah](athena://person/p1)\n- [ ] Milk" },
    { title: "Old gift ideas", body: "athena://person/p1\n- [ ] Scarf", archived_at: "2026-01-01" },
  ];
  assert.deepEqual(giftIdeas(notes, "p1"), ["Château Musar 2017 · £30"]);
});

test("birthdaysToday: only the people who matter most, or you keep in touch with", () => {
  const people = [
    { id: "p1", name: "Priya Shah", birthday: "1991-11-09" },
    { id: "m1", name: "Mum", birthday: "--11-09", keep_in_touch: true },
    { id: "x1", name: "A colleague", birthday: "--11-09" },
    { id: "t1", name: "Tom", birthday: "--11-10", keep_in_touch: true },
  ];
  assert.deepEqual(birthdaysToday(people, new Set(["p1"]), MONDAY).map((p) => p.name), ["Priya Shah", "Mum"]);
});

test("the sheet's words pass the house style", () => {
  const m = personMoment(PRIYA_P, { today: MONDAY, seen: [lunch(MONDAY, NORTHWIND), lunch("2026-10-16"), lunch("2026-03-02")], facts: [{ key: "Pronouns", value: "she/her" }], gifts: ["Château Musar 2017"] });
  for (const line of [m.birthday!.line, m.lastTime!, m.giftLine!, m.again!, m.remind!.label, m.write]) assert.deepEqual(styleProblems(line), [], line);
});

test("personMoment: a venue reads the way the day's line says it (night G1, lib/day-words.ts)", () => {
  const gallery: SeenItem = { date: MONDAY, people: priya, inPerson: true, how: "Gallery", where: "Barbican Centre" };
  const m = personMoment(PRIYA_P, { today: MONDAY, seen: [gallery], facts: [], gifts: [] });
  assert.match(m.lastTime ?? "", /at the Barbican today\./);
  assert.doesNotMatch(m.lastTime ?? "", /Barbican Centre/);
});

test("Your people: only the people who matter most with Keep in touch on", () => {
  const people = [
    { id: "priya", name: "Priya Shah" },
    { id: "arthur", name: "Arthur" },
    { id: null, name: "Someone typed by name" },
  ];
  const records = [
    { id: "priya", keep_in_touch: true },
    { id: "arthur", keep_in_touch: false },
  ];
  assert.deepEqual(keepingInTouch(people, records).map((p) => p.name), ["Priya Shah"]);
  assert.deepEqual(keepingInTouch(people, []), []);
});
