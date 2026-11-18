/**
 * Home's memory: one a day, chosen from earlier years, written as a
 * sentence the owner would recognise. Pure; components/day-today.ts
 * gathers the candidates and components/day-card.ts draws the card.
 *
 * Candidates, best first:
 *  1. the exact date in an earlier year;
 *  2. a first (a place's first visit, a person's first logged catch-up, the
 *     first run over 5 km, the first finished book) on its anniversary;
 *  3. a day in the same week in an earlier year;
 *  4. a first whose anniversary is within three days.
 * Within those, a day with the owner's own words beats one with a person,
 * which beats a place, which beats media. A day with only media is a
 * memory only when nothing richer is there (a first always counts). Ties are broken by a hash of
 * today's date, so the memory doesn't change between opens.
 *
 * Never: a day with mood Rough or Low, a day with someone since archived,
 * anything that names a "Never nudge about" topic, or a day hidden with
 * "Not this one". Memories are for the app only, never a push.
 */

import type { DaySummary, Mood } from "../../../lib/day-types";

export type FirstKind = "place" | "person" | "run" | "book";

export interface MemoryFirst {
  kind: FirstKind;
  /** The place, the person or the book; "run" for a run. */
  name: string;
  /** Days back at the place, or catch-ups with the person, since. */
  since?: number;
  /** A run's distance. */
  km?: number;
}

export interface MemoryCandidate {
  /** The day remembered (for a first, the day of the first time). */
  date: string;
  first?: MemoryFirst;
  mood?: Mood | null;
  /** The owner's own words that day: a journal, or a line they wrote. */
  words?: boolean;
  /** Who was there; archived people rule the day out. */
  people?: Array<{ name: string; archived?: boolean }>;
  /** Named stops, not home or work. */
  places?: string[];
  /** Watched, read, listened to or played something. */
  media?: boolean;
  /** Anything else to check against the never-nudge topics (the day's line, titles). */
  text?: string[];
}

/** A day as On this day shows it: with a memory, the card is the sentence (components/day-card.ts). */
export type RememberedDay = DaySummary & { memory?: { sentence: string; tier: MemoryTier; first?: FirstKind } };

export type MemoryTier = "date" | "first-day" | "week" | "first-week";

export interface PickedMemory {
  candidate: MemoryCandidate;
  tier: MemoryTier;
  /** Whole years since. */
  years: number;
}

export interface PickInput {
  /** YYYY-MM-DD, the owner's today. */
  today: string;
  candidates: MemoryCandidate[];
  /** Days hidden with "Not this one". */
  hidden: string[];
  /** "Never nudge about" topics, any case. */
  neverTopics: string[];
}

/** An anniversary this many days either side counts as the same week. */
export const WEEK_WINDOW = 3;
/** Rough (1) and Low (2) days are never brought back. */
export const LOWEST_REMEMBERED_MOOD = 3;
/** The journal quote's length before it's trimmed. */
export const QUOTE_CHARS = 90;

// ---------- Dates ----------

const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const anniversaryIn = (date: string, y: number) => (date.slice(5) === "02-29" && !isLeap(y) ? `${y}-02-28` : `${y}-${date.slice(5)}`);

/**
 * How far `date`'s nearest anniversary is from `today`, in days, and how
 * many years ago it was. Null when it's less than a year ago or further
 * than `window` days from an anniversary.
 */
export function anniversary(date: string, today: string, window = WEEK_WINDOW): { gap: number; years: number } | null {
  const y = Number(today.slice(0, 4));
  let best: { gap: number; years: number } | null = null;
  for (const yy of [y - 1, y, y + 1]) {
    const gap = Math.round((dayMs(today) - dayMs(anniversaryIn(date, yy))) / 86_400_000);
    const years = yy - Number(date.slice(0, 4));
    if (years < 1 || Math.abs(gap) > window) continue;
    if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { gap, years };
  }
  return best;
}

// ---------- Choosing ----------

/** A 32-bit FNV-1a hash: the same string gives the same number on every device. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` name one of `topics` (at a word start, any case)? The briefing writer's rule. */
export function namesTopic(text: string, topics: string[]): boolean {
  return topics.some((t) => {
    const topic = t.trim();
    return topic.length >= 2 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(topic)}`, "iu").test(text);
  });
}

/** Everything in a candidate that a never-nudge topic could name. */
const textOf = (c: MemoryCandidate) => [c.first?.name, ...(c.people ?? []).map((p) => p.name), ...(c.places ?? []), ...(c.text ?? [])].filter((x): x is string => !!x);

/** Is this candidate one Athena may bring back? */
export function remembered(c: MemoryCandidate, hidden: Iterable<string>, neverTopics: string[]): boolean {
  if (new Set(hidden).has(c.date)) return false;
  if (c.mood != null && c.mood < LOWEST_REMEMBERED_MOOD) return false;
  if ((c.people ?? []).some((p) => p.archived)) return false;
  return !textOf(c).some((t) => namesTopic(t, neverTopics));
}

/** Own words, then a person, then a place, then media. */
export function richness(c: MemoryCandidate): number {
  if (c.first) return c.first.kind === "person" ? 4 : c.first.kind === "place" ? 2 : 1;
  const live = (c.people ?? []).filter((p) => !p.archived);
  return (c.words ? 8 : 0) + (live.length ? 4 : 0) + (c.places?.length ? 2 : 0) + (c.media ? 1 : 0);
}

/** Worth a morning on its own: a first, or a day with words, a person or a place (not only media). */
const substantial = (c: MemoryCandidate, score: number) => !!c.first || score > 1;

const TIER_ORDER: Record<MemoryTier, number> = { date: 0, "first-day": 1, week: 2, "first-week": 3 };

/** Which tier a candidate is in for `today`, with its years; null when it's not a memory today. */
export function tierOf(c: MemoryCandidate, today: string): { tier: MemoryTier; years: number } | null {
  const a = anniversary(c.date, today);
  if (!a) return null;
  if (c.first) return { tier: a.gap === 0 ? "first-day" : "first-week", years: a.years };
  return { tier: a.gap === 0 ? "date" : "week", years: a.years };
}

/** Today's memory, or null. The same inputs always give the same answer. */
export function pickMemory(input: PickInput): PickedMemory | null {
  const hidden = new Set(input.hidden);
  const ranked = input.candidates
    .filter((c) => remembered(c, hidden, input.neverTopics))
    .map((c) => ({ c, t: tierOf(c, input.today), score: richness(c), seed: seedOf(`${input.today}|${c.date}|${c.first?.kind ?? "day"}|${c.first?.name ?? ""}`) }))
    .filter((x): x is typeof x & { t: NonNullable<typeof x.t> } => !!x.t && x.score > 0)
    .sort((a, b) => Number(substantial(b.c, b.score)) - Number(substantial(a.c, a.score)) || TIER_ORDER[a.t.tier] - TIER_ORDER[b.t.tier] || b.score - a.score || a.seed - b.seed);
  const best = ranked[0];
  return best ? { candidate: best.c, tier: best.t.tier, years: best.t.years } : null;
}

// ---------- Writing it ----------

const YEARS = ["", "A year", "Two years", "Three years", "Four years", "Five years", "Six years", "Seven years", "Eight years", "Nine years", "Ten years"];
export const yearsWord = (n: number) => YEARS[n] ?? `${n} years`;

const TIMES = ["", "once", "twice", "three times", "four times", "five times", "six times", "seven times", "eight times", "nine times", "ten times"];
export const timesWord = (n: number) => TIMES[n] ?? `${n} times`;

/** "Priya Shah" → "Priya". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Priya", "Priya and Tom", "Priya, Tom and Ana". */
export function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The journal's first sentence, at most `max` characters, cut at a word
 * with an ellipsis when it's longer. Ends with its own full stop, question
 * or exclamation mark, or with one added.
 */
export function firstSentence(text: string, max = QUOTE_CHARS): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const m = /^.+?[.!?](?=\s|$)/.exec(flat);
  let s = (m ? m[0] : flat).trim();
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const at = cut.lastIndexOf(" ");
    s = `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.!?-]+$/, "")}…`;
  } else if (!/[.!?…]$/.test(s)) s = `${s}.`;
  return s;
}

/** The parts of a places line that aren't home or work: "Work, lunch at Dishoom, then Hampstead Heath" → ["lunch at Dishoom", "Hampstead Heath"]. */
export function placeClauses(line: string): string[] {
  return line
    .split(/,\s*then\s+|,\s*|\s+then\s+/i)
    .map((x) => x.trim())
    .filter((x) => x && !/^(home|work)$/i.test(x))
    .map((x) => (/^(breakfast|brunch|lunch|dinner|coffee|drinks|a walk|a run)\b/i.test(x) ? x[0].toLowerCase() + x.slice(1) : x));
}

/** The details of the chosen day, read once it's picked (the full day, and who and where). */
export interface MemoryDetail {
  /** The journal (or the owner's own line), to quote from. */
  words?: string | null;
  /** First names, at most two. */
  people?: string[];
  /** A catch-up only by phone. */
  call?: boolean;
  /** The day's first place clause: "lunch at Dishoom", "Hampstead Heath". */
  place?: string | null;
  /** The day's main thing watched, read, heard or played: "watching Northern Lines". */
  media?: string | null;
  /** The day's line, as a last resort. */
  line?: string | null;
}

const MEAL = /^(breakfast|brunch|lunch|dinner|coffee|drinks) at (.+)$/i;

/** What happened, as a phrase: "lunch with Priya at Dishoom", "Hampstead Heath with Tom", "time with Ana". */
export function whatHappened(d: MemoryDetail): string | null {
  const who = names((d.people ?? []).slice(0, 2));
  const place = d.place?.trim() || null;
  if (who && place) {
    const m = MEAL.exec(place);
    return m ? `${m[1].toLowerCase()} with ${who} at ${m[2]}` : `${place} with ${who}`;
  }
  if (who) return d.call ? `a call with ${who}` : `time with ${who}`;
  if (place) return place;
  if (d.media) return d.media;
  return d.line?.trim() || null;
}

/** The memory as one or two sentences, ready for the card. */
export function memorySentence(m: PickedMemory, d: MemoryDetail): string {
  const years = yearsWord(m.years);
  const f = m.candidate.first;
  if (f) {
    const today = m.tier === "first-day";
    const who = names((d.people ?? []).slice(0, 2));
    switch (f.kind) {
      case "place": {
        const back = f.since ? ` You've been back ${timesWord(f.since)} since.` : "";
        const subject = who ? `you and ${who}` : "you";
        return today ? `${years} since ${subject} first went to ${f.name}.${back}` : `${years} ago this week, ${subject} went to ${f.name} for the first time.${back}`;
      }
      case "person": {
        const p = firstName(f.name);
        const since = f.since ? ` You've caught up ${timesWord(f.since)} since.` : "";
        return today ? `${years} since your first catch-up with ${p}.${since}` : `${years} ago this week: your first catch-up with ${p}.${since}`;
      }
      case "run": {
        const km = f.km ? ` That one was ${f.km} km.` : "";
        return today ? `${years} since your first run over 5 km.${km}` : `${years} ago this week: your first run over 5 km.${km}`;
      }
      case "book":
        return today ? `${years} since you finished ${f.name}, the first book you logged.` : `${years} ago this week, you finished ${f.name}, the first book you logged.`;
    }
  }
  const when = `${years} ago ${m.tier === "date" ? "today" : "this week"}`;
  const quote = d.words ? firstSentence(d.words) : null;
  const what = whatHappened(d);
  if (what && quote) return `${when}: ${what}. You wrote "${quote}"`;
  if (what) return `${when}: ${what}.`;
  if (quote) return `${when}, you wrote "${quote}"`;
  return `${when}.`;
}
