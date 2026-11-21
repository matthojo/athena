/**
 * Flows, for the app: the API client for netlify/lib/flow-routes.ts and its
 * siblings (lib/flow-types.ts lists the routes). Sample mode keeps its own
 * flows (db/sample-flows.ts) and every change stays on this page.
 *
 * Like Team, Flows needs the server: nothing here is kept offline.
 */
import { isSampleMode, request } from "./api";
import { sampleCatalog, sampleFlows, sampleRunFrom, type SampleFlows } from "./sample-flows";
import { triggerGives } from "../../../lib/flow-trigger-gives";
import { SAMPLE_TEAM_IDS } from "./sample-team";
import { listTeam } from "./team";
import { FLOW_LIMITS, type CatalogEntry, type Flow, type FlowDraft, type FlowInput, type FlowListResponse, type FlowRun, type FlowSuggestion } from "../../../lib/flow-types";

export type { CatalogEntry, Flow, FlowDraft, FlowInput, FlowListResponse, FlowRun, FlowSuggestion };

const listeners = new Set<() => void>();
/** A flow or a run changed: the list, the editor and an assistant's page follow. */
export function onFlowsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());
/** One of an assistant's triggers, made a flow (lib/team-flows.ts): it counts toward the assistant's triggers, not FLOW_LIMITS.flows. */
export const isJobFlow = (f: Pick<Flow, "assistant_id" | "origin">): boolean => !!f.assistant_id && (f.origin === "trigger" || f.origin === "shared");
/** Something outside Flows changed flows: an assistant's triggers are its flows (lib/team-flows.ts), so saving them does. */
export const flowsChanged = (): void => changed();

// ---------- sample mode ----------

let sample: SampleFlows | null = null;
const store = () => (sample ??= sampleFlows());
const sampleFlow = (id: string) => store().flows.find((f) => f.id === id) ?? null;
const notThere = () => Object.assign(new Error("That flow isn't there any more"), { status: 404 });

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `f10e0000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`);

function latestOf(flowId: string): FlowRun | undefined {
  return store()
    .runs.filter((r) => r.run.flow_id === flowId)
    .sort((a, b) => b.run.started_at.localeCompare(a.run.started_at))[0]?.run;
}

function sampleApply(f: Flow, input: FlowInput): Flow {
  const next: Flow = {
    ...f,
    ...(input.name !== undefined && { name: input.name.trim().slice(0, FLOW_LIMITS.name) || f.name }),
    ...(input.trigger && { trigger: input.trigger, trigger_gives: triggerGives(input.trigger) }),
    ...(input.steps && { steps: structuredClone(input.steps) }),
    ...(input.money !== undefined && { money: input.money }),
    ...(input.paused !== undefined && { paused: input.paused }),
    updated_at: new Date().toISOString(),
  };
  return next;
}

// ---------- flows ----------

export async function listFlows(): Promise<FlowListResponse> {
  if (isSampleMode()) {
    const s = store();
    const latest: Record<string, FlowRun> = {};
    for (const f of s.flows) {
      const r = latestOf(f.id);
      if (r) latest[f.id] = structuredClone(r);
    }
    return { flows: structuredClone(s.flows), latest, max: FLOW_LIMITS.flows };
  }
  return request<FlowListResponse>("/flows");
}

export async function getFlow(id: string): Promise<{ flow: Flow; runs: FlowRun[] } | null> {
  if (isSampleMode()) {
    const f = sampleFlow(id);
    if (!f) return null;
    const runs = store()
      .runs.filter((r) => r.run.flow_id === id)
      .map((r) => structuredClone(r.run))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
    return { flow: structuredClone(f), runs };
  }
  try {
    return await request<{ flow: Flow; runs: FlowRun[] }>(`/flows/${encodeURIComponent(id)}`);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export async function createFlow(input: FlowInput): Promise<Flow> {
  let made: Flow;
  if (isSampleMode()) {
    const s = store();
    if (s.flows.filter((f) => !isJobFlow(f)).length >= FLOW_LIMITS.flows) throw new Error(`You have ${FLOW_LIMITS.flows} flows, which is the most Athena keeps. Delete one first.`);
    const now = new Date().toISOString();
    const trigger = input.trigger ?? { kind: "manual" };
    made = sampleApply(
      { id: uuid(), name: "New flow", trigger, trigger_gives: triggerGives(trigger), steps: [], assistant_id: null, handed_at: null, money: false, paused: true, origin: input.origin ?? "owner", last_run_at: null, created_at: now, updated_at: now },
      input
    );
    s.flows.push(made);
    s.values[made.id] = {};
    made = structuredClone(made);
  } else {
    made = (await request<{ flow: Flow }>("/flows", { method: "POST", body: JSON.stringify(input) })).flow;
  }
  changed();
  return made;
}

export async function updateFlow(id: string, input: FlowInput): Promise<Flow> {
  let next: Flow;
  if (isSampleMode()) {
    const s = store();
    const i = s.flows.findIndex((f) => f.id === id);
    if (i < 0) throw notThere();
    s.flows[i] = sampleApply(s.flows[i], input);
    next = structuredClone(s.flows[i]);
  } else {
    next = (await request<{ flow: Flow }>(`/flows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })).flow;
  }
  changed();
  return next;
}

export async function deleteFlow(id: string): Promise<void> {
  if (isSampleMode()) {
    const s = store();
    s.flows = s.flows.filter((f) => f.id !== id);
    s.runs = s.runs.filter((r) => r.run.flow_id !== id);
  } else await request<{ ok: true }>(`/flows/${encodeURIComponent(id)}`, { method: "DELETE" });
  changed();
}

/** Hand a flow to an assistant ("new": Athena makes one for it). */
export async function handFlow(id: string, assistantId: string | "new"): Promise<Flow> {
  let next: Flow;
  if (isSampleMode()) {
    const f = sampleFlow(id);
    if (!f) throw notThere();
    let to = assistantId;
    if (to === "new") {
      // Sample mode has no one to make: the new assistant is played by whoever's free.
      const team = await listTeam();
      to = team.find((a) => !store().flows.some((x) => x.assistant_id === a.id))?.id ?? team[0]?.id ?? SAMPLE_TEAM_IDS.penny;
    }
    f.assistant_id = to;
    f.handed_at = new Date().toISOString();
    f.updated_at = f.handed_at;
    next = structuredClone(f);
  } else {
    next = (await request<{ flow: Flow }>(`/flows/${encodeURIComponent(id)}/hand`, { method: "POST", body: JSON.stringify({ assistant_id: assistantId }) })).flow;
  }
  changed();
  return next;
}

/** Take a flow back from its assistant: a plain flow again. Its thinking steps go, as the server drops them. */
export async function takeBack(id: string): Promise<Flow> {
  let next: Flow;
  if (isSampleMode()) {
    const f = sampleFlow(id);
    if (!f) throw notThere();
    f.assistant_id = null;
    f.handed_at = null;
    f.updated_at = new Date().toISOString();
    next = structuredClone(f);
  } else {
    next = (await request<{ flow: Flow }>(`/flows/${encodeURIComponent(id)}/take-back`, { method: "POST" })).flow;
  }
  changed();
  return next;
}

// ---------- runs ----------

/** Run now, or a try on the last thing that matched (`dry`: nothing is changed). */
export async function runFlow(id: string, dry: boolean): Promise<FlowRun> {
  let run: FlowRun;
  if (isSampleMode()) {
    const s = store();
    const f = sampleFlow(id);
    if (!f) throw notThere();
    const last = latestOf(id);
    const state = sampleRunFrom(s, f, { label: dry ? (last?.label ?? "A try") : "Run now", at: Date.now(), decisions: {}, dry });
    s.runs.push(state);
    if (!dry) f.last_run_at = state.run.started_at;
    run = structuredClone(state.run);
  } else {
    run = (await request<{ run: FlowRun }>(`/flows/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify({ dry }) })).run;
  }
  changed();
  return run;
}

export async function getRun(runId: string): Promise<FlowRun | null> {
  if (isSampleMode()) {
    const r = store().runs.find((x) => x.run.id === runId);
    return r ? structuredClone(r.run) : null;
  }
  try {
    return (await request<{ run: FlowRun }>(`/flows/runs/${encodeURIComponent(runId)}`)).run;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** Sample mode: record a decision on a run and walk it on from there. */
function sampleDecide(runId: string, stepId: string, decision: "go" | "skip" | number | "stop"): FlowRun {
  const s = store();
  const i = s.runs.findIndex((x) => x.run.id === runId);
  if (i < 0) throw notThere();
  const state = s.runs[i];
  if (decision === "stop") {
    state.run = { ...state.run, status: "stopped", waits_for: null, finished_at: new Date().toISOString() };
    return structuredClone(state.run);
  }
  const f = sampleFlow(state.run.flow_id);
  if (!f) throw notThere();
  const decisions = { ...state.decisions, [stepId]: decision };
  const next = sampleRunFrom(s, f, { id: state.run.id, label: state.run.label, at: Date.parse(state.run.started_at), decisions, dry: state.run.dry, check: state.check });
  s.runs[i] = next;
  return structuredClone(next.run);
}

async function decide(runId: string, path: "answer" | "go" | "skip" | "stop", body: object, sampleStep: string, decision: "go" | "skip" | number | "stop"): Promise<FlowRun> {
  const run = isSampleMode() ? sampleDecide(runId, sampleStep, decision) : (await request<{ run: FlowRun }>(`/flows/runs/${encodeURIComponent(runId)}/${path}`, { method: "POST", body: JSON.stringify(body) })).run;
  changed();
  return run;
}

export const answerRun = (runId: string, stepId: string, choice: number) => decide(runId, "answer", { step_id: stepId, choice }, stepId, choice);
export const goRun = (runId: string, stepId: string) => decide(runId, "go", { step_id: stepId }, stepId, "go");
export const skipRun = (runId: string, stepId: string) => decide(runId, "skip", { step_id: stepId }, stepId, "skip");
export const stopRun = (runId: string) => decide(runId, "stop", {}, "", "stop");

// ---------- the catalogue, drafts and suggestions ----------

let catalog: Promise<CatalogEntry[]> | null = null;

/** What the Add a step sheet offers. Asked for once a visit. */
export function loadCatalog(): Promise<CatalogEntry[]> {
  if (isSampleMode()) return Promise.resolve(sampleCatalog());
  catalog ??= request<{ entries: CatalogEntry[] }>("/flows/catalog")
    .then((r) => r.entries)
    .catch((e) => {
      catalog = null;
      throw e;
    });
  return catalog;
}

/** Athena draws a flow from one sentence. Nothing is saved. */
export async function draftFlow(sentence: string): Promise<FlowDraft> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 900));
    return sampleDraft(sentence);
  }
  return (await request<{ draft: FlowDraft }>("/flows/draft", { method: "POST", body: JSON.stringify({ sentence }) })).draft;
}

/** Sample mode's drawing: Renewal guard's shape for a renewal, the delivery suggestion for a parcel, else a blank flow. */
function sampleDraft(sentence: string): FlowDraft {
  const s = sentence.toLowerCase();
  const renewal = store().flows.find((f) => f.name === "Renewal guard");
  if (/renew/.test(s) && renewal) return { flow: { name: "Renewal check", trigger: renewal.trigger, steps: structuredClone(renewal.steps), money: true }, notes: [] };
  const sug = store().suggestions.find((x) => x.id === "sug-delivery");
  if (/deliver|parcel/.test(s) && sug) return { flow: structuredClone(sug.flow), notes: ["I couldn't tell when you wanted the reminder, so it's on the morning of the delivery."] };
  const name = sentence.trim().replace(/[.?!]+$/, "").slice(0, FLOW_LIMITS.name) || "New flow";
  return { flow: { name: name.charAt(0).toUpperCase() + name.slice(1), trigger: { kind: "manual" }, steps: [] }, notes: ["Sample mode only draws a couple of flows. Add the steps yourself."], fallback: true };
}

export async function listSuggestions(): Promise<FlowSuggestion[]> {
  if (isSampleMode()) return structuredClone(store().suggestions);
  return (await request<{ suggestions: FlowSuggestion[] }>("/flows/suggestions")).suggestions;
}

export async function dismissSuggestion(id: string): Promise<void> {
  if (isSampleMode()) {
    const s = store();
    s.suggestions = s.suggestions.filter((x) => x.id !== id);
    return;
  }
  await request<{ ok: true }>(`/flows/suggestions/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
}

/** For tests: start sample mode over. */
export function resetSampleFlows(): void {
  sample = null;
}
