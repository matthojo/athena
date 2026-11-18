/**
 * A day's check-in questions (lib/checkin-types.ts has the owner's rules). Pure: the store
 * (lib/checkins.ts) gives it the routine, the questions that exist and when each was last asked.
 *
 *  - A routine that's off asks nothing.
 *  - Pinned questions are asked every day, first, in the routine's order. They're all asked even
 *    when there are more of them than the day's count.
 *  - The rest take turns: the least recently asked fill the day up to per_day (a question never
 *    asked counts as the oldest). Two last asked on the same day are told apart by the time
 *    before that, and so on back; then the routine's order breaks the tie. Without that step
 *    back, the first few in the list would win every tie and the last would wait twice as long.
 *    They're asked in the routine's order.
 *  - A question that no longer exists, or doesn't belong to this routine's kind, is passed over.
 */
import type { CheckinKind, CheckinQuestion, RoutineSettings } from "./checkin-types";

/** The days each question was in a plan, by question id, newest first: "YYYY-MM-DD". Absent: never asked. */
export type AskedHistory = Record<string, string[]>;

/** Which was asked longer ago: negative when `a` was. Each list is newest first; running out counts as oldest. */
function older(a: string[] = [], b: string[] = []): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = (a[i] ?? "").localeCompare(b[i] ?? "");
    if (c) return c;
  }
  return 0;
}

export function planFor(routine: RoutineSettings, library: CheckinQuestion[], history: AskedHistory, kind?: CheckinKind): CheckinQuestion[] {
  if (!routine.enabled) return [];
  const byId = new Map(library.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const list = routine.questions.filter((r) => {
    const q = byId.get(r.id);
    if (!q || seen.has(r.id) || (kind && !q.kinds.includes(kind))) return false;
    seen.add(r.id);
    return true;
  });
  const pinned = list.filter((r) => r.pinned);
  const rest = list.map((r, i) => ({ r, i })).filter(({ r }) => !r.pinned);
  const room = Math.max(0, routine.per_day - pinned.length);
  const picked = new Set(
    [...rest]
      .sort((a, b) => older(history[a.r.id], history[b.r.id]) || a.i - b.i)
      .slice(0, room)
      .map(({ r }) => r.id),
  );
  return [...pinned, ...rest.filter(({ r }) => picked.has(r.id)).map(({ r }) => r)].map((r) => structuredClone(byId.get(r.id)!));
}

/** The history from earlier plans, given in any order. */
export function askedHistory(plans: Array<{ date: string; plan: Array<Pick<CheckinQuestion, "id">> }>): AskedHistory {
  const out: AskedHistory = {};
  for (const p of plans) for (const q of p.plan) (out[q.id] ??= []).push(p.date);
  for (const dates of Object.values(out)) dates.sort((a, b) => b.localeCompare(a));
  return out;
}
