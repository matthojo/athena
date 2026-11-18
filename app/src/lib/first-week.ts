/**
 * A first week that knows it's a first week (docs/notes/affection-2026-11.md,
 * moment 3). Pure: which day of it today is, and what Home says on that day
 * from what already exists (apps connected, days kept, people added). Home
 * (views/home.ts) paints it; Days' recap (views/days-recap.ts) shows the
 * seventh day's review.
 *
 * The first week counts from `started_at` on the setup progress
 * (lib/profile.ts), stamped the first time Home opens for a new owner. Day 1
 * is that date, day 7 six days later, and after that it's an ordinary week.
 *
 * Voice: Athena says "I" only to say what it will do. No counting the owner's
 * effort back at them, no streaks, nothing to complete.
 */

import { localToday } from "./time";

export const FIRST_WEEK_DAYS = 7;

/** What Home says first on day one, after the greeting. */
export const ATHENA_HELLO = "I'm Athena. I'll keep your days, your people and what you're reading, and give some of it back when it helps.";

/** The name question, inline on Home while there's no name. */
export const NAME_QUESTION = "What should I call you?";

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T12:00:00Z`) / DAY_MS;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day the first week starts on, here: `started_at` is an instant (or already a date). */
export function firstWeekStart(startedAt: string | null | undefined): string | null {
  if (!startedAt) return null;
  if (DATE.test(startedAt)) return startedAt;
  const t = Date.parse(startedAt);
  return Number.isNaN(t) ? null : localToday(new Date(t));
}

/** Which day of the first week `today` is: 1 to 7, or null before it started, after it, or without a start. */
export function firstWeekDay(startedAt: string | null | undefined, today: string): number | null {
  const start = firstWeekStart(startedAt);
  if (!start || !DATE.test(today)) return null;
  const day = Math.round(dayNumber(today) - dayNumber(start)) + 1;
  return day >= 1 && day <= FIRST_WEEK_DAYS ? day : null;
}

/** The seven days, first to last (the first-week review's range). */
export function firstWeekRange(startedAt: string): { from: string; to: string } {
  const from = firstWeekStart(startedAt) ?? startedAt.slice(0, 10);
  return { from, to: addDays(from, FIRST_WEEK_DAYS - 1) };
}

/** What already exists, for the card's words. */
export interface FirstWeekFacts {
  /** Apps and accounts connected and working. */
  sources: number;
  /** Days with something on them so far (a mood, a line, anything an app sent). */
  daysKept: number;
  /** People in Athena. */
  people: number;
  /** Places visited, for the seventh day. */
  places?: number;
  /** Whether anything about the owner is waiting to keep (the learner's suggestions). */
  picked?: boolean;
}

export type FirstWeekAction = "connect" | "people" | "mood" | "write" | "review";

export interface FirstWeekCard {
  kicker: string;
  title: string;
  body: string;
  action: { kind: FirstWeekAction; label: string } | null;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number) => (n >= 0 && n < WORDS.length ? WORDS[n] : n.toLocaleString("en-GB"));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n: number, one: string, many = `${one}s`) => `${word(n)} ${n === 1 ? one : many}`;
const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/**
 * The seventh day's line: "Five days kept, two people and three places.
 * Here's what I picked up, if you want to keep it." Only what's there, and
 * the second sentence only when something is waiting to keep.
 */
export function firstWeekReviewLine(f: Pick<FirstWeekFacts, "daysKept" | "people" | "places" | "picked">): string {
  const bits = [f.daysKept ? count(f.daysKept, "day") + " kept" : null, f.people ? count(f.people, "person", "people") : null, f.places ? count(f.places, "place") : null].filter(Boolean) as string[];
  const lead = bits.length ? `${capital(list(bits))}.` : "A quiet first week.";
  return f.picked === false ? lead : `${lead} Here's what I picked up, if you want to keep it.`;
}

/** Home's one card for the first week, for the day it is and what exists. */
export function firstWeekCard(day: number, f: FirstWeekFacts): FirstWeekCard {
  if (day >= FIRST_WEEK_DAYS) {
    return {
      kicker: "Day 7",
      title: "Your first week with Athena",
      body: firstWeekReviewLine(f),
      action: { kind: "review", label: "See your first week" },
    };
  }
  const kicker = day === 1 ? "Day 1" : `Day ${day} of 7`;
  if (day === 1) {
    return f.sources
      ? {
          kicker,
          title: "Your first week",
          body: `${f.sources === 1 ? "One app is" : `${capital(word(f.sources))} apps are`} connected, so tomorrow's page will have something in it. Tap a mood now and today has one too.`,
          action: { kind: "mood", label: "Set today's mood" },
        }
      : {
          kicker,
          title: "Your first week",
          body: "Connect one app tonight and tomorrow's page will have something in it. Or tap a mood now.",
          action: { kind: "connect", label: "Connect an app" },
        };
  }
  if (!f.sources) {
    return {
      kicker,
      title: "Your first week",
      body: "Each morning I'll keep yesterday as a page. Connect your calendar or your steps and those pages fill themselves in.",
      action: { kind: "connect", label: "Connect an app" },
    };
  }
  if (!f.people) {
    return {
      kicker,
      title: "Your first week",
      body: "Tell me who matters most and I'll keep their birthdays and when you last saw them.",
      action: { kind: "people", label: "Add your people" },
    };
  }
  return {
    kicker,
    title: "Your first week",
    body: "Each morning I keep yesterday as a page. Write a line about today and it will be on tomorrow's.",
    action: { kind: "write", label: "Write a line" },
  };
}

/** What a day had, enough for the second morning's small page. */
export interface DayKept {
  mood?: number | null;
  line?: string | null;
  journal?: boolean;
  steps?: number | null;
  photos?: number;
  entries?: number;
}

/** "Your first day: a mood, one line and 4,100 steps." Day 2 opens with it. */
export function yesterdayPage(d: DayKept | null): string {
  if (!d) return "Your first day was a quiet one. Today's page fills in as your apps send things.";
  const steps = d.steps && d.steps >= 100 ? `${(Math.round(d.steps / 100) * 100).toLocaleString("en-GB")} steps` : null;
  const others = Math.max(0, (d.entries ?? 0) - (d.photos ?? 0));
  const bits = [
    d.mood ? "a mood" : null,
    d.line ? "one line" : null,
    d.journal ? "a few words" : null,
    steps,
    d.photos ? count(d.photos, "photo") : null,
    !steps && others ? count(others, "thing", "things") + " from your apps" : null,
  ].filter(Boolean) as string[];
  if (!bits.length) return "Your first day was a quiet one. Today's page fills in as your apps send things.";
  return `Your first day: ${list(bits)}.`;
}
