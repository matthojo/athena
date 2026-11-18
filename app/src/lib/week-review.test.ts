// The week in review's model (app/src/lib/week-review.ts): who counts as seen, the Mood tile's strip,
// goals moved on from the server's log, and what counts as a meeting.
// Run: npx tsx --test app/src/lib/week-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, catchUpsDue, decisionsIn, moodStrip, peopleSeen, stillOpen, type ReviewInput, type SeenEvent } from "./week-review";
import type { Day } from "../db/days-app";
import type { Asset, Commitment, Interaction, Person } from "../types";

const TZ = "Europe/London";
const FROM = "2026-11-02";
const TO = "2026-11-08";

const ix = (id: string, at: string, channel: Interaction["channel"], people: [string, string][], summary = "", extra: Partial<Interaction> = {}): Interaction => ({
  id,
  at,
  channel,
  summary,
  source: "manual",
  source_ref: null,
  people: people.map(([pid, name]) => ({ id: pid, name })),
  created_at: at,
  updated_at: at,
  ...extra,
});

const day = (date: string, over: Partial<Day> = {}): Day => ({ date, photos: [], places: [], entries: [], notes: [], events: [], counts: { entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0 }, ...over }) as Day;

const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  period: "week",
  from: FROM,
  to: TO,
  today: TO,
  tz: TZ,
  days: [],
  interactions: [],
  seenEvents: [],
  commitments: [],
  goalMoves: [],
  trips: [],
  events: [],
  knownPlaces: null,
  ...over,
});

// ---------- Seen ----------

test("seen: in-person catch-ups and calls count; meetings, messages and emails don't", () => {
  const people = peopleSeen(
    [
      ix("1", "2026-11-04T13:00:00Z", "in_person", [["priya", "Priya Shah"]], "Lunch upstairs."),
      ix("2", "2026-11-05T10:00:00Z", "call", [["mum", "Mum"]], "Her tomatoes."),
      ix("3", "2026-11-03T09:00:00Z", "meeting", [["elena", "Dr. Elena Osei"]], "Roadmap review"),
      ix("4", "2026-11-03T09:00:00Z", "message", [["tom", "Tom Hale"]]),
      ix("5", "2026-11-03T09:00:00Z", "email", [["sam", "Sam Reid"]]),
    ],
    [],
    FROM,
    TO,
    TZ,
  );
  assert.deepEqual(
    people.map((p) => [p.name, p.how, p.inPerson]),
    [
      ["Priya", "In person", true],
      ["Mum", "Call", false],
    ],
  );
});

test("seen: a calendar event with a named person at a place counts as seeing them", () => {
  const events: SeenEvent[] = [{ id: "e1", title: "Lunch with Tom", date: "2026-11-06", people: [{ id: "tom", name: "Tom Hale" }], place: "Barbican Centre" }];
  const [tom] = peopleSeen([], events, FROM, TO, TZ);
  assert.deepEqual(tom, { id: "tom", name: "Tom", how: "Lunch with Tom", inPerson: true, dates: ["2026-11-06"], summary: "", where: "Barbican Centre" });
});

test("seen: an event with no place, or outside the week, doesn't count", () => {
  const events: SeenEvent[] = [
    { id: "e1", title: "Call", date: "2026-11-06", people: [{ id: "tom", name: "Tom Hale" }], place: "" },
    { id: "e2", title: "Lunch", date: "2026-11-10", people: [{ id: "tom", name: "Tom Hale" }], place: "Dishoom" },
  ];
  assert.deepEqual(peopleSeen([], events, FROM, TO, TZ), []);
});

test("seen: one row per person; seeing them beats a call, and a logged lunch and its calendar event are one day", () => {
  const people = peopleSeen(
    [ix("1", "2026-11-03T12:00:00Z", "call", [["priya", "Priya Shah"]], "Contract questions."), ix("2", "2026-11-05T12:30:00Z", "in_person", [["priya", "Priya Shah"]], "Lunch upstairs.")],
    [{ id: "e1", title: "Lunch with Priya", date: "2026-11-05", people: [{ id: "priya", name: "Priya Shah" }], place: "Dishoom King's Cross" }],
    FROM,
    TO,
    TZ,
  );
  assert.equal(people.length, 1);
  assert.deepEqual(people[0].dates, ["2026-11-05", "2026-11-03"]);
  assert.equal(people[0].inPerson, true);
  assert.equal(people[0].summary, "Lunch upstairs.");
  assert.equal(people[0].where, "Dishoom King's Cross");
});

test("seen: dates are read in the owner's zone, and two people with one first name keep their full names", () => {
  const people = peopleSeen(
    [
      // 23:30 UTC on Sunday 1 Nov is 00:30 on Monday in Berlin: this week.
      ix("1", "2026-11-01T23:30:00Z", "in_person", [["tomh", "Tom Hale"]]),
      ix("2", "2026-11-04T12:00:00Z", "in_person", [["toml", "Tom Lee"]]),
      // 23:30 UTC on Sunday 8 Nov is Monday 9 Nov in Berlin: next week.
      ix("3", "2026-11-08T23:30:00Z", "in_person", [["jo", "Jo Carter"]]),
    ],
    [],
    FROM,
    TO,
    "Europe/Berlin",
  );
  assert.deepEqual(people.map((p) => p.name).sort(), ["Tom Hale", "Tom Lee"]);
});

// ---------- Mood strip ----------

test("mood strip: a cell per day, future days marked, the average of the days set", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((date, i) => ({
    date,
    mood: ([4, 5, null, 3, 4, null, null] as const)[i] ?? undefined,
    future: date > "2026-11-06",
  }));
  const m = moodStrip(days, "week");
  assert.equal(m.cells.length, 7);
  assert.deepEqual(
    m.cells.map((c) => c.label),
    ["M", "T", "W", "T", "F", "S", "S"],
  );
  assert.deepEqual(
    m.cells.map((c) => c.mood),
    [4, 5, null, 3, 4, null, null],
  );
  assert.equal(m.set, 4);
  assert.equal(m.average, 4);
  assert.equal(m.cells[2].title, "Wed 4 Nov: not set");
  assert.equal(m.cells[6].title, "Sun 8 Nov: still to come");
  assert.equal(m.cells[0].title, "Mon 2 Nov: good");
});

test("mood strip: a month has every day, labelled by its number, and nothing set has no average", () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, future: false }));
  const m = moodStrip(days, "month");
  assert.equal(m.cells.length, 30);
  assert.equal(m.cells[0].label, "1");
  assert.equal(m.cells[29].label, "30");
  assert.equal(m.set, 0);
  assert.equal(m.average, null);
});

test("the model's mood tile reads the period's Days, and the headline opens with the mood word", () => {
  const days = [day("2026-11-02", { mood: 4 }), day("2026-11-03", { mood: 5 }), day("2026-11-05", { mood: 4 })];
  const m = buildModel(input({ days, today: "2026-11-05" }));
  assert.equal(m.mood.cells.length, 7);
  assert.equal(m.mood.set, 3);
  assert.equal(m.mood.average, 4);
  assert.equal(m.mood.cells[6].future, true);
  assert.match(m.headline.text, /^A good week/);
});

// ---------- Goals moved on ----------

test("goals moved on come from the server's log: was and now become progress and how far it moved", () => {
  const m = buildModel(
    input({
      goalMoves: [
        { title: "Ship the memory layer", target: "Live on every device", was: 30, now: 50 },
        { title: "Read twelve books", target: "", was: 60, now: 60 },
      ],
    }),
  );
  assert.deepEqual(m.goals, [{ title: "Ship the memory layer", progress: 50, delta: 20, target: "Live on every device" }]);
  assert.deepEqual(m.signals.goalsMoved, ["Ship the memory layer"]);
  assert.equal(m.headline.text, "Ship the memory layer moved on");
});

// ---------- Meetings and the rest ----------

test("meetings are the week's timed calendar events, not birthdays, deadlines or the lunch already counted as seeing someone", () => {
  const days = [
    day("2026-11-03", {
      events: [
        { id: "a", title: "Roadmap review", kind: "other", starts_at: "2026-11-03T10:00:00Z" },
        { id: "b", title: "Mum's birthday", kind: "birthday", date: "2026-11-03" },
        { id: "c", title: "Lunch with Priya", kind: "other", starts_at: "2026-11-03T12:00:00Z" },
        { id: "d", title: "Tax return", kind: "deadline", date: "2026-11-03" },
        { id: "e", title: "Bank holiday", kind: "other", date: "2026-11-03" },
      ],
    }),
  ];
  const m = buildModel(input({ days, seenEvents: [{ id: "c", title: "Lunch with Priya", date: "2026-11-03", people: [{ id: "p", name: "Priya Shah" }], place: "Dishoom" }] }));
  assert.deepEqual(
    m.meetings.map((x) => x.title),
    ["Roadmap review"],
  );
  assert.deepEqual(
    m.people.map((p) => p.name),
    ["Priya"],
  );
});

test("links are the entries' own addresses, once each; places skip home and work and mark first visits", () => {
  const days = [
    day("2026-11-03", {
      places: [{ name: "Home" }, { name: "Barbican Centre", minutes: 90 }, { name: "Dishoom", minutes: 60 }],
      entries: [
        { id: "1", kind: "saved", title: "A good read", url: "https://www.example.com/a", source: "saved" },
        { id: "2", kind: "saved", title: "A good read again", url: "https://www.example.com/a", source: "saved" },
        { id: "3", kind: "posted", title: "A post", url: "https://example.social/p/1", source: "mastodon" },
      ] as Day["entries"],
    }),
  ];
  const m = buildModel(input({ days, knownPlaces: new Set(["Dishoom"]) }));
  assert.deepEqual(
    m.links.map((l) => [l.url, l.host, l.via]),
    [
      ["https://www.example.com/a", "example.com", "Saved"],
      ["https://example.social/p/1", "example.social", "Posted"],
    ],
  );
  assert.deepEqual(
    m.places.map((p) => [p.name, p.isNew]),
    [
      ["Barbican Centre", true],
      ["Dishoom", false],
    ],
  );
  // Without the eight weeks before (offline), nothing is called a first visit.
  assert.ok(buildModel(input({ days })).places.every((p) => !p.isNew));
});

// ---------- The page's new copy ----------

test("the review's new copy passes the house style check: no em dashes, no stock words", async () => {
  const { styleProblems } = await import("../../../lib/writing-style");
  const copy = [
    "No one in your catch-ups or calendar this week.",
    "You're offline, so this is what this device kept.",
    "Not here yet: Health, habits, places and media · Goals moved on · Calendar catch-ups · First visits · Logged catch-ups · To-dos and decisions · Trips · The diary.",
    "Mon 2 Nov: good",
    "Tue 3 Nov: not set",
    "Sun 8 Nov: still to come",
    "set on four days",
    "none set",
    "Give from and to as dates, with from first",
    "A review covers a month at most",
  ];
  for (const s of copy) {
    assert.deepEqual(styleProblems(s), [], s);
    assert.doesNotMatch(s, /—|--/, s);
  }
  const m = moodStrip([{ date: "2026-11-02", mood: 4, future: false }], "week");
  assert.ok(copy.includes(m.cells[0].title));
});

// ---------- Takeaways and rides (receipt emails) ----------

test("takeaways and rides from receipts are counted in words; journeys and other things aren't", () => {
  const e = (id: string, source: string, group: string) => ({ id, kind: "other" as const, source, title: id, group });
  const days = [
    day("2026-11-06", { entries: [e("uber", "uber", "Rides"), e("roo", "deliveroo", "Takeaway"), e("tfl", "tfl", "commute")] }),
    day("2026-11-07", { entries: [e("bolt", "bolt", "Rides"), e("je", "justeat", "Takeaway"), e("ue", "ubereats", "Takeaway")] }),
  ];
  assert.equal(buildModel(input({ days })).nights, "Three takeaways and two rides");
  assert.equal(buildModel(input({ days: [day("2026-11-06", { entries: [e("uber", "uber", "Rides")] })] })).nights, "A ride");
  assert.equal(buildModel(input({ days: [day("2026-11-06", { entries: [e("tfl", "tfl", "commute")] })] })).nights, null);
});

// ---------- Moved in from the old weekly review (#/week) ----------

const cm = (id: string, over: Partial<Commitment> = {}): Commitment =>
  ({ id, title: `Thing ${id}`, kind: "todo", status: "open", due_on: null, notes: "", person_id: null, person: null, done_at: null, created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z", source: "manual", source_ref: null, ...over }) as Commitment;
const priya = { id: "priya", name: "Priya Shah" };
const mum = { id: "mum", name: "Mum" };

test("still open: soonest due first, undated last, with the old page's tally", () => {
  const { open, openTally } = stillOpen(
    [
      cm("a", { due_on: "2026-11-10" }),
      cm("b", { due_on: "2026-11-07" }),
      cm("c", { kind: "i_owe", person: priya, person_id: "priya", due_on: "2026-11-09" }),
      cm("d", { kind: "waiting_on", person: mum, person_id: "mum" }),
      cm("e", { status: "done", done_at: "2026-11-05T10:00:00Z" }),
      cm("f", { kind: "decision" }),
      cm("g", { archived_at: "2026-11-02T10:00:00Z" }),
    ],
    "2026-11-08"
  );
  assert.deepEqual(open.map((o) => o.title), ["Thing b", "Thing c", "Thing a", "Thing d"]);
  assert.deepEqual(openTally, { overdue: 1, forOthers: 1, waiting: 1 });
  assert.equal(open[1].relation, "For Priya");
  assert.equal(open[3].relation, "Waiting on Mum");
  assert.equal(open[0].overdue, true);
});

test("still open and catch-ups show only for the period holding today", () => {
  const people: Person[] = [{ id: "m", name: "Marcus Webb", notes: "", last_contacted_at: "2026-08-01T10:00:00Z", keep_in_touch: true, created_at: "", updated_at: "" }];
  const now = buildModel(input({ commitments: [cm("a")], people }));
  assert.equal(now.open.length, 1);
  assert.equal(now.catchUps.length, 1);
  // Someone seen this week isn't overdue, whatever their record says.
  const seen = buildModel(input({ people, interactions: [ix("1", "2026-11-04T13:00:00Z", "in_person", [["m", "Marcus Webb"]])] }));
  assert.equal(seen.catchUps.length, 0);
  const past = buildModel(input({ from: "2026-10-26", to: "2026-11-01", commitments: [cm("a")], people }));
  assert.equal(past.open.length, 0);
  assert.equal(past.catchUps.length, 0);
});

test("catch up with: kept-in-touch people past their gap, longest first, never-logged first of all", () => {
  const p = (id: string, last: string | null, over: Partial<Person> = {}): Person => ({ id, name: id, notes: "", last_contacted_at: last, keep_in_touch: true, created_at: "", updated_at: "", ...over });
  const list = catchUpsDue(
    [
      p("recent", "2026-10-20T10:00:00Z"),
      p("old", "2026-07-01T10:00:00Z"),
      p("older", "2026-05-01T10:00:00Z"),
      p("never", null),
      p("quiet", "2026-05-01T10:00:00Z", { keep_in_touch: false }),
      p("weekly", "2026-10-30T10:00:00Z", { catch_up_days: 7 }),
      p("gone", null, { archived_at: "2026-11-01T00:00:00Z" }),
    ],
    "2026-11-08"
  );
  assert.deepEqual(list.map((x) => x.id), ["never", "older", "old", "weekly"]);
  assert.equal(list[0].since, null);
  assert.equal(list[3].since, 9);
});

test("decisions: counted on the day closed, or the day made when still open; dropped and repeats left out", () => {
  const day = (iso: string) => iso.slice(0, 10);
  const list = decisionsIn(
    [
      cm("a", { kind: "decision", title: "Fortnightly mentoring", status: "done", done_at: "2026-11-07T10:00:00Z", person: priya }),
      cm("b", { kind: "decision", title: "Fortnightly mentoring", status: "done", done_at: "2026-11-05T10:00:00Z" }),
      cm("c", { kind: "decision", title: "Take the Lisbon flat", created_at: "2026-11-03T10:00:00Z" }),
      cm("d", { kind: "decision", title: "Dropped idea", status: "dropped", created_at: "2026-11-03T10:00:00Z" }),
      cm("e", { kind: "decision", title: "Last month", status: "done", done_at: "2026-10-03T10:00:00Z" }),
      cm("f", { title: "A to-do", status: "done", done_at: "2026-11-03T10:00:00Z" }),
    ],
    FROM,
    TO,
    day
  );
  assert.deepEqual(list.map((d) => [d.title, d.date, d.person]), [["Fortnightly mentoring", "2026-11-07", "Priya"], ["Take the Lisbon flat", "2026-11-03", undefined]]);
});

test("looking ahead: renewals in the next seven days, worded by kind", () => {
  const a = (name: string, kind: Asset["kind"], renews_on: string): Asset => ({ id: name, name, kind, provider: "", renews_on, remind_days_before: [], notes: "", created_at: "", updated_at: "" });
  const m = buildModel(input({ assets: [a("Netflix", "subscription", "2026-11-12"), a("Passport", "passport", "2026-11-10"), a("Car insurance", "insurance", "2026-12-20")] }));
  assert.deepEqual(m.ahead.filter((x) => x.kind === "renewal").map((x) => [x.title, x.detail]), [["Passport", "Expires"], ["Netflix", "Renews"]]);
});

test("the moved-in copy passes the house style check", async () => {
  const { styleProblems } = await import("../../../lib/writing-style");
  const copy = ["Still open", "one overdue", "two for other people", "two waiting on other people", "Nothing open. A clean slate for next week.", "See all eight in To do", "Catch up with", "Past their usual gap", "Last spoke three months ago", "Last spoke 74 days ago", "Not logged yet", "Life admin · Renews", "Expires", "Waiting on someone", "This week"];
  for (const s of copy) {
    assert.deepEqual(styleProblems(s), [], s);
    assert.doesNotMatch(s, /—|--/, s);
  }
});

// ---------- Habits: what held (night F3) ----------

const row = (name: string, marks: string): import("./week-review").HabitRow => {
  const days = [...marks].map((c) => (c === "x" ? true : c === "o" ? false : null));
  return { name, days, kept: days.filter((d) => d === true).length, due: days.filter((d) => d !== null).length };
};

test("heldLine: names what held, by name, never a percentage", async () => {
  const { heldLine } = await import("./week-review");
  // Mon–Fri walks, reading on six days, a habit that didn't hold this week.
  const rows = [row("Evening walk", "xxxxx.."), row("Read 20 pages", "xxx.xxx"), row("Stretch", "x.o.x..")];
  assert.equal(heldLine(rows, FROM), "Evening walk every weekday. Read 20 pages on six days.");
  assert.equal(heldLine([row("Water plants", "xxxxxxx")], FROM), "Water plants every day.");
  // Five days including a weekend day is "on five days", not "every weekday".
  assert.equal(heldLine([row("Yoga", "xxxx..x")], FROM), "Yoga on five days.");
  // Nothing reached five: the most-done one or two are named with their days, never what was missed.
  assert.equal(heldLine([row("Stretch", "x.o.x.x"), row("Meditate", "x......"), row("Floss", "o.o....")], FROM), "Stretch on three days. Meditate on one day.");
  // Nothing done at all: nothing to say.
  assert.equal(heldLine([row("Floss", "o.o....")], FROM), "");
  // More than four held: four by name, then the rest in a word.
  const many = ["A", "B", "C", "D", "E", "F"].map((n) => row(n, "xxxxxx."));
  assert.equal(heldLine(many, FROM), "A on six days. B on six days. C on six days. D on six days. Two more held too.");
  // Without a start date the first day is a Monday.
  assert.equal(heldLine([row("Evening walk", "xxxxx..")]), "Evening walk every weekday.");
  for (const r of [heldLine(rows, FROM), heldLine(many, FROM)]) assert.doesNotMatch(r, /%|kept|missed|streak/i);
  const { styleProblems } = await import("../../../lib/writing-style");
  assert.deepEqual(styleProblems(heldLine(rows, FROM)), []);
});

test("heldLine: a month needs five days in seven of its days", async () => {
  const { heldLine } = await import("./week-review");
  const month = (n: number) => row("Run", "x".repeat(n) + ".".repeat(30 - n));
  assert.equal(heldLine([month(22)], "2026-11-01"), "Run on 22 days.");
  assert.equal(heldLine([month(21), row("Swim", "x".repeat(20) + ".".repeat(10))], "2026-11-01"), "Run on 21 days. Swim on 20 days.");
  assert.equal(heldLine([month(10)], "2026-11-01"), "Run on ten days.");
});

test("the habits tile's model: missed days are blank in the grid, not boxes", () => {
  const m = buildModel(input({ days: [day("2026-11-02", { entries: [{ id: "h1", kind: "habit", source: "habits", title: "Evening walk", count: 0 }] as Day["entries"] })] }));
  assert.deepEqual(m.habits[0].days.slice(0, 2), [false, null]);
});

// ---------- The Sunday push and the page agree (lib/week-push.ts) ----------

test("push and page: the server's signals give the page's headline, word for word", async () => {
  const { weekSignals } = await import("../../../lib/week-push");
  const { weekHeadline } = await import("../../../lib/week-headline");
  const art = { id: "a", w: 2, h: 3 };
  const days = [
    day("2026-11-02", { mood: 4, places: [{ name: "Home" }, { name: "Barbican Centre", minutes: 120 }] as Day["places"], health: { sleep_minutes: 430, workouts: [{ type: "Run", minutes: 30, distance_m: 5000 }] } as Day["health"], entries: [{ id: "h1", kind: "habit", source: "habits", title: "Evening walk" }, { id: "w1", kind: "watched", source: "trakt", title: "S2E1", group: "Severance", art }] as Day["entries"], events: [{ id: "m1", title: "Standup", kind: "meeting", starts_at: "2026-11-02T09:00:00Z" }] }),
    day("2026-11-03", { mood: 5, places: [{ name: "Barbican Centre" }, { name: "Dishoom" }] as Day["places"], health: { sleep_minutes: 410, workouts: [{ type: "Swim", minutes: 40 }] } as Day["health"], entries: [{ id: "h2", kind: "habit", source: "habits", title: "Evening walk", count: 0 }, { id: "l1", kind: "listened", source: "spotify", title: "Blackstar", subtitle: "David Bowie", art }] as Day["entries"] }),
    day("2026-11-04", { mood: 4, entries: [{ id: "h3", kind: "habit", source: "habits", title: "Evening walk" }] as Day["entries"] }),
  ];
  const interactions = [ix("1", "2026-11-04T13:00:00Z", "in_person", [["priya", "Priya Shah"]]), ix("2", "2026-11-05T10:00:00Z", "call", [["mum", "Mum"]]), ix("3", "2026-11-03T09:00:00Z", "meeting", [["el", "Elena Osei"]])];
  const seenEvents: SeenEvent[] = [{ id: "e1", title: "Lunch with Tom", date: "2026-11-06", people: [{ id: "tom", name: "Tom Hale" }], place: "Dishoom" }];
  const c = (id: string, kind: Commitment["kind"], status: Commitment["status"], done_at: string | null, created_at = "2026-10-20T10:00:00Z") => ({ id, title: `Thing ${id}`, kind, status, done_at, created_at, due_on: "2026-10-30", archived_at: null }) as unknown as Commitment;
  const commitments = [c("a", "todo", "done", "2026-11-03T10:00:00Z"), c("b", "todo", "done", "2026-11-04T10:00:00Z"), c("d", "todo", "done", "2026-11-05T10:00:00Z"), c("e", "decision", "open", null, "2026-11-04T10:00:00Z"), c("f", "todo", "open", null), c("g", "todo", "done", "2026-10-28T10:00:00Z")];
  const trips = [{ id: "t", title: "Bristol", starts_on: "2026-11-06", ends_on: "2026-11-07", archived_at: null, bookings: [] }] as unknown as ReviewInput["trips"];
  const goalMoves = [{ title: "Run a half", target: "", was: 40, now: 55 }];
  const knownPlaces = new Set(["Dishoom"]);

  for (const today of ["2026-11-08", "2026-11-04"]) {
    const page = buildModel(input({ today, days, interactions, seenEvents, commitments, trips, goalMoves, knownPlaces }));
    const server = weekSignals({ period: "week", from: FROM, to: TO, today, tz: TZ, days, interactions, seenEvents, commitments, goalMoves, trips, knownPlaces });
    assert.deepEqual(server, page.signals, `signals on ${today}`);
    assert.equal(weekHeadline(server).text, page.headline.text);
  }
  // Something late never reaches the line.
  assert.doesNotMatch(buildModel(input({ days, interactions, seenEvents, commitments, trips, goalMoves, knownPlaces })).headline.text, /overdue|late|open/i);
});

test("heldWhen: a month's habit bars say when it was done in the week's words, never 'n of m days' (night G1)", async () => {
  const { heldWhen } = await import("./week-review");
  // 30 days of November 2026, from Sunday 1 November.
  const month = (f: (i: number) => boolean) => row("Read", Array.from({ length: 30 }, (_, i) => (f(i) ? "x" : "o")).join(""));
  assert.equal(heldWhen(month(() => true), "2026-11-01"), "every day");
  // Weekdays only (1 Nov is a Sunday, so day i is a weekday when (i % 7) is 1 to 5).
  assert.equal(heldWhen(month((i) => i % 7 >= 1 && i % 7 <= 5), "2026-11-01"), "every weekday");
  assert.equal(heldWhen(month((i) => i < 12), "2026-11-01"), "on 12 days");
  assert.equal(heldWhen(month((i) => i === 3), "2026-11-01"), "on one day");
  assert.equal(heldWhen(month(() => false), "2026-11-01"), "");
  for (const r of [month((i) => i < 12)]) assert.doesNotMatch(heldWhen(r, "2026-11-01"), / of \d+/);
});
