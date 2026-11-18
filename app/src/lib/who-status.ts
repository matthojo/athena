/**
 * Who Ask is talking to, in words (docs/team.md, Vocabulary → Status line):
 * a short present-tense line under an assistant's name. While it works the
 * line is its current step ("Creating shopping list"); idle, it says when it
 * last ran today ("Last ran 9:12") or what it watches ("Watching Linear").
 * Pure, so Home, Ask and tests share it.
 */
import type { TeamAssistant } from "../../../lib/team-types";

/** Athena's own line in Ask's header and the picker. */
export const ATHENA_STATUS = "Your notes, calls and email";

const DAY_MS = 86_400_000;

const clock = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "linear" → "Linear", "gift-idea" → "gift ideas". */
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (s: string) => {
  const words = s.replace(/[-_]+/g, " ").trim();
  return words.endsWith("s") ? words : `${words}s`;
};

/** What an event trigger watches, as "Watching …" finishes it. */
function watching(a: Pick<TeamAssistant, "triggers">): string | null {
  const t = a.triggers.find((x) => x.kind === "event" && !x.paused && x.event);
  const e = t?.event;
  if (!e) return null;
  if (e.connector) return title(e.connector);
  if (e.source === "saved") return e.savedAction ? plural(e.savedAction) : "what you save";
  if (e.source === "note") return "new notes";
  return "new items";
}

export function statusLine(a: Pick<TeamAssistant, "paused" | "last_run_at" | "triggers" | "job">, now = new Date()): string {
  if (a.paused) return "Paused";
  const ran = a.last_run_at ? new Date(a.last_run_at) : null;
  const today = startOfDay(now);
  if (ran && !Number.isNaN(ran.getTime()) && ran.getTime() >= today) return `Last ran ${clock(ran)}`;
  const watch = watching(a);
  if (watch) return `Watching ${watch}`;
  if (ran && ran.getTime() >= today - DAY_MS) return "Last ran yesterday";
  if (ran && ran.getTime() >= today - 6 * DAY_MS) return `Last ran ${ran.toLocaleDateString(undefined, { weekday: "short" })}`;
  return a.job;
}

/** Ask's head while an assistant works: one word, so it's never cut short. The pill beside the reply has the step. */
export const WORKING = "Working";

/** The step line in a status pill: the running step without its trailing dots, which the pill draws itself. */
export const stepLine = (step: string | null): string | null => (step ? step.replace(/(…|\.\.\.)$/, "").trim() || null : null);
