/**
 * Sample mode's week (or month) in review: the sample stores, plus what they
 * don't hold, so the page shows a full week as the approved prototype did.
 * A lunch, a gallery visit and a call this
 * week, two more to-dos done, goals that moved on, a calendar lunch at a
 * place (the "seen" rule), and the places of the eight weeks before.
 * Nothing is saved.
 */

import { addDays } from "../components/day-words";
import { sampleDayNow } from "./sample-days";
import { sampleGoals } from "./sample-memory";
import { SAMPLE_IDS } from "./sample-data";
import type { Day } from "./days-app";
import type { Commitment, Interaction } from "../types";
import type { GoalMoveIn, ReviewInput, SeenEvent } from "../lib/week-review";

const KNOWN_DAYS = 56;
const at = (date: string, hour = 13) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).toISOString();

/** The first day in the period whose places include `name`, else the fallback. */
const dayWith = (days: Day[], name: string, fallback: string) => days.find((d) => d.places.some((p) => p.name.startsWith(name)))?.date ?? fallback;

function interaction(date: string, channel: Interaction["channel"], summary: string, people: { id: string; name: string }[], extra: { how?: string; where?: string } = {}): ReviewInput["interactions"][number] {
  const when = at(date);
  return { id: `sample-wr-${date}-${people[0].id}`, at: when, channel, summary, source: "manual", source_ref: null, people, archived_at: null, created_at: when, updated_at: when, ...extra };
}

function done(title: string, date: string, kind: Commitment["kind"] = "todo", extra: Partial<Commitment> = {}): Commitment {
  const when = at(date, 17);
  return { id: `sample-wr-${title}`, title, kind, status: "done", due_on: null, notes: "", person_id: null, person: null, source: "manual", source_ref: null, source_quote: null, confidence: null, done_at: when, archived_at: null, created_at: when, updated_at: when, ...extra } as Commitment;
}

export interface SampleExtras {
  interactions: ReviewInput["interactions"];
  commitments: Commitment[];
  goalMoves: GoalMoveIn[];
  seenEvents: SeenEvent[];
  knownPlaces: Set<string>;
}

/** What sample mode adds for the period from `from` to `to`, given its Days. */
export function sampleWeekExtras(period: "week" | "month", from: string, to: string, today: string, days: Day[]): SampleExtras {
  const end = to > today ? today : to;
  const clamp = (d: string) => (d > end ? end : d);
  const known = new Set<string>();
  for (let d = addDays(from, -KNOWN_DAYS); d < from; d = addDays(d, 1)) for (const p of sampleDayNow(d).places) known.add(p.name);

  const priya = { id: SAMPLE_IDS.priya, name: "Priya Shah" };
  const tom = { id: SAMPLE_IDS.tom, name: "Tom Hale" };
  const marcus = { id: SAMPLE_IDS.marcus, name: "Marcus Webb" };
  const mum = { id: SAMPLE_IDS.mum, name: "Mum" };
  const goals = sampleGoals();
  const moved = (prefix: string, by: number): GoalMoveIn[] => {
    const g = goals.find((x) => x.title.startsWith(prefix) && x.status === "active");
    return g && g.progress >= by ? [{ title: g.title, target: g.target, was: g.progress - by, now: g.progress }] : [];
  };

  if (period === "month") {
    const d = (n: number) => clamp(addDays(from, n));
    return {
      interactions: [
        interaction(d(3), "in_person", "Lunch at Dishoom. Mentoring, every two weeks from now on.", [priya], { how: "Lunch", where: "Dishoom" }),
        interaction(d(17), "in_person", "Lunch at Dishoom again. Her first Northwind interview went well.", [priya], { how: "Lunch", where: "Dishoom" }),
        interaction(d(17), "in_person", "Coffee near his office. The round is close.", [marcus], { how: "Coffee" }),
        interaction(d(11), "in_person", "Sunday lunch at Mum's. Took the spare chairs back.", [mum], { how: "Lunch", where: "Mum's" }),
        interaction(d(8), "call", "Workshop dates, and whether the pricing memo is ready.", [{ id: SAMPLE_IDS.elena, name: "Dr. Elena Osei" }]),
      ],
      commitments: [
        ...["Renew the parking permit", "Write up the 1:1 notes", "Order new running shoes", "Book train tickets to Leeds", "Cancel the unused gym plan", "Share the offsite notes", "Return the jacket", "Back up the photo library", "Update the CV", "Book the dentist"].map((t, i) => done(t, d((i * 7) % 28))),
        done("Mentoring every two weeks, not weekly", d(3), "decision", { person: priya, notes: "Career framing rather than tactics." }),
      ],
      goalMoves: [...moved("Run", 20), ...moved("Read", 8), ...moved("Ship", 25)],
      seenEvents: [{ id: "sample-wr-quiz", title: "Quiz night", date: d(24), people: [tom], place: "The Lyric" }],
      knownPlaces: known,
    };
  }

  return {
    interactions: [
      interaction(dayWith(days, "Dishoom", clamp(addDays(from, 2))), "in_person", "Lunch upstairs. She's weighing the Northwind offer and wants a second read of the contract.", [priya], { how: "Lunch", where: "Dishoom" }),
      interaction(clamp(addDays(from, 3)), "call", "His round closed. He wants a first designer by January and asked who I'd trust.", [marcus], { how: "Video call" }),
    ],
    commitments: [done("Send Priya the contract notes", clamp(addDays(from, 2)), "i_owe", { person: priya }), done("Renew the passport", clamp(addDays(from, 1)))],
    goalMoves: [...moved("Run", 8), ...moved("Ship", 12)],
    // Not logged as a catch-up: a calendar event with Tom at a place, which counts as seeing him.
    seenEvents: [{ id: "sample-wr-barbican", title: "Gallery", date: dayWith(days, "Barbican", clamp(addDays(from, 4))), people: [tom], place: "Barbican Centre" }],
    knownPlaces: known,
  };
}
