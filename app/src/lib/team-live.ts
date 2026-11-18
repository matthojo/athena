/**
 * What the team is doing, shared by everything on screen that shows it
 * (Home's report and chips, Ask's picker): one listActivity() at a time,
 * looked at again every few seconds only while someone is on a job and
 * something is listening, and never while the page is hidden.
 */
import { listActivity, onTeamChange, type TeamRun } from "../db/team";
import { isLive } from "./team-report";

const POLL_MS = 4000;

let runs: TeamRun[] | null = null;
const subs = new Set<(runs: TeamRun[]) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let looking: Promise<void> | null = null;

function look(): Promise<void> {
  clearTimeout(timer);
  looking ??= listActivity(30)
    .then(
      (r) => void (runs = r),
      () => void (runs ??= [])
    )
    .then(() => {
      looking = null;
      for (const fn of subs) fn(runs!);
      if (subs.size && runs!.some(isLive) && document.visibilityState === "visible") timer = setTimeout(() => void look(), POLL_MS);
    });
  return looking;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && subs.size) void look();
  });
  // A Run now, a pause, a deletion: look again straight away.
  onTeamChange(() => subs.size && void look());
}

/** Follow the team's runs (newest first, queued and working ones included). Calls back now if they're known, and on every look. */
export function onTeamActivity(fn: (runs: TeamRun[]) => void): () => void {
  subs.add(fn);
  if (runs) fn(runs);
  void look();
  return () => {
    subs.delete(fn);
    if (!subs.size) clearTimeout(timer);
  };
}

/** The runs as last seen, without asking. */
export const teamActivityNow = (): TeamRun[] => runs ?? [];
