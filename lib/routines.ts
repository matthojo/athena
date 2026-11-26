/**
 * Routines: recurring Ask questions the owner sets up, like "Every Friday at
 * 4pm: what slipped this week?" (migration 0055, `ask_routines`).
 *
 * Made from Ask ("do this every Friday", the save_routine tool below) or in
 * Settings → Ask → Routines, which also pauses, edits and deletes them. At
 * most MAX_ROUTINES. A routine runs on chosen weekdays at a time of day in
 * the owner's zone, so it follows them when they travel and clock changes
 * need nothing.
 *
 * Routines are becoming Team assistants (lib/team-migrate.ts):
 * the reminders job turns each into an assistant with a schedule trigger, and
 * save_routine now makes an assistant. The slot maths below is shared with
 * Team's schedule triggers (lib/team-triggers.ts).
 *
 * The reminders function (every 5 minutes) asks dueSlot which routines are
 * due and claims each slot once in the row itself (claimSlot), so a routine
 * runs at most once per slot even when runs overlap; a slot missed by more
 * than RUN_WINDOW_MINUTES is skipped, never run late in a burst. The run
 * itself is lib/routine-run.ts. Its words are sealed; the schedule is plain.
 */
import { z } from "zod";
import { AthenaInputError, getOwnerTimeZone, q, qRaw } from "./db";
import { sealText } from "./data-box";
import { addDays, zonedParts, zonedToInstant } from "./dates";
import type { Anthropic } from "./ai";
import type { Change } from "./assistant";

export const MAX_ROUTINES = 10;
/** A slot this late is skipped (the site was down, say): the next one comes round. */
export const RUN_WINDOW_MINUTES = 90;
/** One routine's words: enough for a real question, short enough to read on a phone. */
export const MAX_PROMPT = 500;
export const MAX_TITLE = 80;

/** 0 = Sunday … 6 = Saturday, as Date.getUTCDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface RoutineSchedule {
  /** Which weekdays, each once, in order. */
  days: Weekday[];
  /** HH:MM in the owner's zone. */
  time: string;
}

export interface Routine extends RoutineSchedule {
  id: string;
  /** "What slipped this week". */
  title: string;
  /** What Ask is asked each time. */
  prompt: string;
  paused: boolean;
  /** The slot it last ran for. */
  last_slot: string | null;
  last_run_at: string | null;
  /** The conversation its last run made. */
  last_thread_id: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- schedule maths (pure) ----------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** "fri", "Friday", 5, "weekdays", "every day" → weekdays. Throws on anything else. */
export function parseDays(raw: unknown): Weekday[] {
  // "every day" → daily, "every Friday" → Friday, before splitting on spaces and commas.
  const plain = (t: string) => t.toLowerCase().replace(/every[\s_]*day/g, "daily").replace(/\bevery\s+/g, "");
  const items = Array.isArray(raw) ? raw.map((x) => (typeof x === "string" ? plain(x) : x)) : typeof raw === "string" ? plain(raw).split(/[,\s]+and\s+|[,\s]+/i) : [raw];
  const out = new Set<Weekday>();
  for (const item of items) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6) {
      out.add(item as Weekday);
      continue;
    }
    const s = String(item ?? "").trim().toLowerCase();
    if (!s) continue;
    if (s === "weekdays" || s === "weekday") WEEKDAYS.forEach((d) => out.add(d));
    else if (s === "weekends" || s === "weekend") [0, 6].forEach((d) => out.add(d as Weekday));
    else if (s === "daily" || s === "every_day" || s === "everyday" || s === "all") EVERY_DAY.forEach((d) => out.add(d));
    else {
      const i = DAY_NAMES.findIndex((n) => n === s || n.slice(0, 3) === s.slice(0, 3));
      if (i < 0 || s.length < 3) throw new AthenaInputError(`days: weekday names, like ["friday"] or ["weekdays"]; not “${String(item).slice(0, 20)}”`);
      out.add(i as Weekday);
    }
  }
  if (!out.size) throw new AthenaInputError("days: at least one weekday");
  return [...out].sort((a, b) => a - b);
}

/** "16:00", "4pm", "4:30 pm", "09:05" → "HH:MM". Throws on anything else. */
export function parseTime(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (HHMM.test(s)) return s;
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    const out = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    if (HHMM.test(out)) return out;
  }
  throw new AthenaInputError("time: a time of day, like 16:00");
}

export function parseSchedule(raw: { days?: unknown; time?: unknown }): RoutineSchedule {
  return { days: parseDays(raw.days), time: parseTime(raw.time) };
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() as Weekday;

/** The most recent slot at or before `now`, in the owner's zone; null if none in the last 8 days. */
export function latestSlot(s: RoutineSchedule, now: Date, tz: string): Date | null {
  const today = zonedParts(now, tz).date;
  for (let back = 0; back <= 7; back++) {
    const date = addDays(today, -back);
    if (!s.days.includes(weekdayOf(date))) continue;
    const at = zonedToInstant(date, s.time, tz);
    if (at.getTime() <= now.getTime()) return at;
  }
  return null;
}

/** The next slot after `now`. */
export function nextSlot(s: RoutineSchedule, now: Date, tz: string): Date | null {
  const today = zonedParts(now, tz).date;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = addDays(today, ahead);
    if (!s.days.includes(weekdayOf(date))) continue;
    const at = zonedToInstant(date, s.time, tz);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/**
 * The slot a routine should run for now, or null: not paused, the latest slot
 * is newer than the one it last ran for (and than the routine itself), and
 * it was less than RUN_WINDOW_MINUTES ago.
 */
export function dueSlot(r: Pick<Routine, "days" | "time" | "paused" | "last_slot" | "created_at">, now: Date, tz: string): Date | null {
  if (r.paused) return null;
  const slot = latestSlot(r, now, tz);
  if (!slot) return null;
  if (now.getTime() - slot.getTime() > RUN_WINDOW_MINUTES * 60_000) return null;
  if (r.last_slot && Date.parse(r.last_slot) >= slot.getTime()) return null;
  if (Date.parse(r.created_at) > slot.getTime()) return null;
  return slot;
}

/** "Every Friday at 16:00", "Weekdays at 08:00", "Every day at 07:30", "Mon, Wed and Fri at 07:30". */
export function scheduleWords(s: RoutineSchedule): string {
  const d = [...s.days].sort((a, b) => a - b);
  const same = (a: Weekday[]) => a.length === d.length && a.every((x, i) => x === d[i]);
  const when = same(EVERY_DAY) ? "Every day" : same(WEEKDAYS) ? "Weekdays" : same([0, 6]) ? "Weekends" : d.length === 1 ? `Every ${DAY_NAMES[d[0]].charAt(0).toUpperCase()}${DAY_NAMES[d[0]].slice(1)}` : joinAnd(d.map((x) => SHORT[x]));
  return `${when} at ${s.time}`;
}

const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A routine's name when it wasn't given one: its words, cut at a word. */
export function titleFrom(prompt: string): string {
  const t = prompt.replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
  const cut = t.length <= 48 ? t : `${t.slice(0, 48).replace(/\s+\S*$/, "")}…`;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

// ---------- the store ----------

interface Row {
  id: string;
  payload: string;
  days: number[];
  at_time: string;
  paused: boolean;
  last_slot: string | Date | null;
  last_run_at: string | Date | null;
  last_thread_id: string | null;
  delivered_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const COLUMNS = `id, payload, days, at_time, paused, last_slot, last_run_at, last_thread_id, delivered_at, created_at, updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

function present(r: Row): Routine {
  let p: { title?: string; prompt?: string } = {};
  try {
    p = JSON.parse(r.payload);
  } catch {
    // sealed under a key this deploy doesn't have: shown without its words, never run
  }
  return {
    id: r.id,
    title: p.title ?? "",
    prompt: p.prompt ?? "",
    days: (r.days ?? []).map(Number).filter((d) => d >= 0 && d <= 6) as Weekday[],
    time: r.at_time,
    paused: r.paused,
    last_slot: iso(r.last_slot),
    last_run_at: iso(r.last_run_at),
    last_thread_id: r.last_thread_id,
    delivered_at: iso(r.delivered_at),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

const seal = (title: string, prompt: string) => sealText(JSON.stringify({ title, prompt }));

export async function listRoutines(): Promise<Routine[]> {
  return (await q<Row>(`SELECT ${COLUMNS} FROM ask_routines ORDER BY created_at`)).map(present);
}

export async function getRoutine(id: unknown): Promise<Routine | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM ask_routines WHERE id = $1::uuid`, [id]);
  return row ? present(row) : null;
}

export interface RoutineInput {
  title?: unknown;
  prompt?: unknown;
  days?: unknown;
  time?: unknown;
  paused?: unknown;
}

function words(input: RoutineInput, was?: Routine): { title: string; prompt: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT) : (was?.prompt ?? "");
  if (!prompt) throw new AthenaInputError("What should Ask do each time?");
  const given = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  return { prompt, title: given || (input.prompt !== undefined || !was?.title ? titleFrom(prompt) : was.title) };
}

const FULL = `You have ${MAX_ROUTINES} routines, which is the most Ask keeps. Delete or change one first.`;

/** Refuse a new routine when there are MAX_ROUTINES already. Pure. */
export function checkRoom(count: number): void {
  if (count >= MAX_ROUTINES) throw new AthenaInputError(FULL);
}

/** A new routine. Refused past MAX_ROUTINES (checked again in the insert, so two at once can't pass it). */
export async function createRoutine(input: RoutineInput, now = new Date()): Promise<Routine> {
  const { title, prompt } = words(input);
  const s = parseSchedule(input);
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ask_routines`);
  checkRoom(n);
  const [row] = await q<Row>(
    `INSERT INTO ask_routines (payload, days, at_time, paused, created_at, updated_at)
     SELECT $1, $2::smallint[], $3, $4, $5, $5
      WHERE (SELECT count(*) FROM ask_routines) < $6
     RETURNING ${COLUMNS}`,
    [seal(title, prompt), s.days, s.time, input.paused === true, now.toISOString(), MAX_ROUTINES],
  );
  if (!row) throw new AthenaInputError(FULL);
  return present(row);
}

/** Change its words, days, time or pause. Changing when it runs doesn't run a slot that has already passed. */
export async function updateRoutine(id: unknown, input: RoutineInput, now = new Date()): Promise<Routine> {
  const was = await getRoutine(id);
  if (!was) throw new AthenaInputError("That routine isn't there any more", 404);
  const { title, prompt } = input.prompt !== undefined || input.title !== undefined ? words(input, was) : was;
  const s = input.days !== undefined || input.time !== undefined ? parseSchedule({ days: input.days ?? was.days, time: input.time ?? was.time }) : was;
  const paused = input.paused === undefined ? was.paused : input.paused === true;
  if (input.paused !== undefined && typeof input.paused !== "boolean") throw new AthenaInputError("paused: true or false");
  // A new time that's already gone today shouldn't fire the moment it's saved: count it as run.
  const moved = s.time !== was.time || s.days.join() !== was.days.join() || (was.paused && !paused);
  const passed = moved ? latestSlot(s, now, await getOwnerTimeZone()) : null;
  const [row] = await q<Row>(
    `UPDATE ask_routines SET payload = $2, days = $3::smallint[], at_time = $4, paused = $5, updated_at = now(),
       last_slot = CASE WHEN $6::timestamptz IS NOT NULL AND (last_slot IS NULL OR last_slot < $6::timestamptz) THEN $6::timestamptz ELSE last_slot END
     WHERE id = $1::uuid RETURNING ${COLUMNS}`,
    [was.id, seal(title, prompt), s.days, s.time, paused, passed ? passed.toISOString() : null],
  );
  return present(row);
}

export async function deleteRoutine(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  const rows = await qRaw<{ id: string }>(`DELETE FROM ask_routines WHERE id = $1::uuid RETURNING id`, [id]);
  return rows.length > 0;
}

/** Claim this slot for one run: false when another run has it, or the routine was paused or deleted meanwhile. */
export async function claimSlot(id: string, slot: Date): Promise<boolean> {
  const rows = await qRaw<{ id: string }>(
    `UPDATE ask_routines SET last_slot = $2::timestamptz, delivered_at = NULL
      WHERE id = $1::uuid AND NOT paused AND (last_slot IS NULL OR last_slot < $2::timestamptz) RETURNING id`,
    [id, slot.toISOString()],
  );
  return rows.length > 0;
}

export async function recordRun(id: string, threadId: string, at = new Date()): Promise<void> {
  await qRaw(`UPDATE ask_routines SET last_run_at = $2, last_thread_id = $3::uuid WHERE id = $1::uuid`, [id, at.toISOString(), threadId]);
}

export async function markDelivered(id: string): Promise<void> {
  await qRaw(`UPDATE ask_routines SET delivered_at = now(), pending = NULL WHERE id = $1::uuid`, [id]);
}

/** Keep a run's nudge until it can go out. */
export async function setPending(id: string, nudge: unknown): Promise<void> {
  await qRaw(`UPDATE ask_routines SET pending = $2, delivered_at = NULL WHERE id = $1::uuid`, [id, sealText(JSON.stringify(nudge))]);
}

/** Runs whose nudge hasn't gone out yet (held for quiet hours, say), from the last day. */
export async function pendingNudges(): Promise<Array<{ id: string; nudge: unknown }>> {
  const rows = await q<{ id: string; pending: string }>(`SELECT id, pending FROM ask_routines WHERE pending IS NOT NULL AND delivered_at IS NULL AND last_run_at > now() - interval '1 day'`);
  return rows.flatMap((r) => {
    try {
      return [{ id: r.id, nudge: JSON.parse(r.pending) }];
    } catch {
      return [];
    }
  });
}

// ---------- from Ask: save_routine ----------

export const ROUTINE_TOOLS: Anthropic.Tool[] = [
  {
    name: "save_routine",
    description:
      "Set up something done again on a schedule, for “every Friday at 4pm, tell me what slipped this week” or “do this every Monday morning” (this = the owner's question just before). " +
      "It becomes a Team assistant with that schedule: each run answers from the owner's data and sends it to their phone; any changes it would make wait as a plan for them to approve. " +
      `prompt is the question or request in the owner's words, complete on its own. days are weekday names (or "weekdays", "every day"), time is HH:MM in their zone. Give routine_id (the assistant's id) to change one.`,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "What to ask each time, standalone: “What slipped this week?”" },
        title: { type: "string", description: "A short name: “What slipped”. Optional." },
        days: { type: "array", items: { type: "string" }, description: "[\"friday\"], [\"weekdays\"], [\"monday\", \"thursday\"]" },
        time: { type: "string", description: "HH:MM, the owner's time." },
        routine_id: { type: "string", description: "An existing scheduled assistant to change (its id)." },
      },
      required: ["prompt", "days", "time"],
    },
  },
];
export const ROUTINE_TOOL_NAMES = new Set(ROUTINE_TOOLS.map((t) => t.name));

export const ROUTINE_GUIDANCE = `- Routines: for “every Friday at 4pm, …”, “do this every morning” or “each Monday, check …”, call save_routine (with the earlier question as prompt for “do this”). It joins the owner's Team as an assistant. Reply with when it'll run; say it can be paused or changed on the Team page.`;

const routineInput = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT * 2),
  title: z.string().max(200).optional(),
  days: z.union([z.array(z.union([z.string(), z.number()])).max(14), z.string()]),
  time: z.string().max(20),
  routine_id: z.string().uuid().optional(),
});

export interface RoutineUndo {
  op: "remove_routine" | "restore_routine";
  /** The assistant's id (or, for entries from before Team, the routine's). */
  id: string;
  title?: string;
  prompt?: string;
  days?: Weekday[];
  time?: string;
  paused?: boolean;
  /** restore: the assistant as it was. */
  assistant?: { name: string; job: string; instructions: string; paused: boolean; triggers: Array<{ id?: string; kind: "schedule" | "event"; days?: number[]; time?: string; event?: unknown; paused?: boolean }> };
}

export const isRoutineUndo = (raw: unknown): raw is RoutineUndo => !!raw && typeof raw === "object" && ["remove_routine", "restore_routine"].includes(String((raw as { op?: unknown }).op));

/** save_routine: a Team assistant with a schedule trigger (lib/team.ts). Given routine_id, that assistant (or the one made from that routine) changes. */
export async function runRoutineTool(name: string, raw: unknown, record: (c: Omit<Change, "label">) => string): Promise<string> {
  if (name !== "save_routine") throw new Error(`Unknown tool ${name}`);
  const input = routineInput.parse(raw);
  const team = await import("./team");
  const { MAX_JOB, MAX_NAME } = await import("./team-types");
  const prompt = input.prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT);
  const title = (input.title?.replace(/\s+/g, " ").trim() || titleFrom(prompt)).slice(0, MAX_TITLE);
  const s = parseSchedule(input);
  const when = scheduleWords(s);
  const trigger = { kind: "schedule" as const, days: s.days, time: s.time };
  if (input.routine_id) {
    const was = (await team.getAssistant(input.routine_id)) ?? (await team.listAssistants()).find((a) => a.routine_id === input.routine_id) ?? null;
    if (!was) throw new AthenaInputError("That routine isn't there any more");
    // Its schedule changes; any event triggers it has stay as they are.
    const keepSchedule = was.triggers.find((t) => t.kind === "schedule");
    const others = was.triggers.filter((t) => t.kind !== "schedule").map((t) => ({ id: t.id, kind: t.kind, event: t.event ?? undefined, paused: t.paused }));
    const a = await team.updateAssistant(was.id, { name: title.slice(0, MAX_NAME), job: title.slice(0, MAX_JOB), instructions: prompt, triggers: [{ ...(keepSchedule ? { id: keepSchedule.id } : {}), ...trigger }, ...others] });
    const back = { name: was.name, job: was.job, instructions: was.instructions, paused: was.paused, triggers: was.triggers.map((t) => ({ id: t.id, kind: t.kind, ...(t.kind === "schedule" ? { days: t.days, time: t.time ?? undefined } : { event: t.event }), paused: t.paused })) };
    return record({ kind: "routine", id: a.id, action: "updated", title: a.name, detail: `Team · ${when}`, open: { kind: "routine", id: a.id }, undo: { op: "restore_routine", id: a.id, assistant: back } });
  }
  const a = await team.createAssistant({ name: title.slice(0, MAX_NAME), job: title.slice(0, MAX_JOB), instructions: prompt, triggers: [trigger] });
  return record({ kind: "routine", id: a.id, action: "created", title: a.name, detail: `New on your team · ${when}`, open: { kind: "routine", id: a.id }, undo: { op: "remove_routine", id: a.id } });
}

export async function applyRoutineUndo(raw: RoutineUndo): Promise<void> {
  if (typeof raw.id !== "string" || !UUID.test(raw.id)) throw new AthenaInputError("That can't be undone");
  const team = await import("./team");
  const assistant = await team.getAssistant(raw.id);
  if (raw.op === "remove_routine") {
    if (assistant) await team.deleteAssistant(raw.id);
    else await deleteRoutine(raw.id);
    return;
  }
  if (assistant) {
    if (!raw.assistant) throw new AthenaInputError("That can't be undone");
    await team.updateAssistant(raw.id, raw.assistant);
    return;
  }
  if (!(await getRoutine(raw.id))) throw new AthenaInputError("That routine was deleted, so it can't be put back");
  await updateRoutine(raw.id, { title: raw.title, prompt: raw.prompt, days: raw.days, time: raw.time, paused: raw.paused });
}
