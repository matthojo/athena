/**
 * Layer 2 of the data layer: what's in motion. Commitments (open loops both
 * ways, plus decisions), interactions, facts, identities (recognising a person
 * across systems), the review inbox of agent suggestions, life admin, watch &
 * read and goals — and the reads built on them: person briefs, recall (ranked
 * full-text search), renewals and the weekly review.
 *
 * Same rules as lib/db.ts: the SQL lives here, archived rows are hidden from
 * every read except the Archived page, and agents never delete (archive and
 * delete-forever live in lib/db.ts and cover these kinds too).
 *
 * Provenance: anything an agent writes carries `source` (who), `source_ref`
 * (a URL or 'note:<uuid>'), `source_quote` (the exact words) and
 * `confidence` (0..1; null when the owner typed it). Agents write directly at
 * >= 0.8 and `propose` below that, which files a suggestion for review.
 *
 * The free text here is encrypted at rest like notes (SECURITY.md §11):
 * writes seal it through sealer(), reads come back opened from q(), and the
 * comparisons SQL used to make on it (dedupe by title, ranking, sorting by
 * name) happen in TypeScript, or on a blind index for identities.
 */
import { dayRecallHits } from "./days";
import { sameKey, type SuggestionEmail } from "./suggestion-similar";
import {
  AthenaInputError,
  byName,
  getOwnerTimeZone,
  getPerson,
  linkEntities,
  listEvents,
  notDeclined,
  listPeople,
  listStalePeople,
  lookupIndexes,
  matchKey,
  q,
  sealer,
  syncContentLinks,
  tx,
  upsertEvent,
  upsertPerson,
  type EventInput,
  type Person,
  type PersonInput,
  type Sealer,
  type UpcomingEvent,
} from "./db";
import { PlaceholderWrite, type IndexPurpose } from "./data-box";
import { isEncryptedPlaceholder } from "./encrypted";
import { addDays, daysBetween, isValidDate, isValidTimeZone, upcomingOccurrences, zonedToInstant, zonedToday } from "./dates";
import { headline, parseQuery, score, type SearchField } from "./text-search";
import { saveBooking, savePurchase, type BookingInput, type PurchaseInput } from "./trips";
import { parseProgress, READING_KINDS, READING_STATUSES, type ReadingKind, type ReadingProgress, type ReadingStatus } from "./watch-read";
import { MAX_TAGS, nameList, readMeta, TAG_LENGTH, type WatchMeta } from "./watch-meta";
import { searchableValues } from "./custom-fields";
import { autoContext, checkContextIds, rememberCorrection, type AutoContextInput } from "./todo-contexts";
import { cleanLinks, cleanPriority, cleanSteps, linkableText, readList, stepsText, TodoDetailsError, type TodoLink, type TodoPriority, type TodoStep } from "./todo-details";

// ---------- Shared shapes ----------

export interface PersonRef {
  id: string;
  name: string;
}

export interface Provenance {
  source?: string | null;
  source_ref?: string | null;
  source_quote?: string | null;
  confidence?: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AthenaInputError(`Invalid ${label} '${value}': must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** "YYYY-MM-DD" (validated), null to clear, undefined to leave alone. */
function localDate(raw: string | null | undefined, label: string): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const s = raw.trim();
  if (s === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !isValidDate(s)) throw new AthenaInputError(`Invalid ${label} '${raw}': use YYYY-MM-DD`);
  return s;
}

function confidence(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) throw new AthenaInputError("confidence must be between 0 and 1");
  return raw;
}

function personId(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (!UUID_RE.test(raw)) throw new AthenaInputError(`Invalid person id '${raw}'`);
  return raw;
}

function remindDays(days: number[] | undefined): number[] | undefined {
  if (!days) return undefined;
  const clean = [...new Set(days.map((d) => Math.floor(d)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 365))];
  return clean.sort((a, b) => b - a);
}

const personJson = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('id', ${alias}.id, 'name', ${alias}.name) END`;

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

function instant(raw: string | undefined, label: string): string | undefined {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new AthenaInputError(`Invalid ${label} '${raw}': use an ISO date or timestamp`);
  return d.toISOString();
}

// ---------- Commitments ----------

export type CommitmentKind = "todo" | "i_owe" | "waiting_on" | "decision";
export const COMMITMENT_KINDS: readonly CommitmentKind[] = ["todo", "i_owe", "waiting_on", "decision"];
/** The kinds that are loops (a decision is a record, not something to close). */
export const LOOP_KINDS: readonly CommitmentKind[] = ["todo", "i_owe", "waiting_on"];
export type CommitmentStatus = "open" | "done" | "dropped";
export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ["open", "done", "dropped"];

export interface Commitment {
  id: string;
  title: string;
  kind: CommitmentKind;
  status: CommitmentStatus;
  /** "YYYY-MM-DD", a calendar date (due/overdue are judged in the owner's zone), or null. */
  due_on: string | null;
  notes: string;
  person_id: string | null;
  /** The counterparty (owed to / waiting on / decided with); null if archived or none. */
  person: PersonRef | null;
  source: string | null;
  source_ref: string | null;
  source_quote: string | null;
  confidence: number | null;
  /** Its area and where/how (lib/todo-context.ts); null when none, or when that context was removed. */
  area_id: string | null;
  where_id: string | null;
  /** Athena set the context itself; the owner picking one clears it. */
  context_by_athena: boolean;
  /** Its checklist, in order (lib/todo-details.ts). */
  steps: TodoStep[];
  /** Web pages and things in Athena it points at. */
  links: TodoLink[];
  /** 0 none, 1 low, 2 medium, 3 high. */
  priority: TodoPriority;
  done_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommitmentInput extends Provenance {
  id?: string;
  title?: string;
  kind?: CommitmentKind;
  status?: CommitmentStatus;
  due_on?: string | null;
  notes?: string;
  person_id?: string | null;
  /** The owner's choice of context, by id (null clears). Remembered for the next to-do from the same sender. */
  area_id?: string | null;
  where_id?: string | null;
  /** The whole checklist (replaces what's there): strings or { id?, text, done? }. */
  steps?: unknown;
  /** The whole link list (replaces what's there): addresses or { id?, url, title? }. */
  links?: unknown;
  priority?: unknown;
  /**
   * When Athena files it (an agent, a collection, Ask): what it knows for
   * choosing a context (lib/todo-contexts.ts autoContext). Without area_id or
   * where_id, a new to-do from any source but 'manual' gets one when it's clear.
   */
  context?: Pick<AutoContextInput, "label" | "given" | "suggestion">;
}

const COMMITMENT_SELECT = `
  SELECT c.id, c.title, c.kind, c.status, to_char(c.due_on, 'YYYY-MM-DD') AS due_on, c.notes, c.person_id,
    ${personJson("p")} AS person,
    c.source, c.source_ref, c.source_quote, c.confidence,
    CASE WHEN ca.archived_at IS NULL THEN c.area_id END AS area_id,
    CASE WHEN cw.archived_at IS NULL THEN c.where_id END AS where_id,
    c.context_by_athena, c.steps, c.links, c.priority, c.done_at, c.archived_at, c.created_at, c.updated_at
  FROM commitments c
  LEFT JOIN people p ON p.id = c.person_id AND p.archived_at IS NULL
  LEFT JOIN todo_contexts ca ON ca.id = c.area_id
  LEFT JOIN todo_contexts cw ON cw.id = c.where_id`;

/** Steps and links come back from q() as opened JSON text (or null): as lists. */
function shapeCommitment(row: Commitment): Commitment {
  row.steps = readList(row.steps, cleanSteps);
  row.links = readList(row.links, cleanLinks);
  row.priority = (row.priority ?? 0) as TodoPriority;
  return row;
}

async function commitmentRows(text: string, params: unknown[]): Promise<Commitment[]> {
  return (await q<Commitment>(text, params)).map(shapeCommitment);
}

export async function getCommitment(id: string, opts: { includeArchived?: boolean } = {}): Promise<Commitment | null> {
  const [row] = await commitmentRows(`${COMMITMENT_SELECT} WHERE c.id = $1 AND ($2::boolean OR c.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return row ?? null;
}

/** The details of a write, tidied: undefined where the input left them alone. Bad input is a 400. */
function commitmentDetails(input: CommitmentInput): { steps?: TodoStep[]; links?: TodoLink[]; priority?: TodoPriority } {
  try {
    return {
      steps: input.steps === undefined ? undefined : cleanSteps(input.steps),
      links: input.links === undefined ? undefined : cleanLinks(input.links),
      priority: cleanPriority(input.priority),
    };
  } catch (error) {
    if (error instanceof TodoDetailsError) throw new AthenaInputError(error.message);
    throw error;
  }
}

/** Mentions in the description and links to things in Athena are the to-do's content edges. */
async function syncCommitmentLinks(c: Commitment): Promise<void> {
  if (isEncryptedPlaceholder(c.notes)) return;
  await syncContentLinks(c.id, linkableText(c), "commitment");
}

/**
 * Create (no id) or update a commitment. Marking one done stamps done_at;
 * reopening clears it. A new decision is recorded as done. With a
 * `source_ref`, an agent re-filing the same title from the same source gets
 * the existing row back instead of a duplicate.
 */
export async function upsertCommitment(input: CommitmentInput): Promise<Commitment> {
  const kind = oneOf(input.kind, COMMITMENT_KINDS, "kind");
  const status = oneOf(input.status, COMMITMENT_STATUSES, "status");
  const due = localDate(input.due_on, "due date");
  const who = personId(input.person_id);
  const conf = confidence(input.confidence);
  const title = input.title?.trim();
  const s = await sealer();
  const setArea = input.area_id !== undefined;
  const setAny = input.area_id !== undefined || input.where_id !== undefined;
  if (setAny) await checkContextIds(input);
  const details = commitmentDetails(input);

  if (input.id) {
    const [row] = await q<{ id: string; source: string | null; person_id: string | null; area_id: string | null; where_id: string | null; context_by_athena: boolean }>(
      `UPDATE commitments SET
         title = COALESCE($2, title),
         kind = COALESCE($3, kind),
         status = COALESCE($4, status),
         done_at = CASE WHEN $4::text IS NULL THEN done_at WHEN $4 = 'done' THEN COALESCE(done_at, now()) ELSE NULL END,
         due_on = CASE WHEN $5::boolean THEN $6::date ELSE due_on END,
         notes = COALESCE($7, notes),
         person_id = CASE WHEN $8::boolean THEN $9::uuid ELSE person_id END,
         area_id = CASE WHEN $10::boolean THEN $11::uuid ELSE area_id END,
         where_id = CASE WHEN $12::boolean THEN $13::uuid ELSE where_id END,
         context_by_athena = CASE WHEN $10::boolean OR $12::boolean THEN false ELSE context_by_athena END,
         steps = CASE WHEN $14::boolean THEN $15::jsonb ELSE steps END,
         links = CASE WHEN $16::boolean THEN $17::jsonb ELSE links END,
         priority = COALESCE($18::smallint, priority),
         updated_at = now()
       WHERE id = $1
       RETURNING id, source, person_id, area_id, where_id, context_by_athena`,
      [
        input.id,
        s.maybe(title || null),
        kind ?? null,
        status ?? null,
        due !== undefined,
        due ?? null,
        s.maybe(input.notes ?? null),
        who !== undefined,
        who ?? null,
        setArea,
        input.area_id ?? null,
        input.where_id !== undefined,
        input.where_id ?? null,
        details.steps !== undefined,
        details.steps ? s.json(details.steps) : null,
        details.links !== undefined,
        details.links ? s.json(details.links) : null,
        details.priority ?? null,
      ],
    );
    if (!row) throw new AthenaInputError(`Commitment ${input.id} not found`, 404);
    // The owner changed the context of one Athena filed: the next from the same sender follows it.
    if (setArea || input.where_id !== undefined) await rememberCorrection(row);
    const updated = (await getCommitment(row.id, { includeArchived: true }))!;
    if (input.notes !== undefined || details.links !== undefined) await syncCommitmentLinks(updated);
    return updated;
  }

  if (!title) throw new AthenaInputError("A new commitment needs a title");
  if (input.source_ref) {
    // Titles are encrypted: compare the few filed from the same source here.
    const filed = await q<{ id: string; title: string }>(
      `SELECT id, title FROM commitments WHERE source_ref = $1 AND archived_at IS NULL ORDER BY created_at`,
      [input.source_ref],
    );
    const existing = filed.find((c) => c.title.toLowerCase() === title.toLowerCase());
    if (existing) return (await getCommitment(existing.id))!;
  }
  const finalKind = kind ?? "todo";
  const finalStatus = status ?? (finalKind === "decision" ? "done" : "open");
  const source = input.source ?? "manual";
  // The owner's own pick, else (for anything Athena files) a context when it's clear. Decisions get none.
  let ctx: { area_id: string | null; where_id: string | null; by_athena: boolean } = { area_id: input.area_id ?? null, where_id: input.where_id ?? null, by_athena: false };
  if (!setAny && source !== "manual" && finalKind !== "decision") {
    const chosen = await autoContext({ title, notes: input.notes, source, person_id: who ?? null, ...input.context });
    ctx = { ...chosen, by_athena: !!(chosen.area_id || chosen.where_id) };
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO commitments (title, kind, status, done_at, due_on, notes, person_id, source, source_ref, source_quote, confidence, area_id, where_id, context_by_athena, steps, links, priority)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'done' THEN now() END, $4::date, $5, $6::uuid, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14::jsonb, $15::jsonb, $16)
     RETURNING id`,
    [
      s.text(title),
      finalKind,
      finalStatus,
      due ?? null,
      s.text(input.notes ?? ""),
      who ?? null,
      source,
      input.source_ref ?? null,
      s.maybe(input.source_quote ?? null),
      conf,
      ctx.area_id,
      ctx.where_id,
      ctx.by_athena,
      details.steps?.length ? s.json(details.steps) : null,
      details.links?.length ? s.json(details.links) : null,
      details.priority ?? 0,
    ],
  );
  const created = (await getCommitment(row.id))!;
  if (created.notes || created.links.length) await syncCommitmentLinks(created);
  return created;
}

export async function listCommitments(
  opts: {
    status?: CommitmentStatus | "all";
    kinds?: CommitmentKind[];
    personId?: string;
    doneSince?: Date;
    dueBy?: string;
    limit?: number;
  } = {},
): Promise<Commitment[]> {
  return commitmentRows(
    `${COMMITMENT_SELECT}
     WHERE c.archived_at IS NULL
       AND ($1::text = 'all' OR c.status = $1)
       AND (cardinality($2::text[]) = 0 OR c.kind = ANY($2::text[]))
       AND ($3::uuid IS NULL OR c.person_id = $3::uuid)
       AND ($4::timestamptz IS NULL OR c.done_at >= $4::timestamptz)
       AND ($5::date IS NULL OR c.due_on <= $5::date)
     ORDER BY (c.status = 'open') DESC, c.due_on ASC NULLS LAST, COALESCE(c.done_at, c.created_at) DESC
     LIMIT $6`,
    [
      opts.status ?? "open",
      opts.kinds ?? [],
      opts.personId ?? null,
      opts.doneSince?.toISOString() ?? null,
      opts.dueBy ?? null,
      opts.limit ?? 200,
    ],
  );
}

/** Everything still open: todos, what I owe, what I'm waiting on. Soonest due first. */
export async function listOpenLoops(opts: { personId?: string; limit?: number } = {}): Promise<Commitment[]> {
  return listCommitments({ status: "open", kinds: [...LOOP_KINDS], personId: opts.personId, limit: opts.limit });
}

/** Open loops due on or before `date` (overdue included). */
export async function listDueCommitments(date: string): Promise<Commitment[]> {
  return listCommitments({ status: "open", kinds: [...LOOP_KINDS], dueBy: date });
}

/** What I've been waiting on for more than `days` days without it moving. */
export async function listWaitingQuiet(days = 5): Promise<Commitment[]> {
  return commitmentRows(
    `${COMMITMENT_SELECT}
     WHERE c.archived_at IS NULL AND c.status = 'open' AND c.kind = 'waiting_on'
       AND c.updated_at < now() - make_interval(days => $1::int)
     ORDER BY c.updated_at ASC`,
    [days],
  );
}

// ---------- Interactions ----------

export type InteractionChannel = "meeting" | "call" | "message" | "email" | "in_person" | "other";
export const INTERACTION_CHANNELS: readonly InteractionChannel[] = ["meeting", "call", "message", "email", "in_person", "other"];

export interface Interaction {
  id: string;
  at: string;
  channel: InteractionChannel;
  summary: string;
  source: string | null;
  source_ref: string | null;
  /** Live people it was with, by name. */
  people: PersonRef[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InteractionInput {
  id?: string;
  /** ISO timestamp; defaults to now on create. */
  at?: string;
  channel?: InteractionChannel;
  summary?: string;
  /** Who it was with. Required (at least one) on create; replaces the set on update. */
  person_ids?: string[];
  source?: string | null;
  source_ref?: string | null;
}

const INTERACTION_SELECT = `
  SELECT i.id, i.at, i.channel, i.summary, i.source, i.source_ref, i.archived_at, i.created_at, i.updated_at,
    COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name))
                FROM interaction_people ip JOIN people p ON p.id = ip.person_id AND p.archived_at IS NULL
               WHERE ip.interaction_id = i.id), '[]'::json) AS people
  FROM interactions i`;

/** Who each was with, alphabetical (names are encrypted, so sorted here). */
function withPeopleSorted(rows: Interaction[]): Interaction[] {
  for (const r of rows) r.people.sort(byName((p) => p.name));
  return rows;
}

export async function getInteraction(id: string, opts: { includeArchived?: boolean } = {}): Promise<Interaction | null> {
  const [row] = withPeopleSorted(
    await q<Interaction>(`${INTERACTION_SELECT} WHERE i.id = $1 AND ($2::boolean OR i.archived_at IS NULL)`, [id, opts.includeArchived ?? false]),
  );
  return row ?? null;
}

/**
 * Log that you spoke with someone (or edit a logged interaction). Each person
 * it's with has last_contacted_at moved forward to `at` — never back — which
 * is what clears them from catch-ups. With a `source_ref`, re-logging the same
 * meeting from the same source updates it rather than duplicating it.
 */
export async function logInteraction(input: InteractionInput): Promise<Interaction> {
  const channel = oneOf(input.channel, INTERACTION_CHANNELS, "channel");
  const at = instant(input.at, "time");
  const people = input.person_ids?.map((p) => personId(p) as string);
  const s = await sealer();

  const id = await tx(async (run) => {
    let id = input.id;
    if (!id && input.source_ref) {
      const [existing] = await run<{ id: string }>(
        `SELECT id FROM interactions WHERE source_ref = $1 AND archived_at IS NULL LIMIT 1`,
        [input.source_ref],
      );
      id = existing?.id;
    }
    if (id) {
      const [row] = await run<{ id: string }>(
        `UPDATE interactions SET
           at = COALESCE($2::timestamptz, at),
           channel = COALESCE($3, channel),
           summary = COALESCE($4, summary),
           updated_at = now()
         WHERE id = $1 RETURNING id`,
        [id, at ?? null, channel ?? null, s.maybe(input.summary ?? null)],
      );
      if (!row) throw new AthenaInputError(`Interaction ${id} not found`, 404);
      if (people && people.length > 0) {
        await run(`DELETE FROM interaction_people WHERE interaction_id = $1 AND NOT (person_id = ANY($2::uuid[]))`, [id, people]);
      }
    } else {
      if (!people || people.length === 0) throw new AthenaInputError("An interaction needs at least one person (person_ids)");
      const [row] = await run<{ id: string }>(
        `INSERT INTO interactions (at, channel, summary, source, source_ref)
         VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5) RETURNING id`,
        [at ?? null, channel ?? "other", s.text(input.summary ?? ""), input.source ?? "manual", input.source_ref ?? null],
      );
      id = row.id;
    }
    if (people && people.length > 0) {
      await run(
        `INSERT INTO interaction_people (interaction_id, person_id)
         SELECT $1, id FROM people WHERE id = ANY($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [id, people],
      );
      const [{ n }] = await run<{ n: number }>(`SELECT count(*)::int AS n FROM interaction_people WHERE interaction_id = $1`, [id]);
      if (n === 0) throw new AthenaInputError("None of those people exist", 404);
    }
    await run(
      `UPDATE people p SET last_contacted_at = i.at, updated_at = now()
         FROM interactions i JOIN interaction_people ip ON ip.interaction_id = i.id
        WHERE i.id = $1 AND p.id = ip.person_id
          AND (p.last_contacted_at IS NULL OR p.last_contacted_at < i.at)`,
      [id],
    );
    return id;
  });
  return (await getInteraction(id, { includeArchived: true }))!;
}

export async function listInteractions(
  opts: { personId?: string; since?: Date; until?: Date; limit?: number } = {},
): Promise<Interaction[]> {
  return withPeopleSorted(await q<Interaction>(
    `${INTERACTION_SELECT}
     WHERE i.archived_at IS NULL
       AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM interaction_people ip WHERE ip.interaction_id = i.id AND ip.person_id = $1::uuid))
       AND ($2::timestamptz IS NULL OR i.at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR i.at < $3::timestamptz)
     ORDER BY i.at DESC
     LIMIT $4`,
    [opts.personId ?? null, opts.since?.toISOString() ?? null, opts.until?.toISOString() ?? null, opts.limit ?? 50],
  ));
}

// ---------- Facts ----------

export type FactSubjectKind = "me" | "person" | "place" | "organisation";
export const FACT_SUBJECT_KINDS: readonly FactSubjectKind[] = ["me", "person", "place", "organisation"];

export interface Fact {
  id: string;
  subject_kind: FactSubjectKind;
  subject_id: string | null;
  key: string;
  value: string;
  source: string | null;
  source_ref: string | null;
  source_quote: string | null;
  confidence: number | null;
  observed_at: string;
  superseded_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactInput extends Provenance {
  subject_kind: FactSubjectKind;
  subject_id?: string | null;
  key: string;
  value: string;
  observed_at?: string;
}

const FACT_COLUMNS = `id, subject_kind, subject_id, key, value, source, source_ref, source_quote, confidence,
  observed_at, superseded_at, archived_at, created_at, updated_at`;

const SUBJECT_TABLE: Record<Exclude<FactSubjectKind, "me">, string> = {
  person: "people",
  place: "places",
  organisation: "organisations",
};

/**
 * Who is writing a fact. `byOwner` marks the owner's own words (the app, Ask)
 * and an accepted suggestion; anything else writing about the owner ('me')
 * with a source or a confidence is treated as learned.
 */
export interface FactWriter {
  byOwner?: boolean;
}

/** A `me` fact from anyone but the owner: always the Review inbox, whatever its confidence (docs/notes/profile-memory-plan.md). */
function learnedAboutOwner(input: FactInput, writer: FactWriter): boolean {
  if (writer.byOwner) return false;
  const source = input.source ?? null;
  return (source !== null && source !== "manual") || (input.confidence ?? null) !== null;
}

/**
 * Record a fact. One current value per subject + key (case-insensitive): the
 * same value again just refreshes observed_at; a new value supersedes the
 * old one, which stays as history.
 *
 * A fact about the owner ('me') from anything but the owner is filed as a
 * suggestion instead and that Suggestion is returned, so an owner-typed value
 * only changes by the owner's hand or an accepted suggestion.
 */
export async function addFact(input: FactInput, writer: FactWriter & { byOwner: true }): Promise<Fact>;
export async function addFact(input: FactInput, writer?: FactWriter): Promise<Fact | Suggestion>;
export async function addFact(input: FactInput, writer: FactWriter = {}): Promise<Fact | Suggestion> {
  const kind = oneOf(input.subject_kind, FACT_SUBJECT_KINDS, "subject_kind");
  if (!kind) throw new AthenaInputError("A fact needs a subject_kind (me, person, place or organisation)");
  const subject = kind === "me" ? null : (input.subject_id ?? null);
  if (kind !== "me") {
    if (!subject || !UUID_RE.test(subject)) throw new AthenaInputError("A fact about a person, place or organisation needs its subject_id");
    const [exists] = await q<{ id: string }>(`SELECT id FROM ${SUBJECT_TABLE[kind]} WHERE id = $1`, [subject]);
    if (!exists) throw new AthenaInputError(`${kind} ${subject} not found`, 404);
  }
  const key = tidy(input.key ?? "");
  const value = (input.value ?? "").trim();
  if (!key || !value) throw new AthenaInputError("A fact needs a key and a value");
  const observed = instant(input.observed_at, "observed_at");
  const conf = confidence(input.confidence);
  if (kind === "me" && learnedAboutOwner(input, writer)) {
    const [current] = await q<Fact>(
      `SELECT ${FACT_COLUMNS} FROM facts WHERE subject_kind = 'me' AND lower(key) = lower($1) AND superseded_at IS NULL AND archived_at IS NULL
       ORDER BY observed_at DESC LIMIT 1`,
      [key],
    );
    // Already what Athena has: nothing to ask.
    if (current && current.value.trim().toLowerCase() === value.toLowerCase()) return current;
    return propose({
      op: "fact",
      summary: `About you · ${current?.key ?? key}: ${value}`,
      payload: { subject_kind: "me", key: current?.key ?? key, value, ...(observed ? { observed_at: observed } : {}) },
      source: input.source ?? null,
      source_ref: input.source_ref ?? null,
      source_quote: input.source_quote ?? null,
      confidence: conf,
    });
  }
  const s = await sealer();

  return tx(async (run) => {
    const [current] = await run<Fact>(
      `SELECT ${FACT_COLUMNS} FROM facts
       WHERE subject_kind = $1 AND subject_id IS NOT DISTINCT FROM $2::uuid AND lower(key) = lower($3)
         AND superseded_at IS NULL AND archived_at IS NULL
       ORDER BY observed_at DESC LIMIT 1`,
      [kind, subject, key],
    );
    if (current && current.value.trim().toLowerCase() === value.toLowerCase()) {
      const [same] = await run<Fact>(
        `UPDATE facts SET observed_at = GREATEST(observed_at, COALESCE($2::timestamptz, now())), updated_at = now()
         WHERE id = $1 RETURNING ${FACT_COLUMNS}`,
        [current.id, observed ?? null],
      );
      return same;
    }
    const [fact] = await run<Fact>(
      `INSERT INTO facts (subject_kind, subject_id, key, value, source, source_ref, source_quote, confidence, observed_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
       RETURNING ${FACT_COLUMNS}`,
      [
        kind,
        subject,
        current?.key ?? key,
        s.text(value),
        input.source ?? "manual",
        input.source_ref ?? null,
        s.maybe(input.source_quote ?? null),
        conf,
        observed ?? null,
      ],
    );
    if (current) {
      await run(`UPDATE facts SET superseded_at = now(), superseded_by = $2, updated_at = now() WHERE id = $1`, [current.id, fact.id]);
    }
    return fact;
  });
}

/** Correct a fact in place (the owner fixing a typo): no new history row. */
export async function updateFact(id: string, patch: { key?: string; value?: string }): Promise<Fact> {
  const key = patch.key === undefined ? null : tidy(patch.key);
  const value = patch.value === undefined ? null : patch.value.trim();
  if (key === "" || value === "") throw new AthenaInputError("A fact needs a key and a value");
  const s = await sealer();
  const [fact] = await q<Fact>(
    `UPDATE facts SET key = COALESCE($2, key), value = COALESCE($3, value), updated_at = now()
     WHERE id = $1 RETURNING ${FACT_COLUMNS}`,
    [id, key, s.maybe(value)],
  );
  if (!fact) throw new AthenaInputError(`Fact ${id} not found`, 404);
  return fact;
}

export async function getFact(id: string, opts: { includeArchived?: boolean } = {}): Promise<Fact | null> {
  const [fact] = await q<Fact>(`SELECT ${FACT_COLUMNS} FROM facts WHERE id = $1 AND ($2::boolean OR archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return fact ?? null;
}

/** Current facts about a subject (history too if asked), alphabetical by key. */
export async function listFacts(opts: { subjectKind: FactSubjectKind; subjectId?: string | null; history?: boolean }): Promise<Fact[]> {
  return q<Fact>(
    `SELECT ${FACT_COLUMNS} FROM facts
     WHERE subject_kind = $1 AND subject_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL
       AND ($3::boolean OR superseded_at IS NULL)
     ORDER BY lower(key), observed_at DESC`,
    [opts.subjectKind, opts.subjectKind === "me" ? null : (opts.subjectId ?? null), opts.history ?? false],
  );
}

/** Current details about people that came from one source ("assistant": what the owner told Ask to remember), newest first. */
export async function listFactsFrom(source: string, opts: { subjectKind?: FactSubjectKind; limit?: number } = {}): Promise<Fact[]> {
  return q<Fact>(
    `SELECT ${FACT_COLUMNS} FROM facts
     WHERE source = $1 AND ($2::text IS NULL OR subject_kind = $2) AND archived_at IS NULL AND superseded_at IS NULL
     ORDER BY observed_at DESC LIMIT $3`,
    [source, opts.subjectKind ?? null, opts.limit ?? 200],
  );
}

// ---------- Identities (entity resolution) ----------

export type IdentityKind = "email" | "phone" | "slack" | "alias" | "other";
export const IDENTITY_KINDS: readonly IdentityKind[] = ["email", "phone", "slack", "alias", "other"];

export interface Identity {
  id: string;
  person_id: string;
  kind: IdentityKind;
  value: string;
  created_at: string;
}

/** The comparable form of an identifier: lowercased email, digits-only phone, bare Slack handle. */
export function normaliseIdentity(kind: IdentityKind, raw: string): string {
  const s = raw.trim();
  switch (kind) {
    case "email":
      return s.toLowerCase();
    case "phone": {
      const plus = s.startsWith("+") || s.startsWith("00");
      const digits = s.replace(/\D/g, "").replace(/^00/, "");
      return plus ? `+${digits}` : digits;
    }
    case "slack":
      return s.replace(/^@/, "").toLowerCase();
    default:
      return tidy(s).toLowerCase();
  }
}

const IDENTITY_COLUMNS = "id, person_id, kind, value, created_at";

/**
 * Identities are encrypted, so lookups go by blind index: the value
 * normalised as resolvePerson compares it (an alias like a name, a phone by
 * its last ten digits) and keyed per kind.
 */
const IDENTITY_INDEX: Record<IdentityKind, { purpose: IndexPurpose; key: (normalised: string) => string }> = {
  email: { purpose: "email", key: (v) => v },
  phone: { purpose: "phone", key: matchKey.phone },
  slack: { purpose: "slack", key: (v) => v },
  alias: { purpose: "name", key: (v) => v },
  other: { purpose: "other", key: (v) => v },
};

/** An identity's blind index (also used by lib/encryption.ts when it seals existing rows). */
export const identityIndex = (s: Sealer, kind: IdentityKind, normalised: string) =>
  s.index(IDENTITY_INDEX[kind].purpose, IDENTITY_INDEX[kind].key(normalised));
const identityLookups = (kind: IdentityKind, normalised: string) =>
  lookupIndexes(IDENTITY_INDEX[kind].purpose, IDENTITY_INDEX[kind].key(normalised));

/** Matches an identity by blind index ($2), or a row not encrypted yet by its plain value ($3). */
const identityMatch = (t: string) =>
  `(${t}.value_bidx = ANY($2::text[]) OR (${t}.value_bidx IS NULL AND ${t}.value NOT LIKE 'enc:%' AND ${t}.value = $3))`;

export async function listIdentities(personId: string): Promise<Identity[]> {
  const rows = await q<Identity>(`SELECT ${IDENTITY_COLUMNS} FROM identities WHERE person_id = $1`, [personId]);
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value));
}

/** Teach Athena another way to recognise a person. Errors if it already belongs to someone else. */
export async function addIdentity(input: { person_id: string; kind: IdentityKind; value: string }): Promise<Identity> {
  const kind = oneOf(input.kind, IDENTITY_KINDS, "identity kind");
  if (!kind) throw new AthenaInputError("An identity needs a kind (email, phone, slack, alias or other)");
  const who = personId(input.person_id);
  if (!who) throw new AthenaInputError("An identity needs a person_id");
  const value = normaliseIdentity(kind, input.value ?? "");
  if (!value) throw new AthenaInputError("An identity needs a value");
  if (!(await getPerson(who))) throw new AthenaInputError(`Person ${who} not found`, 404);
  const s = await sealer();
  const [existing] = await q<Identity & { owner: string }>(
    `SELECT i.id, i.person_id, i.kind, i.value, i.created_at, p.name AS owner
     FROM identities i JOIN people p ON p.id = i.person_id
     WHERE i.kind = $1 AND ${identityMatch("i")}
     LIMIT 1`,
    [kind, identityLookups(kind, value), value],
  );
  if (existing) {
    if (existing.person_id !== who) throw new AthenaInputError(`That ${kind} already belongs to ${existing.owner}`);
    const { owner: _owner, ...identity } = existing;
    return identity;
  }
  const [created] = await q<Identity>(
    `INSERT INTO identities (person_id, kind, value, value_bidx) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, value) DO NOTHING RETURNING ${IDENTITY_COLUMNS}`,
    [who, kind, s.text(value), identityIndex(s, kind, value)],
  );
  if (!created) throw new AthenaInputError(`That ${kind} already belongs to someone else`);
  return created;
}

/** Forget an identity (app only — a mapping row, not your data). */
export async function removeIdentity(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(`DELETE FROM identities WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

export type MatchKind = "email" | "phone" | "slack" | "alias" | "name" | "partial_name";

export interface PersonMatch {
  person: Person;
  matched_on: MatchKind;
}

/**
 * Who is this? Checks every identifier given against identities and the
 * people table (email, phone, exact name, alias), strongest match first, then
 * falls back to partial name matches. Agents call this before writing about
 * someone so the same person isn't created twice.
 *
 * Exact matches go by blind index ($5–$8), or by plain value for rows not
 * encrypted yet; partial names are matched here against decrypted names.
 */
export async function resolvePerson(input: { email?: string; phone?: string; slack?: string; name?: string }): Promise<PersonMatch[]> {
  const email = input.email ? normaliseIdentity("email", input.email) : null;
  const phone = input.phone ? normaliseIdentity("phone", input.phone).replace(/^\+/, "") : null;
  const slack = input.slack ? normaliseIdentity("slack", input.slack) : null;
  const name = input.name ? normaliseIdentity("alias", input.name) : null;
  if (!email && !phone && !slack && !name) throw new AthenaInputError("Give at least one of email, phone, slack or name");

  const plain = (col: string) => `${col}_bidx IS NULL AND ${col} NOT LIKE 'enc:%'`;
  const rows = await q<{ id: string; matched_on: MatchKind; strength: number }>(
    `WITH hits AS (
       SELECT person_id AS id, 'email' AS matched_on, 1 AS strength FROM identities
         WHERE $1::text IS NOT NULL AND kind = 'email' AND (value_bidx = ANY($5::text[]) OR (${plain("value")} AND value = $1))
       UNION ALL SELECT id, 'email', 1 FROM people
         WHERE $1::text IS NOT NULL AND (email_bidx = ANY($5::text[]) OR (${plain("email")} AND lower(trim(email)) = $1))
       UNION ALL SELECT person_id, 'phone', 2 FROM identities
         WHERE $2::text IS NOT NULL AND length($2) >= 7 AND kind = 'phone'
           AND (value_bidx = ANY($6::text[]) OR (${plain("value")} AND right(replace(value, '+', ''), 10) = right($2, 10)))
       UNION ALL SELECT id, 'phone', 2 FROM people
         WHERE $2::text IS NOT NULL AND length($2) >= 7 AND phone <> ''
           AND (phone_bidx = ANY($6::text[]) OR (${plain("phone")} AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = right($2, 10)))
       UNION ALL SELECT person_id, 'slack', 3 FROM identities
         WHERE $3::text IS NOT NULL AND kind = 'slack' AND (value_bidx = ANY($7::text[]) OR (${plain("value")} AND value = $3))
       UNION ALL SELECT id, 'name', 4 FROM people
         WHERE $4::text IS NOT NULL AND (name_bidx = ANY($8::text[]) OR (${plain("name")} AND lower(trim(name)) = $4))
       UNION ALL SELECT person_id, 'alias', 4 FROM identities
         WHERE $4::text IS NOT NULL AND kind = 'alias' AND (value_bidx = ANY($8::text[]) OR (${plain("value")} AND value = $4))
     )
     SELECT DISTINCT ON (h.id) h.id, h.matched_on, h.strength FROM hits h
     JOIN people p ON p.id = h.id AND p.archived_at IS NULL
     ORDER BY h.id, h.strength`,
    [
      email,
      phone,
      slack,
      name,
      email ? lookupIndexes("email", email) : [],
      phone ? lookupIndexes("phone", matchKey.phone(phone)) : [],
      slack ? lookupIndexes("slack", slack) : [],
      name ? lookupIndexes("name", name) : [],
    ],
  );
  const best = new Map(rows.map((r) => [r.id, r]));
  if (name && name.length >= 3) {
    const everyone = await q<{ id: string; name: string }>(`SELECT id, name FROM people WHERE archived_at IS NULL`);
    for (const p of everyone) {
      const theirs = matchKey.name(p.name);
      if (!best.has(p.id) && theirs !== name && theirs.includes(name)) best.set(p.id, { id: p.id, matched_on: "partial_name", strength: 5 });
    }
  }
  const ranked = [...best.values()].sort((a, b) => a.strength - b.strength).slice(0, 8);
  const people = await Promise.all(ranked.map((r) => getPerson(r.id)));
  return ranked.flatMap((r, i) => (people[i] ? [{ person: people[i]!, matched_on: r.matched_on }] : []));
}

/** How findPeople matched someone: resolvePerson's ways, or one of the wider ones. */
export type FoundOn = MatchKind | "email_domain" | "organisation" | "relationship" | "field";

export interface PersonFound {
  person: Person;
  matched_on: FoundOn;
}

/** Strongest first: an email, a phone, a name, then a domain, partial names, where they work, who they are, a field. */
const FOUND_STRENGTH: Record<FoundOn, number> = {
  email: 1,
  phone: 2,
  slack: 3,
  email_domain: 3,
  name: 4,
  alias: 4,
  partial_name: 5,
  organisation: 6,
  relationship: 7,
  field: 8,
};

/** Every word of the query is in the text, any case; "colleagues" finds "colleague". */
function hasWords(text: string, words: string[]): boolean {
  if (!text || isEncryptedPlaceholder(text)) return false;
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

/**
 * Everyone in Athena who fits some words, for Ask: a name, nickname or whole
 * email or phone (resolvePerson), an email domain ("@brightwater.co" or
 * "netlify.com", their own email or one of their identities), the
 * organisation they work at, their relationship ("colleague"), or a value in
 * one of the owner's own fields. Strongest match first, then by name. All of
 * that is encrypted, so people are read and compared here, not in SQL.
 */
export async function findPeople(query: string): Promise<PersonFound[]> {
  const raw = query.trim();
  if (!raw) throw new AthenaInputError("Say who to look for");
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
  const domain = isEmail ? undefined : /^\*?@?((?:[a-z0-9-]+\.)+[a-z]{2,})$/i.exec(raw)?.[1]?.toLowerCase();
  const isPhone = /^\+?[\d\s().-]{7,}$/.test(raw) && raw.replace(/\D/g, "").length >= 7;
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter(Boolean);

  const best = new Map<string, FoundOn>();
  const add = (id: string, on: FoundOn) => {
    const had = best.get(id);
    if (!had || FOUND_STRENGTH[on] < FOUND_STRENGTH[had]) best.set(id, on);
  };
  if (!domain) {
    for (const m of await resolvePerson(isEmail ? { email: raw } : isPhone ? { phone: raw } : { name: raw })) add(m.person.id, m.matched_on);
  }

  const people = await listPeople(Number.MAX_SAFE_INTEGER);
  if (domain) {
    const others = await q<{ person_id: string; value: string }>(`SELECT person_id, value FROM identities WHERE kind = 'email'`);
    const emails = new Map<string, string[]>();
    for (const i of others) emails.set(i.person_id, [...(emails.get(i.person_id) ?? []), i.value]);
    const atDomain = (email: string) => {
      if (!email || isEncryptedPlaceholder(email)) return false;
      const host = email.trim().toLowerCase().split("@")[1] ?? "";
      return host === domain || host.endsWith(`.${domain}`);
    };
    for (const p of people) if ([p.email, ...(emails.get(p.id) ?? [])].some(atDomain)) add(p.id, "email_domain");
  } else if (!isEmail && !isPhone) {
    const fields = await searchableValues(["person"]);
    for (const p of people) {
      if (p.organisation && hasWords(p.organisation.name, words)) add(p.id, "organisation");
      else if (hasWords(p.relationship, words)) add(p.id, "relationship");
      else if (hasWords(fields.get(p.id) ?? "", words)) add(p.id, "field");
    }
  }

  const byId = new Map(people.map((p) => [p.id, p]));
  const named = byName<PersonFound>((f) => f.person.name);
  return [...best.entries()]
    .flatMap(([id, matched_on]) => (byId.has(id) ? [{ person: byId.get(id)!, matched_on }] : []))
    .sort((a, b) => FOUND_STRENGTH[a.matched_on] - FOUND_STRENGTH[b.matched_on] || named(a, b));
}

/**
 * Fold a duplicate person into the one you keep, in one transaction: links,
 * note mentions, interactions, commitments, facts, identities and dates move
 * across; the duplicate's name, email and phone become identities of the
 * keeper; the duplicate is archived (never deleted). App only.
 */
export async function mergePeople(keepId: string, duplicateId: string): Promise<Person> {
  if (keepId === duplicateId) throw new AthenaInputError("Pick two different people to merge");
  const [keep, dup] = await Promise.all([getPerson(keepId), getPerson(duplicateId)]);
  if (!keep) throw new AthenaInputError(`Person ${keepId} not found`, 404);
  if (!dup) throw new AthenaInputError(`Person ${duplicateId} not found`, 404);
  // Folding an unreadable field into the keeper would replace ciphertext that might still be recoverable.
  if ([keep, dup].some((p) => [p.name, p.email, p.phone, p.relationship, p.notes].some(isEncryptedPlaceholder))) {
    throw new PlaceholderWrite();
  }
  const s = await sealer();

  await tx(async (run) => {
    // Graph: drop edges between the two, and ones the keeper already has; re-point the rest.
    await run(
      `DELETE FROM edges e
       WHERE (e.source_type = 'person' AND e.source_id = $2 AND e.target_type = 'person' AND e.target_id = $1)
          OR (e.source_type = 'person' AND e.source_id = $1 AND e.target_type = 'person' AND e.target_id = $2)
          OR (e.source_type = 'person' AND e.source_id = $2 AND EXISTS (
               SELECT 1 FROM edges k WHERE k.source_type = 'person' AND k.source_id = $1
                 AND k.target_type = e.target_type AND k.target_id = e.target_id AND k.relation = e.relation))
          OR (e.target_type = 'person' AND e.target_id = $2 AND EXISTS (
               SELECT 1 FROM edges k WHERE k.target_type = 'person' AND k.target_id = $1
                 AND k.source_type = e.source_type AND k.source_id = e.source_id AND k.relation = e.relation))`,
      [keepId, duplicateId],
    );
    await run(`UPDATE edges SET source_id = $1 WHERE source_type = 'person' AND source_id = $2`, [keepId, duplicateId]);
    await run(`UPDATE edges SET target_id = $1 WHERE target_type = 'person' AND target_id = $2`, [keepId, duplicateId]);
    // Note bodies: point athena:// links at the keeper so re-saving a note keeps its backlink.
    // Bodies are encrypted, so they're read and rewritten here (a rare, app-only action).
    const from = `athena://person/${duplicateId}`;
    for (const note of await run<{ id: string; body: string }>(`SELECT id, body FROM notes`)) {
      if (!note.body.includes(from)) continue;
      await run(`UPDATE notes SET body = $2, updated_at = now() WHERE id = $1`, [
        note.id,
        s.text(note.body.split(from).join(`athena://person/${keepId}`)),
      ]);
    }
    await run(
      `INSERT INTO interaction_people (interaction_id, person_id)
       SELECT interaction_id, $1 FROM interaction_people WHERE person_id = $2 ON CONFLICT DO NOTHING`,
      [keepId, duplicateId],
    );
    await run(`DELETE FROM interaction_people WHERE person_id = $1`, [duplicateId]);
    await run(`UPDATE commitments SET person_id = $1, updated_at = now() WHERE person_id = $2`, [keepId, duplicateId]);
    await run(`UPDATE reading_items SET recommended_by = $1, updated_at = now() WHERE recommended_by = $2`, [keepId, duplicateId]);
    // Facts: the keeper's current value wins a clash; the duplicate's becomes history.
    await run(
      `UPDATE facts d SET superseded_at = now(), updated_at = now()
       WHERE d.subject_kind = 'person' AND d.subject_id = $2 AND d.superseded_at IS NULL
         AND EXISTS (SELECT 1 FROM facts k WHERE k.subject_kind = 'person' AND k.subject_id = $1
                       AND lower(k.key) = lower(d.key) AND k.superseded_at IS NULL AND k.archived_at IS NULL)`,
      [keepId, duplicateId],
    );
    await run(`UPDATE facts SET subject_id = $1, updated_at = now() WHERE subject_kind = 'person' AND subject_id = $2`, [keepId, duplicateId]);
    await run(`UPDATE identities SET person_id = $1 WHERE person_id = $2`, [keepId, duplicateId]);
    // Dates: one birthday per person, so the keeper's stays and the duplicate's is archived.
    await run(
      `UPDATE events SET archived_at = now(), person_id = NULL, updated_at = now()
       WHERE person_id = $2 AND kind = 'birthday'
         AND EXISTS (SELECT 1 FROM events k WHERE k.person_id = $1 AND k.kind = 'birthday')`,
      [keepId, duplicateId],
    );
    await run(`UPDATE events SET person_id = $1, updated_at = now() WHERE person_id = $2`, [keepId, duplicateId]);
    // Custom fields: the duplicate's values fill the keeper's empty ones, copied as stored (still sealed).
    await run(
      `INSERT INTO custom_values (field_id, entity_kind, entity_id, value, updated_at)
       SELECT field_id, entity_kind, $1, value, updated_at FROM custom_values WHERE entity_kind = 'person' AND entity_id = $2
       ON CONFLICT (field_id, entity_id) DO NOTHING`,
      [keepId, duplicateId],
    );
    // Fields the keeper is missing come from the duplicate. Only fields that change are written,
    // so the keeper's own values are never re-sealed from a decrypted copy.
    const params: unknown[] = [keepId, duplicateId];
    const sets: string[] = [];
    const set = (column: string, value: unknown) => sets.push(`${column} = $${params.push(value)}`);
    if (!keep.email && dup.email) {
      set("email", s.text(dup.email));
      set("email_bidx", s.index("email", matchKey.email(dup.email)));
    }
    if (!keep.phone && dup.phone) {
      set("phone", s.text(dup.phone));
      set("phone_bidx", s.index("phone", matchKey.phone(dup.phone)));
    }
    if (!keep.relationship && dup.relationship) set("relationship", s.text(dup.relationship));
    if (dup.notes) set("notes", s.text(keep.notes ? `${keep.notes}\n\n${dup.notes}` : dup.notes));
    await run(
      `UPDATE people k SET ${[
        ...sets,
        "catch_up_days = COALESCE(k.catch_up_days, d.catch_up_days)",
        "keep_in_touch = k.keep_in_touch OR d.keep_in_touch",
        "last_contacted_at = GREATEST(k.last_contacted_at, d.last_contacted_at)",
        "updated_at = now()",
      ].join(", ")}
       FROM people d WHERE k.id = $1 AND d.id = $2`,
      params,
    );
    const carried: Array<[IdentityKind, string]> = [
      ["alias", dup.name],
      ["email", dup.email],
      ["phone", dup.phone],
    ];
    for (const [kind, raw] of carried) {
      const value = raw && !isEncryptedPlaceholder(raw) ? normaliseIdentity(kind, raw) : "";
      if (!value || (kind === "alias" && value === normaliseIdentity("alias", keep.name))) continue;
      // Already someone's identity (the keeper's, after the move above, or anyone's): leave it.
      const [taken] = await run<{ id: string }>(`SELECT id FROM identities i WHERE i.kind = $1 AND ${identityMatch("i")} LIMIT 1`, [
        kind,
        identityLookups(kind, value),
        value,
      ]);
      if (taken) continue;
      await run(`INSERT INTO identities (person_id, kind, value, value_bidx) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, value) DO NOTHING`, [
        keepId,
        kind,
        s.text(value),
        identityIndex(s, kind, value),
      ]);
    }
    await run(`UPDATE people SET archived_at = now(), updated_at = now() WHERE id = $1`, [duplicateId]);
  });
  return (await getPerson(keepId))!;
}

// ---------- Suggestions (the review inbox) ----------

export type SuggestionOp = "commitment" | "fact" | "interaction" | "event" | "person" | "link" | "booking" | "purchase";
export const SUGGESTION_OPS: readonly SuggestionOp[] = ["commitment", "fact", "interaction", "event", "person", "link", "booking", "purchase"];
export type SuggestionStatus = "pending" | "accepted" | "rejected";
export const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ["pending", "accepted", "rejected"];

export interface Suggestion {
  id: string;
  op: SuggestionOp;
  summary: string;
  payload: Record<string, unknown>;
  source: string | null;
  source_ref: string | null;
  source_quote: string | null;
  confidence: number | null;
  status: SuggestionStatus;
  result_id: string | null;
  resolved_at: string | null;
  created_at: string;
  /** The email it came from (0086, sealed): null when it wasn't one, or was filed before. */
  email: SuggestionEmail | null;
}

/**
 * File a suggestion for the owner to accept or reject. The same suggestion
 * (op + summary + source_ref) is never filed twice — even after a rejection,
 * so a rerun agent doesn't keep asking. Nor is one that says the same as one
 * still waiting from another source item (a reminder email repeating the
 * first; lib/suggestion-similar.ts sameKey): the owner answers it once.
 * Another date or number is another thing, and is filed.
 */
export async function propose(
  input: { op: SuggestionOp; summary: string; payload: Record<string, unknown>; email?: SuggestionEmail | null } & Provenance,
): Promise<Suggestion> {
  const op = oneOf(input.op, SUGGESTION_OPS, "op");
  if (!op) throw new AthenaInputError(`A suggestion needs an op (${SUGGESTION_OPS.join(", ")})`);
  const summary = tidy(input.summary ?? "");
  if (!summary) throw new AthenaInputError("A suggestion needs a one-line summary");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new AthenaInputError("A suggestion needs a payload object");
  }
  // Summaries are encrypted: compare the ones filed for the same op and source here.
  const filed = suggestionRows(
    await q<Suggestion>(`SELECT * FROM suggestions WHERE op = $1 AND COALESCE(source_ref, '') = COALESCE($2, '') ORDER BY created_at`, [
      op,
      input.source_ref ?? null,
    ]),
  );
  const existing = filed.find((f) => f.summary.toLowerCase() === summary.toLowerCase());
  if (existing) return existing;
  const waiting = suggestionRows(await q<Suggestion>(`SELECT * FROM suggestions WHERE op = $1 AND status = 'pending' ORDER BY created_at`, [op]));
  const key = sameKey({ op, summary });
  const repeat = waiting.find((f) => sameKey(f) === key);
  if (repeat) return repeat;
  const email = suggestionEmail(input.email);
  const s = await sealer();
  const [row] = await q<Suggestion>(
    `INSERT INTO suggestions (op, summary, payload, source, source_ref, source_quote, confidence, email)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
    [
      op,
      s.text(summary),
      s.json(input.payload),
      input.source ?? null,
      input.source_ref ?? null,
      s.maybe(input.source_quote ?? null),
      confidence(input.confidence),
      email ? s.json(email) : null,
    ],
  );
  return suggestionRows([row])[0];
}

/** An email as stored: a sender is required; anything else is dropped. */
function suggestionEmail(raw: unknown): SuggestionEmail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const from = line(e.from, 300);
  if (!from) return null;
  const connector = typeof e.connector_id === "string" && /^[0-9a-f-]{36}$/i.test(e.connector_id) ? e.connector_id : null;
  return { from, subject: line(e.subject, 300), connector_id: connector };
}

/**
 * A sealed payload is stored as one JSON string, so it comes back from q()
 * as the payload's JSON text: parse it. One that can't be decrypted reads as {}.
 */
function suggestionRows(rows: Suggestion[]): Suggestion[] {
  for (const r of rows) {
    r.email = readEmail(r.email);
    if (typeof r.payload !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(r.payload);
      r.payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      r.payload = {};
    }
  }
  return rows;
}

/** The email column as q() opens it: the sealed value's JSON text, or (unsealed) the object itself. */
function readEmail(raw: unknown): SuggestionEmail | null {
  if (typeof raw !== "string") return suggestionEmail(raw);
  try {
    return suggestionEmail(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function listSuggestions(opts: { status?: SuggestionStatus; limit?: number } = {}): Promise<Suggestion[]> {
  return suggestionRows(
    await q<Suggestion>(`SELECT * FROM suggestions WHERE status = $1 ORDER BY created_at DESC LIMIT $2`, [opts.status ?? "pending", opts.limit ?? 100]),
  );
}

export async function countPendingSuggestions(): Promise<number> {
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM suggestions WHERE status = 'pending'`);
  return n;
}

/**
 * Accept a suggestion: apply its payload (with any edits the owner made)
 * through the same function the matching MCP tool uses, then mark it
 * accepted. Returns what it created or changed.
 */
export async function acceptSuggestion(
  id: string,
  edits: Record<string, unknown> = {},
): Promise<{ suggestion: Suggestion; result: unknown }> {
  const [s] = suggestionRows(await q<Suggestion>(`SELECT * FROM suggestions WHERE id = $1`, [id]));
  if (!s) throw new AthenaInputError(`Suggestion ${id} not found`, 404);
  if (s.status !== "pending") throw new AthenaInputError(`That suggestion was already ${s.status}`);
  if (isEncryptedPlaceholder(s.summary)) throw new PlaceholderWrite();
  const p = { ...s.payload, ...edits };
  const provenance = { source: s.source, source_ref: s.source_ref, source_quote: s.source_quote, confidence: s.confidence };
  let result: { id?: string };
  switch (s.op) {
    case "commitment":
      result = await upsertCommitment({ ...(p as CommitmentInput), ...provenance });
      break;
    case "fact":
      // Accepting is the owner's say: it saves even a fact about them.
      result = await addFact({ ...(p as unknown as FactInput), ...provenance }, { byOwner: true });
      break;
    case "interaction":
      result = await logInteraction({ ...(p as InteractionInput), source: s.source, source_ref: s.source_ref });
      break;
    case "event":
      result = await upsertEvent(p as EventInput);
      break;
    case "person":
      result = await upsertPerson(p as PersonInput);
      break;
    case "link":
      result = await linkEntities(p as unknown as Parameters<typeof linkEntities>[0]);
      break;
    // Trips and purchases (lib/trips.ts): the same save the collector's tools make.
    case "booking": {
      const saved = await saveBooking({ ...(p as unknown as BookingInput), source: s.source, source_ref: s.source_ref, confidence: s.confidence });
      result = saved.booking ?? {};
      break;
    }
    case "purchase": {
      const saved = await savePurchase({ ...(p as unknown as PurchaseInput), source: s.source, source_ref: s.source_ref, confidence: s.confidence });
      result = saved.purchase ?? {};
      break;
    }
  }
  const [suggestion] = suggestionRows(
    await q<Suggestion>(`UPDATE suggestions SET status = 'accepted', result_id = $2, resolved_at = now() WHERE id = $1 RETURNING *`, [
      id,
      result?.id ?? null,
    ]),
  );
  return { suggestion, result };
}

/**
 * The owner dealt with it another way (Add to calendar put it on their
 * calendar): it leaves the Inbox as accepted, with nothing applied here, so
 * it's neither filed again nor counted as wrong.
 */
export async function finishSuggestion(id: string): Promise<Suggestion> {
  const [s] = suggestionRows(
    await q<Suggestion>(`UPDATE suggestions SET status = 'accepted', resolved_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [id]),
  );
  if (s) return s;
  const [existing] = suggestionRows(await q<Suggestion>(`SELECT * FROM suggestions WHERE id = $1`, [id]));
  if (!existing) throw new AthenaInputError(`Suggestion ${id} not found`, 404);
  return existing;
}

export async function rejectSuggestion(id: string): Promise<Suggestion> {
  const [s] = suggestionRows(
    await q<Suggestion>(`UPDATE suggestions SET status = 'rejected', resolved_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [id]),
  );
  if (s) return s;
  const [existing] = suggestionRows(await q<Suggestion>(`SELECT * FROM suggestions WHERE id = $1`, [id]));
  if (!existing) throw new AthenaInputError(`Suggestion ${id} not found`, 404);
  return existing;
}

// ---------- Life admin ----------

export type AssetKind =
  | "passport"
  | "licence"
  | "insurance"
  | "vehicle"
  | "warranty"
  | "subscription"
  | "home"
  | "pet"
  | "health"
  | "other";
export const ASSET_KINDS: readonly AssetKind[] = [
  "passport",
  "licence",
  "insurance",
  "vehicle",
  "warranty",
  "subscription",
  "home",
  "pet",
  "health",
  "other",
];

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  provider: string;
  /** Renewal or expiry, a calendar date "YYYY-MM-DD", or null. */
  renews_on: string | null;
  remind_days_before: number[];
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetInput {
  id?: string;
  name?: string;
  kind?: AssetKind;
  provider?: string;
  renews_on?: string | null;
  remind_days_before?: number[];
  notes?: string;
}

const ASSET_COLUMNS = `id, name, kind, provider, to_char(renews_on, 'YYYY-MM-DD') AS renews_on, remind_days_before, notes,
  archived_at, created_at, updated_at`;

export async function getAsset(id: string, opts: { includeArchived?: boolean } = {}): Promise<Asset | null> {
  const [row] = await q<Asset>(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = $1 AND ($2::boolean OR archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return row ?? null;
}

/** Never put ID, policy or account numbers in `notes`: those are sensitive_blobs material. */
export async function upsertAsset(input: AssetInput): Promise<Asset> {
  const kind = oneOf(input.kind, ASSET_KINDS, "kind");
  const renews = localDate(input.renews_on, "renewal date");
  const remind = remindDays(input.remind_days_before);
  const s = await sealer();
  if (input.id) {
    const [row] = await q<{ id: string }>(
      `UPDATE assets SET
         name = COALESCE($2, name), kind = COALESCE($3, kind), provider = COALESCE($4, provider),
         renews_on = CASE WHEN $5::boolean THEN $6::date ELSE renews_on END,
         remind_days_before = COALESCE($7::int[], remind_days_before), notes = COALESCE($8, notes),
         updated_at = now()
       WHERE id = $1 RETURNING id`,
      [
        input.id,
        s.maybe(input.name?.trim() || null),
        kind ?? null,
        s.maybe(input.provider ?? null),
        renews !== undefined,
        renews ?? null,
        remind ?? null,
        s.maybe(input.notes ?? null),
      ],
    );
    if (!row) throw new AthenaInputError(`Item ${input.id} not found`, 404);
    return (await getAsset(row.id, { includeArchived: true }))!;
  }
  if (!input.name?.trim()) throw new AthenaInputError("A new item needs a name");
  const [row] = await q<{ id: string }>(
    `INSERT INTO assets (name, kind, provider, renews_on, remind_days_before, notes)
     VALUES ($1, $2, $3, $4::date, COALESCE($5::int[], '{30,7,0}'), $6) RETURNING id`,
    [s.text(input.name.trim()), kind ?? "other", s.text(input.provider ?? ""), renews ?? null, remind ?? null, s.text(input.notes ?? "")],
  );
  return (await getAsset(row.id))!;
}

/** Live items, soonest renewal first (undated last), then by name (sorted here: names are encrypted). */
export async function listAssets(limit = 200): Promise<Asset[]> {
  const rows = await q<Asset>(`SELECT ${ASSET_COLUMNS} FROM assets WHERE archived_at IS NULL`);
  const byDate = (a: Asset, b: Asset) => (a.renews_on ?? "9999-99-99").localeCompare(b.renews_on ?? "9999-99-99");
  const named = byName<Asset>((a) => a.name);
  return rows.sort((a, b) => byDate(a, b) || named(a, b)).slice(0, limit);
}

/** Lowercase, no punctuation, spaces tidied: "Car Insurance!" and "car insurance" are one name. Pure. */
export function assetNameKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The life-admin item a renewal notice is about, archived ones included (an
 * item the owner archived stays archived): the same name, else the only
 * item of that kind with that provider. Names are encrypted: compared here.
 */
export async function findAsset(input: { name: string; kind?: AssetKind; provider?: string }): Promise<Asset | null> {
  const rows = await q<Asset>(`SELECT ${ASSET_COLUMNS} FROM assets`);
  const name = assetNameKey(input.name);
  const live = (a: Asset) => (a.archived_at ? 1 : 0);
  const byName = rows.filter((a) => assetNameKey(a.name) === name).sort((a, b) => live(a) - live(b));
  if (byName.length) return byName[0];
  const provider = assetNameKey(input.provider);
  if (!provider || !input.kind || input.kind === "other") return null;
  const same = rows.filter((a) => a.kind === input.kind && assetNameKey(a.provider) === provider);
  return same.length === 1 ? same[0] : null;
}

export interface Renewal {
  asset: Asset;
  /** Negative once it has lapsed. */
  days_until: number;
}

/**
 * Items renewing or expiring within `days` of `today` (and any that lapsed in
 * the 30 days before it). `today` defaults to today in the owner's zone.
 */
export async function listRenewals(days = 60, today?: string): Promise<Renewal[]> {
  const day = today ?? zonedToday(new Date(), await getOwnerTimeZone());
  const rows = await q<Asset>(
    `SELECT ${ASSET_COLUMNS} FROM assets
     WHERE archived_at IS NULL AND renews_on IS NOT NULL
       AND renews_on BETWEEN $1::date - 30 AND $1::date + $2::int
     ORDER BY renews_on ASC`,
    [day, days],
  );
  return rows.map((asset) => ({ asset, days_until: daysBetween(day, asset.renews_on!) }));
}

// ---------- Watch & read (reading_items) ----------
// Books, films, TV shows, articles, podcasts, music, games… The table and the
// stored statuses keep their first names; lib/watch-read.ts has the kinds and
// the words each status is shown in ("To watch", "Listening", "Played").

export { READING_KINDS, READING_STATUSES, type ReadingKind, type ReadingProgress, type ReadingStatus };

export interface ReadingItem {
  id: string;
  title: string;
  url: string;
  kind: ReadingKind;
  author: string;
  status: ReadingStatus;
  notes: string;
  recommended_by: string | null;
  recommender: PersonRef | null;
  finished_at: string | null;
  source: string | null;
  /** How far through it you are (0042): pages, episodes or a percent; null when only the status is known. */
  progress: ReadingProgress | null;
  /** Year, running time, genres, playlists, tags (0063, lib/watch-meta.ts). Empty when nothing's known. */
  meta: WatchMeta;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReadingInput {
  id?: string;
  title?: string;
  url?: string;
  kind?: ReadingKind;
  author?: string;
  status?: ReadingStatus;
  notes?: string;
  recommended_by?: string | null;
  source?: string | null;
  /** { unit, done, total } to set it, null to clear it, left out to keep it (lib/watch-read.ts parseProgress). */
  progress?: ReadingProgress | null;
  /** The owner's tags: the whole list, replacing what's there. Left out to keep them. */
  tags?: string[];
}

const READING_SELECT = `
  SELECT r.id, r.title, r.url, r.kind, r.author, r.status, r.notes, r.recommended_by, ${personJson("p")} AS recommender,
    r.finished_at, r.source,
    CASE WHEN r.progress_unit IS NULL THEN NULL
         ELSE json_build_object('unit', r.progress_unit, 'done', r.progress_done, 'total', r.progress_total) END AS progress,
    r.meta,
    r.archived_at, r.created_at, r.updated_at
  FROM reading_items r
  LEFT JOIN people p ON p.id = r.recommended_by AND p.archived_at IS NULL`;

export async function getReadingItem(id: string, opts: { includeArchived?: boolean } = {}): Promise<ReadingItem | null> {
  const [row] = await q<ReadingItem>(`${READING_SELECT} WHERE r.id = $1 AND ($2::boolean OR r.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return row ? withMeta(row) : null;
}

/** The stored meta (sealed: JSON text) as the shape the app reads. */
const withMeta = (row: ReadingItem): ReadingItem => ({ ...row, meta: readMeta(row.meta) });

function checkedTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) throw new AthenaInputError("'tags' is a list of words");
  return nameList(raw, MAX_TAGS, TAG_LENGTH);
}

/** Create or update; saving the same URL twice returns the existing item. */
export async function upsertReadingItem(input: ReadingInput): Promise<ReadingItem> {
  const kind = oneOf(input.kind, READING_KINDS, "kind");
  const status = oneOf(input.status, READING_STATUSES, "status");
  const by = personId(input.recommended_by);
  const progress = parseProgress(input.progress);
  if (progress && "problem" in progress) throw new AthenaInputError(progress.problem);
  const tags = checkedTags(input.tags);
  const s = await sealer();
  if (input.id) {
    // Tags live inside the sealed meta: read it, set them, write it back.
    let meta: string | null = null;
    if (tags) {
      const [kept] = await q<{ meta: unknown }>(`SELECT meta FROM reading_items WHERE id = $1`, [input.id]);
      if (kept) {
        const next = { ...readMeta(kept.meta) };
        if (tags.length) next.tags = tags;
        else delete next.tags;
        meta = s.json(next);
      }
    }
    const [row] = await q<{ id: string }>(
      `UPDATE reading_items SET
         title = COALESCE($2, title), url = COALESCE($3, url), kind = COALESCE($4, kind), author = COALESCE($5, author),
         status = COALESCE($6, status),
         finished_at = CASE WHEN $6::text IS NULL THEN finished_at WHEN $6 = 'done' THEN COALESCE(finished_at, now()) ELSE NULL END,
         notes = COALESCE($7, notes),
         recommended_by = CASE WHEN $8::boolean THEN $9::uuid ELSE recommended_by END,
         progress_unit = CASE WHEN $10::boolean THEN $11::text ELSE progress_unit END,
         progress_done = CASE WHEN $10::boolean THEN $12::int ELSE progress_done END,
         progress_total = CASE WHEN $10::boolean THEN $13::int ELSE progress_total END,
         meta = COALESCE($14::jsonb, meta),
         updated_at = now()
       WHERE id = $1 RETURNING id`,
      [
        input.id,
        s.maybe(input.title?.trim() || null),
        s.maybe(input.url ?? null),
        kind ?? null,
        s.maybe(input.author ?? null),
        status ?? null,
        s.maybe(input.notes ?? null),
        by !== undefined,
        by ?? null,
        progress !== undefined,
        progress?.unit ?? null,
        progress?.done ?? null,
        progress?.total ?? null,
        meta,
      ],
    );
    if (!row) throw new AthenaInputError(`Watch & read item ${input.id} not found`, 404);
    return (await getReadingItem(row.id, { includeArchived: true }))!;
  }
  if (!input.title?.trim()) throw new AthenaInputError("A new watch & read item needs a title");
  if (input.url) {
    // URLs are encrypted: compare the saved ones here.
    const saved = await q<{ id: string; url: string }>(`SELECT id, url FROM reading_items WHERE url <> '' AND archived_at IS NULL ORDER BY created_at`);
    const existing = saved.find((r) => r.url === input.url);
    if (existing) return (await getReadingItem(existing.id))!;
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO reading_items (title, url, kind, author, status, notes, recommended_by, source, finished_at, progress_unit, progress_done, progress_total, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8, CASE WHEN $5 = 'done' THEN now() END, $9, $10, $11, $12::jsonb) RETURNING id`,
    [
      s.text(input.title.trim()),
      s.text(input.url ?? ""),
      kind ?? "article",
      s.text(input.author ?? ""),
      status ?? "queued",
      s.text(input.notes ?? ""),
      by ?? null,
      input.source ?? "manual",
      progress?.unit ?? null,
      progress?.done ?? null,
      progress?.total ?? null,
      tags?.length ? s.json({ tags }) : null,
    ],
  );
  return (await getReadingItem(row.id))!;
}

/** In progress first, then the queue (newest first), then finished (most recent first). */
export async function listReading(opts: { status?: ReadingStatus; limit?: number } = {}): Promise<ReadingItem[]> {
  const rows = await q<ReadingItem>(
    `${READING_SELECT}
     WHERE r.archived_at IS NULL AND ($1::text IS NULL OR r.status = $1)
     ORDER BY CASE r.status WHEN 'reading' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
              COALESCE(r.finished_at, r.created_at) DESC
     LIMIT $2`,
    [opts.status ?? null, opts.limit ?? 200],
  );
  return rows.map(withMeta);
}

// ---------- Goals ----------

export type GoalPeriod = "week" | "month" | "quarter" | "year";
export const GOAL_PERIODS: readonly GoalPeriod[] = ["week", "month", "quarter", "year"];
export type GoalStatus = "active" | "done" | "dropped";
export const GOAL_STATUSES: readonly GoalStatus[] = ["active", "done", "dropped"];

export interface Goal {
  id: string;
  title: string;
  period: GoalPeriod;
  target: string;
  progress: number;
  status: GoalStatus;
  due_on: string | null;
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalInput {
  id?: string;
  title?: string;
  period?: GoalPeriod;
  target?: string;
  progress?: number;
  status?: GoalStatus;
  due_on?: string | null;
  notes?: string;
}

const GOAL_COLUMNS = `id, title, period, target, progress, status, to_char(due_on, 'YYYY-MM-DD') AS due_on, notes,
  archived_at, created_at, updated_at`;

export async function getGoal(id: string, opts: { includeArchived?: boolean } = {}): Promise<Goal | null> {
  const [row] = await q<Goal>(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = $1 AND ($2::boolean OR archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return row ?? null;
}

export async function upsertGoal(input: GoalInput): Promise<Goal> {
  const period = oneOf(input.period, GOAL_PERIODS, "period");
  const status = oneOf(input.status, GOAL_STATUSES, "status");
  const due = localDate(input.due_on, "due date");
  const progress = input.progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(input.progress)));
  const s = await sealer();
  if (input.id) {
    // One statement: the update, and a goal_progress row when progress changed (0041).
    const [row] = await q<{ id: string }>(
      `WITH before AS (SELECT progress FROM goals WHERE id = $1),
       upd AS (
         UPDATE goals SET
           title = COALESCE($2, title), period = COALESCE($3, period), target = COALESCE($4, target),
           progress = COALESCE($5::int, progress), status = COALESCE($6, status),
           due_on = CASE WHEN $7::boolean THEN $8::date ELSE due_on END, notes = COALESCE($9, notes),
           updated_at = now()
         WHERE id = $1 RETURNING id, progress),
       logged AS (
         INSERT INTO goal_progress (goal_id, progress)
         SELECT upd.id, upd.progress FROM upd, before WHERE upd.progress <> before.progress)
       SELECT id FROM upd`,
      [
        input.id,
        s.maybe(input.title?.trim() || null),
        period ?? null,
        s.maybe(input.target ?? null),
        progress ?? null,
        status ?? null,
        due !== undefined,
        due ?? null,
        s.maybe(input.notes ?? null),
      ],
    );
    if (!row) throw new AthenaInputError(`Goal ${input.id} not found`, 404);
    return (await getGoal(row.id, { includeArchived: true }))!;
  }
  if (!input.title?.trim()) throw new AthenaInputError("A new goal needs a title");
  // A new goal's starting value is its first goal_progress row (0041).
  const [row] = await q<{ id: string }>(
    `WITH ins AS (
       INSERT INTO goals (title, period, target, progress, status, due_on, notes)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7) RETURNING id, progress),
     logged AS (INSERT INTO goal_progress (goal_id, progress) SELECT id, progress FROM ins)
     SELECT id FROM ins`,
    [s.text(input.title.trim()), period ?? "quarter", s.text(input.target ?? ""), progress ?? 0, status ?? "active", due ?? null, s.text(input.notes ?? "")],
  );
  return (await getGoal(row.id))!;
}

/** Active goals first (soonest due), then finished ones. */
export async function listGoals(limit = 100): Promise<Goal[]> {
  return q<Goal>(
    `SELECT ${GOAL_COLUMNS} FROM goals WHERE archived_at IS NULL
     ORDER BY (status = 'active') DESC, due_on ASC NULLS LAST, updated_at DESC LIMIT $1`,
    [limit],
  );
}

// ---------- Derived reads ----------

export interface PersonBrief {
  person: Person;
  facts: Fact[];
  identities: Identity[];
  /** Most recent first. */
  interactions: Interaction[];
  /** Open loops with them, both ways. */
  open_loops: Commitment[];
  decisions: Commitment[];
  /** Things they recommended that you haven't finished. */
  reading: ReadingItem[];
}

/** Everything Athena knows that you'd want before speaking to someone. */
export async function personBrief(id: string): Promise<PersonBrief | null> {
  const person = await getPerson(id);
  if (!person) return null;
  const [facts, identities, interactions, openLoops, decisions, reading] = await Promise.all([
    listFacts({ subjectKind: "person", subjectId: id }),
    listIdentities(id),
    listInteractions({ personId: id, limit: 20 }),
    listOpenLoops({ personId: id }),
    listCommitments({ status: "all", kinds: ["decision"], personId: id, limit: 5 }),
    q<ReadingItem>(
      `${READING_SELECT} WHERE r.archived_at IS NULL AND r.recommended_by = $1 AND r.status <> 'done' ORDER BY r.created_at DESC`,
      [id],
    ),
  ]);
  return { person, facts, identities, interactions, open_loops: openLoops, decisions, reading };
}

export type RecallKind = "note" | "commitment" | "interaction" | "fact" | "person" | "reading" | "record" | "day";

export interface RecallHit {
  kind: RecallKind;
  id: string;
  title: string;
  /** Plain text around the match. */
  snippet: string;
  at: string;
  rank: number;
  /** For commitments, facts and interactions: who it's about. */
  person: PersonRef | null;
  /** For a custom record: its kind's id and its name for one ("wine"). */
  custom_kind?: { id: string; one: string };
}

/** Snippets are plain text: links keep their label, Markdown markers go. */
const plainText = (markdown: string) =>
  markdown.replace(/\[@?([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_#>`~|]+|\[[ xX]\]/g, "");

/** A field to search, unless it's a placeholder (a deploy without the key shouldn't match "encrypted"). */
const field = (text: string | null | undefined, weight: number): SearchField => ({
  text: text && !isEncryptedPlaceholder(text) ? text : "",
  weight,
});

/** Several columns searched as one text, each screened for placeholders first. */
const joined = (weight: number, ...texts: string[]): SearchField => ({ text: texts.map((t) => field(t, weight).text).join(" "), weight });

/**
 * Recall: ranked full-text search (English stemming, so "meeting" finds
 * "meetings") across notes, commitments, interactions, facts, people, the
 * watch & read list and the owner's own records (a wine, a plant: while its
 * kind isn't archived). Accepts web-search syntax: quotes, OR, -exclude.
 *
 * Everything it searches is encrypted at rest, so it reads the live rows,
 * decrypted, and ranks them here (lib/text-search.ts): fine at personal
 * scale. A note's title counts for more than its body; a match on a person,
 * fact or to-do is nudged up, as before.
 */
export async function recall(query: string, limit = 20): Promise<RecallHit[]> {
  const parsed = parseQuery(query.trim());
  if (!parsed) return [];
  const [notes, commitments, interactions, facts, people, reading, records, custom] = await Promise.all([
    q<{ id: string; title: string; body: string; updated_at: string }>(`SELECT id, title, body, updated_at FROM notes WHERE archived_at IS NULL`),
    q<{ id: string; title: string; notes: string; steps: unknown; updated_at: string; person: PersonRef | null }>(
      `SELECT c.id, c.title, c.notes, c.steps, c.updated_at, ${personJson("p")} AS person
       FROM commitments c LEFT JOIN people p ON p.id = c.person_id AND p.archived_at IS NULL
       WHERE c.archived_at IS NULL`,
    ),
    q<{ id: string; summary: string; at: string; person: PersonRef | null }>(
      `SELECT i.id, i.summary, i.at,
         (SELECT json_build_object('id', p.id, 'name', p.name) FROM interaction_people ip
            JOIN people p ON p.id = ip.person_id AND p.archived_at IS NULL WHERE ip.interaction_id = i.id LIMIT 1) AS person
       FROM interactions i WHERE i.archived_at IS NULL`,
    ),
    q<{ id: string; key: string; value: string; observed_at: string; person: PersonRef | null }>(
      `SELECT f.id, f.key, f.value, f.observed_at, ${personJson("p")} AS person
       FROM facts f LEFT JOIN people p ON f.subject_kind = 'person' AND p.id = f.subject_id AND p.archived_at IS NULL
       WHERE f.archived_at IS NULL AND f.superseded_at IS NULL`,
    ),
    q<{ id: string; name: string; relationship: string; notes: string; updated_at: string }>(
      `SELECT id, name, relationship, notes, updated_at FROM people WHERE archived_at IS NULL`,
    ),
    q<{ id: string; title: string; author: string; notes: string; updated_at: string }>(
      `SELECT id, title, author, notes, updated_at FROM reading_items WHERE archived_at IS NULL`,
    ),
    q<{ id: string; title: string; body: string; updated_at: string; kind_id: string; one: string }>(
      `SELECT r.id, r.title, r.body, r.updated_at, r.kind_id, k.one
       FROM custom_records r JOIN custom_kinds k ON k.id = r.kind_id AND k.archived_at IS NULL
       WHERE r.archived_at IS NULL`,
    ),
    // The owner's text and choices fields ("Interests: Climbing, Jazz") count as part of the record.
    searchableValues(["note", "person", "reading"], { custom: true }),
  ]);
  const extra = (id: string) => field(custom.get(id), 0.1);

  const hits: RecallHit[] = [];
  const add = (hit: Omit<RecallHit, "rank">, fields: SearchField[], boost = 1) => {
    const rank = score(parsed, fields);
    if (rank > 0) hits.push({ ...hit, rank: rank * boost });
  };
  // Weights follow the old index: a note's title like Postgres's A (1.0), its body B (0.4), everything else D (0.1).
  for (const n of notes) {
    const body = plainText(field(n.body, 0).text);
    add({ kind: "note", id: n.id, title: n.title, snippet: headline(body, parsed), at: n.updated_at, person: null }, [field(n.title, 1), field(body, 0.4), extra(n.id)]);
  }
  for (const c of commitments) {
    const text = joined(0.1, c.title, c.notes, stepsText(readList(c.steps, cleanSteps)).replace(/\[[ x]\] /g, ""));
    add({ kind: "commitment", id: c.id, title: c.title, snippet: headline(text.text, parsed), at: c.updated_at, person: c.person }, [text], 1.2);
  }
  for (const i of interactions) {
    add({ kind: "interaction", id: i.id, title: i.summary.slice(0, 80), snippet: headline(i.summary, parsed), at: i.at, person: i.person }, [field(i.summary, 0.1)]);
  }
  for (const f of facts) {
    add({ kind: "fact", id: f.id, title: `${f.key}: ${f.value}`, snippet: f.value, at: f.observed_at, person: f.person }, [field(f.key, 0.1), field(f.value, 0.1)], 1.3);
  }
  for (const p of people) {
    add({ kind: "person", id: p.id, title: p.name, snippet: p.relationship, at: p.updated_at, person: null }, [
      field(p.name, 0.1),
      field(p.relationship, 0.1),
      field(p.notes, 0.1),
      extra(p.id),
    ], 1.5);
  }
  for (const r of reading) {
    const text = joined(0.1, r.title, r.author, r.notes, custom.get(r.id) ?? "");
    add({ kind: "reading", id: r.id, title: r.title, snippet: headline(text.text, parsed), at: r.updated_at, person: null }, [text]);
  }
  // A custom record weighs like a note: its title first, then its body, then its fields' words.
  for (const r of records) {
    const body = plainText(field(r.body, 0).text);
    const values = custom.get(r.id) ?? "";
    add(
      { kind: "record", id: r.id, title: r.title, snippet: headline(`${values} ${body}`.trim(), parsed), at: r.updated_at, person: null, custom_kind: { id: r.kind_id, one: r.one } },
      [field(r.title, 1), field(body, 0.4), extra(r.id)],
      1.1,
    );
  }
  // Days (lib/days.ts): the best entry or line on each day that matches; the id is the date.
  for (const d of await dayRecallHits(parsed, limit).catch(() => [])) {
    hits.push({ kind: "day", id: d.date, title: d.title, snippet: d.snippet, at: `${d.date}T12:00:00.000Z`, person: null, rank: d.rank });
  }
  const at = (h: RecallHit) => new Date(h.at).getTime();
  return hits.sort((a, b) => b.rank - a.rank || at(b) - at(a)).slice(0, limit);
}

export interface Today {
  today: string;
  /** Open loops due today or overdue. */
  due: Commitment[];
  /** Every open loop (the client groups them). */
  open_loops: Commitment[];
  renewals: Renewal[];
  pending_suggestions: number;
}

/** A caller's zone if it's a real one, else the owner's (one settings read). */
async function zoneOr(tz: string | undefined): Promise<string> {
  return tz && isValidTimeZone(tz) ? tz : getOwnerTimeZone();
}

/**
 * The "what's in motion" half of Home (Coming up is listUpcoming in lib/db.ts).
 * "Today" and what's due are in `tz` (the owner's zone unless given).
 */
export async function loadToday(now: Date = new Date(), tz?: string): Promise<Today> {
  const today = zonedToday(now, await zoneOr(tz));
  const [openLoops, renewals, pending] = await Promise.all([listOpenLoops(), listRenewals(60, today), countPendingSuggestions()]);
  const due = openLoops.filter((c) => c.due_on !== null && c.due_on <= today);
  return { today, due, open_loops: openLoops, renewals, pending_suggestions: pending };
}

/** The Monday of the week containing calendar date `date`. */
export function weekStartOf(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export interface WeeklyReview {
  week_start: string;
  /** Inclusive (the Sunday). */
  week_end: string;
  done: Commitment[];
  decisions: Commitment[];
  interactions: Interaction[];
  people_seen: PersonRef[];
  open_loops: Commitment[];
  catch_ups: Person[];
  next_week: { events: UpcomingEvent[]; due: Commitment[] };
  goals: Goal[];
  reading_done: ReadingItem[];
  renewals: Renewal[];
  notes_written: number;
}

/**
 * The Sunday review: what moved this week, what's still open, what's next.
 * The week runs Monday to Sunday in `tz` (the owner's zone unless given).
 */
export async function weeklyReview(weekStart?: string, now: Date = new Date(), tz?: string): Promise<WeeklyReview> {
  const zone = await zoneOr(tz);
  const start = weekStart ? weekStartOf(localDate(weekStart, "week start") as string) : weekStartOf(zonedToday(now, zone));
  const end = addDays(start, 6);
  const nextFrom = addDays(start, 7);
  const from = zonedToInstant(start, "00:00", zone).toISOString();
  const until = zonedToInstant(nextFrom, "00:00", zone).toISOString();

  const [done, decisions, interactions, openLoops, catchUps, events, goals, readingDone, renewals, written] = await Promise.all([
    q<Commitment>(
      `${COMMITMENT_SELECT} WHERE c.archived_at IS NULL AND c.status = 'done' AND c.kind <> 'decision'
         AND c.done_at >= $1 AND c.done_at < $2 ORDER BY c.done_at DESC`,
      [from, until],
    ),
    q<Commitment>(
      `${COMMITMENT_SELECT} WHERE c.archived_at IS NULL AND c.kind = 'decision'
         AND c.created_at >= $1 AND c.created_at < $2 ORDER BY c.created_at DESC`,
      [from, until],
    ),
    listInteractions({ since: new Date(from), until: new Date(until), limit: 200 }),
    listOpenLoops(),
    listStalePeople(),
    listEvents(),
    listGoals(),
    q<ReadingItem>(
      `${READING_SELECT} WHERE r.archived_at IS NULL AND r.status = 'done' AND r.finished_at >= $1 AND r.finished_at < $2
       ORDER BY r.finished_at DESC`,
      [from, until],
    ),
    listRenewals(13, nextFrom),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE archived_at IS NULL AND created_at >= $1 AND created_at < $2`, [from, until]),
  ]);

  const seen = new Map<string, PersonRef>();
  for (const i of interactions) for (const p of i.people) seen.set(p.id, p);
  const nextEnd = addDays(nextFrom, 6);
  return {
    week_start: start,
    week_end: end,
    done,
    decisions,
    interactions,
    people_seen: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    open_loops: openLoops,
    catch_ups: catchUps.slice(0, 6),
    next_week: {
      events: upcomingOccurrences(events.filter(notDeclined), nextFrom, 7, zone),
      due: openLoops.filter((c) => c.due_on !== null && c.due_on >= nextFrom && c.due_on <= nextEnd),
    },
    goals: goals.filter((g) => g.status === "active"),
    reading_done: readingDone,
    renewals: renewals.filter((r) => r.days_until >= 0),
    notes_written: written[0]?.n ?? 0,
  };
}

/** For get-by-id routes. */
export async function getMemoryItem(
  kind: "commitment" | "interaction" | "fact" | "asset" | "reading" | "goal",
  id: string,
  includeArchived = false,
) {
  const opts = { includeArchived };
  switch (kind) {
    case "commitment":
      return getCommitment(id, opts);
    case "interaction":
      return getInteraction(id, opts);
    case "fact":
      return getFact(id, opts);
    case "asset":
      return getAsset(id, opts);
    case "reading":
      return getReadingItem(id, opts);
    case "goal":
      return getGoal(id, opts);
  }
}
