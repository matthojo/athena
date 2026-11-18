/**
 * This week's moment (docs/notes/affection-2026-11.md, moment 6): what the
 * picker at the end of the Week in review offers, what the "Kept" toast says,
 * and how a kept moment is stored (lib/week-moments.ts on the server).
 *
 * Pure and DOM-free so it runs under `npx tsx --test`. The choices come from
 * the week's Days: its photos first, then the covers of what was watched,
 * read and listened to, then the days' own lines. A kept moment stores only
 * where it points (a photo, an entry or a day) and the image's id and size,
 * never the words: those stay sealed with the day.
 */

import type { Day, DayArt } from "../db/days-app";

export type MomentKind = "photo" | "entry" | "line";

export interface WeekMoment {
  kind: MomentKind;
  ref: string;
  date: string;
  art?: DayArt;
}

export interface MomentChoice extends WeekMoment {
  /** For a line: the day's words, shown on the card. */
  text?: string;
  /** What the toast calls it: "the Barbican Centre one", "Saturday's line". */
  label: string;
  /** For a screen reader: "Photo from Saturday at the Barbican Centre". */
  title: string;
  /** The caption under the tile: the day ("Thu") and what it is ("Dishoom", "Soft Neon", a line's first words). */
  day: string;
  what: string;
}

const ROUTINE = new Set(["home", "work"]);
const MAX = { photo: 10, entry: 6, line: 7 };

export function weekdayLong(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

/** The ISO week number of a week's Monday: 2026-11-09 is week 46. */
export function isoWeek(monday: string): number {
  const d = new Date(`${monday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  // d is now the week's Thursday, which sits in the year the week belongs to.
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1, 12);
  return Math.floor((d.getTime() - jan1) / 86_400_000 / 7) + 1;
}

/** A name short enough to say in a toast, without a leading "The". */
function short(name: string | undefined): string | null {
  const n = name?.trim().replace(/^the\s+/i, "");
  return n && n.length <= 32 ? n : null;
}

/** A line's first few words, for a caption: "A full Thursday: King's Cross…". */
export function firstWords(text: string, n = 5): string {
  const words = text.trim().split(/\s+/);
  return words.length <= n ? words.join(" ") : `${words.slice(0, n).join(" ").replace(/[,;:.]$/, "")}…`;
}

const dayShort = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

/** Where the day went, beyond home and work: the longest stop. */
function placeOf(day: Pick<Day, "places">): string | null {
  const stops = day.places.filter((p) => !ROUTINE.has(p.name.toLowerCase())).sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0));
  return short(stops[0]?.name);
}

/** The week's photos, covers and lines, in that order, for the picker. */
export function momentChoices(days: Pick<Day, "date" | "photos" | "places" | "entries" | "line">[], from: string, end: string): MomentChoice[] {
  const inWeek = days.filter((d) => d.date >= from && d.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const photos: MomentChoice[] = [];
  for (const d of inWeek) {
    const place = placeOf(d);
    for (const p of d.photos) {
      const day = weekdayLong(d.date);
      photos.push({ kind: "photo", ref: p.id, date: d.date, art: { id: p.id, w: p.w || 4, h: p.h || 3 }, label: place ? `the ${place} one` : `the ${day} one`, title: place ? `Photo from ${day} at ${place}` : `Photo from ${day}`, day: dayShort(d.date), what: place ?? (d.line?.trim() ? firstWords(d.line, 4) : "Photo") });
    }
  }
  const covers = new Map<string, MomentChoice & { weight: number }>();
  for (const d of inWeek)
    for (const e of d.entries) {
      if ((e.kind !== "watched" && e.kind !== "read" && e.kind !== "listened") || !e.art) continue;
      const name = e.group ?? e.title;
      const key = `${e.kind}:${name}`;
      const prev = covers.get(key);
      if (prev) {
        prev.weight += e.count ?? 1;
        continue;
      }
      const label = short(name);
      covers.set(key, { kind: "entry", ref: e.id, date: d.date, art: e.art, label: label ? `the ${label} one` : `the ${weekdayLong(d.date)} one`, title: `${e.kind === "watched" ? "Watched" : e.kind === "read" ? "Read" : "Listened to"} ${name}`, day: dayShort(d.date), what: name, weight: e.count ?? 1 });
    }
  const entries = [...covers.values()].sort((a, b) => b.weight - a.weight).map(({ weight: _w, ...c }) => c);
  const lines: MomentChoice[] = inWeek.filter((d) => d.line?.trim()).map((d) => ({ kind: "line", ref: d.date, date: d.date, text: d.line!.trim(), label: `${weekdayLong(d.date)}'s line`, title: d.line!.toLowerCase().includes(weekdayLong(d.date).toLowerCase()) ? d.line!.trim() : `${weekdayLong(d.date)}: ${d.line!.trim()}`, day: dayShort(d.date), what: firstWords(d.line!) }));
  return [...photos.slice(0, MAX.photo), ...entries.slice(0, MAX.entry), ...lines.slice(-MAX.line)];
}

/** "Kept. Week 46 is the Barbican one." */
export function keptToast(monday: string, choice: Pick<MomentChoice, "label">): string {
  return `Kept. Week ${isoWeek(monday)} is ${choice.label}.`;
}

/** What's stored for a choice: where it points, and the image's id and size. */
export function toMoment(c: WeekMoment): WeekMoment {
  return { kind: c.kind, ref: c.ref, date: c.date, ...(c.kind !== "line" && c.art ? { art: { id: c.art.id, w: c.art.w, h: c.art.h, ...(c.art.tone ? { tone: c.art.tone } : {}) } } : {}) };
}

/** The same moment, whichever copy it came from. */
export const sameMoment = (a: WeekMoment | null | undefined, b: WeekMoment | null | undefined) => !!a && !!b && a.kind === b.kind && a.ref === b.ref;
