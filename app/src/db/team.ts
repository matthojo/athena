/**
 * Team, for the app (docs/team.md; lib/team.ts and netlify/lib/team-routes.ts
 * on the server). Sample mode keeps its own team (db/sample-team.ts) and
 * every change stays on this page.
 */
import { isSampleMode, request } from "./api";
import { sampleQuestions, sampleRuns, sampleTeam } from "./sample-team";
import { sampleRunHistory, sampleRunNowSummary, sampleRunStep, sampleRunThreadId, seedSampleThreads } from "./sample-team-detail";
import { sampleSkillFrom, sampleSkillList, setSampleSkills, type AppSkill } from "./skills";
import { sampleLimits, sampleRunPlans } from "./sample-ask-plans";
import { SAMPLE_ACCOUNTS } from "./item-accounts";
import type { AskPlan } from "../types";
import { assistantSkillDescription, assistantSkillName, fitAnswers, hashText, skillBasis, skillEdited, skillGist, skillStale, templateSkill, type TeamAnswer, type TeamQuestion, type TeamSkillDraft } from "../../../lib/team-skill";
import { serialiseSkillMd } from "../../../lib/skills";
import { avatarFromSeed, nameFromSeed, newSeed, personalityFromSeed } from "../../../lib/team-seed";
import { MAX_ASSISTANTS, type TeamQuestionsResponse, type TeamSkillInfo, type TeamSkillPreviewResponse, type TeamSkillView, type AssistantMemory, type TeamAssistant, type TeamAssistantInput, type TeamDraft, type TeamDraftResponse, type TeamActivityResponse, type TeamListResponse, type TeamMemoryResponse, type TeamRun, type TeamRunResponse, type TeamRunsResponse, type TeamTrigger, type TeamTriggerInput, type TeamWeekday } from "../../../lib/team-types";

export type { AssistantMemory, TeamAnswer, TeamAssistant, TeamAssistantInput, TeamDraft, TeamQuestion, TeamRun, TeamSkillInfo, TeamSkillView, TeamTrigger, TeamTriggerInput };

const listeners = new Set<() => void>();
/** Something changed an assistant (made, edited, removed, ran): the Team page and Home's chips follow. */
export function onTeamChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

// ---------- sample mode ----------

const sample = { team: null as TeamAssistant[] | null, runs: [] as TeamRun[] };

/** A Run now in sample mode: queued, then working, then done a few seconds later, as a real run would go. */
function sampleRunNow(r: TeamRun): TeamRun {
  const age = Date.now() - Date.parse(r.started_at);
  if (age < 1500) return { ...r, step: "Getting started" };
  if (age < 6500) return { ...r, status: "running", step: sampleRunStep(r.assistant_id, age - 1500, sampleWeb(r.assistant_id)) };
  if (r.status !== "done") {
    r.status = "done";
    r.summary = sampleRunNowSummary(r.assistant_id);
    r.thread_id = sampleRunThreadId(r.id);
    r.waiting = 0;
    r.finished_at = new Date(Date.parse(r.started_at) + 6500).toISOString();
    const a = sampleList().find((x) => x.id === r.assistant_id);
    if (a) a.last_run_at = r.finished_at;
    // An imported one (Dot from the sample link) leaves a plan whose Go needs Gmail: its Go asks when Gmail isn't ticked for it.
    if (a?.imported) {
      const plan: AskPlan = {
        id: uuid(),
        source: "routine",
        proposed: true,
        steps: [
          { label: "Add a to-do: Review the export spec", tool: "add_todo" },
          { label: "Draft a reply to Priya about the export spec", tool: "draft_message" },
        ],
      };
      sampleRunPlans.set(r.id, plan);
      sampleLimits.set(plan.id, {
        assistant: () => {
          const now = sampleList().find((x) => x.id === r.assistant_id);
          return now ? { name: now.name, accounts: [...(now.accounts ?? [])] } : null;
        },
        tick: (accountId) => {
          const now = sampleList().find((x) => x.id === r.assistant_id);
          if (now && !(now.accounts ?? []).includes(accountId)) now.accounts = [...(now.accounts ?? []), accountId];
          changed();
        },
        accounts: SAMPLE_ACCOUNTS,
      });
      r.summary = "One issue came in. I've left a to-do and a reply to Priya for your approval.";
      r.waiting = plan.steps.length;
    }
  }
  return r;
}
const sampleList = () => (sample.team ??= sampleTeam());
/** Whether a sample assistant may look things up online (`web`, docs/team.md "Looking things up online"). */
const sampleWeb = (id: string) => (sampleList().find((a) => a.id === id) as { web?: boolean } | undefined)?.web === true;

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `5a3e0000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`);

/** A trigger as the app sent it, filled in the way the server would (lenient: sample mode only). */
function sampleTrigger(assistantId: string, t: TeamTriggerInput, was?: TeamTrigger): TeamTrigger {
  const days = Array.isArray(t.days) ? (t.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) as TeamWeekday[]) : [];
  return {
    id: was?.id ?? uuid(),
    assistant_id: assistantId,
    kind: t.kind,
    days: t.kind === "schedule" ? days : [],
    time: t.kind === "schedule" ? (t.time ?? "09:00") : null,
    event: t.kind === "event" ? (t.event ?? null) : null,
    paused: t.paused === true,
    last_slot: was?.last_slot ?? null,
    last_fired_at: was?.last_fired_at ?? null,
    created_at: was?.created_at ?? new Date().toISOString(),
  };
}

function sampleApply(a: TeamAssistant, input: TeamAssistantInput): TeamAssistant {
  const next: TeamAssistant = {
    ...a,
    ...(input.name !== undefined && { name: input.name.trim() || a.name }),
    ...(input.job !== undefined && { job: input.job.trim() || a.job }),
    ...(input.instructions !== undefined && { instructions: input.instructions }),
    ...(input.personality && { personality: input.personality }),
    ...(input.avatar && { avatar: input.avatar }),
    ...(input.allow && { allow: [...new Set(input.allow)] }),
    ...(input.accounts && { accounts: [...new Set(input.accounts)] }),
    ...(input.paused !== undefined && { paused: input.paused }),
    // The contract's `web` (team/web-access.ts), until lib/team-types.ts has it.
    ...((input as { web?: boolean }).web !== undefined && { web: (input as { web?: boolean }).web === true }),
    updated_at: new Date().toISOString(),
  };
  if (input.triggers) next.triggers = input.triggers.map((t) => sampleTrigger(a.id, t, a.triggers.find((x) => x.id === t.id)));
  return next;
}

// ---------- the API ----------

export async function listTeam(): Promise<TeamAssistant[]> {
  if (isSampleMode()) return structuredClone(sampleList());
  return (await request<TeamListResponse>("/team")).assistants;
}

export async function getAssistant(id: string): Promise<TeamAssistant | null> {
  if (isSampleMode()) return structuredClone(sampleList().find((a) => a.id === id) ?? null);
  try {
    return await request<TeamAssistant>(`/team/${encodeURIComponent(id)}`);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** Add an assistant. `answers` (setup's questions) go to the server, which writes its skill after it's added. */
export async function createAssistant(input: TeamAssistantInput & { answers?: TeamAnswer[] }, opts: { sampleSkill?: boolean; imported?: boolean; needs?: string[] } = {}): Promise<TeamAssistant> {
  let made: TeamAssistant;
  if (isSampleMode()) {
    const list = sampleList();
    if (list.length >= MAX_ASSISTANTS) throw new Error(`You have ${MAX_ASSISTANTS} assistants, which is the most a team can have. Remove one first.`);
    const seed = input.avatar?.seed ?? newSeed();
    const now = new Date().toISOString();
    const base: TeamAssistant = {
      id: uuid(),
      name: nameFromSeed(seed, list.map((a) => a.name)),
      job: "",
      instructions: "",
      personality: personalityFromSeed(seed),
      avatar: avatarFromSeed(seed),
      allow: [],
      paused: false,
      routine_id: null,
      memory: { summary: "", facts: [] },
      memory_updated_at: null,
      last_run_at: null,
      triggers: [],
      created_at: now,
      updated_at: now,
      ...{ web: false },
      ...(opts.imported ? { imported: true, accounts: [], needs: [...(opts.needs ?? [])] } : {}),
    };
    const { answers, ...rest } = input;
    made = sampleApply(base, rest);
    list.push(made);
    made = structuredClone(made);
    // As the server does, a moment later: the skill attaches when it's written.
    // An added shared brings its own (sampleKeepImportedSkill): `sampleSkill: false`.
    const forMade = made;
    if (opts.sampleSkill !== false) setTimeout(() => sampleWriteSkill(forMade, fitAnswers(answers)), 2500);
  } else {
    made = await request<TeamAssistant>("/team", { method: "POST", body: JSON.stringify(input) });
  }
  changed();
  return made;
}

export async function updateAssistant(id: string, patch: TeamAssistantInput): Promise<TeamAssistant> {
  let next: TeamAssistant;
  if (isSampleMode()) {
    const list = sampleList();
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) throw new Error("That assistant isn't there any more");
    list[i] = sampleApply(list[i], patch);
    next = structuredClone(list[i]);
  } else {
    next = await request<TeamAssistant>(`/team/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }
  changed();
  return next;
}

export async function deleteAssistant(id: string): Promise<void> {
  if (isSampleMode()) {
    sample.team = sampleList().filter((a) => a.id !== id);
    if (sampleSkillList().some((s) => s.assistant_id === id)) setSampleSkills(sampleSkillList().filter((s) => s.assistant_id !== id));
  }
  else await request<{ ok: true }>(`/team/${encodeURIComponent(id)}`, { method: "DELETE" });
  changed();
}

/** Setup's first step: a proposed name, job, instructions, triggers, allowlist and seed from one sentence. */
export async function draftAssistant(text: string): Promise<TeamDraft> {
  if (isSampleMode()) {
    const seed = newSeed();
    const job = text.replace(/\s+/g, " ").trim().slice(0, 140);
    const weekly = /\bevery\b/i.test(job);
    // As the server does: a job that needs something online (prices, here) comes back with `web: true`.
    const web = /\b(price|prices|deal|deals|cheap|cheaper|cheapest|discount|sale|bargain|in stock)\b/i.test(job);
    const draft: TeamDraft & { web: boolean } = { name: nameFromSeed(seed, sampleList().map((a) => a.name)), job, instructions: job, triggers: weekly ? [{ kind: "schedule", days: [5], time: "17:00" }] : [], allow: [], seed, web };
    return draft;
  }
  return (await request<TeamDraftResponse>("/team/draft", { method: "POST", body: JSON.stringify({ text }) })).draft;
}

/** Its recent runs, newest first. */
export async function listRuns(id: string): Promise<TeamRun[]> {
  if (isSampleMode()) {
    const runs = [...sample.runs.filter((r) => r.assistant_id === id).map(sampleRunNow).reverse(), ...sampleRunHistory(id)].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    // Each run's conversation is on the device before anything opens or counts it.
    await seedSampleThreads(runs);
    return runs.map((r) => structuredClone(r));
  }
  return (await request<TeamRunsResponse>(`/team/${encodeURIComponent(id)}/runs`)).runs;
}

/** The whole team's recent runs, newest first, with any still queued or working: what the team has been doing. */
export async function listActivity(limit = 30): Promise<TeamRun[]> {
  if (isSampleMode()) {
    const team = sample.team ?? sampleTeam();
    const live = sample.runs.map(sampleRunNow);
    const past = team.flatMap((a) => sampleRuns(a.id));
    const on = new Set(team.map((a) => a.id));
    const runs = [...live, ...past]
      .filter((r) => on.has(r.assistant_id))
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, limit);
    await seedSampleThreads(runs);
    return runs.map((r) => structuredClone(r));
  }
  return (await request<TeamActivityResponse>(`/team/activity?limit=${limit}`)).runs;
}

/** Run it now, outside its triggers. The run comes back queued. */
export async function runNow(id: string): Promise<TeamRun> {
  let run: TeamRun;
  if (isSampleMode()) {
    const now = new Date().toISOString();
    run = { id: uuid(), assistant_id: id, trigger_id: null, event_id: null, status: "queued", thread_id: null, summary: null, error: null, started_at: now, finished_at: null, label: "Run now", step: "Getting started" };
    sample.runs.push(structuredClone(run));
  } else {
    run = (await request<TeamRunResponse>(`/team/${encodeURIComponent(id)}/run`, { method: "POST" })).run;
  }
  changed();
  return run;
}

/** Forget one fact (by its index), or everything it remembers when no fact is given. */
export async function forgetMemory(id: string, fact?: number): Promise<AssistantMemory> {
  let memory: AssistantMemory;
  if (isSampleMode()) {
    const a = sampleList().find((x) => x.id === id);
    if (!a) throw new Error("That assistant isn't there any more");
    a.memory = fact === undefined ? { summary: "", facts: [] } : { ...a.memory, facts: a.memory.facts.filter((_, i) => i !== fact) };
    memory = structuredClone(a.memory);
  } else {
    const qs = fact === undefined ? "" : `?fact=${fact}`;
    memory = (await request<TeamMemoryResponse>(`/team/${encodeURIComponent(id)}/memory${qs}`, { method: "DELETE" })).memory;
  }
  changed();
  return memory;
}

// ---------- its own skill (docs/team.md, "Skills") ----------

/** Setup's questions for this job: 2–4, or none when Athena can't think of any (setup then skips the step). */
export async function teamQuestions(text: string, draft?: { job?: string; instructions?: string }): Promise<TeamQuestion[]> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 600));
    return sampleQuestions(`${text} ${draft?.job ?? ""}`);
  }
  return (await request<TeamQuestionsResponse>("/team/questions", { method: "POST", body: JSON.stringify({ text, ...(draft ? { draft } : {}) }) })).questions;
}

const sampleOwn = (id: string): AppSkill | undefined => sampleSkillList().find((s) => s.assistant_id === id);

function sampleView(s: AppSkill): TeamSkillView {
  return { id: s.id, name: s.name, description: s.description, body: s.body, summary: s.team?.summary ?? "", gist: skillGist(s.body), answers: s.team?.answers ?? [], updated_at: s.updated_at };
}

function sampleInfo(a: TeamAssistant): TeamSkillInfo {
  const s = sampleOwn(a.id);
  return s ? { skill: sampleView(s), stale: skillStale(s.team, a), edited: skillEdited(s.team, s.body) } : { skill: null, stale: false, edited: false };
}

/** Sample mode: write and keep a skill the way the server does (its plain skill), replacing the one there. */
function sampleWriteSkill(a: TeamAssistant, answers: TeamAnswer[], draft?: TeamSkillDraft): void {
  if (!sampleList().some((x) => x.id === a.id)) return;
  const d = draft ?? templateSkill(a, answers);
  const was = sampleOwn(a.id);
  const now = new Date().toISOString();
  const doc = { name: was?.name ?? assistantSkillName(a.name, a.job), description: assistantSkillDescription(a.name, a.job), body: d.body, extra: "" };
  const next = sampleSkillFrom(was?.id ?? uuid(), serialiseSkillMd(doc), { assistant_id: a.id, team: { basis: skillBasis(a), made: hashText(d.body.trim()), summary: d.summary, answers }, source: { kind: "team", at: was?.source.at ?? now }, created_at: was?.created_at ?? now, updated_at: now });
  setSampleSkills([...sampleSkillList().filter((s) => s.id !== next.id), next]);
  changed();
}

/** Its own skill, whether the job has moved on since it was written, and whether you've edited it. */
export async function getAssistantSkill(id: string): Promise<TeamSkillInfo> {
  if (isSampleMode()) {
    const a = sampleList().find((x) => x.id === id);
    return a ? sampleInfo(a) : { skill: null, stale: false, edited: false };
  }
  return request<TeamSkillInfo>(`/team/${encodeURIComponent(id)}/skill`);
}

/** "Give <Name> a skill": Athena writes it now from the job, the instructions and these answers. */
export async function giveSkill(id: string, answers: TeamAnswer[]): Promise<TeamSkillInfo> {
  let info: TeamSkillInfo;
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 1200));
    const a = sampleList().find((x) => x.id === id);
    if (!a) throw new Error("That assistant isn't there any more");
    sampleWriteSkill(a, answers);
    info = sampleInfo(a);
  } else info = await request<TeamSkillInfo>(`/team/${encodeURIComponent(id)}/skill`, { method: "POST", body: JSON.stringify({ answers }) });
  changed();
  return info;
}

/** What Athena would write now, for the update offer. Nothing is saved. */
export async function previewSkillUpdate(id: string): Promise<TeamSkillPreviewResponse["preview"]> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 900));
    const a = sampleList().find((x) => x.id === id);
    if (!a) throw new Error("That assistant isn't there any more");
    const d = templateSkill(a, sampleOwn(id)?.team?.answers ?? []);
    return { name: d.name, description: d.description, body: d.body, summary: d.summary, gist: skillGist(d.body) };
  }
  return (await request<TeamSkillPreviewResponse>(`/team/${encodeURIComponent(id)}/skill`, { method: "POST", body: JSON.stringify({ preview: true }) })).preview;
}

/** Accept the update: the skill becomes the preview. Your own edits to it go. */
export async function acceptSkillUpdate(id: string, preview: TeamSkillPreviewResponse["preview"]): Promise<TeamSkillInfo> {
  let info: TeamSkillInfo;
  if (isSampleMode()) {
    const a = sampleList().find((x) => x.id === id);
    if (!a) throw new Error("That assistant isn't there any more");
    sampleWriteSkill(a, sampleOwn(id)?.team?.answers ?? [], { ...preview, extra: "" });
    info = sampleInfo(a);
  } else info = await request<TeamSkillInfo>(`/team/${encodeURIComponent(id)}/skill`, { method: "PUT", body: JSON.stringify(preview) });
  changed();
  return info;
}

/** Keep the skill as it is: no more offer until the job or instructions change again. */
export async function keepSkill(id: string): Promise<TeamSkillInfo> {
  if (isSampleMode()) {
    const a = sampleList().find((x) => x.id === id);
    const s = sampleOwn(id);
    if (!a || !s?.team) return { skill: null, stale: false, edited: false };
    setSampleSkills(sampleSkillList().map((x) => (x.id === s.id ? { ...s, team: { ...s.team!, basis: skillBasis(a) } } : x)));
    return sampleInfo(a);
  }
  return request<TeamSkillInfo>(`/team/${encodeURIComponent(id)}/skill`, { method: "POST", body: JSON.stringify({ keep: true }) });
}

/** Sample mode: an imported assistant's own skill, kept as the server keeps it, with the owner's answers worked in (db/team-share.ts). */
export function sampleKeepImportedSkill(a: TeamAssistant, body: string, answers: TeamAnswer[], summary: string): void {
  sampleWriteSkill(a, answers, { name: "", description: "", body, extra: "", summary });
}

/** Something outside this module added an assistant (an added shared, db/team-share.ts): pages look again. */
export function teamChanged(): void {
  changed();
}
