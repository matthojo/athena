/**
 * Sample mode's team reports (docs/team.md, "Home"): the cards the server
 * would have sent for the sample day's runs (db/sample-team.ts), one per
 * assistant, as lib/team-run.ts teamNudge writes them: title "From <Name>",
 * the run's summary as the body, keyed "team:<run id>", with the
 * conversation the run kept. So Home tells the same day as the Team page
 * and the assistant's page, and a Go on any of them clears the same plan.
 *
 * As on the server: a run that found nothing to do sends no card, a card
 * lasts 20 hours, and a newer finished run's card replaces an older one.
 */
import type { AppNudge } from "./nudges";
import type { TeamAssistant, TeamRun } from "../../../lib/team-types";
import { isQuiet, runWaits } from "../lib/team-report";
import { eventWords, triggerSentence } from "../team/trigger-editor-words";
import { pronouns } from "../team/detail-words";

/** lib/team-run.ts CARD_HOURS. */
const CARD_MS = 20 * 3_600_000;

/** Dismissed this visit. */
const gone = new Set<string>();
export const dismissSampleReport = (nudgeId: string): void => void gone.add(nudgeId);

/** A report's id: its run's, with a different prefix. */
const reportId = (runId: string) => runId.replace(/^5a3e0000/, "5a3e0900");

/** The card's "Why", as the server words it: when it runs, then what it did alone or left for you. */
function why(a: TeamAssistant, r: TeamRun): string[] {
  const t = r.trigger_id ? a.triggers.find((x) => x.id === r.trigger_id) : null;
  const p = pronouns(a.personality);
  const when = t?.kind === "event" && t.event ? `${a.name} runs ${eventWords(t.event)}.` : t ? `${a.name} runs ${triggerSentence(t).replace(/^Every/, "every")}.` : `You asked ${a.name} to run.`;
  const what = runWaits(r) ? `Anything ${p.they} can't do alone waits for you to tap Approve.` : `${a.name} only did what you let ${p.them} do alone.`;
  return [when, what];
}

/** The team's reports for Home, newest first: each assistant's latest card from the sample day's runs. */
export async function sampleTeamReports(team: TeamAssistant[], runs: readonly TeamRun[], now = Date.now()): Promise<AppNudge[]> {
  const out: AppNudge[] = [];
  for (const a of team) {
    if (a.paused) continue;
    // The newest finished run with something to say, from the last 20 hours.
    const r = runs.find((x) => x.assistant_id === a.id && (x.status === "done" || x.status === "failed") && !(x.status === "done" && isQuiet(x)) && now - Date.parse(x.finished_at ?? x.started_at) < CARD_MS);
    if (!r || gone.has(reportId(r.id))) continue;
    const at = r.finished_at ?? r.started_at;
    out.push({
      id: reportId(r.id),
      rule: "team" as AppNudge["rule"],
      key: `team:${r.id}`,
      title: `From ${a.name}`,
      body: r.status === "failed" ? `Didn't finish: ${(r.error ?? "it stopped partway").replace(/\.$/, "")}. Ask me about it and I'll pick it up.` : (r.summary ?? ""),
      why: why(a, r),
      context: `${a.name}, from your team.`,
      prompt: "",
      about: [],
      actions: [],
      thread_id: r.thread_id,
      expires_at: new Date(Date.parse(at) + CARD_MS).toISOString(),
      created_at: at,
      pushed_at: null,
      applied: [],
      ...({ assistant: { id: a.id, name: a.name, avatar: a.avatar } } as object),
    } as AppNudge);
  }
  return out.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
}
