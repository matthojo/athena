/**
 * Team: the assistants and their triggers (docs/team.md, migration 0067).
 *
 * An assistant's words (name, job, instructions, personality, avatar) are
 * sealed in `payload` and what it remembers in `memory`, as ask_routines
 * does; `allow`, `paused` and the triggers' schedules and filters are plain,
 * so the reminders job can read them, and so is `web` (may it look things up
 * online; migration 0072). At most MAX_ASSISTANTS, checked again
 * in the insert so two at once can't pass it. On create, anything left out
 * comes from a fresh seed (lib/team-seed.ts); only the job is required.
 *
 * Triggers belong to one assistant and go with it. PATCH with `triggers`
 * replaces the set: an entry with an existing id keeps that trigger (and the
 * slot it last ran for); the rest are made new; any left out are removed.
 *
 * Once triggers have moved to flows (lib/team-flows.ts, migration 0083), an
 * assistant's triggers are its job flows: `triggers` reads them, and writing
 * `triggers` keeps them as job flows. A trigger row that hasn't moved yet is
 * still read and kept as before, until the next pass moves it.
 */
import { z } from "zod";
import { AthenaInputError, q, qRaw, tx } from "./db";
import { sealText } from "./data-box";
import { parseDays, parseTime } from "./routines";
import { avatarFromSeed, nameFromSeed, newSeed, personalityFromSeed } from "./team-seed";
import { checkAssistantModels, cleanAssistantModels, loadModelSettings } from "./models";
import { cleanAccountIds, MAX_ITEM_ACCOUNTS, MAX_ITEM_NEEDS, skillImported } from "./shared-limits";
import {
  ACCENT_KEYS,
  ACCESSORY_IDS,
  ACCESSORY_LIST,
  EYES,
  FUR_KEYS,
  MAX_ASSISTANTS,
  MAX_GREETING,
  MAX_INSTRUCTIONS,
  MAX_JOB,
  MAX_MEMORY_FACTS,
  MAX_MEMORY_SUMMARY,
  MAX_NAME,
  MAX_TRAITS,
  MAX_TRIGGERS,
  MOUTH_IDS,
  OUTFITS,
  OUTFIT_COLOR_KEYS,
  PRONOUNS,
  SPECIES,
  TONES,
  type AccessoryId,
  type AssistantMemory,
  type AvatarSpec,
  type EventFilter,
  type Personality,
  type TeamAssistant,
  type TeamAssistantInput,
  type TeamTrigger,
  type TeamTriggerInput,
  type TeamWeekday,
} from "./team-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------- validation ----------

const keyOf = (keys: readonly string[]) => z.string().refine((k) => keys.includes(k), { message: "not a palette colour" });

export const avatarSchema = z
  .object({
    v: z.literal(1),
    seed: z.string().min(1).max(64),
    species: z.enum(SPECIES),
    fur: keyOf(FUR_KEYS),
    accent: keyOf(ACCENT_KEYS),
    eyes: z.enum(EYES),
    mouth: z.enum(MOUTH_IDS),
    outfit: z.enum(OUTFITS),
    outfitColor: keyOf(OUTFIT_COLOR_KEYS),
    accessories: z.array(z.enum(ACCESSORY_LIST as [AccessoryId, ...AccessoryId[]])).max(3),
  })
  .strict()
  .refine((a) => new Set(a.accessories.map((x) => ACCESSORY_IDS[x])).size === a.accessories.length, { message: "at most one accessory per slot (head, face, neck)", path: ["accessories"] });

export const personalitySchema = z
  .object({
    tone: z.enum(TONES),
    traits: z.array(z.string().trim().min(1).max(30)).max(MAX_TRAITS),
    pronoun: z.enum(PRONOUNS),
    greeting: z.string().trim().max(MAX_GREETING),
  })
  .strict();

const facet = z.string().trim().min(1).max(80).optional();
export const eventFilterSchema = z
  .object({
    source: z.enum(["collected", "saved", "note"]),
    connector: facet,
    kind: facet,
    savedAction: facet,
    tag: z.string().trim().min(1).max(80).transform((t) => t.replace(/^#/, "")).optional(),
    match: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const triggerSchema = z
  .object({
    id: z.string().regex(UUID).optional(),
    kind: z.enum(["schedule", "event"]),
    days: z.union([z.array(z.union([z.string(), z.number()])).max(14), z.string().max(80)]).optional(),
    time: z.string().max(20).optional(),
    event: eventFilterSchema.optional(),
    paused: z.boolean().optional(),
  })
  .strict();

/** Tool names, as lib/assistant.ts names them. */
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "a tool name");

const inputSchema = z
  .object({
    name: z.string().max(MAX_NAME * 2).optional(),
    job: z.string().max(MAX_JOB * 2).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS).optional(),
    personality: personalitySchema.optional(),
    avatar: avatarSchema.optional(),
    allow: z.array(toolName).max(60).optional(),
    // An imported assistant's connected accounts (lib/shared-limits.ts): ids, checked against the accounts there are.
    accounts: z.array(z.string().regex(/^[0-9a-f-]{36}$/i, "an account id")).max(MAX_ITEM_ACCOUNTS).optional(),
    web: z.boolean().optional(),
    // Checked apart, with the owner's agreements (lib/models.ts checkAssistantModels).
    models: z.record(z.unknown()).optional(),
    paused: z.boolean().optional(),
    triggers: z.array(triggerSchema).max(MAX_TRIGGERS).optional(),
  })
  .strict();

/** Zod's first problem, as one line the app can show. */
function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new AthenaInputError(`${issue.path.join(".") || "input"}: ${issue.message}`);
}

interface CleanTrigger {
  id?: string;
  kind: "schedule" | "event";
  days: TeamWeekday[] | null;
  time: string | null;
  event: EventFilter | null;
  paused: boolean;
}

/** A trigger as the app sent it, checked: a schedule has days and a time; an event has a filter. */
export function cleanTrigger(raw: unknown): CleanTrigger {
  const t = parse(triggerSchema, raw);
  if (t.kind === "schedule") {
    if (t.event) throw new AthenaInputError("A schedule trigger has days and a time, not an event");
    return { id: t.id, kind: "schedule", days: parseDays(t.days) as TeamWeekday[], time: parseTime(t.time), event: null, paused: t.paused === true };
  }
  if (!t.event) throw new AthenaInputError("An event trigger needs an event: what should it wait for?");
  return { id: t.id, kind: "event", days: null, time: null, event: t.event as EventFilter, paused: t.paused === true };
}

/** Memory as kept: the summary cut to MAX_MEMORY_SUMMARY, facts to MAX_MEMORY_FACTS (the newest kept). */
export function cleanMemory(m: Partial<AssistantMemory> | null | undefined): AssistantMemory {
  const summary = typeof m?.summary === "string" ? m.summary.trim().slice(0, MAX_MEMORY_SUMMARY).trimEnd() : "";
  const facts = Array.isArray(m?.facts) ? m.facts.filter((f): f is string => typeof f === "string").map(oneLine).filter(Boolean) : [];
  return { summary, facts: facts.slice(-MAX_MEMORY_FACTS) };
}

// ---------- rows ----------

interface AssistantRow {
  id: string;
  payload: string;
  allow: string[] | null;
  /** Missing before migration 0072. */
  web?: boolean | null;
  /** Its own models (0076). */
  models?: unknown;
  /** 'shared' for an imported one (0087). */
  origin?: string | null;
  /** Connected accounts ticked for an imported one (0087). */
  accounts?: string[] | null;
  paused: boolean;
  routine_id: string | null;
  memory: string | null;
  memory_updated_at: string | Date | null;
  last_run_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
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

const A_COLUMNS = `id, payload, allow, web, models, origin, accounts, paused, routine_id, memory, memory_updated_at, last_run_at, created_at, updated_at`;
const T_COLUMNS = `id, assistant_id, kind, days, at_time, event, paused, last_slot, last_fired_at, created_at`;

interface Words {
  name: string;
  job: string;
  instructions: string;
  personality: Personality;
  avatar: AvatarSpec;
  /** An imported one: the accounts its file says it needs, by provider ("linear"), kept from the import. Sealed with its words. */
  needs?: string[];
}

const sealWords = (w: Words) => sealText(JSON.stringify(w));

function readJson<T>(text: string | null): Partial<T> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Partial<T>;
  } catch {
    // sealed under a key this deploy doesn't have: shown without its words, never run
    return {};
  }
}

function presentTrigger(r: TriggerRow): TeamTrigger {
  return {
    id: r.id,
    assistant_id: r.assistant_id,
    kind: r.kind,
    days: (r.days ?? []).map(Number).filter((d) => d >= 0 && d <= 6) as TeamWeekday[],
    time: r.at_time,
    event: r.event,
    paused: r.paused,
    last_slot: iso(r.last_slot),
    last_fired_at: iso(r.last_fired_at),
    created_at: iso(r.created_at)!,
  };
}

/** The owner's agreements, for reading each assistant's models (a choice on a provider no longer agreed to is dropped). */
type Consent = NonNullable<Awaited<ReturnType<typeof loadModelSettings>>["consent"]>;

/** The triggers an assistant shows: its trigger rows not yet moved, then its job flows' (lib/team-flows.ts). */
async function jobTriggers(assistantId?: string): Promise<TeamTrigger[]> {
  try {
    const { listJobFlows, triggerOfFlow } = await import("./team-flows");
    return (await listJobFlows(assistantId)).map(triggerOfFlow).filter((t): t is TeamTrigger => !!t);
  } catch (error) {
    // Flows' table isn't there yet (a copy part-way through its migrations): its triggers are the rows.
    console.warn("Athena team: couldn't read assistants' flows", error instanceof Error ? error.message.slice(0, 120) : error);
    return [];
  }
}

function present(r: AssistantRow, triggers: TeamTrigger[], consent: Consent = {}): TeamAssistant {
  const w = readJson<Words>(r.payload);
  const seed = w.avatar?.seed ?? r.id;
  return {
    id: r.id,
    name: w.name ?? "",
    job: w.job ?? "",
    instructions: w.instructions ?? "",
    personality: w.personality ?? personalityFromSeed(seed),
    avatar: w.avatar ?? avatarFromSeed(seed),
    ...(r.origin === "shared" ? { needs: cleanNeeds(w.needs) } : {}),
    allow: r.allow ?? [],
    web: r.web === true,
    models: cleanAssistantModels(r.models, consent),
    imported: r.origin === "shared",
    accounts: r.accounts ?? [],
    paused: r.paused,
    routine_id: r.routine_id,
    memory: cleanMemory(readJson<AssistantMemory>(r.memory)),
    memory_updated_at: iso(r.memory_updated_at),
    last_run_at: iso(r.last_run_at),
    triggers,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

// ---------- assistants ----------

export async function listAssistants(): Promise<TeamAssistant[]> {
  await markImported();
  // A guest (assignment_id set; lib/assignments.ts) isn't on the team: not listed here, to main Ask's check_with_assistant, or counted toward the 12.
  const rows = await q<AssistantRow>(`SELECT ${A_COLUMNS} FROM team_assistants WHERE assignment_id IS NULL ORDER BY created_at, id`);
  const [rowsT, flowsT, { consent }] = await Promise.all([listTriggers(), jobTriggers(), loadModelSettings()]);
  const triggers = [...rowsT, ...flowsT];
  return rows.map((r) => present(r, triggers.filter((t) => t.assistant_id === r.id), consent));
}

export async function getAssistant(id: unknown): Promise<TeamAssistant | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  await markImported();
  const [row] = await q<AssistantRow>(`SELECT ${A_COLUMNS} FROM team_assistants WHERE id = $1::uuid`, [id]);
  if (!row) return null;
  const [rowsT, flowsT, { consent }] = await Promise.all([listTriggers(id), jobTriggers(id), loadModelSettings()]);
  return present(row, [...rowsT, ...flowsT], consent);
}

/** Ticked account ids, keeping only accounts that are there (lib/shared-limits.ts). */
async function knownAccounts(ids: string[]): Promise<string[]> {
  const rows = await q<{ id: string }>(`SELECT id::text AS id FROM connectors`);
  return cleanAccountIds(ids, new Set(rows.map((r) => r.id.toLowerCase())));
}

let marking: Promise<void> | null = null;
/**
 * Once: an assistant imported before migration 0087 whose own skill came from a file or a link (only an import
 * writes one so) is marked imported. Its words are sealed, so this is code, not SQL. Never throws.
 */
function markImported(): Promise<void> {
  marking ??= (async () => {
    try {
      const claimed = await qRaw<{ key: string }>(`INSERT INTO settings (key, value) VALUES ('team.origin_marked', 'true'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`);
      if (!claimed.length) return;
      const { assistantSkill } = await import("./skills-store");
      const rows = await q<{ id: string }>(`SELECT id FROM team_assistants WHERE origin IS NULL`);
      for (const r of rows) {
        const s = await assistantSkill(r.id).catch(() => null);
        if (s && skillImported(s.source)) await qRaw(`UPDATE team_assistants SET origin = 'shared' WHERE id = $1::uuid AND origin IS NULL`, [r.id]);
      }
    } catch (error) {
      marking = null;
      console.warn("Athena team: couldn't mark imported assistants", error instanceof Error ? error.message.slice(0, 120) : error);
    }
  })();
  return marking;
}

const FULL = `You have ${MAX_ASSISTANTS} assistants, which is the most a team can have. Remove one first.`;

/** Refuse a new assistant when there are MAX_ASSISTANTS already. Pure. */
export function checkRoom(count: number): void {
  if (count >= MAX_ASSISTANTS) throw new AthenaInputError(FULL);
}

function words(input: z.infer<typeof inputSchema>, was?: Words): Words {
  const job = input.job !== undefined ? oneLine(input.job).slice(0, MAX_JOB) : (was?.job ?? "");
  if (!job) throw new AthenaInputError("job: what should it do?");
  const seed = input.avatar?.seed ?? was?.avatar.seed ?? newSeed();
  const name = input.name !== undefined ? oneLine(input.name).slice(0, MAX_NAME) : (was?.name ?? "");
  return {
    name: name || nameFromSeed(seed),
    job,
    instructions: input.instructions !== undefined ? input.instructions.trim() : (was?.instructions ?? ""),
    personality: input.personality ?? was?.personality ?? personalityFromSeed(seed),
    avatar: (input.avatar as AvatarSpec | undefined) ?? was?.avatar ?? avatarFromSeed(seed),
    // Set only by an import; kept through every change after.
    ...(was?.needs?.length ? { needs: cleanNeeds(was.needs) } : {}),
  };
}

/** Providers an imported file says it needs: slugs only, each once, at most MAX_ITEM_NEEDS. Pure. */
export function cleanNeeds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) && !out.includes(v) && out.length < MAX_ITEM_NEEDS) out.push(v);
  return out;
}

type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;

async function insertTrigger(run: Run, assistantId: string, t: CleanTrigger): Promise<void> {
  await run(`INSERT INTO team_triggers (assistant_id, kind, days, at_time, event, paused) VALUES ($1::uuid, $2, $3::smallint[], $4, $5::jsonb, $6)`, [assistantId, t.kind, t.days, t.time, t.event ? JSON.stringify(t.event) : null, t.paused]);
}

/** A trigger kept as Team keeps it once triggers are flows: its job flow (lib/team-flows.ts). */
async function insertJob(run: Run, assistantId: string, t: CleanTrigger, origin: "trigger" | "shared" = "trigger"): Promise<void> {
  const { flowTriggerOf, insertJobFlow } = await import("./team-flows");
  const trigger = flowTriggerOf(t);
  if (!trigger) throw new AthenaInputError("A schedule trigger needs days and a time");
  await insertJobFlow(run, { assistantId, trigger, paused: t.paused, origin });
}

/**
 * A new assistant, with its triggers. `routineId` marks one made from a routine (one assistant per routine). Once
 * triggers are flows, each trigger is kept as a job flow; `origin: "shared"` marks an imported one's.
 */
export async function createAssistant(raw: unknown, opts: { routineId?: string; now?: Date; origin?: "trigger" | "shared"; needs?: readonly string[] } = {}): Promise<TeamAssistant> {
  const input = parse(inputSchema, raw ?? {});
  const accounts = input.accounts ? await knownAccounts(input.accounts) : [];
  const needs = opts.origin === "shared" ? cleanNeeds(opts.needs) : [];
  const w: Words = { ...words(input), ...(needs.length ? { needs } : {}) };
  const triggers = (input.triggers ?? []).map(cleanTrigger);
  const models = input.models ? await checkAssistantModels(input.models) : {};
  const now = (opts.now ?? new Date()).toISOString();
  const asFlows = triggers.length > 0 && (await (await import("./team-flows")).triggersMoved());
  const id = await tx(async (run) => {
    const [{ n }] = await run<{ n: number }>(`SELECT count(*)::int AS n FROM team_assistants WHERE assignment_id IS NULL`);
    checkRoom(n);
    const [row] = await run<{ id: string }>(
      `INSERT INTO team_assistants (payload, allow, paused, routine_id, created_at, updated_at, web, models, origin, accounts)
       SELECT $1, $2::text[], $3, $4::uuid, $5, $5, $7, $8::jsonb, $9, $10::text[]
        WHERE (SELECT count(*) FROM team_assistants WHERE assignment_id IS NULL) < $6
       RETURNING id`,
      [sealWords(w), [...new Set(input.allow ?? [])], input.paused === true, opts.routineId ?? null, now, MAX_ASSISTANTS, input.web === true, JSON.stringify(models), opts.origin === "shared" ? "shared" : null, accounts],
    );
    if (!row) throw new AthenaInputError(FULL);
    for (const t of triggers) {
      if (asFlows) await insertJob(run, row.id, { ...t, id: undefined }, opts.origin);
      else await insertTrigger(run, row.id, { ...t, id: undefined });
    }
    return row.id;
  });
  return (await getAssistant(id))!;
}

/** Change any part of it. `triggers`, when given, replaces the set (see the file's head). */
export async function updateAssistant(id: unknown, raw: unknown): Promise<TeamAssistant> {
  const was = await getAssistant(id);
  if (!was) throw new AthenaInputError("That assistant isn't there any more", 404);
  const input = parse(inputSchema, raw ?? {});
  const w = words(input, was);
  const triggers = input.triggers?.map(cleanTrigger);
  if (triggers?.length) await noGuest(was.id);
  // Sent: the whole set, checked. Left out: kept as it is.
  const models = input.models ? await checkAssistantModels(input.models) : (was.models ?? {});
  const accounts = input.accounts ? await knownAccounts(input.accounts) : (was.accounts ?? []);
  const keep = new Set(was.triggers.map((t) => t.id));
  const jobs = new Map(was.triggers.filter((t) => t.flow_id).map((t) => [t.id, t]));
  const teamFlows = await import("./team-flows");
  const asFlows = !!triggers?.length && (await teamFlows.triggersMoved());
  const flowsNow = jobs.size ? new Map((await teamFlows.listJobFlows(was.id)).map((f) => [f.id, f])) : new Map();
  await tx(async (run) => {
    await run(`UPDATE team_assistants SET payload = $2, allow = $3::text[], paused = $4, web = $5, models = $6::jsonb, accounts = $7::text[], updated_at = now() WHERE id = $1::uuid`, [
      was.id,
      sealWords(w),
      input.allow ? [...new Set(input.allow)] : was.allow,
      input.paused ?? was.paused,
      input.web ?? was.web === true,
      JSON.stringify(models),
      accounts,
    ]);
    // Turned back on: an imported assistant's flows, made paused with it and never run, come on with it.
    if (was.paused && input.paused === false && !triggers) await run(`UPDATE flows SET paused = false, updated_at = now() WHERE assistant_id = $1::uuid AND origin = 'shared' AND paused AND last_run_at IS NULL`, [was.id]);
    if (!triggers) return;
    const kept = triggers.filter((t) => t.id && keep.has(t.id)).map((t) => t.id!);
    // Moved rows aren't the assistant's triggers any more (their flows are): only unmoved rows are replaced here.
    await run(`DELETE FROM team_triggers WHERE assistant_id = $1::uuid AND moved_at IS NULL AND NOT (id = ANY($2::uuid[]))`, [was.id, kept]);
    for (const id of jobs.keys()) if (!kept.includes(id)) await teamFlows.dropJobFlow(run, id);
    for (const t of triggers) {
      const job = t.id ? flowsNow.get(t.id) : undefined;
      if (job) {
        const trigger = teamFlows.flowTriggerOf(t);
        if (!trigger) throw new AthenaInputError("A schedule trigger needs days and a time");
        await teamFlows.writeJobFlow(run, job.id, job, trigger, t.paused);
      } else if (t.id && keep.has(t.id)) await writeTrigger(run, t.id, t);
      else if (asFlows) await insertJob(run, was.id, { ...t, id: undefined });
      else await insertTrigger(run, was.id, t);
    }
  });
  return (await getAssistant(was.id))!;
}

export async function deleteAssistant(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  // Its "From <Name>" cards go from Home with it (their key is the run's, and its runs go below).
  await qRaw(`UPDATE nudges SET dismissed_at = now() WHERE dismissed_at IS NULL AND rule = 'team' AND key IN (SELECT 'team:' || id::text FROM team_runs WHERE assistant_id = $1::uuid)`, [id]);
  // Its triggers go with it: its job flows too (a flow handed to it stays, as a plain flow again).
  if (UUID.test(id)) {
    const { listJobFlows, dropJobFlow } = await import("./team-flows");
    for (const f of await listJobFlows(id).catch(() => [])) await tx((run) => dropJobFlow(run, f.id));
  }
  const rows = await qRaw<{ id: string }>(`DELETE FROM team_assistants WHERE id = $1::uuid RETURNING id`, [id]);
  return rows.length > 0;
}

/** Keep what it remembers (the memory refresh after a chat or a run). */
export async function setMemory(id: string, memory: Partial<AssistantMemory>): Promise<AssistantMemory> {
  const clean = cleanMemory(memory);
  await qRaw(`UPDATE team_assistants SET memory = $2, memory_updated_at = now() WHERE id = $1::uuid`, [id, sealText(JSON.stringify(clean))]);
  return clean;
}

// ---------- triggers ----------

/** A guest has no triggers: it works on its assignment only. Kept on the team, it can have them. */
async function noGuest(assistantId: string): Promise<void> {
  const [row] = await qRaw<{ guest: boolean }>(`SELECT assignment_id IS NOT NULL AS guest FROM team_assistants WHERE id = $1::uuid`, [assistantId]);
  if (row?.guest) throw new AthenaInputError("A guest runs with its assignment. Keep it on the team to give it triggers.");
}

/** Every trigger row not yet moved to a flow, or one assistant's, oldest first. */
export async function listTriggers(assistantId?: string): Promise<TeamTrigger[]> {
  if (assistantId !== undefined && !UUID.test(assistantId)) return [];
  const rows = assistantId
    ? await q<TriggerRow>(`SELECT ${T_COLUMNS} FROM team_triggers WHERE assistant_id = $1::uuid AND moved_at IS NULL ORDER BY created_at, id`, [assistantId])
    : await q<TriggerRow>(`SELECT ${T_COLUMNS} FROM team_triggers WHERE moved_at IS NULL ORDER BY created_at, id`);
  return rows.map(presentTrigger);
}

export async function getTrigger(id: unknown): Promise<TeamTrigger | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<TriggerRow>(`SELECT ${T_COLUMNS} FROM team_triggers WHERE id = $1::uuid`, [id]);
  return row ? presentTrigger(row) : null;
}

export async function createTrigger(assistantId: string, raw: TeamTriggerInput | unknown): Promise<TeamTrigger> {
  const t = cleanTrigger(raw);
  const a = await getAssistant(assistantId);
  if (!a) throw new AthenaInputError("That assistant isn't there any more", 404);
  await noGuest(assistantId);
  if (a.triggers.length >= MAX_TRIGGERS) throw new AthenaInputError(`An assistant can have ${MAX_TRIGGERS} triggers at most`);
  // Once triggers are flows, a new one is a job flow (lib/team-flows.ts).
  if (await (await import("./team-flows")).triggersMoved()) {
    await tx((run) => insertJob(run, assistantId, { ...t, id: undefined }));
    const made = (await getAssistant(assistantId))!.triggers.filter((x) => x.flow_id).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
    return made;
  }
  const [row] = await q<TriggerRow>(
    `INSERT INTO team_triggers (assistant_id, kind, days, at_time, event, paused) VALUES ($1::uuid, $2, $3::smallint[], $4, $5::jsonb, $6) RETURNING ${T_COLUMNS}`,
    [assistantId, t.kind, t.days, t.time, t.event ? JSON.stringify(t.event) : null, t.paused],
  );
  return presentTrigger(row);
}

async function writeTrigger(run: Run, id: string, t: CleanTrigger): Promise<void> {
  await run(`UPDATE team_triggers SET kind = $2, days = $3::smallint[], at_time = $4, event = $5::jsonb, paused = $6 WHERE id = $1::uuid`, [id, t.kind, t.days, t.time, t.event ? JSON.stringify(t.event) : null, t.paused]);
}

/** Change a trigger: the whole of it, as cleanTrigger reads it. */
export async function updateTrigger(id: unknown, raw: TeamTriggerInput | unknown): Promise<TeamTrigger> {
  // A job flow, by its id: its trigger and on/off change, its steps stay.
  const teamFlows = await import("./team-flows");
  const job = typeof id === "string" && UUID.test(id) ? (await teamFlows.listJobFlows()).find((f) => f.id === id) : undefined;
  if (job) {
    const t = cleanTrigger(raw);
    const trigger = teamFlows.flowTriggerOf(t);
    if (!trigger) throw new AthenaInputError("A schedule trigger needs days and a time");
    await tx((run) => teamFlows.writeJobFlow(run, job.id, job, trigger, t.paused));
    return (await getAssistant(job.assistant_id))!.triggers.find((x) => x.id === job.id)!;
  }
  const was = await getTrigger(id);
  if (!was) throw new AthenaInputError("That trigger isn't there any more", 404);
  const t = cleanTrigger(raw);
  await tx((run) => writeTrigger(run, was.id, t));
  return (await getTrigger(was.id))!;
}

export async function deleteTrigger(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  const { listJobFlows, dropJobFlow } = await import("./team-flows");
  if ((await listJobFlows()).some((f) => f.id === id)) {
    await tx((run) => dropJobFlow(run, id));
    return true;
  }
  const rows = await qRaw<{ id: string }>(`DELETE FROM team_triggers WHERE id = $1::uuid RETURNING id`, [id]);
  return rows.length > 0;
}
