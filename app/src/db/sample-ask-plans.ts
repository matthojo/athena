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

/** Go in sample mode: every ticked step "runs", unticked ones are skipped. */
export function sampleGo(plan: AskPlan, ticked: number[]): { plan: AskPlan; changes: AssistantChange[] } {
  const results = plan.steps.map((_, i) => {
    if (!ticked.includes(i)) return { status: "skipped" as const, changes: [] };
    // A Team run's plan (no routine of its own) gets a receipt for its own step, not the sample plan's.
    const c = plan.source === "routine" ? { ...RECEIPTS[2], id: id(990030 + i), title: plan.steps[i].label.replace(/^Add a to-do:\s*/i, ""), detail: "To do", label: plan.steps[i].label } : (RECEIPTS[i] ?? { ...RECEIPTS[2], id: id(990020 + i), title: plan.steps[i].label });
    return { status: "done" as const, changes: [{ ...c, activity_id: id(991000 + i) }] };
  });
  return { plan: { ...plan, ran: { at: new Date().toISOString(), results } }, changes: results.flatMap((r) => r.changes) };
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
