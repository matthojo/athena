/**
 * How the team reports back on Home and in Ask (docs/team.md, "Home"): an
 * assistant's run, said as that assistant telling you what it did, with
 * what waits on you pulled out so it can be one tap away. Pure, so Home,
 * Ask and the tests share it.
 */
import type { TeamRun } from "../../../lib/team-types";
import { stepLine } from "./who-status";

/**
 * The runner's last sentence when a run left a plan (lib/team-run.ts runSummary): "One change waits for you to tap Go."
 * The nudge's body is clipped at 180 characters, so the sentence may end early ("One change waits for…"): it still counts.
 */
const WAITS = /\s*(?:One change waits|(\d+) changes wait)(?: for(?: you(?: to(?: tap(?: Go)?)?)?)?)?(?:\.|…)?\s*$/;

/** A run's summary, split into what it said and how many changes wait for Go (0 when none). */
export function splitReport(summary: string): { said: string; waits: number } {
  const m = summary.match(WAITS);
  if (!m) return { said: summary.trim(), waits: 0 };
  return { said: summary.slice(0, m.index).trim(), waits: m[1] ? Number(m[1]) : 1 };
}

type Plan = { steps?: unknown[]; ran?: unknown };

/** How many changes a run's conversation still holds for Go: its last plan's steps, or 0 once it ran. Null: no plan in it. */
export function planWaits(messages: readonly unknown[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    // An assistant's reply keeps it under `reply`; a written answer (what a Team run keeps) on the message itself.
    const m = messages[i] as { plan?: Plan; reply?: { plan?: Plan } | null };
    const plan = m.plan ?? m.reply?.plan;
    if (plan && Array.isArray(plan.steps)) return plan.ran ? 0 : plan.steps.length;
  }
  return null;
}

/** The summary says something waits for your Go, in the runner's words or in a reply's ("…waits for your Go"). */
const SAYS_GO = /\b(?:tap|your) Go\b/;

/**
 * How many changes from a run still wait for your Go: the one count every
 * Team surface shows (the Team page, the sidebar, Home's Team button and
 * card, the assistant's page). The server's `waiting` and the run's
 * conversation on this device both know; a Go only ever lowers the count and
 * either may hear of it first, so the lower wins. With neither, the summary's
 * words count for a day.
 */
export function runWaits(
  r: Pick<TeamRun, "status" | "started_at"> & { finished_at?: string | null; summary?: string | null; waiting?: number | null },
  messages?: readonly unknown[] | null,
  now = Date.now()
): number {
  if (r.status !== "done") return 0;
  const known = [typeof r.waiting === "number" ? r.waiting : null, messages ? planWaits(messages) : null].filter((n): n is number => n !== null);
  if (known.length) return Math.max(0, Math.min(...known));
  if (now - Date.parse(r.finished_at ?? r.started_at) >= 86_400_000) return 0;
  const summary = r.summary ?? "";
  return splitReport(summary).waits || (SAYS_GO.test(summary) ? 1 : 0);
}

/** "1 change waits for you", "2 changes wait for you". */
export const waitsWords = (n: number): string => (n === 1 ? "1 change waits for you" : `${n} changes wait for you`);

/** "Review 1 change", "Review 3 changes": the button that takes you to Go. */
export const reviewWords = (n: number): string => `Review ${n === 1 ? "1 change" : `${n} changes`}`;

/** A run that hasn't finished: queued or working. */
export const isLive = (r: Pick<TeamRun, "status">): boolean => r.status === "queued" || r.status === "running";

/**
 * What an assistant is doing right now, as a sentence that starts with its name:
 * "Penny is checking prices", "Wren is getting it done", "Dot is about to start".
 * A step that isn't an -ing phrase follows a colon: "Penny: 3 of 5 done".
 */
export function workingWords(name: string, run: Pick<TeamRun, "status" | "step"> & { retried?: boolean }): string {
  if (run.status === "queued" && run.retried) return `${name} will try again shortly`;
  if (run.status === "queued") return `${name} is about to start`;
  const step = stepLine(run.step ?? null);
  if (!step) return `${name} is getting it done`;
  if (/^[A-Z][a-z]+ing\b/.test(step)) return `${name} is ${step.charAt(0).toLowerCase()}${step.slice(1)}`;
  return `${name}: ${step}`;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** A reply that says there was nothing to do (as lib/team-run.ts reads it on newer servers). */
const NOTHING_SAID = /^(?:nothing\b|no (?:new|changes?|action)\b|all quiet\b|there(?:'s| is| was) nothing\b|not(?:hing)? (?:new|needed)\b)/i;

/** Words that only say nothing happened ("Nothing to do this time."). */
export const saysNothing = (text: string | null | undefined): boolean => !!text && NOTHING_SAID.test(text.trim());

/**
 * A run that found nothing to do (owner, 15 Nov 2026: off Home; it stays in
 * Lately and on the assistant's page). Newer servers say so (`quiet`); older
 * ones only say it in the summary.
 */
export function isQuiet(r: Pick<TeamRun, "status"> & { summary?: string | null; quiet?: boolean | null }): boolean {
  if (r.status !== "done") return false;
  if (typeof r.quiet === "boolean") return r.quiet;
  return saysNothing(r.summary);
}

/** How many jobs this assistant finished today (failed ones count: it still went to work; quiet ones don't: there was no job). */
export function jobsToday(runs: readonly (Pick<TeamRun, "assistant_id" | "status" | "started_at" | "finished_at"> & { summary?: string | null; quiet?: boolean | null })[], assistantId: string, now = new Date()): number {
  const from = startOfDay(now);
  return runs.filter((r) => r.assistant_id === assistantId && !isLive(r) && !isQuiet(r) && Date.parse(r.finished_at ?? r.started_at) >= from).length;
}

/** "3 runs today" (the Team page's words), or null for one or none (the time already says when). */
export const jobsWords = (n: number): string | null => (n > 1 ? `${n} runs today` : null);

/** Each assistant's newest live run, newest first: who's on a job right now. */
export function liveRuns<T extends Pick<TeamRun, "assistant_id" | "status" | "started_at">>(runs: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...runs]
    .filter(isLive)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .filter((r) => !seen.has(r.assistant_id) && !!seen.add(r.assistant_id));
}

/** "Penny is working" / "Penny and Dot are working" / "Penny, Dot and 2 others are working": the sidebar's and the Team page's words, for a screen reader's one line. */
export function teamWorkingSentence(names: readonly string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} is working`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are working`;
  return `${names[0]}, ${names[1]} and ${names.length - 2 === 1 ? "1 other" : `${names.length - 2} others`} are working`;
}

/**
 * The assistant's own words from its run's conversation: its last reply,
 * without citation marks, up to about two sentences. Null when there's none.
 */
export function ownWords(messages: readonly unknown[], max = 240): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; text?: string; reply?: { text?: string } | null };
    const text = m.role === "assistant" ? m.reply?.text : m.role === "answer" ? m.text : undefined;
    if (!text?.trim()) continue;
    const plain = text.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").trim();
    if (plain.length <= max) return plain;
    // Whole sentences that fit; else a clean cut at a word.
    const sentences = plain.match(/[^.!?]+[.!?]+(?:["”’)]+)?\s*/g) ?? [];
    let out = "";
    for (const s of sentences) {
      if ((out + s).trim().length > max) break;
      out += s;
    }
    return out.trim() || `${plain.slice(0, max).replace(/\s+\S*$/, "")}…`;
  }
  return null;
}
