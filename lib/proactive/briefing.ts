/**
 * The day plan by energy rides in the morning briefing (lib/briefing-run.ts deliverBriefing):
 * after a short night the briefing note gets a "lighter plan" section with each suggested
 * move, and its push says a plan is ready. Like the go-easy briefing, it never says why:
 * the sleep figures stay in "Why am I seeing this?". The moves themselves are one tap on
 * Home's card, through the move flow with Undo.
 */
import type { Nudge } from "./types";
import { nudgeUrl } from "./urls";

export const DAY_PLAN_PUSH = "A lighter plan for today is on Home.";

/** The briefing's section for today's day plan (pure). Times are the owner's wall clock. */
export function dayPlanSection(n: Pick<Nudge, "actions"> & { id: string }, hhmm: (iso: string) => string): string {
  const moves = n.actions.flatMap((a) => (a.kind === "move" ? [`- “${a.title}” from ${hhmm(a.from)} to ${hhmm(a.start)}`] : []));
  return [
    "## A lighter plan for today",
    "",
    moves.length ? "Heavy work can move to the afternoon, and the morning stays quiet:" : "Nothing heavy is on this morning. Keep an hour quiet if you can.",
    ...(moves.length ? ["", ...moves, "", "Each move is one tap on Home, with Undo."] : []),
    "",
    `[Talk it through in Ask](${nudgeUrl(n.id)})`,
  ].join("\n");
}
