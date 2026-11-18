/**
 * Sample mode's patterns: believable lines, each tied to the sample days it
 * fits (their workouts, meetings, watching and weekends), so a sample day
 * page shows a pattern on the right days. Words come from the real engine
 * (lib/patterns.ts patternWords), so they read exactly as the owner's will.
 */

import { addDays, patternWords, type Factor, type Outcome, type Pattern, type PatternWindow, type Sure } from "../../../lib/patterns";
import { localToday } from "../lib/time";
import { sampleDayNow } from "./sample-days";
import type { Day } from "../../../lib/day-types";

interface Spec {
  factor: string;
  kind: Factor["kind"];
  name?: string;
  amount?: number;
  outcome: Outcome;
  lag: 0 | 1;
  diff: number;
  usual: number;
  /** Share of the factor's days on the pattern's side. */
  share: number;
  sure: Sure;
  fits: (d: Day) => boolean;
}

const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const watched = (d: Day) => d.entries.filter((e) => e.kind === "watched").reduce((n, e) => n + (e.minutes ?? 0), 0);
const commuted = (d: Day) => d.entries.filter((e) => e.source === "tfl").reduce((n, e) => n + (e.minutes ?? 0), 0);
const kind = (d: Day, re: RegExp) => (d.health?.workouts ?? []).some((w) => re.test(w.type));

const SPECS: Spec[] = [
  { factor: "workout:yoga", kind: "workout", name: "yoga", outcome: "sleep", lag: 0, diff: 41, usual: 432, share: 0.74, sure: 3, fits: (d) => kind(d, /yoga/i) },
  { factor: "busy_calendar", kind: "busy_calendar", amount: 3, outcome: "mood", lag: 0, diff: -0.7, usual: 3.6, share: 0.42, sure: 2, fits: (d) => d.events.length >= 3 },
  { factor: "weekend", kind: "weekend", outcome: "steps", lag: 0, diff: 2640, usual: 8100, share: 0.78, sure: 3, fits: (d) => isWeekend(d.date) },
  { factor: "watching", kind: "watching", amount: 120, outcome: "deep", lag: 0, diff: -12, usual: 84, share: 0.69, sure: 2, fits: (d) => watched(d) >= 120 },
  { factor: "workout:run", kind: "workout", name: "run", outcome: "resting_hr", lag: 0, diff: -2.2, usual: 57, share: 0.66, sure: 1, fits: (d) => kind(d, /run/i) },
  { factor: "caffeine_late", kind: "caffeine_late", outcome: "sleep", lag: 0, diff: -34, usual: 445, share: 0.71, sure: 2, fits: (d) => ((d.health as { caffeine_after_14_mg?: number } | undefined)?.caffeine_after_14_mg ?? 0) > 0 },
  { factor: "mindful", kind: "mindful", outcome: "mood", lag: 0, diff: 0.4, usual: 3.5, share: 0.55, sure: 1, fits: (d) => ((d.health as { mindful_minutes?: number } | undefined)?.mindful_minutes ?? 0) > 0 },
  { factor: "workout:run", kind: "workout", name: "run", outcome: "mood", lag: 1, diff: 0.5, usual: 3.5, share: 0.58, sure: 1, fits: (d) => kind(d, /run/i) },
  // Commute (TfL): the Canary Wharf days, 1h 30m or more on the Tube, and a shorter night after.
  { factor: "commute", kind: "commute", amount: 90, outcome: "sleep", lag: 0, diff: -24, usual: 438, share: 0.7, sure: 3, fits: (d) => commuted(d) >= 90 },
  // Habits (lib/habits.ts): the sample's Habitify "No phone in bed".
  { factor: "habit:No phone in bed", kind: "habit", name: "No phone in bed", outcome: "sleep", lag: 0, diff: 26, usual: 432, share: 0.68, sure: 2, fits: (d) => d.entries.some((e) => e.kind === "habit" && e.title === "No phone in bed" && (e.count ?? 1) > 0) },
];

const memo = new Map<string, Pattern[]>();

/** Sample mode's patterns over the last `window` days. */
export async function samplePatterns(window: PatternWindow): Promise<Pattern[]> {
  await new Promise((r) => setTimeout(r, 120));
  const today = localToday();
  const key = `${today}|${window}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const days = Array.from({ length: window }, (_, i) => sampleDayNow(addDays(today, -i))).reverse();
  const out: Pattern[] = [];
  for (const s of SPECS) {
    const dates = days.filter(s.fits).map((d) => d.date);
    const n_with = dates.length;
    const n_without = days.length - n_with;
    if (n_with < 8 || n_without < 8) continue;
    const beat = Math.round(n_with * s.share);
    const beat_without = Math.round(n_without * (s.outcome === "mood" ? 0.12 : 0.45));
    const base = { factor_kind: s.kind, ...(s.name ? { factor_name: s.name } : {}), outcome: s.outcome, lag: s.lag, diff: s.diff, beat, beat_without, n_with, n_without };
    out.push({
      id: `${s.factor}|${s.outcome}|${s.lag}`,
      factor: s.factor,
      ...base,
      with_avg: s.usual + s.diff,
      without_avg: s.usual,
      // As the engine: fewer days, less sure.
      sure: Math.min(s.sure, n_with < 12 ? 1 : n_with < 20 ? 2 : 3) as Sure,
      score: s.sure + Math.abs(s.diff) / (Math.abs(s.usual) || 1),
      dates,
      ...patternWords({ ...base, amount: s.amount }),
    });
  }
  out.sort((a, b) => b.score - a.score);
  memo.set(key, out);
  return out;
}
