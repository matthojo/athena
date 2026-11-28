/**
 * Fallback sample data, shown only when the real API is unreachable (backend
 * not deployed yet, or genuinely offline with an empty cache) so the app
 * never renders a dead/blank screen. Called by views/dashboard.ts and
 * views/capture.ts as the last resort after: IndexedDB cache -> live API.
 * Every caller that uses this must pair it with the "sample data" status
 * pill (see components/status-pill.ts) — never presented as real.
 */

import { addDays, zonedToInstant } from "../../../lib/dates";
import { deviceZone, localToday } from "../lib/time";
import { sampleTrainTime } from "./sample-trips";
import type { AthenaEvent, MetricPoint, Note, Organisation, Person, Place } from "../types";
import type { NoteFolder } from "../../../lib/note-folder-rules";

const now = () => new Date();

/** Stable sample ids (real UUIDs so athena:// links to them parse). */
export const SAMPLE_IDS = {
  priya: "5a3e0000-0000-4000-8000-000000000101",
  marcus: "5a3e0000-0000-4000-8000-000000000102",
  elena: "5a3e0000-0000-4000-8000-000000000103",
  mum: "5a3e0000-0000-4000-8000-000000000104",
  tom: "5a3e0000-0000-4000-8000-000000000105",
  dishoom: "5a3e0000-0000-4000-8000-000000000201",
  barbican: "5a3e0000-0000-4000-8000-000000000202",
  netlify: "5a3e0000-0000-4000-8000-000000000301",
  dentist: "5a3e0000-0000-4000-8000-000000000401",
  renewal: "5a3e0000-0000-4000-8000-000000000402",
  anniversary: "5a3e0000-0000-4000-8000-000000000403",
  priyaBirthday: "5a3e0000-0000-4000-8000-000000000404",
  mumBirthday: "5a3e0000-0000-4000-8000-000000000405",
  briefing: "5a3e0000-0000-4000-8000-000000000010",
  mentoring: "5a3e0000-0000-4000-8000-000000000406",
} as const;

const link = (kind: string, id: string, label: string) => `[${label}](athena://${kind}/${id})`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Sample mode's folders: Work (with Planning and Meetings, and Projects › Athena), Personal (Mentoring, Gifts) and Reading. */
const folderId = (n: number) => `5a3e0000-0000-4000-8000-${String(1300 + n).padStart(12, "0")}`;
export const SAMPLE_FOLDER_IDS = {
  work: folderId(1),
  planning: folderId(2),
  meetings: folderId(3),
  projects: folderId(4),
  athena: folderId(5),
  personal: folderId(6),
  mentoring: folderId(7),
  gifts: folderId(8),
  reading: folderId(9),
} as const;

const FOLDER_AT = "2026-01-05T09:00:00.000Z";
const sampleFolder = (id: string, name: string, parent_id: string | null = null): NoteFolder => ({ id, name, parent_id, created_at: FOLDER_AT, updated_at: FOLDER_AT });
const F = SAMPLE_FOLDER_IDS;
export const SAMPLE_FOLDERS: NoteFolder[] = [
  sampleFolder(F.work, "Work"),
  sampleFolder(F.planning, "Planning", F.work),
  sampleFolder(F.meetings, "Meetings", F.work),
  sampleFolder(F.projects, "Projects", F.work),
  sampleFolder(F.athena, "Athena", F.projects),
  sampleFolder(F.personal, "Personal"),
  sampleFolder(F.mentoring, "Mentoring", F.personal),
  sampleFolder(F.gifts, "Gifts", F.personal),
  sampleFolder(F.reading, "Reading"),
];

/** Which sample note is in which folder; the briefing, the dailies and the digests are in none. */
const SAMPLE_FILED: Record<string, string> = {
  "5a3e0000-0000-4000-8000-000000000001": F.planning,
  "5a3e0000-0000-4000-8000-000000000002": F.mentoring,
  "5a3e0000-0000-4000-8000-000000000004": F.athena,
  "5a3e0000-0000-4000-8000-000000000005": F.reading,
  "5a3e0000-0000-4000-8000-000000000006": F.meetings,
  "5a3e0000-0000-4000-8000-000000000011": F.gifts,
};

export function sampleNotes(): Note[] {
  return sampleNoteList().map((n) => ({ ...n, folder_id: SAMPLE_FILED[n.id] ?? null }));
}

function sampleNoteList(): Note[] {
  const today = localToday();
  return [
    {
      id: SAMPLE_IDS.briefing,
      title: `Today, ${new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}`,
      body: [
        // The writer's own line opens the note, as lib/briefing-run.ts saves it (bodyWithLead); Home's card shows it.
        `> Morning, Alex. The ${sampleTrainTime()} to Heathrow is 12 minutes late, BA 432 leaves T5 at 10:40, and Priya turns 35 on ${new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(Date.now() + 3 * 86_400_000))}.`,
        "",
        // Matches the sample trips and parcels (sample-trips.ts), worded as lib/trip-text.ts and
        // lib/live-travel-text.ts and lib/flight-text.ts word them: the train to the airport and the flight with their live times, then the owner's line that isn't running well.
        "## Travel",
        `- ${sampleTrainTime()} London Paddington to Heathrow Terminal 5: 12 min late, platform 7, ref HX4Q7N2P`,
        "- Flight BA 432 to Lisbon today 10:40 from Heathrow T5, ref K7Q2XB (moved from 10:10)",
        "",
        "## Commute",
        "- Elizabeth line: part suspended",
        "",
        "## Deliveries",
        "- Kindle Paperwhite from Amazon is out for delivery",
        "",
        "## Coming up",
        `- ${link("event", SAMPLE_IDS.dentist, "@Dentist")} in 2 days, 09:30`,
        `- ${link("person", SAMPLE_IDS.priya, "@Priya Shah")} turns 35 in 3 days`,
        "",
        "## Catch up",
        `- ${link("person", SAMPLE_IDS.marcus, "@Marcus Webb")}: last spoke 96 days ago`,
        "",
        "## Yesterday",
        `- [Daily: Nov 3](athena://note/5a3e0000-0000-4000-8000-000000000003)`,
      ].join("\n"),
      type: "daily",
      source: "briefing",
      tags: ["briefing", today],
      created_at: daysAgo(0.05),
      updated_at: daysAgo(0.05),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000001",
      title: "Reframe the Q3 planning doc",
      // The owner's own note, so it shows what a note can hold: a callout, a line that's also a to-do, a table and a toggle.
      body: [
        `Split the roadmap into now/next/later instead of a single flat list. It's easier to defend in review. Run it past ${link("person", SAMPLE_IDS.elena, "@Dr. Elena Osei")} first.`,
        "",
        "> [!tip] For the review",
        "> Lead with what moved from next to now, and why.",
        "",
        '- [ ] [@Draft the Q3 planning doc](athena://todo/5a3e0000-0000-4000-8000-000000000505 "link")',
        "- [ ] Find half an hour with Elena before Thursday",
        "",
        "| Now | Next | Later |",
        "| --- | --- | --- |",
        "| Shorter onboarding | Shared budgets | Offline mode |",
        "| Faster search | Calendar sync | Widgets |",
        "",
        "> [!note]- Why not one flat list",
        "> A flat list hides what we said no to. Three columns show the trade-offs, and later isn't never.",
      ].join("\n"),
      type: "note",
      source: "manual",
      tags: ["planning"],
      created_at: daysAgo(0.1),
      updated_at: daysAgo(0.1),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000002",
      title: "Call with Priya: mentorship structure",
      body: `${link("person", SAMPLE_IDS.priya, "@Priya Shah")} wants a lighter cadence, biweekly instead of weekly, focused on career framing rather than tactics. Next one over lunch at ${link("place", SAMPLE_IDS.dishoom, "@Dishoom King's Cross")}.\n\nShe swears by the ${link("record", "5a3e0000-0000-4000-8000-000000001101", "@Château Musar 2017")}. Pick up a bottle for her birthday.`,
      type: "capture",
      source: "manual",
      tags: ["people", "mentorship"],
      created_at: daysAgo(0.6),
      updated_at: daysAgo(0.6),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000003",
      title: "Daily: Nov 3",
      body: "Shipped the search endpoint. Still thinking about whether embeddings should live beside notes or in their own table.",
      type: "daily",
      source: "manual",
      tags: [],
      created_at: daysAgo(1.2),
      updated_at: daysAgo(1.2),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000004",
      title: "Athena / second brain",
      body: `Core loop: capture fast, structure later. The structuring step is the one people skip, so make it near-free. Why it matters: ${link("note", "5a3e0000-0000-4000-8000-000000000005", "attention residue")}.`,
      type: "project",
      source: "manual",
      tags: ["athena"],
      created_at: daysAgo(2),
      updated_at: daysAgo(1.8),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000005",
      title: "Reading: attention residue",
      body: "Switching costs between deep work blocks are higher than they feel in the moment. Batch context switches.",
      type: "note",
      source: "manual",
      tags: ["reading"],
      created_at: daysAgo(3),
      updated_at: daysAgo(3),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000006",
      title: "Design review: onboarding flow",
      body: "Agreed to cut the setup steps from seven to five and test the shorter flow against the current one next sprint.\n\nOwners: product for copy, design for the goal selection screen.",
      type: "note",
      source: "calendar-meetings",
      tags: ["meetings", "onboarding"],
      created_at: daysAgo(0.25),
      updated_at: daysAgo(0.25),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000007",
      title: "Work activity: Wednesday",
      body: `Signed off the ${link("note", "5a3e0000-0000-4000-8000-000000000001", "Q3 roadmap draft")} and shared the offsite agenda. Two Slack threads are waiting on your reply.`,
      type: "daily",
      source: "work-activity",
      tags: ["work"],
      created_at: daysAgo(1.1),
      updated_at: daysAgo(1.1),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000008",
      title: "Inbox digest",
      body: `Three threads to look at: the Q3 planning follow-up, a ${link("event", SAMPLE_IDS.renewal, "@Contract renewal")} reminder, and an intro from the design agency.`,
      type: "note",
      source: "email-digest",
      tags: ["email"],
      created_at: daysAgo(0.4),
      updated_at: daysAgo(0.4),
    },
    {
      id: "5a3e0000-0000-4000-8000-000000000009",
      title: "Personal inbox digest",
      body: `${link("event", SAMPLE_IDS.dentist, "@Dentist")} moved to 9:30. Train tickets for the weekend are confirmed.`,
      type: "note",
      source: "email-digest-personal",
      tags: ["personal"],
      created_at: daysAgo(2.4),
      updated_at: daysAgo(2.4),
    },
    {
      // Priya's gift list, as Ask or a Saved item's "Gift idea" makes it: Home's birthday sheet reads its open lines.
      id: "5a3e0000-0000-4000-8000-000000000011",
      title: "Priya Shah · Gift ideas",
      body: `For ${link("person", SAMPLE_IDS.priya, "@Priya Shah")}.\n\n- [ ] Château Musar 2017\n- [x] Dishoom cookbook`,
      type: "note",
      source: "assistant",
      tags: ["gift ideas"],
      created_at: daysAgo(48),
      updated_at: daysAgo(30),
    },
  ];
}

export function samplePeople(): Person[] {
  const base = { relationship: "", email: "", phone: "", catch_up_days: null, keep_in_touch: false, organisation: null, birthday: null, birthday_event_id: null, archived_at: null };
  return [
    {
      ...base,
      id: SAMPLE_IDS.priya,
      name: "Priya Shah",
      relationship: "Mentee",
      email: "priya@example.com",
      notes: "Mentee, biweekly check-ins.",
      keep_in_touch: true,
      catch_up_days: 14,
      birthday: priyaBirthday(),
      birthday_event_id: SAMPLE_IDS.priyaBirthday,
      organisation: { id: SAMPLE_IDS.netlify, name: "Netlify" },
      // Lunch at Dishoom this week (db/sample-week.ts), so This week's catch-ups and Your people agree.
      last_contacted_at: priyaLunch(),
      created_at: daysAgo(400),
      updated_at: daysAgo(21),
    },
    {
      ...base,
      id: SAMPLE_IDS.marcus,
      name: "Marcus Webb",
      relationship: "Former teammate",
      notes: "Now at a seed-stage startup.",
      keep_in_touch: true,
      last_contacted_at: daysAgo(96),
      created_at: daysAgo(500),
      updated_at: daysAgo(96),
    },
    {
      ...base,
      id: SAMPLE_IDS.elena,
      name: "Dr. Elena Osei",
      relationship: "Advisor",
      notes: "Quarterly strategy chats.",
      keep_in_touch: true,
      catch_up_days: 90,
      last_contacted_at: daysAgo(64),
      created_at: daysAgo(600),
      updated_at: daysAgo(64),
    },
    {
      ...base,
      id: SAMPLE_IDS.mum,
      name: "Mum",
      relationship: "Family",
      phone: "+44 7700 900123",
      keep_in_touch: true,
      catch_up_days: 7,
      birthday: `--${addDays(localToday(), 10).slice(5)}`,
      birthday_event_id: SAMPLE_IDS.mumBirthday,
      notes: "",
      last_contacted_at: daysAgo(3),
      created_at: daysAgo(700),
      updated_at: daysAgo(3),
    },
    {
      ...base,
      id: SAMPLE_IDS.tom,
      name: "Tom Hale",
      relationship: "Neighbour",
      notes: "Number 14. Has a spare key for emergencies.",
      last_contacted_at: daysAgo(180),
      created_at: daysAgo(300),
      updated_at: daysAgo(180),
    },
  ];
}

/** This week's lunch with Priya, as Home reads it from db/sample-week.ts: Wednesday, or today early in the week. */
function priyaLunch(): string {
  const today = localToday();
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const wednesday = addDays(monday, 2);
  return new Date(`${wednesday < today ? wednesday : today}T13:00:00`).toISOString();
}

function priyaBirthday(): string {
  const md = addDays(localToday(), 3).slice(5);
  return `${Number(localToday().slice(0, 4)) - 35}-${md === "02-29" ? "02-28" : md}`;
}

export function samplePlaces(): Place[] {
  return [
    {
      id: SAMPLE_IDS.dishoom,
      name: "Dishoom King's Cross",
      address: "5 Stable St, London N1C 4AB",
      url: "https://www.dishoom.com",
      notes: "Good for mentoring lunches. Book the upstairs tables.",
      archived_at: null,
      created_at: daysAgo(120),
      updated_at: daysAgo(30),
    },
    {
      id: SAMPLE_IDS.barbican,
      name: "Barbican Centre",
      address: "Silk St, London EC2Y 8DS",
      url: "https://www.barbican.org.uk",
      notes: "",
      archived_at: null,
      created_at: daysAgo(200),
      updated_at: daysAgo(200),
    },
  ];
}

export function sampleOrganisations(): Organisation[] {
  return [
    {
      id: SAMPLE_IDS.netlify,
      name: "Netlify",
      website: "https://www.netlify.com",
      notes: "",
      archived_at: null,
      created_at: daysAgo(300),
      updated_at: daysAgo(300),
    },
  ];
}

/** Today, or tomorrow once today's 16:00 has gone. */
function mentoringDay(): string {
  const today = localToday();
  return zonedToInstant(today, "16:00", deviceZone()).getTime() > Date.now() ? today : addDays(today, 1);
}

export function sampleEvents(): AthenaEvent[] {
  const today = localToday();
  const base = { notes: "", person_id: null, archived_at: null, created_at: daysAgo(30), updated_at: daysAgo(30), remind_days_before: [0], time: null, year_known: true };
  return [
    { ...base, id: SAMPLE_IDS.dentist, title: "Dentist", kind: "appointment", date: addDays(today, 2), starts_at: zonedToInstant(addDays(today, 2), "09:30", deviceZone()).toISOString(), recurrence: "none", remind_days_before: [1, 0] },
    { ...base, id: SAMPLE_IDS.renewal, title: "Contract renewal", kind: "deadline", date: addDays(today, 9), recurrence: "none", remind_days_before: [7, 1] },
    { ...base, id: SAMPLE_IDS.anniversary, title: "Wedding anniversary", kind: "anniversary", date: `2019-${addDays(today, 40).slice(5)}`, recurrence: "yearly", remind_days_before: [7, 0] },
    { ...base, id: SAMPLE_IDS.priyaBirthday, title: "Priya Shah's birthday", kind: "birthday", date: priyaBirthday(), recurrence: "yearly", person_id: SAMPLE_IDS.priya },
    { ...base, id: SAMPLE_IDS.mumBirthday, title: "Mum's birthday", kind: "birthday", date: `2000-${addDays(today, 10).slice(5)}`, recurrence: "yearly", year_known: false, person_id: SAMPLE_IDS.mum, remind_days_before: [7, 0] },
    // A meeting later today (tomorrow once 16:00 has passed), for Today's "Prepare notes" and the Meeting notes template.
    { ...base, id: SAMPLE_IDS.mentoring, title: "Mentoring with Priya", kind: "appointment", date: mentoringDay(), starts_at: zonedToInstant(mentoringDay(), "16:00", deviceZone()).toISOString(), recurrence: "none", person_id: SAMPLE_IDS.priya, source: "calendar-meetings-work" },
  ];
}

// Deterministic pseudo-noise (not Math.random): the sample chart must look
// the same every time it's drawn — on tab switch, on a sync-triggered
// refresh, etc. — or it reads as broken rather than as sample data.
function pseudoNoise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x); // deterministic, stable per index, range [0,1)
}

function series(base: number, amplitude: number, points: number, integer = false): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (let i = points - 1; i >= 0; i--) {
    const wobble = Math.sin(i * 0.8) * amplitude + (pseudoNoise(i) - 0.5) * amplitude * 0.6;
    const raw = Math.max(0, base + wobble);
    out.push({
      value: integer ? Math.round(raw) : Math.round(raw * 10) / 10,
      recorded_at: new Date(now().getTime() - i * 7 * 86_400_000).toISOString(),
    });
  }
  return out;
}

/** Sample weeks for a metric key; meeting hours is the only one Home charts from metrics. */
export function sampleMetricPoints(_metric: string): MetricPoint[] {
  return series(14, 4, 10); // fractional hours are real
}

export const SAMPLE_METRICS = ["meeting_hours_per_week"] as const;
