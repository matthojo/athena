/**
 * The Team page in words (views/team.ts, docs/team.md "Experience"): what
 * each assistant is doing now, what it did today, what waits for you, and
 * the one sentence at the top. Pure, so the tests can check the words.
 *
 *   deskFor(moss, activity)  → { state: "working", live, last, today }
 *   nowWords(run)            → "Checking prices at Smyths"
 *   nextWords(wren)          → "Next run Friday at 17:00"
 *   teamLede(team, desks)    → "Moss is working. Dot needs your Go."
 */
import type { TeamAssistant, TeamRun } from "../../../lib/team-types";
import { isQuiet, runWaits, splitReport } from "../lib/team-report";
import { cap, pronouns } from "./detail-words";
import { clockWords, eventWords, prefers12h, triggerSentence, WEEK } from "./trigger-editor-words";

export type DeskState = "working" | "queued" | "waiting" | "failed" | "paused" | "idle";

/** One assistant's place on the page: what it's doing, and what it did last. */
export interface Desk {
  state: DeskState;
  /** The run it's on now (working first, then waiting to start). */
  live: TeamRun | null;
  /** Its last finished run, done or failed. */
  last: TeamRun | null;
  /** Its finished runs today, newest first. */
  today: TeamRun[];
  /** Its last run left a plan that still waits for your Go (even while it's paused or working on something else). */
  asks: boolean;
  /** How many changes from that plan wait for Go (lib/team-report.ts `runWaits`): 0 when none. */
  waits: number;
  /** Its last run didn't finish and you dismissed it on this device: it stays in the history, not in Waiting for you. */
  dismissed: boolean;
}

type Who = Pick<TeamAssistant, "id" | "paused" | "triggers"> & { personality?: Pick<TeamAssistant["personality"], "pronoun"> };

export const isLive = (r: Pick<TeamRun, "status">) => r.status === "queued" || r.status === "running";

/** Skipped because it was paused: not a failure worth your attention. */
const skipped = (r: TeamRun) => r.status === "failed" && /^paused\b/i.test(r.error ?? "");

/** The run's summary says something waits for your Go (lib/team-run.ts `runSummary`). Words only: `runWaits` is the count. */
export function waitsForGo(r: Pick<TeamRun, "status" | "summary">): boolean {
  return r.status === "done" && /\b(tap|your) Go\b/.test(r.summary ?? "");
}

/** How many changes a run leaves for Go, given what this device knows of its conversation (team/page-pulse.ts `planCounts`). */
export type WaitsOf = (r: TeamRun) => number;

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const at = (r: TeamRun) => r.finished_at ?? r.started_at;

/**
 * Where an assistant is now. `waitsOf` says how many changes a run's plan
 * still holds for Go; without it, the run's own `waiting` (else its summary,
 * for a day) counts. `dismissed` says whether you've dismissed a failed run
 * (team/page-dismiss.ts).
 */
export function deskFor(a: Who, activity: TeamRun[], now = new Date(), waitsOf?: WaitsOf, dismissed?: (r: TeamRun) => boolean): Desk {
  const mine = activity.filter((r) => r.assistant_id === a.id);
  const live = mine.find((r) => r.status === "running") ?? mine.find((r) => r.status === "queued") ?? null;
  const finished = mine.filter((r) => !isLive(r) && !skipped(r));
  const last = finished[0] ?? null;
  // Runs today, as Home counts them: one that found nothing to do had no job to report.
  const today = finished.filter((r) => sameDay(new Date(at(r)), now) && !isQuiet(r));
  const waits = last ? (waitsOf ? waitsOf(last) : runWaits(last, null, now.getTime())) : 0;
  const asks = waits > 0;
  const gone = last?.status === "failed" && !!dismissed?.(last);
  let state: DeskState = "idle";
  if (live) state = live.status === "running" ? "working" : "queued";
  else if (a.paused) state = "paused";
  else if (last?.status === "failed" && !gone) state = "failed";
  else if (asks) state = "waiting";
  return { state, live, last, today, asks, waits, dismissed: gone };
}

/** What it's doing right now, in its own words when the server has them. */
export function nowWords(r: Pick<TeamRun, "status" | "step"> & { retried?: boolean }): string {
  const step = r.step?.trim().replace(/[.…]+$/, "");
  if (step) return step;
  // A second try waits for the next pass (lib/team-runtime.ts): say so, so it doesn't read as stuck.
  if (r.status === "queued" && r.retried) return "Trying again shortly";
  return r.status === "queued" ? "About to start" : "Getting it done";
}

/** What set a run off: the server's words, else its trigger as a sentence, else nothing. */
export function causeWords(r: Pick<TeamRun, "label" | "trigger_id" | "event_id">, a?: Pick<TeamAssistant, "triggers">, hour12 = prefers12h()): string | null {
  const label = r.label?.trim();
  const t = r.trigger_id ? a?.triggers.find((x) => x.id === r.trigger_id) : null;
  // The server writes a schedule on a 24-hour clock ("Every Friday at 17:00"); say it in the device's, as the assistant's page does (detail-words.ts runLabel).
  if (label && t?.kind === "schedule" && /^Every\b.*\bat \d{1,2}:\d{2}$/.test(label)) return triggerSentence(t, hour12);
  if (label) return label;
  if (t) return triggerSentence(t, hour12);
  return null;
}

/** What came of a finished run. The runner's Go line is left off: what waits is a count of its own ("1 change waits for you"). */
export function resultWords(r: Pick<TeamRun, "status" | "summary" | "error">): string {
  if (r.status === "failed") return r.error?.trim() ? `Didn't finish: ${r.error.trim().replace(/\.$/, "")}.` : "Didn't finish.";
  const said = r.summary?.trim() ?? "";
  return splitReport(said).said || said || "Done.";
}

/** "14:02" (or "2:02 pm"), the way the device writes times. */
export function clock(iso: string, hour12 = prefers12h()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return clockWords(`${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`, hour12);
}

/** "Today", "Yesterday", "Friday", "3 Nov". */
export function dayWords(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (sameDay(t, now)) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(t, y)) return "Yesterday";
  if ((now.getTime() - t.getTime()) / 86_400_000 < 6) return WEEK.find((w) => w.day === t.getDay())!.long;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getMonth()];
  return `${t.getDate()} ${month}`;
}

/** When a finished run happened, as briefly as reads clearly: "14:02" today, else "Yesterday" or "Friday". */
export function whenShort(iso: string, now = new Date(), hour12 = prefers12h()): string {
  return sameDay(new Date(iso), now) ? clock(iso, hour12) : dayWords(iso, now);
}

/** The next time a schedule fires after `now`, or null. */
export function nextSlot(a: Pick<TeamAssistant, "triggers">, now = new Date()): Date | null {
  let best: Date | null = null;
  for (const t of a.triggers) {
    if (t.paused || t.kind !== "schedule") continue;
    const m = /^(\d{1,2}):(\d{2})/.exec(t.time ?? "09:00");
    if (!m) continue;
    for (let d = 0; d <= 7; d++) {
      const c = new Date(now);
      c.setDate(now.getDate() + d);
      c.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (c <= now || (t.days.length && !t.days.includes(c.getDay() as never))) continue;
      if (!best || c < best) best = c;
      break;
    }
  }
  return best;
}

/** What it waits for: "Runs when you save a gift idea", "Next run Friday at 17:00", "Runs when you ask". */
export function nextWords(a: Who, now = new Date(), hour12 = prefers12h()): string {
  if (a.paused) {
    // The assistant's own pronoun, as its page says it.
    const p = pronouns(a.personality ?? { pronoun: "they" });
    return `Paused. ${cap(p.they)} won't run until you turn ${p.them} back on.`;
  }
  const ev = a.triggers.find((t) => !t.paused && t.kind === "event");
  const slot = nextSlot(a, now);
  if (ev) return `Runs when ${eventWords(ev.event)}`;
  if (slot) {
    const time = clockWords(`${slot.getHours()}:${String(slot.getMinutes()).padStart(2, "0")}`, hour12);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const day = sameDay(slot, now) ? "today" : sameDay(slot, tomorrow) ? "tomorrow" : WEEK.find((w) => w.day === slot.getDay())!.long;
    return `Next run ${day} at ${time}`;
  }
  return "Runs when you ask";
}

const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The page's one sentence: who's working, what waits for you, else how the
 * day has gone. Words over widgets: no counts in boxes.
 */
export function teamLede(team: Array<Pick<TeamAssistant, "id" | "name" | "paused">>, desks: Map<string, Desk>): string {
  const by = (s: DeskState) => team.filter((a) => desks.get(a.id)?.state === s).map((a) => a.name);
  const working = [...by("working"), ...by("queued")];
  const waiting = team.filter((a) => desks.get(a.id)?.asks).map((a) => a.name);
  const failed = by("failed");
  const parts: string[] = [];
  if (working.length > 3) parts.push(`${working.length} of your assistants are working.`);
  else if (working.length) parts.push(`${names(working)} ${working.length === 1 ? "is" : "are"} working.`);
  if (waiting.length) parts.push(`${names(waiting)} ${waiting.length === 1 ? "needs" : "need"} your Go.`);
  if (failed.length) parts.push(`${names(failed)} couldn't finish ${failed.length === 1 ? "a run" : "their runs"}.`);
  if (parts.length) return parts.join(" ");
  if (team.length && team.every((a) => a.paused)) return "Everyone is paused.";
  const done = [...desks.values()].reduce((n, d) => n + d.today.length, 0);
  if (!done) return "All quiet so far today.";
  return `All quiet. Your team has run ${done === 1 ? "once" : done === 2 ? "twice" : `${done} times`} today.`;
}

/** Runs grouped by day, newest first: [["Today", runs], ["Yesterday", runs], …]. Live runs go under Today. */
export function byDay(runs: TeamRun[], now = new Date()): Array<[string, TeamRun[]]> {
  const groups = new Map<string, TeamRun[]>();
  for (const r of runs) {
    const key = isLive(r) ? "Today" : dayWords(at(r), now);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups];
}
