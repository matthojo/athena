/**
 * Everything the week (or month) in review reads, gathered for
 * lib/week-review.ts's buildModel: the period's Days in full, interactions,
 * commitments, trips, event records, and GET /api/week-review's extras
 * (goals moved on, events with a person at a place, places known before).
 *
 * Each source loads on its own. Offline, each falls back to this device's
 * copy: the memory lists, trips and events keep theirs already; the Days and
 * the extras for a period are kept here once they've loaded. Whatever has no
 * copy is left out and named in `missing`, so the page can say so. Sample
 * mode reads the sample stores and adds sample-week.ts's week.
 */

import { isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { loadDay, loadDays, type Day } from "./days-app";
import { loadAssets, loadCommitments, loadInteractions } from "./memory";
import { loadRecords } from "./records";
import { loadTrips } from "./trips";
import { sampleWeekExtras } from "./sample-week";
import { deviceZone } from "../lib/time";
import type { GoalMoveIn, ReviewInput, SeenEvent } from "../lib/week-review";
import type { ConnectionState } from "../types";

/** The parts that can be missing offline, each named on the page. */
export type MissingPart = "days" | "extras" | "people" | "done" | "trips" | "events";

export interface ReviewLoad {
  input: ReviewInput;
  /** True when anything came from this device's copy rather than the server. */
  offline: boolean;
  missing: MissingPart[];
}

interface Extras {
  goals: GoalMoveIn[];
  seen: SeenEvent[];
  known_places: string[];
}

/** Run `fn` over items, `n` at a time, keeping order. */
async function inBatches<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** Live, then this device's copy for the same period; null with neither. */
async function liveOrKept<T>(key: string, live: () => Promise<T>): Promise<{ value: T; state: ConnectionState } | null> {
  try {
    const value = await live();
    try {
      await setMeta(key, JSON.stringify(value));
    } catch {
      // A full disk only costs the offline copy.
    }
    return { value, state: "online" };
  } catch {
    try {
      const kept = await getMeta(key);
      return kept ? { value: JSON.parse(kept) as T, state: "offline" } : null;
    } catch {
      return null;
    }
  }
}

/** The period's Days in full: the range says which days have something, then each of those days. */
async function periodDays(from: string, end: string): Promise<Day[]> {
  const r = await loadDays(from, end);
  return inBatches(
    r.days.map((d) => d.date),
    6,
    (d) => loadDay(d)
  );
}

export async function loadWeekReview(period: "week" | "month", from: string, to: string, today: string): Promise<ReviewLoad> {
  const end = to > today ? today : to;
  const tz = deviceZone();
  const sample = isSampleMode();
  const tag = `${period}:${from}`;

  const [days, extras, interactions, commitments, trips, events, persons, assets] = await Promise.all([
    sample ? periodDays(from, end).then((value) => ({ value, state: "sample" as ConnectionState })) : liveOrKept(`weekReview:days:${tag}`, () => periodDays(from, end)),
    sample ? Promise.resolve(null) : liveOrKept<Extras>(`weekReview:extras:${tag}`, () => request<Extras>(`/week-review?${new URLSearchParams({ from, to, tz })}`)),
    loadInteractions(),
    loadCommitments(),
    loadTrips(),
    loadRecords("event"),
    // For Catch up with and renewals in Looking ahead (from the old weekly review): extras, never missing.
    loadRecords("person").catch(() => ({ items: [], state: "offline" as ConnectionState })),
    loadAssets().catch(() => ({ items: [], state: "offline" as ConnectionState })),
  ]);

  // Outside sample mode, a list that fell back to the sample stores (offline with no copy) is missing, not sample data.
  const real = <T>(r: { items: T[]; state: ConnectionState }) => (sample || r.state !== "sample" ? r.items : null);
  const missing: MissingPart[] = [];
  const dayList = days?.value ?? [];
  if (!days) missing.push("days");
  const people = real(interactions);
  if (!people) missing.push("people");
  const doneList = real(commitments);
  if (!doneList) missing.push("done");
  // Offline, loadTrips gives [] both for a saved empty list and for no copy at all: only the second is missing.
  if (!sample && trips.state === "offline" && !trips.items.length && !(await getMeta("logistics:trips").catch(() => null))) missing.push("trips");
  const eventList = real(events);
  if (!eventList) missing.push("events");

  const input: ReviewInput = {
    period,
    from,
    to,
    today,
    tz,
    days: dayList,
    interactions: people ?? [],
    seenEvents: [],
    commitments: doneList ?? [],
    goalMoves: [],
    trips: trips.items,
    events: eventList ?? [],
    knownPlaces: null,
    people: real(persons) ?? [],
    assets: real(assets) ?? [],
  };

  if (sample) {
    const more = sampleWeekExtras(period, from, to, today, dayList);
    input.interactions = [...input.interactions, ...more.interactions];
    input.commitments = [...input.commitments, ...more.commitments];
    input.goalMoves = more.goalMoves;
    input.seenEvents = more.seenEvents;
    input.knownPlaces = more.knownPlaces;
  } else if (extras) {
    input.goalMoves = extras.value.goals;
    input.seenEvents = extras.value.seen;
    input.knownPlaces = new Set(extras.value.known_places);
  } else missing.push("extras");

  const offline = !sample && [days?.state, extras?.state, interactions.state, commitments.state, trips.state, events.state].some((s) => s === "offline");
  return { input, offline: offline || missing.length > 0, missing };
}
