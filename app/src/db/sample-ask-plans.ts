/**
 * Sample mode's plans, What Ask did and tonight's picks: made up
 * around the sample people, worked out from now so they always read as
 * current. Nothing here reaches a server.
 */
import type { AskPlan, AssistantChange, WatchPick } from "../types";
import type { ActivityEntry } from "./ask-plans";
import { SAMPLE_IDS } from "./sample-data";
import { SAMPLE_EVENT_ID } from "./scheduling";
import { SAMPLE_FLOW_IDS, SAMPLE_RUN_IDS } from "./sample-flows";
import { SAMPLE_ACCOUNTS } from "./item-accounts";
import { sampleSkillList } from "./skills";

const id = (n: number) => `5a3e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const SAMPLE_PLAN_REQUEST = /\b(move|draft|add|remind|book|reply|put)\b.*\b(and|then)\b.*\b(move|draft|add|remind|book|reply|put|to-?do)\b/i;
export const SAMPLE_ROUTINE_REQUEST = /\bevery (day|morning|evening|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/i;

/** "Move the 3pm to Thursday, draft a reply to Sam and add a to-do: book the venue": the sample's three-step plan. */
export function samplePlan(): AskPlan {
  return {
    id: id(990001),
    source: "ask",
    steps: [
      { label: "Move the 3pm design review to Thursday at 14:00", tool: "move_event" },
      { label: "Draft a reply to Marcus about the launch slides", tool: "draft_message" },
      { label: "Add a to-do: book the team offsite venue", tool: "add_todo" },
    ],
  };
}

const RECEIPTS: AssistantChange[] = [
  { kind: "event", id: SAMPLE_EVENT_ID, action: "updated", title: "Design review", detail: "Moved to Thu, 14:00 · Google Calendar", label: "Design review: Moved to Thu, 14:00", open: null, undo: { op: "sample" } },
  { kind: "draft", id: id(990011), action: "created", title: "Reply to Marcus", detail: "Draft · Re: launch slides", label: "Reply to Marcus: Draft", open: null, undo: null },
  { kind: "commitment", id: id(990012), action: "created", title: "Book the team offsite venue", detail: "To do · no date", label: "Book the team offsite venue: To do", open: null, undo: { op: "sample" } },
];

type StepResult = NonNullable<AskPlan["ran"]>["results"][number];

/** One ticked step "run" in sample mode: its receipt. */
function sampleStep(plan: AskPlan, i: number): StepResult {
  // A Team run's plan (no routine of its own) gets a receipt for its own step, not the sample plan's.
  const c = plan.source === "routine" || sampleLimits.get(plan.id)?.skill ? { ...RECEIPTS[2], id: id(990030 + i), title: plan.steps[i].label.replace(/^Add a to-do:\s*/i, ""), detail: "To do", label: plan.steps[i].label } : (RECEIPTS[i] ?? { ...RECEIPTS[2], id: id(990020 + i), title: plan.steps[i].label });
  if (plan.steps[i].tool === "draft_message") {
    const what = plan.steps[i].label.replace(/^Draft (?:a |an )?/i, "");
    const title = what.charAt(0).toUpperCase() + what.slice(1);
    Object.assign(c, { ...RECEIPTS[1], id: id(990040 + i), title, detail: "Draft", label: `${title}: Draft` });
  }
  return { status: "done", changes: [{ ...c, activity_id: id(991000 + i) }] };
}

/**
 * Plans an imported sample assistant proposed (its Run now): Go keeps to the accounts ticked for it, as the server
 * does (lib/ask-plans.ts goPlan). team.ts registers each with a way to read and tick its assistant.
 */
export interface SampleLimit {
  /** Who holds it now: an imported assistant, or an imported skill (`skill`). Null once it isn't imported. */
  assistant: () => { name: string; accounts: string[] } | null;
  /** An imported skill in use when the plan was made: no Always, and the card links to its page. */
  skill?: { id: string };
  tick: (accountId: string) => void;
  accounts: ReadonlyArray<{ id: string; provider: string; name: string; label?: string | null }>;
}
export const sampleLimits = new Map<string, SampleLimit>();
/** An imported sample assistant's Run now leaves a plan in its run's conversation (sample-team-detail.ts sampleRunThread). */
export const sampleRunPlans = new Map<string, AskPlan>();
/** Where a stopped sample Go is: the ticks, the steps so far, and this Go's one-time allowance. */
const paused = new Map<string, { ticked: number[]; results: StepResult[]; once: string[] }>();
/** The account a sample step reaches. */
const STEP_ACCOUNT: Record<string, string> = { draft_message: "gmail", move_event: "google-calendar" };

function sampleRun(plan: AskPlan, ticked: number[], results: StepResult[], once: string[]): { plan: AskPlan; changes: AssistantChange[] } {
  const limit = sampleLimits.get(plan.id);
  const from = results.length;
  for (let i = from; i < plan.steps.length; i++) {
    if (!ticked.includes(i)) {
      results.push({ status: "skipped", changes: [] });
      continue;
    }
    const provider = STEP_ACCOUNT[plan.steps[i].tool];
    const a = limit?.assistant();
    const acct = provider ? limit?.accounts.find((x) => x.provider === provider) : undefined;
    if (limit && a && acct && ![...a.accounts, ...once].includes(acct.id)) {
      paused.set(plan.id, { ticked, results, once });
      const { ran: _ran, ...rest } = plan;
      const skill = limit.skill ? { skill: { id: limit.skill.id, title: a.name } } : {};
      return { plan: { ...rest, needs_account: { step: i, account: acct.name, label: acct.label ?? null, provider, assistant: a.name, ...skill, results: [...results] } }, changes: results.slice(from).flatMap((r) => r.changes) };
    }
    results.push(sampleStep(plan, i));
  }
  paused.delete(plan.id);
  const { needs_account: _ask, ...rest } = plan;
  return { plan: { ...rest, ran: { at: new Date().toISOString(), results } }, changes: results.slice(from).flatMap((r) => r.changes) };
}

/** Go in sample mode: every ticked step "runs", unticked ones are skipped; an imported assistant's stops to ask. */
export function sampleGo(plan: AskPlan, ticked: number[]): { plan: AskPlan; changes: AssistantChange[] } {
  if (plan.needs_account) return { plan, changes: [] };
  return sampleRun(plan, ticked, [], []);
}

/** The owner's answer to a stopped sample Go: as the server does it, nothing leaves the page. */
export function sampleAnswerAccount(plan: AskPlan, answer: "once" | "always" | "skip"): { plan: AskPlan; changes: AssistantChange[] } {
  const ask = plan.needs_account;
  const at = paused.get(plan.id);
  if (!ask || !at) return { plan, changes: [] };
  const acct = sampleLimits.get(plan.id)?.accounts.find((x) => x.provider === ask.provider);
  const results = [...at.results];
  const once = [...at.once];
  if (answer === "always" && ask.skill) throw new Error(`Tick accounts for ${ask.skill.title} on its page in Settings → Ask → Skills, or pick Just this once or Skip it.`);
  if (answer === "always" && acct) sampleLimits.get(plan.id)?.tick(acct.id);
  else if (answer === "once" && acct) once.push(acct.id);
  else if (answer === "skip") results.push({ status: "skipped", error: `You said no to ${ask.account}.`, changes: [] });
  return sampleRun(plan, at.ticked, results, once);
}

/**
 * A plan request while an imported sample skill is in use (picked with "/"): the plan records the skill, so its Go
 * keeps to the accounts ticked for it, as the server does. Null for a skill of the owner's own.
 */
export function sampleSkillPlan(skillId: string): { plan: AskPlan; used: { id: string; name: string } } | null {
  const now = () => sampleSkillList().find((s) => s.id === skillId) ?? null;
  const s = now();
  if (!s?.imported || s.assistant_id) return null;
  const plan: AskPlan = {
    id: crypto.randomUUID(),
    source: "ask",
    steps: [
      { label: "Add a to-do: send Elena the revised terms", tool: "add_todo" },
      { label: "Draft a reply to Elena about the 30-day terms", tool: "draft_message" },
    ],
  };
  sampleLimits.set(plan.id, {
    assistant: () => {
      const k = now();
      return k?.imported ? { name: k.title, accounts: [...(k.accounts ?? [])] } : null;
    },
    skill: { id: skillId },
    // Ticked on the skill's page only.
    tick: () => undefined,
    accounts: SAMPLE_ACCOUNTS,
  });
  return { plan, used: { id: s.id, name: s.title } };
}

/** "Every Friday at 4pm, tell me what slipped this week": the receipt for a new routine. */
export function sampleRoutineChange(): AssistantChange {
  return { kind: "routine", id: id(992001), action: "created", title: "What slipped this week", detail: "New routine · Every Friday at 16:00", label: "What slipped this week: New routine", open: { kind: "routine", id: id(992001) }, undo: { op: "sample" } };
}

export function sampleActivity(): ActivityEntry[] {
  const e = (n: number, minutes: number, source: ActivityEntry["source"], change: AssistantChange, state: ActivityEntry["state"] = "done"): ActivityEntry => ({ id: id(993000 + n), at: ago(minutes), source, thread_id: source === "nudge" ? null : id(994000 + n), state, change: { ...change, activity_id: id(993000 + n) } });
  return [
    e(1, 12, "plan", RECEIPTS[0]),
    e(2, 12, "plan", RECEIPTS[2]),
    e(3, 95, "ask", { kind: "reading", id: id(957), action: "created", title: "Dune: Part Two", detail: "Film · To watch", label: "Dune: Part Two: Film · To watch", open: { kind: "reading", id: id(957) }, undo: { op: "sample" } }),
    e(4, 60 * 26, "routine", { kind: "commitment", id: id(990013), action: "updated", title: "Send Priya the hiring plan draft", detail: "To do · due Mon", label: "Send Priya the hiring plan draft: due Mon", open: null, undo: { op: "sample" } }),
    e(5, 60 * 30, "nudge", { kind: "commitment", id: id(990014), action: "updated", title: "Renew the car insurance", detail: "Tue", label: "Renew the car insurance: Tue", open: null, undo: { op: "sample" } }, "undone"),
    e(6, 60 * 50, "ask", { kind: "person", id: SAMPLE_IDS.elena, action: "updated", title: "Elena Rossi", detail: "Works at Brightwater", label: "Elena Rossi: Works at Brightwater", open: { kind: "person", id: SAMPLE_IDS.elena }, undo: { op: "sample" } }, "undo_failed"),
    // A plain flow's change: "Flow: Delivery day", opening the run that made it.
    { ...e(7, 60 * 3, "flow", { kind: "reminder", id: id(990015), action: "created", title: "Parcel from Larkspur Home", detail: "Thu 08:00", label: "Parcel from Larkspur Home: Thu 08:00", open: null, undo: { op: "sample" } }), thread_id: null, flow_id: SAMPLE_FLOW_IDS.delivery, flow_run_id: SAMPLE_RUN_IDS.delivery, flow_name: "Delivery day" },
  ].sort((a, b) => b.at.localeCompare(a.at));
}

export function samplePicks(): WatchPick[] {
  return [
    { id: id(956), title: "Severance", kind: "tv", why: "You're part-way through: episode 14 of 19.", from: "Watch & read", score: 5 },
    { id: id(965), title: "Slow Horses", kind: "tv", why: "You rate slow-burn spy dramas highly.", from: "Trakt watchlist", score: 3 },
    { id: id(957), title: "Dune: Part Two", kind: "film", why: "You gave Arrival 5 stars, and this is also Denis Villeneuve's.", from: "Watch & read", score: 2 },
  ];
}
