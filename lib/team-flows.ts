/**
 * Team assistants' triggers are flows (owner, 20 Nov 2026: "one model"). An assistant's "When it runs" is the
 * flows it runs whose trigger came from Team: each is a flow with the same trigger, `assistant_id` set, and one
 * think step that does the assistant's job as a run always did (lib/team-run.ts runPrompt, its instructions,
 * memory, allowlist and web). Flows is then the one way anything runs on a trigger.
 *
 * - The move (moveTriggers): the reminders job turns every `team_triggers` row into its flow, all in one
 *   transaction, as routines became assistants (lib/team-migrate.ts). Each flow keeps the trigger's last schedule
 *   slot as a claimed fire, so a slot that already ran never runs again; the trigger is marked `moved_at`, and a
 *   moved trigger never fires (lib/team-triggers.ts). If the transaction fails, nothing moved and every assistant
 *   keeps running on its triggers; it never runs on both. `flows.trigger_id` is unique, so running it twice makes
 *   nothing twice. When it has finished once, `team.triggers_moved` in settings says so. The trigger rows stay, so
 *   old runs still name them.
 * - The triggers an assistant shows (TeamAssistant.triggers) are its job flows' triggers (plus, until they move,
 *   any trigger rows not yet moved). Setup, Ask's save_routine, sharing and the trigger editor send triggers as
 *   before; once moved, lib/team.ts keeps them as job flows (syncJobFlows).
 *
 * A job flow is a flow with an assistant and origin `trigger` (made from a trigger, setup or Ask) or `shared` (an
 * imported assistant's, made paused). The owner can open it in Flows like any other and add steps around the job.
 */
import { qRaw, tx, type Run } from "./db";
import { sealText } from "./data-box";
import { scheduleWords } from "./routines";
import { eventWords } from "./team-run";
import type { Flow, FlowStep, FlowTrigger } from "./flow-types";
import type { EventFilter, TeamTrigger, TeamWeekday } from "./team-types";

export const MOVED_KEY = "team.triggers_moved";

/** What a job flow's think step is asked to do. Its run asks what a Team run asked (lib/flow-run.ts thinkFor). */
export const JOB_TASK = "Do your job, as your instructions say.";
/** The job step's id in every job flow. */
export const JOB_STEP_ID = "job";

export const JOB_ORIGINS: ReadonlySet<Flow["origin"]> = new Set(["trigger", "shared"]);

/** A flow that stands for one of an assistant's triggers. Pure. */
export const isJobFlow = (f: Pick<Flow, "assistant_id" | "origin">): boolean => !!f.assistant_id && JOB_ORIGINS.has(f.origin);

/** A job flow whose steps are still only the job: its run is exactly a Team run. Pure. */
export function isPlainJob(f: Pick<Flow, "assistant_id" | "origin" | "steps">): boolean {
  return isJobFlow(f) && f.steps.length === 1 && f.steps[0].kind === "think" && f.steps[0].id === JOB_STEP_ID;
}

/** The job, as one think step. `web: true`: it looks online when the assistant may (its own switch decides). Pure. */
export function jobSteps(): FlowStep[] {
  return [{ id: JOB_STEP_ID, title: null, kind: "think", task: [JOB_TASK], web: true, gives: [] }];
}

/** A trigger as Team keeps it, as a flow's trigger. Null when it can't be one (a schedule with no time). Pure. */
export function flowTriggerOf(t: { kind: "schedule" | "event"; days?: readonly number[] | null; time?: string | null; event?: EventFilter | null }): FlowTrigger | null {
  if (t.kind === "schedule") {
    const days = [...new Set((t.days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as TeamWeekday[];
    if (!days.length || !t.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)) return null;
    return { kind: "schedule", days, time: t.time };
  }
  if (!t.event?.source) return null;
  return { kind: "event", event: { ...t.event } };
}

/** "Every Friday at 17:00", "When you file something as a gift idea": a job flow's name, from its trigger. Pure. */
export function jobName(t: FlowTrigger): string {
  const words = t.kind === "schedule" ? scheduleWords({ days: t.days, time: t.time }) : t.kind === "event" ? eventWords(t.event) : "By hand";
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return name.length <= 60 ? name : `${name.slice(0, 59).replace(/\s+\S*$/, "")}…`;
}

/** A job flow as the trigger its assistant shows: the flow's id, so the trigger editor keeps it. Null for a trigger Team has no words for. Pure. */
export function triggerOfFlow(f: Pick<Flow, "id" | "assistant_id" | "trigger" | "paused" | "last_run_at" | "created_at">): TeamTrigger | null {
  if (!f.assistant_id) return null;
  const base = { id: f.id, flow_id: f.id, assistant_id: f.assistant_id, paused: f.paused, last_slot: null, last_fired_at: f.last_run_at, created_at: f.created_at };
  if (f.trigger.kind === "schedule") return { ...base, kind: "schedule", days: [...f.trigger.days], time: f.trigger.time, event: null };
  if (f.trigger.kind === "event") return { ...base, kind: "event", days: [], time: null, event: { ...f.trigger.event } };
  return null;
}

/** The plain half of a flow's trigger, as lib/flows.ts plainSchedule keeps it. Pure. */
function plainOf(t: FlowTrigger): Record<string, unknown> {
  if (t.kind === "schedule") return { days: t.days, time: t.time };
  if (t.kind === "event") {
    const { match: _match, ...facets } = t.event;
    return { event: facets };
  }
  return {};
}

export interface JobFlowSpec {
  assistantId: string;
  trigger: FlowTrigger;
  paused: boolean;
  origin?: "trigger" | "shared";
  /** The trigger it was moved from. */
  triggerId?: string | null;
  /**
   * When the trigger was made: nothing fires for a time or an event from before it, as before. `handed_at` is when
   * the flow was made (clock time, after the move's locks): an event Team claimed before then was the trigger's.
   */
  createdAt?: string | null;
  lastRunAt?: string | null;
}

/** Keep one job flow (in a transaction or not). Null when the trigger it's moved from already has one. */
export async function insertJobFlow(run: Run, s: JobFlowSpec): Promise<string | null> {
  const words = { name: jobName(s.trigger), trigger: s.trigger, steps: jobSteps() };
  const rows = await run<{ id: string }>(
    `INSERT INTO flows (payload, trigger_kind, schedule, assistant_id, handed_at, paused, origin, trigger_id, last_run_at, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::uuid, clock_timestamp(), $5, $6, $7::uuid, $9::timestamptz, COALESCE($8::timestamptz, clock_timestamp()), now())
     ON CONFLICT (trigger_id) WHERE trigger_id IS NOT NULL DO NOTHING RETURNING id`,
    [sealText(JSON.stringify(words)), s.trigger.kind, JSON.stringify(plainOf(s.trigger)), s.assistantId, s.paused, s.origin ?? "trigger", s.triggerId ?? null, s.createdAt ?? null, s.lastRunAt ?? null],
  );
  return rows[0]?.id ?? null;
}

/** Change a job flow's trigger and on/off. Its name follows the trigger while it's still the one made for it. */
export async function writeJobFlow(run: Run, id: string, was: Pick<Flow, "name" | "trigger" | "steps">, trigger: FlowTrigger, paused: boolean): Promise<void> {
  const name = was.name === jobName(was.trigger) ? jobName(trigger) : was.name;
  await run(`UPDATE flows SET payload = $2, trigger_kind = $3, schedule = $4::jsonb, paused = $5, updated_at = now() WHERE id = $1::uuid`, [
    id,
    sealText(JSON.stringify({ name, trigger, steps: was.steps })),
    trigger.kind,
    JSON.stringify(plainOf(trigger)),
    paused,
  ]);
}

/** Gone, as lib/flows.ts deleteFlow does it: its cards leave Home and its claimed fires go. */
export async function dropJobFlow(run: Run, id: string): Promise<void> {
  await run(`UPDATE nudges SET dismissed_at = now() WHERE dismissed_at IS NULL AND key LIKE 'flow:%' AND split_part(key, ':', 2) IN (SELECT id::text FROM flow_runs WHERE flow_id = $1::uuid)`, [id]);
  await run(`DELETE FROM flows WHERE id = $1::uuid`, [id]);
  await run(`DELETE FROM flow_trigger_fires WHERE flow_id = $1`, [id]);
}

/** Every job flow, or one assistant's, oldest first. */
export async function listJobFlows(assistantId?: string): Promise<Flow[]> {
  const { listFlows } = await import("./flows");
  return (await listFlows()).filter((f) => isJobFlow(f) && (!assistantId || f.assistant_id === assistantId));
}

export async function triggersMoved(): Promise<boolean> {
  try {
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [MOVED_KEY]);
    return !!row;
  } catch {
    return false;
  }
}

interface TriggerRow {
  id: string;
  assistant_id: string;
  kind: "schedule" | "event";
  days: number[] | null;
  at_time: string | null;
  event: EventFilter | null;
  paused: boolean;
  last_slot: string | Date | null;
  last_fired_at: string | Date | null;
  created_at: string | Date;
}

const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

/**
 * Move every trigger not yet moved to its flow: one transaction, so either every one moves or none does (and the
 * assistants carry on as they were). A schedule's last slot goes with it as a claimed fire. Marked done in settings
 * the first time; after that, a trigger made since (by an older tab, say) moves on the next pass.
 */
export async function moveTriggers(now = new Date()): Promise<{ moved: number; skipped: number; done: boolean }> {
  // Nothing left to move, and done once: no transaction this pass.
  const [left] = await qRaw<{ one: number }>(`SELECT 1 AS one FROM team_triggers WHERE moved_at IS NULL LIMIT 1`);
  if (!left && (await triggersMoved())) return { moved: 0, skipped: 0, done: true };
  return tx(async (run) => {
    const rows = await run<TriggerRow>(
      `SELECT t.id, t.assistant_id, t.kind, t.days, t.at_time, t.event, t.paused, t.last_slot, t.last_fired_at, t.created_at
         FROM team_triggers t JOIN team_assistants a ON a.id = t.assistant_id
        WHERE t.moved_at IS NULL AND a.assignment_id IS NULL ORDER BY t.created_at, t.id FOR UPDATE OF t`,
    );
    let moved = 0;
    let skipped = 0;
    for (const t of rows) {
      const trigger = flowTriggerOf({ kind: t.kind, days: t.days?.map(Number), time: t.at_time, event: t.event });
      // A trigger with nothing to fire on (no time, no filter) could never run: it's marked, with no flow.
      if (trigger) {
        let id = await insertJobFlow(run, { assistantId: t.assistant_id, trigger, paused: t.paused, triggerId: t.id, createdAt: iso(t.created_at), lastRunAt: iso(t.last_fired_at) });
        if (!id) [{ id }] = await run<{ id: string }>(`SELECT id FROM flows WHERE trigger_id = $1::uuid`, [t.id]);
        // The slot it last ran for is the flow's too (lib/flow-triggers.ts claims `schedule:<slot>`), so it isn't run again.
        const slot = iso(t.last_slot);
        if (trigger.kind === "schedule" && slot) {
          await run(`INSERT INTO flow_trigger_fires (flow_id, fire_key, fire_at) VALUES ($1, $2, $3::timestamptz) ON CONFLICT DO NOTHING`, [id, `schedule:${slot}`, slot]);
        }
        moved++;
      } else skipped++;
      await run(`UPDATE team_triggers SET moved_at = $2 WHERE id = $1::uuid`, [t.id, now.toISOString()]);
    }
    await run(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`, [MOVED_KEY, JSON.stringify({ at: now.toISOString(), moved, skipped })]);
    return { moved, skipped, done: true };
  });
}
