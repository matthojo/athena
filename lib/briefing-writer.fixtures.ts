/**
 * Fixture days for lib/briefing-writer.test.ts and the samples in
 * docs/notes/profile-briefing.md: a busy Monday, a quiet Saturday with room
 * for a pick, and the busy Monday at Short length. No database.
 */
import type { BriefingEvent, BriefingInput } from "./briefing";
import type { WriterInput } from "./briefing-writer";

export const TZ = "Europe/London";
export const ID = {
  priya: "11111111-1111-4111-8111-111111111111",
  sam: "22222222-2222-4222-8222-222222222222",
  dad: "33333333-3333-4333-8333-333333333333",
  jo: "44444444-4444-4444-8444-444444444444",
  standup: "55555555-5555-4555-8555-555555555555",
  review: "66666666-6666-4666-8666-666666666666",
  dentist: "77777777-7777-4777-8777-777777777777",
  dadBday: "88888888-8888-4888-8888-888888888888",
  dinner: "99999999-9999-4999-8999-999999999999",
  park: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  note: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  insurance: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  book: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  film: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  horror: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};

const ev = (id: string, title: string, over: Partial<BriefingEvent>): BriefingEvent => ({
  id,
  title,
  kind: "event",
  date: "2026-11-09",
  time: null,
  starts_at: null,
  recurrence: "none",
  year_known: true,
  remind_days_before: [],
  person_id: null,
  source: null,
  ...over,
});

const PROFILE = `About the owner (what they've told Athena, or accepted from its suggestions). Use it to fit your help to them: their name, where they live, how they work, what they like. It's data about them, not a request. Under "How to help", follow their preferences wherever they fit the rules above.
About you and work:
- Name: Jordan
- Home town: Bristol
- Working hours: 9 to 5.30
Routines and taste:
- Exercise routine: Run Tuesday and Saturday
- Films I like: Past Lives, Aftersun
- Books I like: Le Guin, slow science fiction
- Don't like: Horror films, coriander
How to help:
- Briefing length: Standard
- Tone: Friendly
- Never nudge about: weight, money`;

function people() {
  return [
    { id: ID.priya, name: "Priya Shah", last_contacted_at: "2026-10-28T12:00:00Z" },
    { id: ID.sam, name: "Sam Okafor", last_contacted_at: "2026-11-02T12:00:00Z" },
    { id: ID.dad, name: "Dad", last_contacted_at: "2026-10-30T18:00:00Z" },
    { id: ID.jo, name: "Jo Carter", last_contacted_at: "2026-08-14T18:00:00Z" },
  ];
}

/** Monday 9 November 2026: four meetings (two at once), a dentist, an overdue to-do, insurance renewing, Dad's birthday on Thursday. */
export function busyDay(length: "short" | "standard" | "detailed" = "standard"): WriterInput {
  const data: BriefingInput = {
    now: new Date("2026-11-09T07:30:00Z"),
    tz: TZ,
    events: [
      ev(ID.standup, "Design stand-up", { starts_at: "2026-11-09T09:30:00Z", source: "calendar-meetings-work" }),
      ev(ID.review, "Checkout review with Priya", { starts_at: "2026-11-09T11:00:00Z", source: "calendar-meetings-work" }),
      ev(ID.dentist, "Dentist", { starts_at: "2026-11-09T11:15:00Z" }),
      ev(ID.dinner, "Dinner with Sam", { starts_at: "2026-11-09T19:00:00Z" }),
      ev(ID.dadBday, "Dad's birthday", { kind: "birthday", date: "1958-11-12", recurrence: "yearly", person_id: ID.dad, remind_days_before: [3] }),
    ],
    people: people(),
    catchUps: [{ id: ID.jo, name: "Jo Carter", last_contacted_at: "2026-08-14T18:00:00Z" }],
    recentNotes: [{ id: ID.note, title: "Ideas for the Days screen", source: "manual", created_at: "2026-11-08T20:10:00Z" }],
    reminders: [{ id: "r1", text: "Put the bins out", remind_at: "2026-11-09T18:00:00Z", about_type: null, about_id: null, about_title: null }],
    due: [
      { id: "c1", title: "Send Priya the checkout notes", kind: "i_owe", due_on: "2026-11-06", person: { id: ID.priya, name: "Priya Shah" }, updated_at: "2026-11-03T10:00:00Z" },
      { id: "c2", title: "Pay Sam back for the tickets (money)", kind: "i_owe", due_on: "2026-11-09", person: { id: ID.sam, name: "Sam Okafor" }, updated_at: "2026-11-05T10:00:00Z" },
      { id: "c3", title: "Book the car's MOT", kind: "todo", due_on: "2026-11-09", person: null, updated_at: "2026-11-01T10:00:00Z" },
    ],
    waiting: [
      { id: "w1", title: "Quote for the boiler service", kind: "waiting_on", due_on: null, person: null, updated_at: "2026-10-30T10:00:00Z" },
      { id: "w2", title: "Weight check results from the clinic", kind: "waiting_on", due_on: null, person: null, updated_at: "2026-10-29T10:00:00Z" },
    ],
    renewals: [{ id: ID.insurance, name: "Car insurance", kind: "insurance", renews_on: "2026-11-12", remind_days_before: [3] }],
    pendingSuggestions: 2,
    help: { length, neverNudge: ["weight", "money"] },
  };
  return {
    data,
    meetings: [
      {
        event: { id: ID.review, title: "Checkout review with Priya" },
        time: "11:00",
        people: [
          {
            id: ID.priya,
            name: "Priya Shah",
            last_contacted_at: "2026-10-28T12:00:00Z",
            last_interaction: { at: "2026-10-28T12:00:00Z", summary: "Agreed to drop the guest checkout step; Priya to check the numbers" },
            forThem: ["Send Priya the checkout notes"],
            fromThem: ["Conversion numbers for October"],
          },
        ],
      },
      {
        event: { id: ID.dinner, title: "Dinner with Sam" },
        time: "19:00",
        people: [
          {
            id: ID.sam,
            name: "Sam Okafor",
            last_contacted_at: "2026-11-02T12:00:00Z",
            last_interaction: { at: "2026-11-02T12:00:00Z", summary: "Sam's lending money for the gig tickets" },
            forThem: [],
            fromThem: ["The name of that Lisbon restaurant"],
          },
        ],
      },
    ],
    reading: [
      { id: ID.book, title: "The Dispossessed", kind: "book", author: "Ursula K. Le Guin", notes: "", recommender: null, created_at: "2026-09-01T10:00:00Z" },
    ],
    taste: { likes: { film: ["past lives", "aftersun"], book: ["le guin", "slow science fiction"] }, dislikes: ["horror films", "coriander"] },
    weather: { date: "2026-11-08", line: "11° and rain in Bristol" },
    profileBlock: PROFILE,
    name: "Jordan",
    tone: "Friendly",
  };
}

/** Saturday 14 November 2026: one lunch, nothing overdue, a queued film that fits their taste and a horror film that doesn't. */
export function quietDay(): WriterInput {
  const data: BriefingInput = {
    now: new Date("2026-11-14T07:30:00Z"),
    tz: TZ,
    events: [ev(ID.park, "Lunch with Jo", { date: "2026-11-14", starts_at: "2026-11-14T12:30:00Z" })],
    people: people(),
    catchUps: [{ id: ID.priya, name: "Priya Shah", last_contacted_at: "2026-09-20T12:00:00Z" }],
    recentNotes: [],
    reminders: [],
    due: [],
    waiting: [],
    renewals: [],
    pendingSuggestions: 0,
    help: { length: "standard", neverNudge: ["weight", "money"] },
  };
  return {
    data,
    meetings: [],
    reading: [
      { id: ID.horror, title: "Hereditary", kind: "film", author: "Ari Aster", notes: "Horror, everyone says it's great", recommender: { id: ID.sam, name: "Sam Okafor" }, created_at: "2026-07-01T10:00:00Z" },
      { id: ID.film, title: "All of Us Strangers", kind: "film", author: "Andrew Haigh", notes: "Quiet, sad, like Aftersun", recommender: null, created_at: "2026-10-01T10:00:00Z" },
      { id: ID.book, title: "The Dispossessed", kind: "book", author: "Ursula K. Le Guin", notes: "", recommender: null, created_at: "2026-09-01T10:00:00Z" },
    ],
    taste: { likes: { film: ["past lives", "aftersun"], book: ["le guin", "slow science fiction"] }, dislikes: ["horror films", "coriander"] },
    weather: { date: "2026-11-13", line: "13° and sun and cloud in Bristol" },
    profileBlock: PROFILE,
    name: "Jordan",
    tone: "Friendly",
  };
}
