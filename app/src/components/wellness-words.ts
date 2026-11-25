/**
 * Health → Wellness, the pure parts (views/health-wellness.ts): which
 * check-in questions get a card and what each is called, a scale's average
 * in its own words, how it moved since the range before, mornings against
 * evenings, and the words and areas picked most. No DOM, no network, so
 * it's tested on its own (wellness-words.test.ts).
 */

import type { CheckinKind, CheckinQuestion, CheckinTrendDay } from "../../../lib/checkin-types";
import { PRESET_QUESTIONS } from "../../../lib/checkin-types";

/** Short card titles for Athena's own questions; the owner's questions keep their wording. */
const TITLES: Record<string, string> = {
  mood: "Mood",
  energy: "Energy",
  rested: "Rest",
  stress: "Stress",
  productive: "Productivity",
  emotions: "Feelings",
  influences: "What affects how you feel",
  focus: "Main focus",
};

export const questionTitle = (q: Pick<CheckinQuestion, "id" | "prompt">): string => TITLES[q.id] ?? q.prompt;

const PRESET_ORDER = new Map(PRESET_QUESTIONS.map((q, i) => [q.id, i]));

/** Athena's questions in the library's order, then the owner's own in the order they came. */
export function cardOrder(questions: CheckinQuestion[]): CheckinQuestion[] {
  return questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (PRESET_ORDER.get(a.q.id) ?? 100 + a.i) - (PRESET_ORDER.get(b.q.id) ?? 100 + b.i))
    .map((x) => x.q);
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Every answer to a scale question in these days, from one routine or both. */
export function scaleValues(days: CheckinTrendDay[], id: string, kind?: CheckinKind): number[] {
  return days.filter((d) => !kind || d.kind === kind).flatMap((d) => (d.scales[id] !== undefined ? [d.scales[id]] : []));
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** An average in the question's own words: 3.8 on the mood scale is "Good". */
export function levelWord(q: Pick<CheckinQuestion, "levels" | "low" | "high">, avg: number): string {
  const step = Math.min(5, Math.max(1, Math.round(avg)));
  const word = q.levels?.[step - 1] ?? (step <= 2 ? q.low : step >= 4 ? q.high : undefined) ?? `${step} of 5`;
  return cap(word);
}

/** "3.8": one place, and never "4.0". */
export const oneplace = (v: number): string => String(Math.round(v * 10) / 10);

/** "A little higher than the 4 weeks before", or null with nothing to compare. */
export function scaleChange(now: number | null, then: number | null, before: string): string | null {
  if (now === null || then === null) return null;
  const diff = now - then;
  if (Math.abs(diff) < 0.15) return `About the same as ${before}`;
  const way = diff > 0 ? "higher" : "lower";
  return Math.abs(diff) < 0.5 ? `A little ${way} than ${before}` : `${cap(way)} than ${before}`;
}

/** Mornings against evenings, once each has three answers. */
export function mornings(days: CheckinTrendDay[], id: string): { morning: number; evening: number } | null {
  const m = scaleValues(days, id, "morning");
  const e = scaleValues(days, id, "evening");
  if (m.length < 3 || e.length < 3) return null;
  return { morning: mean(m)!, evening: mean(e)! };
}

/** "Lower in the evening than in the morning", or that they're about the same. */
export function mornLine(split: { morning: number; evening: number }): string {
  const diff = split.evening - split.morning;
  if (Math.abs(diff) < 0.25) return "About the same in the morning and the evening";
  return `${diff > 0 ? "Higher" : "Lower"} in the evening than in the morning`;
}

export interface Ranked {
  word: string;
  /** Days it was picked on (once a day, however many check-ins). */
  days: number;
}

/** The words or areas picked most, on how many days each, most first. */
export function rankPicks(days: CheckinTrendDay[], id: string): Ranked[] {
  const seen = new Map<string, Set<string>>();
  for (const d of days) for (const w of d.picks[id] ?? []) (seen.get(w) ?? seen.set(w, new Set()).get(w)!).add(d.date);
  return [...seen].map(([word, ds]) => ({ word, days: ds.size })).sort((a, b) => b.days - a.days || a.word.localeCompare(b.word));
}

/**
 * The card's headline for picks: the word picked most, or two that tie
 * ("Calm and Focused"), or how many tie when it's more ("5 words"), so a
 * tie never reads as one winner.
 */
export function topPicks(ranked: Ranked[], noun: { one: string; many: string }): { value: string; tied: number } | null {
  if (!ranked.length) return null;
  const tied = ranked.filter((x) => x.days === ranked[0].days);
  if (tied.length === 1) return { value: tied[0].word, tied: 1 };
  if (tied.length === 2) return { value: `${tied[0].word} and ${tied[1].word}`, tied: 2 };
  return { value: `${tied.length} ${noun.many}`, tied: tied.length };
}

/** How many days had this question answered. */
export const answeredDays = (days: CheckinTrendDay[], id: string): number => new Set(days.filter((d) => d.picks[id]?.length).map((d) => d.date)).size;

/**
 * The one word that moved most against the range before, as a sentence:
 * "You picked Tired more often than in the 4 weeks before". Only a clear move
 * (a share of days at least 15 points apart, on three days or more).
 */
export function pickChange(now: Ranked[], nowDays: number, then: Ranked[], thenDays: number, before: string): string | null {
  if (nowDays < 5 || thenDays < 5) return null;
  const share = (xs: Ranked[], n: number, w: string) => (xs.find((x) => x.word === w)?.days ?? 0) / n;
  const words = new Set([...now, ...then].map((x) => x.word));
  let best: { word: string; diff: number } | null = null;
  for (const w of words) {
    const diff = share(now, nowDays, w) - share(then, thenDays, w);
    if (!best || Math.abs(diff) > Math.abs(best.diff) || (Math.abs(diff) === Math.abs(best.diff) && w < best.word)) best = { word: w, diff };
  }
  if (!best || Math.abs(best.diff) < 0.15) return null;
  const count = now.find((x) => x.word === best!.word)?.days ?? 0;
  if (best.diff > 0 && count < 3) return null;
  return `You picked ${best.word} ${best.diff > 0 ? "more" : "less"} often than in ${before}`;
}

/** "You checked in on 24 of these 28 days: 22 mornings and 20 evenings." `of` is the span in words. Null with none. */
export function checkedInLine(days: CheckinTrendDay[], of: string): string | null {
  const dates = new Set(days.map((d) => d.date));
  if (!dates.size) return null;
  const m = days.filter((d) => d.kind === "morning").length;
  const e = days.filter((d) => d.kind === "evening").length;
  const parts = [m ? `${m} ${m === 1 ? "morning" : "mornings"}` : null, e ? `${e} ${e === 1 ? "evening" : "evenings"}` : null].filter(Boolean);
  return `You checked in on ${dates.size} of ${of}: ${parts.join(" and ")}.`;
}
