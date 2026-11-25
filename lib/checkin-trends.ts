/**
 * Check-ins as trends (GET /api/checkins/trends, lib/checkin-types.ts): each day's scale answers
 * and picks, with the questions that were asked, for Health → Wellness. Pure, so it's tested on its
 * own (checkin-trends.test.ts); lib/checkins.ts reads and opens the rows.
 *
 * Written answers and skips are left out. A question's latest wording wins, so an own question
 * edited since reads under its new name.
 */

import type { CheckinAnswer, CheckinKind, CheckinQuestion, CheckinTrendDay, CheckinTrends } from "./checkin-types";

export interface TrendRow {
  date: string;
  kind: CheckinKind;
  status: "open" | "done";
  plan: CheckinQuestion[];
  answers: Record<string, CheckinAnswer>;
}

export function trendsOf(rows: TrendRow[]): CheckinTrends {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "morning" ? -1 : 1));
  const days: CheckinTrendDay[] = [];
  const questions = new Map<string, CheckinQuestion>();
  for (const r of sorted) {
    const day: CheckinTrendDay = { date: r.date, kind: r.kind, status: r.status, scales: {}, picks: {} };
    let any = false;
    for (const q of r.plan) {
      const v = r.answers[q.id]?.value;
      if (!v) continue;
      if (q.type === "scale" && "scale" in v && v.scale >= 1 && v.scale <= 5) day.scales[q.id] = v.scale;
      else if ((q.type === "choices" || q.type === "areas") && "picks" in v && v.picks.length) day.picks[q.id] = [...v.picks];
      else continue;
      any = true;
      // Oldest first, so a later day's wording replaces an earlier one.
      questions.set(q.id, q);
    }
    if (any) days.push(day);
  }
  return { days, questions: [...questions.values()] };
}
