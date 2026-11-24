/**
 * Ask's plans, What Ask did and tonight's picks, for the app
 * (lib/ask-plans.ts, lib/routines.ts, lib/ask-activity.ts,
 * lib/watch-tonight.ts on the server). Sample mode keeps its own set
 * (db/sample-ask-plans.ts) and every change stays on this page.
 */
import { isSampleMode, request } from "./api";
import { sampleActivity, sampleAnswerAccount, sampleGo, samplePicks } from "./sample-ask-plans";
import type { AskPlan, AssistantChange, WatchPick } from "../types";

// ---------- plans ----------

/** Go: run the ticked steps, in order. Each change comes back with its Undo. */
export async function goPlan(plan: AskPlan, ticked: number[]): Promise<{ plan: AskPlan; changes: AssistantChange[] }> {
  if (isSampleMode()) return sampleGo(plan, ticked);
  return request("/assistant/plan", { method: "POST", body: JSON.stringify({ id: plan.id, ticked }) });
}

/**
 * The owner's answer when Go stopped for an account (AskPlan.needs_account): "once" lets this Go use it, "always"
 * ticks it for the assistant, "skip" leaves that step out. Go carries on from that step either way.
 */
export async function answerPlanAccount(plan: AskPlan, account: "once" | "always" | "skip"): Promise<{ plan: AskPlan; changes: AssistantChange[] }> {
  if (isSampleMode()) return sampleAnswerAccount(plan, account);
  return request("/assistant/plan", { method: "POST", body: JSON.stringify({ id: plan.id, account }) });
}

/** Undo all: newest first, each through What Ask did. */
export async function undoPlanAll(plan: AskPlan): Promise<Array<{ activity_id?: string; ok: boolean; error?: string }>> {
  if (isSampleMode()) return (plan.ran?.results ?? []).flatMap((r) => r.changes).map((c) => ({ activity_id: c.activity_id, ok: true }));
  return (await request<{ results: Array<{ activity_id?: string; ok: boolean; error?: string }> }>("/assistant/plan-undo", { method: "POST", body: JSON.stringify({ id: plan.id }) })).results;
}

// ---------- routines ----------
// /api/routines is closed (410 Gone, owner 13 Nov 2026): routines are assistants now (db/team.ts).

const sample = { undone: new Set<string>() };

// ---------- What Ask did ----------

export interface ActivityEntry {
  id: string;
  at: string;
  source: "ask" | "plan" | "routine" | "nudge" | "team" | "flow";
  thread_id: string | null;
  /** source "flow" only (lib/ask-activity.ts): the flow, the run that made the change, and the flow's name now. */
  flow_id?: string | null;
  flow_run_id?: string | null;
  flow_name?: string | null;
  state: "done" | "undone" | "undo_failed";
  change: AssistantChange;
}

export async function fetchActivity(before?: string): Promise<ActivityEntry[]> {
  if (isSampleMode()) return sampleActivity().map((e) => (sample.undone.has(e.id) ? { ...e, state: "undone" as const } : e));
  const qs = new URLSearchParams({ limit: "50", ...(before ? { before } : {}) });
  return (await request<{ entries: ActivityEntry[] }>(`/activity?${qs}`)).entries;
}

export async function undoActivity(id: string): Promise<ActivityEntry> {
  if (isSampleMode()) {
    sample.undone.add(id);
    const e = sampleActivity().find((x) => x.id === id)!;
    return { ...e, state: "undone" };
  }
  return request(`/activity/${encodeURIComponent(id)}/undo`, { method: "POST" });
}

// ---------- tonight ----------

export async function fetchTonight(): Promise<{ free: boolean; picks: WatchPick[] }> {
  if (isSampleMode()) return { free: true, picks: samplePicks() };
  return request("/watch-tonight");
}
