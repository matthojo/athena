/**
 * The story on a record page: "Together" for a person, "Visits" for a place.
 * Pure, so it's tested (record-story.test.ts); the loading is in
 * components/person-memory.ts and components/place-visits.ts, the drawing in
 * components/record-timeline.ts.
 *
 * A person's rows come from catch-ups you logged (or a collection did) and
 * calendar events with them, the same "seen" rule as Week in review. A
 * place's rows come from Days (each day's stops, or the server's visits
 * from placeDays) and calendar events there, one row per day: Saturday's
 * two hours at the Barbican and the gallery with Tom are one visit.
 */

import { CHANNEL_META } from "./memory-meta";
import type { InteractionChannel } from "../types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY = 86_400_000;
const utc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const ago = (date: string, today: string) => Math.round((utc(today) - utc(date)) / DAY);
const weekday = (date: string) => WEEKDAYS[new Date(utc(date)).getUTCDay()];
const dayMonth = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const first = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];

/** "Today", "Yesterday", "Wednesday" (this past week), "12 October", "12 October 2025". */
export function storyWhen(date: string, today: string): string {
  const n = ago(date, today);
  if (n === 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n > 1 && n < 7) return weekday(date);
  return date.slice(0, 4) === today.slice(0, 4) ? dayMonth(date) : `${dayMonth(date)} ${date.slice(0, 4)}`;
}

/** "Tuesday 10 November", with the year when it isn't this one: how the app writes a day. */
export function longDate(date: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const base = `${weekday(date)} ${dayMonth(date)}`;
  return date.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${date.slice(0, 4)}`;
}

/** "40 minutes", "an hour", "1½ hours", "2 hours". Rounded the way you'd say it. */
export function minutesWords(minutes: number): string {
  if (minutes < 55) return `${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const halves = Math.round(minutes / 30);
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 1 && !half) return "an hour";
  return `${whole}${half ? "½" : ""} hours`;
}

/** "Tom", "Tom and Priya", "Tom, Priya and Sam". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type StoryKind = "visit" | "event" | InteractionChannel;

export interface StoryRow {
  /** "YYYY-MM-DD". */
  date: string;
  /** "Lunch at Dishoom", "Gallery with Tom", "2 hours here". */
  title: string;
  /** What you talked about, from the catch-up. */
  summary?: string;
  /** The place, on a person's row. */
  where?: string;
  /** "2 hours", on a place's row that also has a title of its own. */
  length?: string;
  inPerson: boolean;
  kind: StoryKind;
  /** A calendar event behind the row, to open. */
  event?: string;
}

// ---------- A person: Together ----------

export interface StoryInteraction {
  id: string;
  /** ISO instant. */
  at: string;
  channel: InteractionChannel;
  summary: string;
  people: Array<{ id: string; name: string }>;
  archived_at?: string | null;
  /** "Lunch", "Video call": sample mode's and Week in review's wording. */
  how?: string;
  where?: string;
}

export interface StorySeen {
  id: string;
  title: string;
  date: string;
  people: Array<{ id: string; name: string }>;
  place: string;
}

export interface StoryEvent {
  id: string;
  title: string;
  /** The day it happened, local. */
  date: string;
  kind?: string;
  place?: string;
  /** Others there (not the person whose page this is). */
  people?: Array<{ id: string; name: string }>;
}

/**
 * A person's catch-ups and the calendar events they were at, newest first.
 * `localDay` turns an interaction's instant into the local day (the device's
 * zone in the app; the tests pass a fixed one).
 */
export function personStory(input: {
  personId: string;
  interactions: StoryInteraction[];
  seen: StorySeen[];
  events: StoryEvent[];
  today: string;
  localDay: (iso: string) => string;
}): StoryRow[] {
  const { personId, today } = input;
  const rows: StoryRow[] = [];
  const others = (people: Array<{ id: string; name: string }> | undefined) => (people ?? []).filter((p) => p.id !== personId).map((p) => first(p.name));
  const withWords = (names: string[]) => (names.length ? ` with ${namesList(names)}` : "");

  for (const i of input.interactions) {
    if (i.archived_at || !i.people.some((p) => p.id === personId)) continue;
    const date = input.localDay(i.at);
    if (date > today) continue;
    const label = i.how ?? (i.channel === "other" ? "Caught up" : CHANNEL_META[i.channel].label);
    rows.push({ date, title: `${label}${withWords(others(i.people))}`, summary: i.summary || undefined, where: i.where, inPerson: i.channel === "in_person", kind: i.channel });
  }

  const seenIds = new Set<string>();
  for (const s of input.seen) {
    if (s.date > today || !s.people.some((p) => p.id === personId)) continue;
    seenIds.add(s.id);
    rows.push({ date: s.date, title: `${s.title}${withWords(others(s.people))}`, where: s.place, inPerson: true, kind: "event", event: s.id });
  }
  for (const e of input.events) {
    if (seenIds.has(e.id) || e.date > today || /^(birthday|anniversary|deadline)$/.test(e.kind ?? "")) continue;
    rows.push({ date: e.date, title: `${e.title}${withWords(others(e.people))}`, where: e.place, inPerson: !!e.place, kind: "event", event: e.id });
  }

  // One logged lunch and the calendar's "Lunch" on the same day are the same lunch: keep the logged one, which says more.
  const out: StoryRow[] = [];
  for (const r of rows.sort((a, b) => b.date.localeCompare(a.date) || Number(!!a.event) - Number(!!b.event))) {
    const twin = r.event ? out.find((o) => o.date === r.date && !o.event && sameThing(o, r)) : undefined;
    if (twin) {
      twin.where ??= r.where;
      twin.event ??= r.event;
      continue;
    }
    out.push(r);
  }
  return out;
}

/** The same meeting written twice: one in person on the same day, or the same title. */
function sameThing(a: StoryRow, b: StoryRow): boolean {
  if (a.inPerson && b.inPerson) return true;
  return a.title.toLowerCase() === b.title.toLowerCase();
}

/**
 * "Last saw Wednesday, lunch at Dishoom" for a person's hero: the latest time
 * in person, unless a call or message is newer ("Last spoke Tuesday, video
 * call"). Null with nothing logged.
 */
export function lastSawLine(rows: StoryRow[], today: string): string | null {
  const latest = rows[0];
  if (!latest) return null;
  const when = storyWhen(latest.date, today);
  const today0 = when === "Today";
  const whenWord = when === "Yesterday" ? "yesterday" : when;
  const generic = /^(in person|caught up|call|other)$/i.test(latest.title);
  if (latest.inPerson) {
    const what = generic ? (latest.where ? `at ${latest.where}` : "") : `${lower(latest.title)}${latest.where && !latest.title.includes(latest.where) ? ` at ${latest.where}` : ""}`;
    const lead = today0 ? "Saw them today" : `Last saw ${whenWord}`;
    return what ? `${lead}${what.startsWith("at ") ? " " : ", "}${what}` : lead;
  }
  const lead = today0 ? "Spoke today" : `Last spoke ${whenWord}`;
  return generic ? lead : `${lead}, ${lower(latest.title)}`;
}

// ---------- A place: Visits ----------

export interface StoryDay {
  date: string;
  places: Array<{ id?: string; name: string; minutes?: number }>;
}

/**
 * A place's visits, one row per day, newest first: its stops in Days (or the
 * server's visits from placeDays, which carry minutes too) and calendar
 * events there, merged. A day matches by the Place's id or, for a stop the
 * Life log named itself, by name.
 */
export function placeStory(input: {
  place: { id: string; name: string };
  days: StoryDay[];
  visits: Array<{ date: string; minutes: number }>;
  seen: StorySeen[];
  events: StoryEvent[];
  today: string;
}): StoryRow[] {
  const name = input.place.name.trim().toLowerCase();
  const byDay = new Map<string, { minutes: number; titles: string[]; people: string[]; event?: string }>();
  const at = (date: string) => {
    let d = byDay.get(date);
    if (!d) byDay.set(date, (d = { minutes: 0, titles: [], people: [] }));
    return d;
  };
  for (const day of input.days) {
    const stops = day.places.filter((p) => p.id === input.place.id || p.name.trim().toLowerCase() === name);
    if (!stops.length || day.date > input.today) continue;
    at(day.date).minutes += stops.reduce((n, p) => n + (p.minutes ?? 0), 0);
  }
  for (const v of input.visits) {
    if (v.date > input.today) continue;
    const d = at(v.date);
    d.minutes = Math.max(d.minutes, v.minutes);
  }
  const addEvent = (e: { id: string; title: string; date: string; people?: Array<{ name: string }> }) => {
    if (e.date > input.today) return;
    const d = at(e.date);
    if (!d.titles.includes(e.title)) d.titles.push(e.title);
    for (const p of e.people ?? []) if (!d.people.includes(first(p.name))) d.people.push(first(p.name));
    d.event ??= e.id;
  };
  for (const s of input.seen) if (s.place.trim().toLowerCase() === name) addEvent(s);
  for (const e of input.events) if (!/^(birthday|anniversary|deadline)$/.test(e.kind ?? "")) addEvent(e);

  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, d]) => {
      const length = d.minutes ? minutesWords(d.minutes) : undefined;
      const people = d.people.length ? ` with ${namesList(d.people)}` : "";
      const title = d.titles.length ? `${d.titles.join(", ")}${people}` : length ? `${length.charAt(0).toUpperCase()}${length.slice(1)} here${people}` : `Visited${people}`;
      return { date, title, length: d.titles.length ? length : undefined, inPerson: true, kind: d.titles.length ? ("event" as const) : ("visit" as const), event: d.event };
    });
}

/** "Last here Saturday, gallery with Tom" / "Last here Saturday, for 2 hours". Null with no visits. */
export function lastHereLine(rows: StoryRow[], today: string): string | null {
  const latest = rows[0];
  if (!latest) return null;
  const when = storyWhen(latest.date, today);
  const lead = when === "Today" ? "Here today" : `Last here ${when === "Yesterday" ? "yesterday" : when}`;
  if (latest.kind === "event") return `${lead}, ${lower(latest.title)}`;
  const m = /^(.+) here( with .+)?$/.exec(latest.title);
  return m ? `${lead}, for ${lower(m[1])}${m[2] ?? ""}` : lead;
}
