/**
 * The team's pulse, for anywhere outside the Team page (components/nav.ts):
 * who's working right now, and how many things wait for you. The sidebar's
 * Team entry shows it, so you can see the team is busy without opening it.
 *
 *   planCounts(runs)        the conversations on this device that may still hold a plan, by run id
 *   readPulse()             { working: ["Penny"], waiting: 1 }
 *   watchTeamPulse(fn)      calls fn now, after any change, and every minute while the app is visible
 *
 * Anywhere else that shows the pulse (Home's Team button on phones) uses
 * watchTeamPulse: it returns a stop function, and `waiting` already leaves
 * out failed runs you've dismissed on this device.
 *
 * What waits is one count everywhere (lib/team-report.ts `runWaits`): the
 * changes each assistant's last plan holds for Go, and each run that didn't
 * finish. A Go anywhere on this device lowers it at once.
 */
import "../styles/team-pulse.css";
import { listActivity, listTeam, onTeamChange, type TeamAssistant, type TeamRun } from "../db/team";
import { getThread, onThreadsChange } from "../db/ask-threads";
import { runWaits } from "../lib/team-report";
import { deskFor, waitsForGo, type WaitsOf } from "./page-words";
import { isDismissed, onDismissChange } from "./page-dismiss";

export interface TeamPulse {
  /** Names of the assistants working or about to start, in the owner's order. */
  working: string[];
  /** Changes waiting for Go, and runs that didn't finish. */
  waiting: number;
}

/** A finished run whose plan may still wait: the server says so, or (an older server) its summary does. */
const mayWait = (r: TeamRun) => r.status === "done" && !!r.thread_id && (typeof r.waiting === "number" ? r.waiting > 0 : waitsForGo(r));

/**
 * The conversations on this device that may still hold a run's plan, by run
 * id: whichever shape the plan is kept in (an assistant's reply, or a Team
 * run's written answer). Runs whose conversation isn't here are left out.
 */
export async function planCounts(runs: TeamRun[]): Promise<Map<string, readonly unknown[]>> {
  const out = new Map<string, readonly unknown[]>();
  await Promise.all(
    runs.filter(mayWait).map(async (r) => {
      const t = await getThread(r.thread_id!).catch(() => null);
      if (t) out.set(r.id, t.messages);
    })
  );
  return out;
}

/** The count deskFor takes: the run's own `waiting` and its conversation here, the lower; else its summary for a day. */
export function waitsFrom(threads: Map<string, readonly unknown[]>, now = Date.now()): WaitsOf {
  return (r) => runWaits(r, threads.get(r.id) ?? null, now);
}

export function pulseOf(team: TeamAssistant[], runs: TeamRun[], threads: Map<string, readonly unknown[]>, now = new Date()): TeamPulse {
  const working: string[] = [];
  let waiting = 0;
  for (const a of team) {
    const d = deskFor(a, runs, now, waitsFrom(threads, now.getTime()), (r) => isDismissed(r.id));
    if (d.live) working.push(a.name);
    waiting += d.waits + (d.state === "failed" ? 1 : 0);
  }
  return { working, waiting };
}

export async function readPulse(): Promise<TeamPulse> {
  const [team, runs] = await Promise.all([listTeam(), listActivity(30)]);
  return pulseOf(team, runs, await planCounts(runs));
}

/** Keep `fn` told: now, after any change to the team, and every minute while the app is on screen. */
export function watchTeamPulse(fn: (p: TeamPulse) => void, everyMs = 60_000): () => void {
  let timer = 0;
  let last = "";
  const tick = async () => {
    window.clearTimeout(timer);
    try {
      const p = await readPulse();
      const key = JSON.stringify(p);
      if (key !== last) {
        last = key;
        fn(p);
      }
      // While someone works, look again sooner, so the dot goes when they finish.
      if (document.visibilityState !== "hidden") timer = window.setTimeout(tick, p.working.length ? Math.min(everyMs, 10_000) : everyMs);
    } catch {
      // No team yet, offline, or an older server: say nothing and try again later.
      if (document.visibilityState !== "hidden") timer = window.setTimeout(tick, everyMs * 5);
    }
  };
  const onVisible = () => {
    if (document.visibilityState !== "hidden") void tick();
    else window.clearTimeout(timer);
  };
  document.addEventListener("visibilitychange", onVisible);
  const off = onTeamChange(() => void tick());
  const offDismiss = onDismissChange(() => void tick());
  // A Go in Ask (or anywhere a conversation changes) lowers what waits.
  const offThreads = onThreadsChange(() => void tick());
  void tick();
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    off();
    offDismiss();
    offThreads();
  };
}
