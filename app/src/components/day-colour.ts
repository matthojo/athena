/**
 * The calendar's "Colour days by" (Settings → Days): how full the day was
 * (the server's heat, the default) or how many of the day's habits were
 * done. Kept on this device; the heat scale and its colours are the same.
 */

import type { DaySummary } from "../db/days-app";

export type ColourBy = "activity" | "habits";
const KEY = "athena.days.colourBy";

export function colourBy(): ColourBy {
  try {
    return localStorage.getItem(KEY) === "habits" ? "habits" : "activity";
  } catch {
    return "activity";
  }
}

export function setColourBy(v: ColourBy): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private mode: the choice lasts until reload.
  }
}

/** A day's level, 0–4, on the chosen scale. Habits: none done is 0, all done is 4. */
export function dayLevel(day: Pick<DaySummary, "counts" | "habits"> | undefined): 0 | 1 | 2 | 3 | 4 {
  if (!day) return 0;
  if (colourBy() !== "habits") return day.counts.heat;
  const h = day.habits;
  if (!h?.of || !h.done) return 0;
  return Math.max(1, Math.min(4, Math.round((h.done / h.of) * 4))) as 1 | 2 | 3 | 4;
}
