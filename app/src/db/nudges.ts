/**
 * Nudges Athena starts (lib/proactive/, netlify/lib/proactive/routes.ts):
 * Home's cards, the one a push opens Ask on, "Fewer like this" and the
 * switches in Settings → Notifications. Sample mode has its own set
 * (db/sample-nudges.ts) and keeps every change on this page.
 */
import { isSampleMode, request } from "./api";
import { sampleNudges } from "./sample-nudges";
import { DEFAULT_PROACTIVE, mergeProactive, type ProactivePrefs } from "../../../lib/proactive/gate";
import type { Nudge, RuleId, TravelMode } from "../../../lib/proactive/types";

export type { Nudge, NudgeAction, RuleId, TravelMode } from "../../../lib/proactive/types";
export { DEFAULT_PROACTIVE, type ProactivePrefs };

export interface AppNudge extends Nudge {
  id: string;
  created_at: string;
  pushed_at: string | null;
  applied: number[];
}

/** Sample mode: what's been dismissed, muted or applied, for this visit only. */
const sample = { gone: new Set<string>(), muted: new Map<RuleId, string>(), applied: new Map<string, number[]>(), prefs: { ...DEFAULT_PROACTIVE, rules: { ...DEFAULT_PROACTIVE.rules }, travel_by_event: {} } as ProactivePrefs };
const withApplied = (n: AppNudge): AppNudge => ({ ...n, applied: sample.applied.get(n.id) ?? n.applied });

export async function fetchNudges(): Promise<AppNudge[]> {
  if (isSampleMode()) return sampleNudges({ drive: sample.prefs.travel_mode === "drive" }).filter((n) => !sample.gone.has(n.id) && !sample.muted.has(n.rule)).map(withApplied);
  return (await request<{ nudges: AppNudge[] }>("/nudges")).nudges;
}

export async function fetchNudge(id: string): Promise<AppNudge | null> {
  if (isSampleMode()) return sampleNudges({ drive: true }).find((n) => n.id === id) ?? null;
  return request<AppNudge>(`/nudges/${encodeURIComponent(id)}`).catch(() => null);
}

export async function dismissNudge(id: string): Promise<void> {
  if (isSampleMode()) return void sample.gone.add(id);
  await request(`/nudges/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
}

export async function markNudgeApplied(id: string, index: number, on = true, undo?: unknown): Promise<number[]> {
  if (isSampleMode()) {
    const now = new Set(sample.applied.get(id) ?? []);
    on ? now.add(index) : now.delete(index);
    sample.applied.set(id, [...now]);
    return [...now];
  }
  return (await request<{ applied: number[] }>(`/nudges/${encodeURIComponent(id)}/applied`, { method: "POST", body: JSON.stringify({ index, on, ...(undo ? { undo } : {}) }) })).applied;
}

/** "Fewer like this": the rule is quiet for 30 days. */
export async function muteRule(rule: RuleId): Promise<string> {
  if (isSampleMode()) {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    sample.muted.set(rule, until);
    return until;
  }
  return (await request<{ muted_until: string }>("/nudges/mute", { method: "POST", body: JSON.stringify({ rule }) })).muted_until;
}

export async function unmuteRule(rule: RuleId): Promise<void> {
  if (isSampleMode()) return void sample.muted.delete(rule);
  await request("/nudges/unmute", { method: "POST", body: JSON.stringify({ rule }) });
}

/** Is a TfL or Google Maps key set up for Leave by (Sources → Places and travel)? Yes or no only. */
export interface JourneyPlanners {
  tfl: boolean;
  google: boolean;
}

export async function fetchProactive(): Promise<{ prefs: ProactivePrefs; mutes: Partial<Record<RuleId, string>>; planners?: JourneyPlanners }> {
  // Sample data has no journey planner, so Leave by says how to add one.
  if (isSampleMode()) return { prefs: sample.prefs, mutes: Object.fromEntries(sample.muted), planners: { tfl: false, google: false } };
  return request("/nudges/prefs");
}

export type ProactivePatch = { rules?: Partial<Record<RuleId, boolean>>; cap?: number; reply_days?: number; travel_mode?: TravelMode; travel_by_event?: Record<string, TravelMode | null> };

export async function saveProactive(patch: ProactivePatch): Promise<ProactivePrefs> {
  if (isSampleMode()) {
    sample.prefs = mergeProactive(sample.prefs, patch);
    return sample.prefs;
  }
  return request<ProactivePrefs>("/nudges/prefs", { method: "PUT", body: JSON.stringify(patch) });
}
