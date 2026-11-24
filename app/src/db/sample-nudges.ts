/**
 * Sample mode's nudges: what the rules (lib/proactive/rules.ts) would say
 * about the sample people today, word for word in their style. Times are
 * worked out from now so the cards always read as current.
 */
import type { AppNudge } from "./nudges";
import { SAMPLE_IDS } from "./sample-data";
import { SAMPLE_EVENT_ID } from "./scheduling";
import { samplePicks } from "./sample-ask-plans";
import { NO_DRIVE_TIME } from "../../../lib/proactive/types";
import { clockTime } from "../lib/clock";

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
// Sample mode writes its own cards on the device, so their times follow the device's clock (lib/clock.ts).
const clock = (iso: string) => clockTime(iso);
const hhmm = clock;
const weekday = (daysAgo: number) => new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(Date.now() - daysAgo * 86_400_000));

/** `drive`: the sample owner set "How you usually travel" to drive (Settings → Notifications), and sample mode has no Google Maps key. */
export function sampleNudges(opts: { drive?: boolean } = {}): AppNudge[] {
  // A meeting a quarter of an hour from now, on the quarter hour.
  const start = new Date(Math.ceil((Date.now() + 14 * 60_000) / (15 * 60_000)) * 15 * 60_000).toISOString();
  const time = clock(start);
  const made = at(-2);
  const base = { pushed_at: made, applied: [] as number[] };
  // The sample car (lib/car-sync.ts sampleVehicle): its MOT runs out in three weeks.
  const mot = new Date(Date.now() + 21 * 86_400_000);
  const motDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(mot);
  // Lunch at 12:30 today, by car, with no Google Maps key in sample mode: no drive time.
  const noon = new Date();
  noon.setHours(12, 30, 0, 0);
  const lunch = noon.toISOString();
  const drive: AppNudge[] = opts.drive
    ? [
        {
          ...base,
          id: "5a3e0000-0000-4000-8000-00000000d006",
          rule: "leave_by",
          key: "leave:sample-drive",
          title: `Drive to Dishoom by ${clock(lunch)}`,
          body: "Lunch with Tom. Athena can't time a drive without Google Maps, so allow for traffic.",
          why: [
            `“Lunch with Tom” is at Dishoom at ${clock(lunch)}, and you're going by car.`,
            `${NO_DRIVE_TIME} Athena only times a drive with Google Maps, which reads the traffic. Add a Google Maps key in Sources, under Places and travel.`,
          ],
          context: `Lunch with Tom at Dishoom, today at ${clock(lunch)}, by car.`,
          prompt: `How long will it take to drive to Dishoom for ${clock(lunch)}?`,
          about: [],
          actions: [],
          expires_at: at(5 * 60),
          created_at: at(-1),
        },
      ]
    : [];
  return [
    ...drive,
    {
      ...base,
      id: "5a3e0000-0000-4000-8000-00000000d005",
      rule: "car",
      key: "car:sample-car:mot:sample:30",
      title: "MOT runs out in 21 days",
      body: `Ford Focus: the MOT ends on ${motDay}. Book a test before then.`,
      why: [
        `The government record for the Ford Focus says the MOT ends on ${motDay}.`,
        "Athena checks it once a day. When it's renewed, the new date shows up and this goes quiet.",
        "You hear about it roughly 30 days before, and again in the last week.",
      ],
      context: `Ford Focus: MOT ends ${motDay}.`,
      prompt: "Help me book an MOT for the Ford Focus",
      about: [],
      actions: [],
      expires_at: at(14 * 24 * 60),
      created_at: at(-30),
    },
    // Something to watch tonight (off by default): picks from the sample watchlist (db/sample-ask-plans.ts).
    {
      ...base,
      id: "5a3e0000-0000-4000-8000-00000000d004",
      rule: "watch_tonight",
      key: "tonight:sample",
      title: "Something to watch tonight",
      body: "Your evening's clear. From your list: Severance, Slow Horses and Dune: Part Two.",
      why: [
        "Nothing is on your calendar after 19:00.",
        ...samplePicks().map((p) => `${p.title}: ${p.why}`),
        "Every pick is one you added to your own list.",
      ],
      context: "Tonight's picks from your list: Severance, Slow Horses and Dune: Part Two.",
      prompt: "Which of these should I watch tonight?",
      about: [],
      actions: [],
      expires_at: at(5 * 60),
      created_at: at(-5),
    },
    {
      ...base,
      id: "5a3e0000-0000-4000-8000-00000000d001",
      rule: "meeting_prep",
      key: "prep:sample",
      title: `${time} with Priya`,
      body: "2 open to-dos, 1 recent email. Tap for the notes from last time.",
      why: [
        `“Mentoring with Priya” starts at ${time} with Priya Shah.`,
        "Last time (3 November): Agreed you'd share the hiring plan draft and she'd intro you to Sam at Linear.",
        "Your note from 3 November: “Mentoring: hiring plan and team shape”.",
        `Email with Priya on ${weekday(2)}: Re: hiring plan, a few questions on the senior role`,
        "Open to-do: Send Priya the hiring plan draft.",
        "Open to-do: Book the team offsite venue.",
      ],
      context: `Mentoring with Priya, today at ${time}.`,
      prompt: `What should I know before my ${time} with Priya?`,
      about: [{ kind: "event", id: SAMPLE_IDS.mentoring, label: "Mentoring with Priya" }, { kind: "person", id: SAMPLE_IDS.priya, label: "Priya Shah" }],
      actions: [],
      expires_at: start,
      created_at: made,
    },
    {
      ...base,
      id: "5a3e0000-0000-4000-8000-00000000d002",
      rule: "awaiting_reply",
      key: "reply:sample",
      title: "No reply from Tom yet",
      body: `You emailed Tom on ${weekday(6)} and haven't heard back. Draft a nudge?`,
      why: [
        `You sent “Flat viewing on Saturday” to Tom Hale (tom@example.com) on ${weekday(6)}.`,
        "It asks something: “Could you let me know by Thursday if 11am works for the viewing?”",
        "Nobody has replied in four working days. You chose three in Settings → Notifications.",
        "Newsletters, automated mail and threads you've closed are left out.",
      ],
      context: `Your email to Tom Hale, “Flat viewing on Saturday”, sent on ${weekday(6)}. No reply yet.`,
      prompt: `Draft a short, friendly follow-up to Tom Hale about “Flat viewing on Saturday”, the email I sent on ${weekday(6)}.`,
      about: [{ kind: "person", id: SAMPLE_IDS.tom, label: "Tom Hale" }],
      actions: [],
      expires_at: at(3 * 24 * 60),
      created_at: at(-40),
    },
    {
      ...base,
      id: "5a3e0000-0000-4000-8000-00000000d003",
      rule: "day_plan",
      key: "dayplan:sample",
      title: "An easier start today?",
      body: `Your ${hhmm(at(60))} “Design review” could move to ${hhmm(at(6 * 60))}. Tap to see the plan.`,
      why: [
        "You slept 5h 10m last night. For you, a night under 6h is a short one.",
        "This morning has one long block of your own work before noon.",
        `${hhmm(at(6 * 60))} onwards is free, so the work can go there.`,
        "Moves use your calendar, and each one has Undo.",
      ],
      context: "Last night was short for you, so this is a lighter plan for today.",
      prompt: "Help me plan a lighter day: heavy work after lunch, and keep an hour this morning quiet.",
      about: [{ kind: "event", id: SAMPLE_EVENT_ID, label: "Design review" }],
      actions: [{ kind: "move", label: `Move to ${hhmm(at(6 * 60))}`, event_id: SAMPLE_EVENT_ID, title: "Design review", from: at(60), start: at(6 * 60), end: at(7 * 60) }],
      expires_at: at(4 * 60),
      created_at: at(-90),
    },
  ];
}
