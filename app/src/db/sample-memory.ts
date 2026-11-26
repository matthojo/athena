/**
 * Sample data for layer 2 — open loops, interactions, facts, the review
 * inbox, life admin, watch & read and goals — so sample mode shows the whole PA.
 * Same rules as sample-data.ts: stable ids, dates relative to today, and only
 * ever shown with the "Sample data" status pill.
 */

import { RENEWAL_NOTE, RENEWAL_REMIND_DAYS } from "../../../lib/car";
import { addDays } from "../../../lib/dates";
import { localToday } from "../lib/time";
import { SAMPLE_IDS } from "./sample-data";
import { sampleContextId as ctx } from "./todo-contexts";
import type { Asset, Commitment, Fact, Goal, Identity, Interaction, PersonRef, ReadingItem, Suggestion } from "../types";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const id = (n: number) => `5a3e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const PRIYA: PersonRef = { id: SAMPLE_IDS.priya, name: "Priya Shah" };
const MARCUS: PersonRef = { id: SAMPLE_IDS.marcus, name: "Marcus Webb" };
const ELENA: PersonRef = { id: SAMPLE_IDS.elena, name: "Dr. Elena Osei" };
const MUM: PersonRef = { id: SAMPLE_IDS.mum, name: "Mum" };
const TOM: PersonRef = { id: SAMPLE_IDS.tom, name: "Tom Hale" };

export function sampleCommitments(): Commitment[] {
  const today = localToday();
  const base = {
    notes: "",
    person_id: null,
    person: null,
    source: "manual",
    source_ref: null,
    source_quote: null,
    confidence: null,
    done_at: null,
    archived_at: null,
  };
  const c = (n: number, rest: Partial<Commitment> & Pick<Commitment, "title" | "kind">, age = 2): Commitment => ({
    ...base,
    id: id(500 + n),
    status: "open",
    due_on: null,
    created_at: daysAgo(age),
    updated_at: daysAgo(age),
    ...rest,
  });
  return [
    c(1, {
      title: "Intro Priya to the design agency",
      kind: "i_owe",
      person_id: PRIYA.id,
      person: PRIYA,
      due_on: addDays(today, 1),
      source: "calendar-meetings-work",
      source_quote: "I'll intro you to the agency folks this week.",
      confidence: 0.92,
      area_id: ctx("area", "work"),
      where_id: ctx("where", "computer"),
      context_by_athena: true,
    }, 1),
    c(2, { title: "Signed contract back from Marcus", kind: "waiting_on", person_id: MARCUS.id, person: MARCUS, source: "email-digest-work", area_id: ctx("area", "work"), context_by_athena: true }, 8),
    c(3, {
      title: "Book the car's MOT",
      kind: "todo",
      due_on: addDays(today, -1),
      priority: 3,
      notes: "The garage on the high street does Saturday slots. Ask for a courtesy car if it needs work.",
      steps: [
        { id: "mot1", text: "Find the V5C logbook", done: true },
        { id: "mot2", text: "Check the old certificate's expiry date", done: true },
        { id: "mot3", text: "Ring the garage for a Saturday slot", done: false },
      ],
      links: [{ id: "motl1", url: "https://www.example.com/check-mot-history", title: "Check MOT history" }],
      area_id: ctx("area", "home"),
      where_id: ctx("where", "phone"),
    }, 6),
    c(4, { title: "Pick up prescription", kind: "todo", due_on: today, area_id: ctx("area", "health"), where_id: ctx("where", "errands") }, 1),
    c(5, {
      title: "Draft the Q3 planning doc",
      kind: "todo",
      due_on: addDays(today, 4),
      priority: 2,
      notes: `Now / next / later, not one flat list. Run the framing past [@Dr. Elena Osei](athena://person/${SAMPLE_IDS.elena}) before it goes wider.`,
      steps: [
        { id: "q3s1", text: "Pull the open themes from last quarter", done: true },
        { id: "q3s2", text: "Sort them into now, next and later", done: true },
        { id: "q3s3", text: "Write the one-paragraph summary at the top", done: false },
        { id: "q3s4", text: "Add the hiring plan", done: false },
        { id: "q3s5", text: "Share the draft with Elena", done: false },
      ],
      links: [
        { id: "q3l1", url: "athena://note/5a3e0000-0000-4000-8000-000000000001", title: "Reframe the Q3 planning doc" },
        { id: "q3l2", url: "https://docs.example.com/q3-roadmap", title: "Q3 roadmap (shared draft)" },
      ],
      area_id: ctx("area", "work"),
      where_id: ctx("where", "computer"),
    }, 3),
    c(6, { title: "Read Elena's pricing memo and reply", kind: "i_owe", person_id: ELENA.id, person: ELENA, due_on: addDays(today, 6), area_id: ctx("area", "work") }, 2),
    c(7, {
      title: "Plan the summer trip",
      kind: "todo",
      priority: 1,
      steps: [
        { id: "trip1", text: "Agree dates with Tom", done: false },
        { id: "trip2", text: "Shortlist three places", done: false },
      ],
      area_id: ctx("area", "family"),
    }, 20),
    c(8, { title: "Mum's photos from the weekend", kind: "waiting_on", person_id: MUM.id, person: MUM, area_id: ctx("area", "family") }, 2),
    c(9, { title: "Reply to the onboarding thread", kind: "todo", status: "done", done_at: daysAgo(1) }, 4),
    c(10, { title: "Book the boiler service", kind: "todo", status: "done", done_at: daysAgo(2) }, 9),
    c(11, { title: "Send Marcus the seed deck feedback", kind: "i_owe", person_id: MARCUS.id, person: MARCUS, status: "done", done_at: daysAgo(3) }, 10),
    c(12, {
      title: "Mentoring every two weeks, not weekly",
      kind: "decision",
      person_id: PRIYA.id,
      person: PRIYA,
      status: "done",
      done_at: daysAgo(1),
      notes: "A lighter cadence, focused on career framing rather than tactics.",
    }, 1),
    // Earlier weeks' ticked-off to-dos, so Home's "To-dos done" chart has a history.
    ...DONE_HISTORY.map(([title, ago], k) => c(20 + k, { title, kind: "todo", status: "done", done_at: daysAgo(ago) }, ago + 3)),
  ];
}

/** [title, days ago it was done]: 4, 2, 5, 3, 4, 6, 3, 2 and 4 a week, going back nine weeks. */
const DONE_HISTORY: Array<[string, number]> = [
  ["Renew the parking permit", 8],
  ["Send Tom's birthday card", 9.5],
  ["Pay the window cleaner", 11],
  ["Write up the 1:1 notes", 13],
  ["Order new running shoes", 15],
  ["Book train tickets to Leeds", 18],
  ["Cancel the unused gym plan", 22],
  ["Share the offsite notes", 23],
  ["Return the jacket", 24.5],
  ["Call the bank about the new card", 26],
  ["RSVP to Sam's wedding", 27],
  ["Back up the photo library", 29],
  ["Update the CV", 31],
  ["Fix the bike puncture", 33],
  ["Book the dentist", 36],
  ["Reply to Elena about the workshop", 37.5],
  ["Sort the car tax", 39],
  ["Send the thank-you notes", 41],
  ["Plan Mum's birthday dinner", 43],
  ["Renew the home insurance", 44],
  ["Clear out the shed", 45.5],
  ["Draft the team update", 46],
  ["Book the vet for Biscuit", 47],
  ["Pick up the dry cleaning", 48],
  ["Set up the new phone", 50],
  ["Read the board pack", 52],
  ["Recycle the old laptop", 54],
  ["Get the boiler quote", 58],
  ["Send Priya the reading list", 61],
  ["Buy the anniversary present", 64],
  ["File the expenses", 65],
  ["Change the energy tariff", 67],
  ["Book the summer flights", 69],
];

export function sampleInteractions(): Interaction[] {
  const i = (n: number, at: string, channel: Interaction["channel"], summary: string, people: PersonRef[], source = "manual"): Interaction => ({
    id: id(600 + n),
    at,
    channel,
    summary,
    source,
    source_ref: null,
    people,
    archived_at: null,
    created_at: at,
    updated_at: at,
  });
  return [
    i(1, daysAgo(3), "call", "Weekend plans and her tomatoes finally coming through.", [MUM]),
    i(2, daysAgo(21), "call", "Mentoring check-in: moving to every two weeks, focus on career framing.", [PRIYA], "calendar-meetings"),
    i(3, daysAgo(64), "meeting", "Quarterly strategy: pricing experiments and who to hire next.", [ELENA], "calendar-meetings"),
    i(4, daysAgo(96), "in_person", "Coffee near his office. His seed round, and hiring a first designer.", [MARCUS]),
    i(5, daysAgo(140), "meeting", "Design review with both of them on the onboarding flow.", [PRIYA, MARCUS], "calendar-meetings"),
    i(6, daysAgo(180), "in_person", "Bumped into him by the bins. Spare key arrangement.", [TOM]),
  ];
}

export function sampleFacts(): Fact[] {
  const f = (n: number, subject: string | null, key: string, value: string, age = 30, source = "manual", quote: string | null = null): Fact => ({
    id: id(700 + n),
    subject_kind: subject ? "person" : "me",
    subject_id: subject,
    key,
    value,
    source,
    source_ref: null,
    source_quote: quote,
    confidence: source === "manual" ? null : 0.9,
    observed_at: daysAgo(age),
    superseded_at: null,
    archived_at: null,
    created_at: daysAgo(age),
    updated_at: daysAgo(age),
  });
  return [
    f(1, PRIYA.id, "Kids", "Maya (7)", 21, "calendar-meetings", "Maya started at the new school this term."),
    f(2, PRIYA.id, "Coffee order", "Oat flat white", 60),
    f(3, PRIYA.id, "Based in", "Islington", 90),
    f(9, PRIYA.id, "Pronouns", "she/her", 400),
    f(4, MARCUS.id, "Company", "Seed-stage climate startup", 96),
    f(5, MARCUS.id, "Partner", "Sam", 140),
    f(6, ELENA.id, "Prefers", "Morning calls, before 10", 64),
    f(7, MUM.id, "Favourite flowers", "Peonies", 200),
    f(8, null, "Coffee order", "Flat white"),
    // Told to Ask ("remember that…"): Settings → What Athena knows lists them under Remembered in Ask.
    f(10, MARCUS.id, "Kids", "Ada (4) and Leo (1)", 3, "assistant"),
    { ...f(11, null, "Diet", "Vegetarian, but eats fish", 1, "assistant"), confidence: null },
    ...sampleProfile(),
  ];
}

/**
 * The sample owner's profile (Settings → About you): `me` facts under the
 * catalogue's keys (app/src/lib/profile-catalogue.ts). Most typed by the
 * owner; two learned and accepted from the Review inbox; Role and Working
 * hours have an older value as history; "Who you live with" is left empty.
 */
function sampleProfile(): Fact[] {
  const link = (p: PersonRef) => `[@${p.name}](athena://person/${p.id})`;
  const me = (n: number, key: string, value: string, age: number, learned?: { source: string; quote: string; confidence: number }, supersededAge?: number): Fact => ({
    id: id(720 + n),
    subject_kind: "me",
    subject_id: null,
    key,
    value,
    source: learned?.source ?? "manual",
    source_ref: null,
    source_quote: learned?.quote ?? null,
    confidence: learned?.confidence ?? null,
    observed_at: daysAgo(age),
    superseded_at: supersededAge === undefined ? null : daysAgo(supersededAge),
    archived_at: null,
    created_at: daysAgo(age),
    updated_at: daysAgo(supersededAge ?? age),
  });
  return [
    me(1, "Name", "Alex", 40),
    me(2, "Home town", "London", 40),
    me(3, "Role", "Designer", 400, undefined, 40),
    me(4, "Role", "Product designer", 40),
    me(5, "Employer", "Netlify", 40),
    me(6, "Working days", "Monday to Friday", 40),
    me(7, "Working hours", "9 to 5.30", 40, undefined, 12),
    me(8, "Working hours", "8.30 to 5", 12, { source: "calendar-meetings", quote: "First meeting at 08:30 on most weekdays since October", confidence: 0.7 }),
    me(9, "Important people", `${link(MUM)}, ${link(PRIYA)}`, 40),
    me(10, "Exercise routine", "Run Tuesday and Saturday mornings", 20, { source: "life-log", quote: "Runs logged on 7 of the last 8 Tuesdays and Saturdays, before 9", confidence: 0.8 }),
    me(11, "Books I like", "Piranesi, The Overstory, Klara and the Sun", 40),
    me(12, "Films I like", "Past Lives, Paddington 2", 40),
    me(13, "Food I like", "Dishoom, Sichuan, a good roast", 40),
    me(14, "Don't like", "Horror films, coriander", 40),
    me(15, "Goals this year", "Run a half marathon\nRead 24 books\nLearn to cook five Sichuan dishes", 40),
    me(16, "Briefing length", "Short", 40),
    me(17, "Tone", "Friendly", 40),
  ];
}

export function sampleIdentities(): Identity[] {
  return [
    { id: id(750), person_id: PRIYA.id, kind: "slack", value: "priya", created_at: daysAgo(300) },
    { id: id(751), person_id: PRIYA.id, kind: "alias", value: "p shah", created_at: daysAgo(300) },
    { id: id(752), person_id: MARCUS.id, kind: "email", value: "marcus@seedco.example", created_at: daysAgo(96) },
  ];
}

export function sampleSuggestions(): Suggestion[] {
  const today = localToday();
  const s = (n: number, rest: Omit<Suggestion, "id" | "status" | "result_id" | "resolved_at" | "created_at">, age: number): Suggestion => ({
    id: id(800 + n),
    status: "pending",
    result_id: null,
    resolved_at: null,
    created_at: daysAgo(age),
    ...rest,
  });
  return [
    s(1, {
      op: "commitment",
      summary: "You told Marcus you'd send him your hiring rubric",
      payload: { title: "Send Marcus the hiring rubric", kind: "i_owe", person_id: MARCUS.id },
      source: "calendar-meetings",
      source_ref: null,
      source_quote: "I'll dig out the hiring rubric we used and send it over.",
      confidence: 0.72,
    }, 0.2),
    s(10, {
      op: "commitment",
      summary: "Priya asked for 30 minutes next week on the pricing tiers",
      payload: { title: "Find 30 minutes with Priya for the pricing tiers", kind: "todo", person_id: PRIYA.id },
      source: "email-digest",
      source_ref: null,
      source_quote: "Could we grab 30 minutes next week to go over the pricing tiers before I send them round?",
      confidence: 0.81,
    }, 0.1),
    s(2, {
      op: "fact",
      summary: "Elena is moving to Lisbon in the spring",
      payload: { subject_kind: "person", subject_id: ELENA.id, key: "Moving", value: "To Lisbon, in the spring" },
      source: "email-digest",
      source_ref: null,
      source_quote: "We're finally doing it — Lisbon in the spring!",
      confidence: 0.66,
    }, 0.5),
    s(9, {
      op: "fact",
      summary: "About you · Sleep routine: Bed by 11.30, up at 7",
      payload: { subject_kind: "me", key: "Sleep routine", value: "Bed by 11.30, up at 7" },
      source: "life-log",
      source_ref: null,
      source_quote: "Asleep between 23:20 and 23:45, awake by 07:10, on 11 of the last 14 nights",
      confidence: 0.74,
    }, 0.3),
    s(3, {
      op: "event",
      summary: `Hamlet at the Barbican, ${new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${addDays(today, 12)}T12:00:00Z`))} at 19:30`,
      payload: { title: "Hamlet at the Barbican", kind: "appointment", date: addDays(today, 12), time: "19:30" },
      source: "email-digest-personal",
      source_ref: null,
      source_quote: "Your tickets for Hamlet, Barbican Theatre, 19:30. Doors open 18:45.",
      confidence: 0.78,
    }, 1),
    s(11, {
      op: "event",
      summary: `Dishoom confirmed your table for 4 on ${new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${addDays(today, 4)}T12:00:00Z`))} at 19:30`,
      payload: { title: "Dinner at Dishoom, table for 4", kind: "appointment", date: addDays(today, 4), time: "19:30", location: "Dishoom King's Cross" },
      source: "email-digest-personal",
      source_ref: null,
      source_quote: "Your table for 4 at Dishoom King's Cross is booked. We'll hold it for 15 minutes.",
      confidence: 0.86,
    }, 0.15),
    // One class booking, found in three emails (the booking, a reminder, the day before): one card, "Found 3 times".
    ...[
      { subject: "Your spin class is booked", quote: "Your spin class is booked for 7am. Please arrive ten minutes early.", age: 3 },
      { subject: "Reminder: spin class coming up", quote: "Just a reminder that your spin class is at 7am.", age: 1.2 },
      { subject: "See you tomorrow at spin class", quote: "See you tomorrow at 7am for spin class.", age: 0.4 },
    ].map((m, i) =>
      s(12 + i, {
        op: "event",
        summary: `Appointment: Spin class at Northfield Leisure · ${addDays(today, 5)}`,
        payload: { title: "Spin class at Northfield Leisure", kind: "appointment", date: addDays(today, 5), time: "07:00", location: "Northfield Leisure Centre" },
        source: "email-digest-personal",
        source_ref: null,
        source_quote: m.quote,
        confidence: 0.62,
        email: { from: "Northfield Leisure <bookings@mail.northfield.example>", subject: m.subject, connector_id: null },
      }, m.age)
    ),
    // The next week's class is another thing: its own card.
    s(15, {
      op: "event",
      summary: `Appointment: Spin class at Northfield Leisure · ${addDays(today, 12)}`,
      payload: { title: "Spin class at Northfield Leisure", kind: "appointment", date: addDays(today, 12), time: "07:00", location: "Northfield Leisure Centre" },
      source: "email-digest-personal",
      source_ref: null,
      source_quote: "Your spin class is booked for 7am. Please arrive ten minutes early.",
      confidence: 0.62,
      email: { from: "Northfield Leisure <bookings@mail.northfield.example>", subject: "Your spin class is booked", connector_id: null },
    }, 2.5),
    // A delivery email for an order already in Purchases: its card says "Update status".
    s(16, {
      op: "purchase",
      summary: "Out for delivery: KALLAX shelf unit and 1 more from IKEA",
      payload: { retailer: "IKEA", order_number: "IK-1155-0287", items: ["KALLAX shelf unit", "Desk lamp"], status: "out_for_delivery", carrier: "DPD", tracking_number: "15501234567890", detail: "Arriving between 12:00 and 13:00" },
      source: "email-digest-personal",
      source_ref: null,
      source_quote: "Your parcel is out for delivery today. Your driver will be with you between 12:00 and 13:00.",
      confidence: 0.64,
      email: { from: "DPD <notifications@parcels.example>", subject: "Your IKEA order is on its way", connector_id: null },
    }, 0.25),
    // One that isn't: "Add to Purchases".
    s(17, {
      op: "purchase",
      summary: "Ordered: Bamboo desk organiser from Larkspur Home",
      payload: { retailer: "Larkspur Home", order_number: "LH-30418", items: ["Bamboo desk organiser"], status: "ordered" },
      source: "email-digest-personal",
      source_ref: null,
      source_quote: "Thanks for your order! We'll let you know as soon as it's on its way.",
      confidence: 0.58,
      email: { from: "Larkspur Home <orders@larkspur.example>", subject: "Order LH-30418 confirmed", connector_id: null },
    }, 0.6),
    s(4, {
      op: "interaction",
      summary: "You saw Tom at the residents' meeting",
      payload: { person_ids: [TOM.id], channel: "in_person", summary: "Residents' meeting about the new bin rota." },
      source: "email-digest-personal",
      source_ref: null,
      source_quote: "Thanks to everyone who came last night, including Tom from number 14…",
      confidence: 0.55,
    }, 1.5),
  ];
}

export function sampleAssets(): Asset[] {
  const today = localToday();
  const a = (n: number, name: string, kind: Asset["kind"], renewsIn: number | null, provider = "", notes = "", remind = [30, 7, 0]): Asset => ({
    id: id(900 + n),
    name,
    kind,
    provider,
    renews_on: renewsIn === null ? null : addDays(today, renewsIn),
    remind_days_before: remind,
    notes,
    archived_at: null,
    created_at: daysAgo(200),
    updated_at: daysAgo(30),
  });
  return [
    a(1, "Car insurance", "insurance", 9, "Direct Line", "Get two quotes before auto-renewing."),
    a(2, "Netflix", "subscription", 4, "Netflix", "", [3]),
    a(3, "Passport", "passport", 26, "HM Passport Office", "Renewals take about three weeks."),
    // The sample car's two, kept in step by the car sync (lib/car-sync.ts sampleVehicle).
    a(4, "Ford Focus MOT", "vehicle", 21, "DVSA", RENEWAL_NOTE, RENEWAL_REMIND_DAYS),
    a(8, "Ford Focus tax", "vehicle", 143, "DVLA", RENEWAL_NOTE, RENEWAL_REMIND_DAYS),
    a(5, "Boiler service", "home", 120, "British Gas"),
    a(6, "Dishwasher warranty", "warranty", 300, "Bosch"),
    a(7, "Driving licence", "licence", 2400, "DVLA", "", [60, 14]),
  ];
}

export function sampleReading(): ReadingItem[] {
  const r = (n: number, rest: Partial<ReadingItem> & Pick<ReadingItem, "title" | "kind">, age = 10): ReadingItem => ({
    id: id(950 + n),
    url: "",
    author: "",
    status: "queued",
    notes: "",
    recommended_by: null,
    recommender: null,
    finished_at: null,
    source: "manual",
    archived_at: null,
    created_at: daysAgo(age),
    updated_at: daysAgo(age),
    ...rest,
  });
  // Watch & read: a mix of kinds in every state.
  return [
    r(1, { title: "The Mom Test", kind: "book", author: "Rob Fitzpatrick", meta: { year: 2013, pages: 136, genres: ["Business"] }, status: "reading", progress: { unit: "page", done: 84, total: 136 }, recommended_by: PRIYA.id, recommender: PRIYA }, 12),
    r(2, { title: "How to do great work", kind: "article", author: "Paul Graham", url: "https://paulgraham.com/greatwork.html" }, 4),
    r(3, { title: "Shape Up", kind: "book", author: "Ryan Singer", meta: { year: 2019, pages: 176, genres: ["Business", "Design"] }, recommended_by: MARCUS.id, recommender: MARCUS }, 30),
    r(4, { title: "Annie Duke on quitting", kind: "podcast", author: "The Knowledge Project" }, 6),
    r(5, {
      title: "Why is it so hard to do my work?",
      kind: "paper",
      author: "Rowan Leroy",
      status: "done",
      finished_at: daysAgo(3),
      notes: "Attention residue: finishing, or writing down where you stopped, before switching cuts the residue.",
    }, 20),
    r(6, { title: "Severance", kind: "tv", meta: { year: 2022, minutes: 50, genres: ["Drama", "Mystery", "Sci-Fi & Fantasy"] }, status: "reading", progress: { unit: "episode", done: 14, total: 19 }, notes: "Up to S2, episode 4.", recommended_by: TOM.id, recommender: TOM }, 16),
    r(7, { title: "Dune: Part Two", kind: "film", author: "Denis Villeneuve", meta: { year: 2024, minutes: 167, genres: ["Science Fiction", "Adventure"] } }, 2),
    r(22, { title: "The Holdovers", kind: "film", author: "Alexander Payne", meta: { year: 2023, minutes: 133, genres: ["Comedy", "Drama"], themes: ["christmas"] } }, 6),
    r(23, { title: "Aftersun", kind: "film", author: "Charlotte Wells", meta: { year: 2022, minutes: 101, genres: ["Drama"] }, recommended_by: PRIYA.id, recommender: PRIYA }, 18),
    r(24, { title: "Perfect Days", kind: "film", author: "Wim Wenders", meta: { year: 2023, minutes: 124, genres: ["Drama"] } }, 22),
    r(15, { title: "Slow Horses", kind: "tv", source: "trakt", meta: { year: 2022, minutes: 45, genres: ["Drama", "Crime"] }, notes: "Slow-burn spy drama, from the Trakt watchlist." }, 40),
    r(8, { title: "Past Lives", kind: "film", author: "Celine Song", meta: { year: 2023, minutes: 106, genres: ["Drama", "Romance"] }, status: "done", finished_at: daysAgo(5), recommended_by: PRIYA.id, recommender: PRIYA }, 25),
    r(9, { title: "Blue Rev", kind: "music", author: "Alvvays", status: "reading" }, 8),
    r(10, { title: "Hades II", kind: "game", author: "Supergiant Games" }, 14),
    // Saved from YouTube: sets, how-tos and songs, the last filed under the artist's "Topic" channel.
    r(16, { title: "How to board a loft", kind: "video", author: "Homebuilding & Renovating", url: "https://www.youtube.com/watch?v=sample-loft", meta: { year: 2024, minutes: 14, genres: ["How-to"], lists: ["Loft conversion"] } }, 1),
    r(17, { title: "Charlotte de Witte at Tomorrowland 2019", kind: "video", author: "Tomorrowland", url: "https://www.youtube.com/watch?v=sample-set", meta: { year: 2019, minutes: 61, genres: ["Electronic"], lists: ["Sets"], music: true } }, 3),
    r(18, { title: "The art of the small kitchen", kind: "video", author: "Never Too Small", url: "https://www.youtube.com/watch?v=sample-kitchen", meta: { year: 2023, minutes: 9, genres: ["Lifestyle"], lists: ["Loft conversion"] }, recommended_by: PRIYA.id, recommender: PRIYA }, 5),
    r(19, { title: "Toxicity", kind: "video", author: "System of A Down - Topic", url: "https://www.youtube.com/watch?v=sample-toxicity", meta: { year: 2001, minutes: 4, genres: ["Rock"], music: true } }, 7),
    r(25, { title: "Bicep live at Glastonbury 2022", kind: "video", author: "BBC Music", url: "https://www.youtube.com/watch?v=sample-bicep", meta: { year: 2022, minutes: 58, genres: ["Electronic"], lists: ["Sets"], music: true } }, 8),
    r(26, { title: "Fairytale of New York", kind: "video", author: "The Pogues", url: "https://www.youtube.com/watch?v=sample-fairytale", meta: { year: 1987, minutes: 5, genres: ["Rock"], lists: ["Christmas"], music: true } }, 320),
    r(27, { title: "Insulating a loft floor, start to finish", kind: "video", author: "Skill Builder", url: "https://www.youtube.com/watch?v=sample-insulate", meta: { year: 2023, minutes: 27, genres: ["How-to"], lists: ["Loft conversion"] } }, 2),
    r(28, { title: "How a Japanese joiner builds without nails", kind: "video", author: "Dylan Iwakuni", url: "https://www.youtube.com/watch?v=sample-joinery", meta: { year: 2021, minutes: 18, genres: ["How-to"] } }, 12),
    // Liked on YouTube, so they arrive watched: a music video (Music's, at the foot of the page) and a Short (not music: stays in Finished here).
    r(30, { title: "Khruangbin: Tiny Desk Concert", kind: "video", author: "NPR Music", url: "https://www.youtube.com/watch?v=sample-tinydesk", source: "youtube", status: "done", finished_at: daysAgo(6), meta: { year: 2018, minutes: 17, genres: ["Funk"], music: true } }, 6),
    r(31, { title: "This riff in 30 seconds", kind: "video", author: "Guitar Shorts", url: "https://www.youtube.com/watch?v=sample-riff", source: "youtube", status: "done", finished_at: daysAgo(4), meta: { year: 2025, minutes: 1, genres: ["Rock"], music: true } }, 4),
    r(33, { title: "POV: you finally fix the squeaky stair", kind: "video", author: "DIY in 60", url: "https://www.youtube.com/shorts/sample-stair", source: "youtube", meta: { year: 2026, minutes: 1, genres: ["How-to"] } }, 2),
    r(34, { title: "Cat discovers the loft hatch", kind: "video", author: "Small Chaos", url: "https://www.youtube.com/watch?v=sample-hatch", source: "youtube", status: "done", finished_at: daysAgo(2), meta: { year: 2026, minutes: 1 } }, 2),
    r(32, { title: "Carrie & Lowell", kind: "music", author: "Sufjan Stevens", status: "done", finished_at: daysAgo(20), meta: { year: 2015, genres: ["Indie"] } }, 60),
    r(20, { title: "In Rainbows", kind: "music", author: "Radiohead", meta: { year: 2007, genres: ["Rock"] } }, 9),
    r(21, { title: "The Rest Is History: The Fall of Rome", kind: "podcast", author: "Goalhanger" }, 11),
    // Loaded from Trakt's history when it was connected (netlify/lib/connectors/backfill.ts): dated when watched.
    r(11, { title: "Arrival", kind: "film", meta: { year: 2016, minutes: 116, genres: ["Science Fiction", "Drama"] }, status: "done", url: "https://trakt.tv/movies/arrival-2016", finished_at: "2021-06-01T20:00:00.000Z", source: "life-log-personal", created_at: "2021-06-01T20:00:00.000Z", updated_at: "2021-06-01T20:00:00.000Z" }),
    r(12, { title: "Paddington 2", kind: "film", meta: { year: 2017, minutes: 104, genres: ["Family", "Comedy"] }, status: "done", url: "https://trakt.tv/movies/paddington-2-2017", finished_at: "2019-03-20T20:00:00.000Z", source: "life-log-personal", created_at: "2019-03-20T20:00:00.000Z", updated_at: "2019-03-20T20:00:00.000Z" }),
    r(29, { title: "The Muppet Christmas Carol", kind: "film", author: "Brian Henson", meta: { year: 1992, minutes: 86, genres: ["Family", "Comedy"], themes: ["christmas"] }, status: "done", finished_at: "2024-12-21T19:00:00.000Z", created_at: "2024-12-21T19:00:00.000Z", updated_at: "2024-12-21T19:00:00.000Z" }),
    r(13, { title: "The Bear", kind: "tv", meta: { year: 2022, minutes: 30, genres: ["Drama", "Comedy"] }, status: "done", url: "https://trakt.tv/shows/the-bear", finished_at: "2023-07-02T21:00:00.000Z", source: "life-log-personal", created_at: "2022-07-01T21:00:00.000Z", updated_at: "2023-07-02T21:00:00.000Z" }),
    r(14, { title: "Spirited Away", kind: "film", meta: { year: 2001, minutes: 125, genres: ["Animation", "Fantasy"] }, status: "done", url: "https://trakt.tv/movies/spirited-away-2001", finished_at: "2019-03-02T20:00:00.000Z", source: "life-log-personal", created_at: "2019-03-02T20:00:00.000Z", updated_at: "2019-03-02T20:00:00.000Z" }),
  ];
}

export function sampleGoals(): Goal[] {
  const today = localToday();
  const year = today.slice(0, 4);
  const quarterEnd = (() => {
    const m = Number(today.slice(5, 7));
    const endMonth = Math.ceil(m / 3) * 3;
    const last = new Date(Date.UTC(Number(year), endMonth, 0)).getUTCDate();
    return `${year}-${String(endMonth).padStart(2, "0")}-${last}`;
  })();
  const g = (n: number, rest: Partial<Goal> & Pick<Goal, "title" | "period">): Goal => ({
    id: id(980 + n),
    target: "",
    progress: 0,
    status: "active",
    due_on: null,
    notes: "",
    archived_at: null,
    created_at: daysAgo(40),
    updated_at: daysAgo(2),
    ...rest,
  });
  return [
    g(1, { title: "Run three times a week", period: "quarter", target: "36 runs by the end of the quarter", progress: 58, due_on: quarterEnd }),
    g(2, { title: "Ship Athena's memory layer", period: "month", target: "To do, people timelines, the weekly review", progress: 70 }),
    g(3, { title: "Read 12 books", period: "year", target: "One a month", progress: 75, due_on: `${year}-12-31` }),
    g(4, { title: "Call Mum every Sunday", period: "month", progress: 100, status: "done" }),
  ];
}
