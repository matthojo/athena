/**
 * Shared data-access layer for Athena.
 *
 * Every read/write — the MCP server's tools, the REST API the PWA and dashboard
 * use, the collection agents — goes through this file or its layer-2 sibling
 * lib/memory.ts (commitments, interactions, facts, …). Those two own the SQL;
 * everything else just calls functions.
 *
 * Uses @netlify/database's getDatabase(), the officially recommended access path
 * from Netlify Functions, so nothing here depends on whether Netlify DB is
 * reachable from outside Netlify's own runtime.
 *
 * Personal content is encrypted at rest (docs: security/encryption, lib/data-box.ts):
 * writes seal text through sealer(), and q() opens every sealed value in what
 * it returns, so callers only ever see plaintext. SQL can't compare, sort or
 * search ciphertext, so those steps happen here in TypeScript, or against a
 * blind index for exact matches on people.
 */
import { getDatabase } from "@netlify/database";

import {
  blindIndex,
  blindIndexes,
  currentKeyId,
  dataKeyProblem,
  DataKeyMissing,
  openDeep,
  sealText,
  type IndexPurpose,
} from "./data-box";
import { isEncryptedPlaceholder } from "./encrypted";
import { contentEdgeKeys } from "./links";
import { DEFAULT_TZ, isValidDate, isValidTimeZone, sameWallClock, upcomingOccurrences, zonedParts, zonedToInstant, zonedToday, type Occurrence } from "./dates";
import { REMINDER_REPEATS, localToInstant, nextRemindAt, type ReminderRepeat } from "./reminders";
import { purchaseName } from "./trip-text";
import { KIND_LIMITS, sameLabel } from "./custom-field-rules";
import { KIND_WORD } from "./custom-kind-words";
import { canRsvp } from "./connector-presets";

// ---------- Types ----------

export type NoteType = "note" | "daily" | "project" | "area" | "capture";
/**
 * Every kind of thing the graph (`edges`) can point at. "record" is any of
 * the owner's own records (lib/custom-kinds.ts), whatever its kind: record
 * ids are unique, so one link kind covers them all (athena://record/<id>).
 */
export type EntityType = PageType | ItemType;
export const ENTITY_TYPES: readonly EntityType[] = ["note", "person", "project", "place", "organisation", "event", "record", "saved", "commitment", "reading"];
/** The kinds with pages of their own: what search, reminders and connectors link between. */
export type PageType = "note" | "person" | "project" | "place" | "organisation" | "event" | "record";
export const PAGE_TYPES: readonly PageType[] = ["note", "person", "project", "place", "organisation", "event", "record"];
/**
 * Things a note can @-mention that live in their own lists: a saved item, a
 * to-do (commitments) and a Watch & read title (reading_items). Their link
 * kinds are saved, todo and watch (lib/links.ts EDGE_KIND). Migration 0044.
 */
export type ItemType = "saved" | "commitment" | "reading";
export const ITEM_TYPES: readonly ItemType[] = ["saved", "commitment", "reading"];
export const isPageType = (kind: string): kind is PageType => (PAGE_TYPES as readonly string[]).includes(kind);
/** Kinds with their own table + generic CRUD (everything except notes and the owner's own records). */
export type RecordKind = Exclude<PageType, "note" | "record">;
export const RECORD_KINDS: readonly RecordKind[] = ["person", "project", "place", "organisation", "event"];
export type Rsvp = "going" | "maybe" | "declined" | "none";
export const RSVPS: readonly Rsvp[] = ["going", "maybe", "declined", "none"];

export type EventKind = "birthday" | "anniversary" | "appointment" | "deadline" | "other";
export const EVENT_KINDS: readonly EventKind[] = ["birthday", "anniversary", "appointment", "deadline", "other"];
export type Recurrence = "none" | "yearly";
/** Layer-2 kinds (lib/memory.ts): archivable like everything else, but not graph nodes. */
export type MemoryKind = "commitment" | "interaction" | "fact" | "asset" | "reading" | "goal";
export const MEMORY_KINDS: readonly MemoryKind[] = ["commitment", "interaction", "fact", "asset", "reading", "goal"];
/** Trips, their bookings and purchases (lib/trips.ts): archivable, not graph nodes. */
export type LogisticsKind = "trip" | "booking" | "purchase";
export const LOGISTICS_KINDS: readonly LogisticsKind[] = ["trip", "booking", "purchase"];
/** Anything with an archived_at. "kind" is one of the owner's own kinds of record (custom_kinds). */
export type ArchivableKind = PageType | MemoryKind | LogisticsKind | "kind";
export const ARCHIVABLE_KINDS: readonly ArchivableKind[] = [...PAGE_TYPES, ...MEMORY_KINDS, ...LOGISTICS_KINDS, "kind"];

/** Default catch-up cadence in days when a person has none set. */
export const DEFAULT_CATCH_UP_DAYS = 60;

export interface Note {
  id: string;
  title: string;
  body: string;
  type: NoteType;
  source: string | null;
  tags: string[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Person {
  id: string;
  name: string;
  notes: string;
  relationship: string;
  email: string;
  phone: string;
  /** null = the default cadence (DEFAULT_CATCH_UP_DAYS). */
  catch_up_days: number | null;
  /** Nudge the owner to catch up with them. Off by default. */
  keep_in_touch: boolean;
  last_contacted_at: string | null;
  /** "YYYY-MM-DD", or "--MM-DD" when the year isn't known; derived from their birthday event. */
  birthday: string | null;
  birthday_event_id: string | null;
  /** Where they work: a manual `works_at` edge to an organisation. */
  organisation: { id: string; name: string } | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "done";
  description: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Place {
  id: string;
  name: string;
  address: string;
  url: string;
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organisation {
  id: string;
  name: string;
  website: string;
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AthenaEvent {
  id: string;
  title: string;
  kind: EventKind;
  /**
   * A calendar date, "YYYY-MM-DD" (year 2000 placeholder when !year_known).
   * For a timed one-off it's the day in the zone it was saved in; `starts_at` is the truth.
   */
  date: string;
  /** Wall-clock "HH:MM" for a yearly event (read in the viewer's zone); null otherwise. */
  time: string | null;
  /** UTC instant a timed one-off event starts; null for all-day and yearly events. */
  starts_at: string | null;
  /** UTC instant a timed one-off ends, as its calendar gives it; null when unknown, all-day or yearly. */
  ends_at: string | null;
  recurrence: Recurrence;
  year_known: boolean;
  remind_days_before: number[];
  notes: string;
  person_id: string | null;
  /** The collection that synced it from a calendar (e.g. "calendar-meetings-work"); null if added by hand. */
  source: string | null;
  /** Push 30 minutes before (timed events only). Synced meetings default to off. */
  timed_push: boolean;
  /** Your answer to an invite (lib/rsvp.ts). "none" for no answer, or an event that isn't an invite. */
  rsvp: Rsvp;
  /** The calendar's own last answer; null when it isn't a calendar invite. */
  rsvp_calendar: Rsvp | null;
  /** You chose `rsvp` in Athena: it holds until the calendar's answer changes. */
  rsvp_mine: boolean;
  /** Why the last send to the calendar failed; "" when it didn't. */
  rsvp_error: string;
  calendar_connector_id: string | null;
  calendar_id: string | null;
  calendar_event_id: string | null;
  /** The calendar account the invite came from; can_send when answers go back to it. */
  rsvp_account: { id: string; name: string; label: string; provider: string; can_send: boolean } | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Edge {
  id: string;
  source_type: EntityType;
  source_id: string;
  target_type: EntityType;
  target_id: string;
  relation: string;
  origin: "manual" | "content";
  created_at: string;
}

export interface MetricPoint {
  id: string;
  metric: string;
  value: number;
  recorded_at: string;
  metadata: Record<string, unknown>;
}

export interface NoteChunkMatch {
  note_id: string;
  title: string;
  chunk_content: string;
  distance: number;
}

/** A search hit / reference to any entity, with a display title. */
export interface EntityRef {
  kind: EntityType;
  id: string;
  title: string;
  /** A record's subtitle is its kind's name for one ("Wine"). */
  subtitle: string;
  updated_at: string;
  /** A record's kind (custom_kinds.id); absent for everything else. */
  kind_id?: string;
}

export interface Connection extends EntityRef {
  edge_id: string;
  relation: string;
  origin: "manual" | "content";
}

export interface ArchivedItem {
  kind: ArchivableKind;
  id: string;
  title: string;
  archived_at: string;
  /** A record's kind ("Wine"), so the Archived page can say what it is; a kind's name for one ("wine"). */
  detail?: string;
  /** A record's kind id, or a kind's own icon. */
  kind_id?: string;
  icon?: string;
  /** A kind: how many records it has, archived ones included (what deleting it removes). */
  count?: number;
}

/** Bad input (400) or a missing id (404) — callers can show the message as-is. */
export class AthenaInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "AthenaInputError";
  }
}

type Database = ReturnType<typeof getDatabase>;
let shared: { url: string; db: Database } | null = null;

/**
 * The database handle. getDatabase() builds a new connection pool every time
 * it's called. With the serverless driver (Netlify's deploys) queries go over
 * HTTP and the pool is only touched by tx(), so a fresh one per call costs
 * nothing. With the plain Postgres driver (`netlify dev`, tests, a server
 * deploy) each pool opens real connections and is never closed, so a busy
 * run piled up idle connections until Postgres refused more. There, one pool
 * per connection string is shared instead.
 */
export function database(): Database {
  if (process.env.NETLIFY_DB_DRIVER === "serverless") return getDatabase();
  const url = process.env.NETLIFY_DB_URL ?? "";
  if (!shared || shared.url !== url) shared = { url, db: getDatabase() };
  return shared.db;
}

/** Is this pool shared between calls (so tx() must leave it open)? */
function isShared(d: Database): boolean {
  return shared?.db === d;
}

function db() {
  return database();
}

/**
 * Parameterised raw query — used where the SQL text is built from constants
 * (shared with lib/memory.ts). Sealed values in the result come back opened.
 */
export async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return openDeep(await qRaw<T>(text, params));
}

/** The same, with values exactly as stored: for compare-and-set and the encryption backfill. */
export async function qRaw<T>(text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await db().sql.unsafe(text, params as never[])) as T[];
  } catch (error) {
    throw dbError(error);
  }
}

/**
 * A failed query. The driver's own error carries the SQL and its parameters
 * (and Postgres's `detail` the offending values), and errors end up in
 * function logs, MCP replies and collection_runs.error. So q, qRaw and tx
 * throw this instead: the Postgres code and the constraint name, nothing else.
 */
export class AthenaDbError extends Error {
  constructor(
    readonly code: string | null,
    readonly constraint: string | null,
  ) {
    super(`Database query failed${code ? ` (${code})` : ""}${constraint ? `: ${constraint}` : ""}`);
    this.name = "AthenaDbError";
  }
}

const SAFE_NAME = /^[A-Za-z0-9_]{1,63}$/;

/** The driver's error (or one it wraps) as an AthenaDbError. The original is dropped, not kept as `cause`: logging an error prints its cause too. */
function dbError(error: unknown): AthenaDbError {
  if (error instanceof AthenaDbError) return error;
  let code: string | null = null;
  let constraint: string | null = null;
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code: c, constraint: k } = e as { code?: unknown; constraint?: unknown };
    if (!code && typeof c === "string" && SAFE_NAME.test(c)) code = c;
    if (!constraint && typeof k === "string" && SAFE_NAME.test(k)) constraint = k;
  }
  return new AthenaDbError(code, constraint);
}

export type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;
interface PooledClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/**
 * Run `fn` as one transaction on a pooled connection; it rolls back if `fn`
 * throws. With the serverless driver database() builds a fresh pool per call,
 * so that one is closed once the transaction is over rather than left holding
 * an idle connection; a shared pool (plain Postgres) stays open.
 */
export async function tx<T>(fn: (run: Run) => Promise<T>): Promise<T> {
  const d = db();
  const pool = d.pool as unknown as { connect(): Promise<PooledClient>; end(): Promise<void> };
  const ownPool = !isShared(d);
  // Only the driver's errors are rewritten; whatever `fn` itself throws passes through.
  const run = async (text: string, params: unknown[] = []) => {
    try {
      return (await client.query(text, params)).rows;
    } catch (error) {
      throw dbError(error);
    }
  };
  const client = await pool.connect().catch((error) => {
    throw dbError(error);
  });
  try {
    await run("BEGIN");
    const result = await fn(async <R>(text: string, params: unknown[] = []) => openDeep((await run(text, params)) as R[]));
    await run("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    if (ownPool) await pool.end().catch(() => undefined);
  }
}

// ---------- Encryption at rest (docs: security/encryption) ----------

/** How a write stores text: see sealer(). */
export interface Sealer {
  /** Seal one value. Empty stays empty. */
  text(value: string): string;
  /** null / undefined pass through: the "leave it alone" of a COALESCE update. */
  maybe<T extends string | null | undefined>(value: T): T;
  list(values: string[]): string[];
  /** A JSON value as the text of a ::jsonb parameter (sealed, it's one JSON string). */
  json(value: unknown): string;
  /** Blind index of a normalised value (see matchKey), or null without a key. */
  index(purpose: IndexPurpose, normalised: string): string | null;
}

const sealing: Sealer = {
  text: sealText,
  maybe: (value) => (typeof value === "string" ? sealText(value) : value) as typeof value,
  list: (values) => values.map(sealText),
  json: (value) => JSON.stringify(sealText(JSON.stringify(value))),
  index: blindIndex,
};

/** Before encryption has ever been switched on: text is stored as it comes, as it always was. */
const plain: Sealer = {
  text: (value) => value,
  maybe: (value) => value,
  list: (values) => values,
  json: (value) => JSON.stringify(value),
  index: () => null,
};

/** Encryption is on but this deploy has no key: refuse rather than store anything readable. */
function refusing(): Sealer {
  const refuse = (value: string) => {
    if (value === "") return value;
    throw new DataKeyMissing(dataKeyProblem() ?? undefined);
  };
  return {
    text: refuse,
    maybe: (value) => (typeof value === "string" ? refuse(value) : value) as typeof value,
    list: (values) => values.map(refuse),
    json: () => refuse("{}"),
    index: () => null,
  };
}

/** settings.encryption: { required, kid, since, last_run } — see sealer(). */
export interface EncryptionSetting {
  required?: boolean;
  kid?: string;
  since?: string;
  last_run?: Record<string, unknown>;
}

export async function getEncryptionSetting(): Promise<EncryptionSetting> {
  const [row] = await qRaw<{ value: EncryptionSetting }>(`SELECT value FROM settings WHERE key = 'encryption'`);
  return row?.value ?? {};
}

let requiredCache: { value: boolean; at: number } | null = null;
let markedKid: string | null = null;

/** Forget what this process learned about the marker (tests switch keys between cases). */
export function resetEncryptionCache(): void {
  requiredCache = null;
  markedKid = null;
}

/**
 * How this write should store text. With the key: sealed, and the first
 * time per process the database is marked as encrypted (settings.encryption),
 * which deploy previews inherit with their copy of the data. Without the
 * key: refused once that mark exists (a preview, or production that lost its
 * key) — never quietly stored readable — and plaintext only before
 * encryption was ever switched on.
 */
export async function sealer(): Promise<Sealer> {
  const kid = currentKeyId();
  if (kid) {
    if (markedKid !== kid) {
      await qRaw(
        `INSERT INTO settings (key, value) VALUES ('encryption', jsonb_build_object('required', true, 'kid', $1::text, 'since', now()))
         ON CONFLICT (key) DO UPDATE SET value = settings.value || jsonb_build_object('required', true, 'kid', $1::text), updated_at = now()
         WHERE settings.value->>'kid' IS DISTINCT FROM $1::text OR (settings.value->>'required') IS DISTINCT FROM 'true'`,
        [kid],
      );
      markedKid = kid;
    }
    return sealing;
  }
  if (dataKeyProblem()) return refusing();
  if (!requiredCache || Date.now() - requiredCache.at > 60_000) {
    requiredCache = { value: (await getEncryptionSetting()).required === true, at: Date.now() };
  }
  return requiredCache.value ? refusing() : plain;
}

/**
 * The normalised forms exact lookups compare, for blind indexes (and for
 * plaintext rows not encrypted yet). Empty means "nothing to index".
 */
export const matchKey = {
  name: (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase(),
  email: (s: string) => s.trim().toLowerCase(),
  /** The last ten digits, as resolve_person always matched phones. */
  phone: (s: string) => {
    const digits = s.replace(/\D/g, "");
    return digits.length >= 7 ? digits.slice(-10) : "";
  },
};

/** A value's blind index under every key we hold (current first). */
export function lookupIndexes(purpose: IndexPurpose, normalised: string): string[] {
  return blindIndexes(purpose, normalised);
}

const collator = new Intl.Collator("en");
/** Names sort here, not in SQL: ORDER BY on ciphertext is random. */
export function byName<T>(get: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => collator.compare(get(a), get(b));
}

// ---------- Notes ----------

export async function createNote(input: {
  title: string;
  body?: string;
  type?: NoteType;
  source?: string;
  tags?: string[];
}): Promise<Note> {
  const s = await sealer();
  const [note] = await q<Note>(
    `INSERT INTO notes (title, body, type, source, tags) VALUES ($1, $2, $3, $4, $5::text[]) RETURNING *`,
    [s.text(input.title), s.text(input.body ?? ""), input.type ?? "note", input.source ?? null, s.list(input.tags ?? [])],
  );
  await syncContentLinks(note.id, note.body);
  return (await dropLinkedPeopleTags(note.id)) ?? note;
}

/**
 * Change a note. A change to the title or body first keeps what was there in
 * note_versions (lib/note-versions.ts; 0061), whoever is making it, so any
 * overwrite can be put back. The stored values are copied as they are (still
 * sealed). `by` says what is making the change: 'mcp', 'api', 'restore', …,
 * or 'owner' for the app's own editor.
 * The owner's typing saves every few seconds, so it is grouped: an 'owner'
 * change keeps nothing while the note's newest version is itself an 'owner'
 * one from the last 10 minutes (that version already holds where they started).
 *
 * Each version also says what wrote it (`written_by`, 0094): what made the
 * change before ('' when that change didn't say; null when there was none).
 * Two allowances are kept per note: the newest 20 the owner wrote ('owner' or
 * 'restore', or null) and the newest 30 anyone else wrote (lib/note-versions.ts). A change the owner didn't make only drops
 * versions of the second kind, so no number of edits by an MCP client, a run
 * or a script pushes the owner's own words out of the history.
 */
export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, "title" | "body" | "type" | "tags" | "source">>,
  opts: { by?: string } = {},
): Promise<Note | null> {
  const s = await sealer();
  if (patch.title !== undefined || patch.body !== undefined) {
    const [was] = await q<{ title: string; body: string }>(`SELECT title, body FROM notes WHERE id = $1`, [id]);
    if (was && ((patch.body !== undefined && patch.body !== was.body) || (patch.title !== undefined && patch.title !== was.title))) {
      // One statement: the copy, then each allowance trimmed (the new version, unseen by `ranked`, takes one place in
      // its own). The owner's versions are trimmed only by a change the owner made.
      await q(
        `WITH kept AS (
           INSERT INTO note_versions (note_id, title, body, changed_by, written_by)
           SELECT id, title, body, $2::text,
             (SELECT COALESCE(changed_by, '') FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)
           FROM notes WHERE id = $1
             AND NOT ($2::text IS NOT DISTINCT FROM 'owner' AND COALESCE((
               SELECT changed_by = 'owner' AND created_at > now() - interval '10 minutes'
               FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1), false))
           RETURNING note_id, COALESCE(written_by IN ('owner', 'restore'), true) AS owners
         ),
         ranked AS (
           SELECT id, owners, row_number() OVER (PARTITION BY owners ORDER BY created_at DESC, id DESC) AS n
           FROM (SELECT id, created_at, COALESCE(written_by IN ('owner', 'restore'), true) AS owners FROM note_versions WHERE note_id = $1) v
         )
         DELETE FROM note_versions v USING kept, ranked
         WHERE v.note_id = kept.note_id AND v.id = ranked.id
           AND ranked.n > (CASE WHEN ranked.owners THEN 20 ELSE 30 END) - (CASE WHEN ranked.owners = kept.owners THEN 1 ELSE 0 END)
           AND (NOT ranked.owners OR COALESCE($2::text IN ('owner', 'restore'), false))`,
        [id, opts.by?.slice(0, 40) ?? null],
      );
    }
  }
  const [note] = await q<Note>(
    `UPDATE notes SET
       title = COALESCE($2, title),
       body = COALESCE($3, body),
       type = COALESCE($4, type),
       tags = COALESCE($5::text[], tags),
       source = COALESCE($6, source),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, s.maybe(patch.title ?? null), s.maybe(patch.body ?? null), patch.type ?? null, patch.tags ? s.list(patch.tags) : null, patch.source ?? null],
  );
  if (!note) return null;
  if (patch.body !== undefined) await syncContentLinks(note.id, note.body);
  return (await dropLinkedPeopleTags(note.id)) ?? note;
}

/** A tag or name as dropLinkedPeopleTags compares them: trimmed, no leading # or @, any case. */
const tagKey = (t: string) => t.trim().replace(/^[#@]+/, "").toLowerCase();

/**
 * A person linked to a note doesn't also need to be one of its tags: drop
 * tags that are a linked (live) person's full name, first name or email,
 * ignoring case and a leading # or @. Runs whenever a note's tags or links
 * change, so it holds whichever comes first. Returns the note if it changed.
 * Names and tags are encrypted, so this compares them here, and writes only
 * if the tags are still what it read.
 */
export async function dropLinkedPeopleTags(noteId: string): Promise<Note | null> {
  const linked = await q<{ name: string; email: string }>(
    `SELECT p.name, p.email
     FROM edges e
     JOIN people p ON p.id = CASE WHEN e.source_type = 'person' THEN e.source_id ELSE e.target_id END
     WHERE p.archived_at IS NULL
       AND ((e.source_type = 'note' AND e.source_id = $1 AND e.target_type = 'person')
         OR (e.target_type = 'note' AND e.target_id = $1 AND e.source_type = 'person'))`,
    [noteId],
  );
  const keys = new Set<string>();
  for (const p of linked) {
    if (isEncryptedPlaceholder(p.name)) continue;
    keys.add(p.name.trim().toLowerCase());
    keys.add(p.name.trim().split(" ")[0].toLowerCase());
    if (p.email && !isEncryptedPlaceholder(p.email)) keys.add(p.email.trim().toLowerCase());
  }
  if (keys.size === 0) return null;
  const [stored] = await qRaw<{ tags: string[] }>(`SELECT tags FROM notes WHERE id = $1`, [noteId]);
  if (!stored) return null;
  const tags = openDeep([...stored.tags]);
  const kept = tags.filter((t) => isEncryptedPlaceholder(t) || !keys.has(tagKey(t)));
  if (kept.length === tags.length) return null;
  const s = await sealer();
  const [note] = await q<Note>(`UPDATE notes SET tags = $2::text[] WHERE id = $1 AND tags = $3::text[] RETURNING *`, [
    noteId,
    s.list(kept),
    stored.tags,
  ]);
  return note ?? null;
}

/** By id. Archived notes are hidden unless `includeArchived` (the Archived page). */
export async function getNote(id: string, opts: { includeArchived?: boolean } = {}): Promise<Note | null> {
  const [note] = await q<Note>(
    `SELECT * FROM notes WHERE id = $1 AND ($2::boolean OR archived_at IS NULL)`,
    [id, opts.includeArchived ?? false],
  );
  return note ?? null;
}

export async function listNotes(
  opts: { type?: NoteType; since?: Date; source?: string; limit?: number; includeArchived?: boolean } = {},
): Promise<Note[]> {
  return q<Note>(
    `SELECT * FROM notes
     WHERE ($1::boolean OR archived_at IS NULL)
       AND ($2::text IS NULL OR type = $2)
       AND ($3::timestamptz IS NULL OR updated_at >= $3)
       AND ($4::text IS NULL OR source = $4)
     ORDER BY updated_at DESC
     LIMIT $5`,
    [
      opts.includeArchived ?? false,
      opts.type ?? null,
      opts.since ? opts.since.toISOString() : null,
      opts.source ?? null,
      opts.limit ?? 50,
    ],
  );
}

const SCAN_PAGE = 400;

/**
 * Case-insensitive substring search over titles and bodies, newest first.
 * They're encrypted, so this reads notes a page at a time, newest first,
 * and stops as soon as it has `limit` matches.
 */
export async function searchNotesByKeyword(query: string, limit = 20): Promise<Note[]> {
  const needle = query.toLowerCase();
  const found: Note[] = [];
  for (let offset = 0; ; offset += SCAN_PAGE) {
    const page = await q<Note>(`SELECT * FROM notes WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT $1 OFFSET $2`, [
      SCAN_PAGE,
      offset,
    ]);
    for (const note of page) {
      const hit = [note.title, note.body].some((v) => !isEncryptedPlaceholder(v) && v.toLowerCase().includes(needle));
      if (hit && !found.some((n) => n.id === note.id)) found.push(note);
      if (found.length >= limit) return found;
    }
    if (page.length < SCAN_PAGE) return found;
  }
}

/**
 * Semantic search over note_chunks via pgvector cosine distance (`<=>`).
 * Chunk text is encrypted like the note it came from; the embedding can't
 * be (docs: security/encryption), and nothing writes chunks yet.
 */
export async function searchNotesBySimilarity(
  embedding: number[],
  limit = 10,
): Promise<NoteChunkMatch[]> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  return q<NoteChunkMatch>(
    `SELECT n.id AS note_id, n.title AS title, c.content AS chunk_content, (c.embedding <=> $1::vector) AS distance
     FROM note_chunks c
     JOIN notes n ON n.id = c.note_id
     WHERE n.archived_at IS NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral, limit],
  );
}

export async function upsertNoteChunk(input: {
  noteId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
}): Promise<void> {
  const s = await sealer();
  const vectorLiteral = `[${input.embedding.join(",")}]`;
  await q(
    `INSERT INTO note_chunks (note_id, chunk_index, content, embedding)
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (note_id, chunk_index)
     DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
    [input.noteId, input.chunkIndex, s.text(input.content), vectorLiteral],
  );
}

/** Quick inbox-style capture — the one-tap/voice/Shortcut entry point. */
export async function capture(input: { text: string; source?: string }): Promise<Note> {
  const title = input.text.length > 80 ? `${input.text.slice(0, 77)}...` : input.text;
  return createNote({
    title,
    body: input.text,
    type: "capture",
    source: input.source ?? "manual",
  });
}

/**
 * Make a note's (or a custom record's, or a to-do's) origin='content' edges exactly match
 * the athena:// links in its body (relation 'mentions'). Manual edges are
 * never touched. If a manual edge with the same relation already exists, the
 * unique constraint keeps it as-is and no content duplicate is added.
 */
export async function syncContentLinks(id: string, body: string, from: "note" | "record" | "commitment" = "note"): Promise<void> {
  const keys = contentEdgeKeys(body, { kind: from, id }).filter((k) =>
    (ENTITY_TYPES as readonly string[]).includes(k.split(":")[0]),
  );
  await q(
    `DELETE FROM edges
     WHERE source_type = $3 AND source_id = $1 AND origin = 'content'
       AND NOT ((target_type || ':' || target_id::text) = ANY($2::text[]))`,
    [id, keys, from],
  );
  if (keys.length === 0) return;
  await q(
    `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, origin)
     SELECT $3, $1::uuid, split_part(k, ':', 1), split_part(k, ':', 2)::uuid, 'mentions', 'content'
     FROM unnest($2::text[]) AS k
     ON CONFLICT (source_type, source_id, target_type, target_id, relation) DO NOTHING`,
    [id, keys, from],
  );
}

// ---------- Shared shapes for the per-kind tables ----------

const TABLES: Record<EntityType, string> = {
  note: "notes",
  person: "people",
  project: "projects",
  place: "places",
  organisation: "organisations",
  event: "events",
  record: "custom_records",
  saved: "saved_items",
  commitment: "commitments",
  reading: "reading_items",
};

/** Display-title column per table. */
const TITLE_COLUMN: Record<EntityType, string> = {
  note: "title",
  person: "name",
  project: "name",
  place: "name",
  organisation: "name",
  event: "title",
  record: "title",
  saved: "title",
  commitment: "title",
  reading: "title",
};

/**
 * Table and display-title column(s) for the layer-2 kinds (the Archived page
 * lists them too). Titles built from encrypted columns are put together in
 * listArchived, not in SQL.
 */
const MEMORY_TABLES: Record<MemoryKind, { table: string; title: string; detail?: string }> = {
  commitment: { table: "commitments", title: "title" },
  interaction: { table: "interactions", title: "summary" },
  fact: { table: "facts", title: "key", detail: "value" },
  asset: { table: "assets", title: "name" },
  reading: { table: "reading_items", title: "title" },
  goal: { table: "goals", title: "title" },
};

const isMemoryKind = (kind: ArchivableKind): kind is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(kind);

function tableFor(kind: ArchivableKind): string {
  if (kind === "kind") return "custom_kinds";
  return isLogisticsKind(kind) ? LOGISTICS_TABLES[kind] : isMemoryKind(kind) ? MEMORY_TABLES[kind].table : TABLES[kind];
}

/** Every people column except the blind indexes, which never leave the server. */
const PERSON_COLUMNS = `p.id, p.name, p.notes, p.relationship, p.email, p.phone, p.catch_up_days, p.keep_in_touch,
    p.last_contacted_at, p.archived_at, p.created_at, p.updated_at`;

const PERSON_SELECT = `
  SELECT ${PERSON_COLUMNS},
    CASE WHEN b.id IS NULL THEN NULL
         WHEN b.year_known THEN to_char(b.date, 'YYYY-MM-DD')
         ELSE to_char(b.date, '"--"MM-DD') END AS birthday,
    b.id AS birthday_event_id,
    (SELECT json_build_object('id', o.id, 'name', o.name)
       FROM edges e JOIN organisations o ON o.id = e.target_id AND o.archived_at IS NULL
      WHERE e.source_type = 'person' AND e.source_id = p.id
        AND e.target_type = 'organisation' AND e.relation = 'works_at'
      ORDER BY e.created_at DESC LIMIT 1) AS organisation
  FROM people p
  LEFT JOIN events b ON b.person_id = p.id AND b.kind = 'birthday' AND b.archived_at IS NULL`;

const EVENT_COLUMNS = `
  id, title, kind, to_char(date, 'YYYY-MM-DD') AS date, to_char(time, 'HH24:MI') AS time,
  recurrence, year_known, remind_days_before, notes, person_id, source, timed_push, starts_at, ends_at, archived_at, created_at, updated_at,
  rsvp, rsvp_calendar, rsvp_mine, rsvp_error, calendar_connector_id, calendar_id, calendar_event_id,
  (SELECT json_build_object('id', c.id, 'name', c.name, 'label', c.account_label, 'provider', c.provider, 'scope', c.scope, 'status', c.status)
     FROM connectors c WHERE c.id = events.calendar_connector_id) AS rsvp_account`;

type EventRow = Omit<AthenaEvent, "rsvp_account"> & { rsvp_account: { id: string; name: string; label: string; provider: string; scope: string; status: string } | null };

/** The calendar account an invite came from, as the app needs it: whether answers can go back to it. */
function eventOut(row: EventRow): AthenaEvent {
  const a = row.rsvp_account;
  return { ...row, rsvp_account: a ? { id: a.id, name: a.name, label: a.label, provider: a.provider, can_send: canRsvp(a) && a.status === "connected" } : null };
}

function liveClause(alias: string, includeArchived: boolean | undefined): string {
  return includeArchived ? "TRUE" : `${alias}.archived_at IS NULL`;
}

/** Fetch one non-note record by kind + id (archived hidden unless asked). */
export async function getRecord(
  kind: RecordKind,
  id: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Person | Project | Place | Organisation | AthenaEvent | null> {
  switch (kind) {
    case "person":
      return getPerson(id, opts);
    case "event":
      return getEvent(id, opts);
    default: {
      const [row] = await q<Project | Place | Organisation>(
        `SELECT * FROM ${TABLES[kind]} WHERE id = $1 AND (${liveClause(TABLES[kind], opts.includeArchived)})`,
        [id],
      );
      return row ?? null;
    }
  }
}

/** List one kind of record, live only, sorted by name (events: by date). */
export async function listRecords(
  kind: RecordKind,
  limit = 200,
): Promise<Array<Person | Project | Place | Organisation | AthenaEvent>> {
  switch (kind) {
    case "person":
      return listPeople(limit);
    case "project":
      return listProjects(limit);
    case "place":
      return listPlaces(limit);
    case "organisation":
      return listOrganisations(limit);
    case "event":
      return listEvents({ limit });
  }
}

// ---------- People ----------

/**
 * Birthday input: "YYYY-MM-DD", or "--MM-DD" / "MM-DD" when the year isn't
 * known (stored against the leap year 2000 so 29 February works).
 */
export function parseBirthday(raw: string, label = "birthday"): { date: string; yearKnown: boolean } {
  const s = raw.trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (full) {
    if (!isValidDate(s)) throw new AthenaInputError(`Invalid ${label} '${raw}'`);
    return { date: s, yearKnown: true };
  }
  const partial = /^(?:--)?(\d{2})-(\d{2})$/.exec(s);
  if (partial) {
    const date = `2000-${partial[1]}-${partial[2]}`;
    if (!isValidDate(date)) throw new AthenaInputError(`Invalid ${label} '${raw}'`);
    return { date, yearKnown: false };
  }
  throw new AthenaInputError(`Invalid ${label} '${raw}': use YYYY-MM-DD, or --MM-DD if the year isn't known`);
}

export interface PersonInput {
  id?: string;
  name?: string;
  notes?: string;
  relationship?: string;
  email?: string;
  phone?: string;
  /** null clears back to the default cadence. */
  catch_up_days?: number | null;
  /** true = nudge the owner to catch up with them. */
  keep_in_touch?: boolean;
  /** ISO timestamp; null clears. */
  last_contacted_at?: string | null;
  /** See parseBirthday; null clears (the birthday event is archived, not deleted). */
  birthday?: string | null;
  /** Organisation they work at (a manual `works_at` edge); null clears. */
  organisation_id?: string | null;
}

export async function upsertPerson(input: PersonInput): Promise<Person> {
  let id = input.id;
  const has = (k: keyof PersonInput) => input[k] !== undefined;
  const s = await sealer();
  // A blind index changes only with its field: null = leave it as it is.
  const index = (purpose: IndexPurpose, key: (v: string) => string, value: string | undefined) =>
    value === undefined ? null : s.index(purpose, key(value));
  if (id) {
    const [row] = await q<{ id: string }>(
      `UPDATE people SET
         name = COALESCE($2, name),
         notes = COALESCE($3, notes),
         relationship = COALESCE($4, relationship),
         email = COALESCE($5, email),
         phone = COALESCE($6, phone),
         catch_up_days = CASE WHEN $7::boolean THEN $8::int ELSE catch_up_days END,
         last_contacted_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE last_contacted_at END,
         keep_in_touch = COALESCE($11, keep_in_touch),
         name_bidx = CASE WHEN $2::text IS NULL THEN name_bidx ELSE $12 END,
         email_bidx = CASE WHEN $5::text IS NULL THEN email_bidx ELSE $13 END,
         phone_bidx = CASE WHEN $6::text IS NULL THEN phone_bidx ELSE $14 END,
         updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [
        id,
        s.maybe(input.name ?? null),
        s.maybe(input.notes ?? null),
        s.maybe(input.relationship ?? null),
        s.maybe(input.email ?? null),
        s.maybe(input.phone ?? null),
        has("catch_up_days"),
        input.catch_up_days ?? null,
        has("last_contacted_at"),
        input.last_contacted_at ?? null,
        input.keep_in_touch ?? null,
        index("name", matchKey.name, input.name),
        index("email", matchKey.email, input.email),
        index("phone", matchKey.phone, input.phone),
      ],
    );
    if (!row) throw new AthenaInputError(`Person ${id} not found`, 404);
  } else {
    if (!input.name) throw new AthenaInputError("A new person needs a name");
    const [row] = await q<{ id: string }>(
      `INSERT INTO people (name, notes, relationship, email, phone, catch_up_days, last_contacted_at, keep_in_touch,
                           name_bidx, email_bidx, phone_bidx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        s.text(input.name),
        s.text(input.notes ?? ""),
        s.text(input.relationship ?? ""),
        s.text(input.email ?? ""),
        s.text(input.phone ?? ""),
        input.catch_up_days ?? null,
        input.last_contacted_at ?? null,
        input.keep_in_touch ?? false,
        index("name", matchKey.name, input.name),
        index("email", matchKey.email, input.email ?? ""),
        index("phone", matchKey.phone, input.phone ?? ""),
      ],
    );
    id = row.id;
  }

  // The birthday event is titled "<name>'s birthday", put together here: SQL can't append to an encrypted name.
  const birthdayTitle = async () => {
    const [p] = await q<{ name: string }>(`SELECT name FROM people WHERE id = $1`, [id]);
    return `${p.name}'s birthday`;
  };
  if (input.birthday === null) {
    await q(
      `UPDATE events SET archived_at = now(), updated_at = now()
       WHERE person_id = $1 AND kind = 'birthday' AND archived_at IS NULL`,
      [id],
    );
  } else if (typeof input.birthday === "string") {
    const { date, yearKnown } = parseBirthday(input.birthday);
    await q(
      `INSERT INTO events (title, kind, date, recurrence, year_known, person_id)
       VALUES ($4, 'birthday', $2::date, 'yearly', $3, $1)
       ON CONFLICT (person_id) WHERE kind = 'birthday' AND person_id IS NOT NULL
       DO UPDATE SET date = EXCLUDED.date, year_known = EXCLUDED.year_known,
                     recurrence = 'yearly', archived_at = NULL, updated_at = now()`,
      [id, date, yearKnown, s.text(await birthdayTitle())],
    );
  }
  if (input.name) {
    // Keep the birthday event's title in step with a rename.
    const [event] = await q<{ id: string; title: string }>(`SELECT id, title FROM events WHERE person_id = $1 AND kind = 'birthday'`, [id]);
    const title = `${input.name}'s birthday`;
    if (event && event.title !== title) {
      await q(`UPDATE events SET title = $2, updated_at = now() WHERE id = $1`, [event.id, s.text(title)]);
    }
  }

  if (input.organisation_id !== undefined) {
    await q(
      `DELETE FROM edges WHERE source_type = 'person' AND source_id = $1
         AND target_type = 'organisation' AND relation = 'works_at'
         AND ($2::uuid IS NULL OR target_id <> $2::uuid)`,
      [id, input.organisation_id],
    );
    if (input.organisation_id) {
      await linkEntities({
        sourceType: "person",
        sourceId: id,
        targetType: "organisation",
        targetId: input.organisation_id,
        relation: "works_at",
      });
    }
  }

  const person = await getPerson(id, { includeArchived: true });
  if (!person) throw new AthenaInputError(`Person ${id} not found`, 404);
  return person;
}

export async function getPerson(id: string, opts: { includeArchived?: boolean } = {}): Promise<Person | null> {
  const [person] = await q<Person>(`${PERSON_SELECT} WHERE p.id = $1 AND (${liveClause("p", opts.includeArchived)})`, [id]);
  return person ?? null;
}

/** Live people, alphabetical (sorted here: names are encrypted). */
export async function listPeople(limit = 100): Promise<Person[]> {
  const people = await q<Person>(`${PERSON_SELECT} WHERE p.archived_at IS NULL`);
  return people.sort(byName((p) => p.name)).slice(0, limit);
}

/**
 * People overdue a catch-up: not contacted within their own cadence
 * (catch_up_days, else `days`), or never. The CRM nudge feature — every
 * catch-up surface reads this, so only people you keep in touch with count.
 */
/**
 * Keep-in-touch people overdue a catch-up. "Last seen" is the latest of
 * last_contacted_at, a catch-up logged with them (in person, a call or
 * "caught up") and a calendar event with them at a place: the same things
 * Home's Your people reads (lastSeenBy in app/src/lib/home-personal.ts), so
 * Home never says "Lunch at Dishoom, today" and "last spoke 3 weeks ago"
 * about one person. Each row's last_contacted_at is that latest time.
 */
export async function listStalePeople(days = DEFAULT_CATCH_UP_DAYS): Promise<Person[]> {
  const rows = await q<Person & { last_seen: string | null }>(
    `SELECT x.*, ls.last_seen FROM (${PERSON_SELECT} WHERE p.archived_at IS NULL AND p.keep_in_touch) x
     CROSS JOIN LATERAL (SELECT GREATEST(
       x.last_contacted_at,
       (SELECT max(i.at) FROM interactions i JOIN interaction_people ip ON ip.interaction_id = i.id
         WHERE ip.person_id = x.id AND i.archived_at IS NULL AND i.at <= now() AND i.channel IN ('in_person', 'call', 'other')),
       (SELECT max(COALESCE(ev.starts_at, ev.date::timestamptz)) FROM events ev
         WHERE ev.archived_at IS NULL AND ev.recurrence = 'none' AND ev.rsvp <> 'declined'
           AND ev.kind NOT IN ('birthday', 'anniversary', 'deadline')
           AND COALESCE(ev.starts_at, ev.date::timestamptz) <= now()
           AND (ev.person_id = x.id
             OR EXISTS (SELECT 1 FROM edges e WHERE e.source_type = 'event' AND e.source_id = ev.id AND e.target_type = 'person' AND e.target_id = x.id)
             OR EXISTS (SELECT 1 FROM edges e WHERE e.target_type = 'event' AND e.target_id = ev.id AND e.source_type = 'person' AND e.source_id = x.id))
           AND EXISTS (SELECT 1 FROM places pl WHERE pl.archived_at IS NULL AND (
             pl.id IN (SELECT e.target_id FROM edges e WHERE e.source_type = 'event' AND e.source_id = ev.id AND e.target_type = 'place')
             OR pl.id IN (SELECT e.source_id FROM edges e WHERE e.target_type = 'event' AND e.target_id = ev.id AND e.source_type = 'place'))))
     ) AS last_seen) ls
     WHERE ls.last_seen IS NULL OR ls.last_seen < now() - make_interval(days => COALESCE(x.catch_up_days, $1::int))
     ORDER BY ls.last_seen ASC NULLS FIRST`,
    [days],
  );
  return rows.map(({ last_seen, ...p }) => ({ ...p, last_contacted_at: last_seen ? new Date(last_seen).toISOString() : null }));
}

// ---------- Projects ----------

export async function upsertProject(input: {
  id?: string;
  name?: string;
  status?: Project["status"];
  description?: string;
}): Promise<Project> {
  const s = await sealer();
  if (input.id) {
    const [project] = await q<Project>(
      `UPDATE projects SET
         name = COALESCE($2, name),
         status = COALESCE($3, status),
         description = COALESCE($4, description),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.id, input.name ?? null, input.status ?? null, s.maybe(input.description ?? null)],
    );
    if (!project) throw new AthenaInputError(`Project ${input.id} not found`, 404);
    return project;
  }
  if (!input.name) throw new AthenaInputError("A new project needs a name");
  const [project] = await q<Project>(
    `INSERT INTO projects (name, status, description) VALUES ($1, $2, $3) RETURNING *`,
    [input.name, input.status ?? "active", s.text(input.description ?? "")],
  );
  return project;
}

export async function listProjects(limit = 100): Promise<Project[]> {
  return q<Project>(`SELECT * FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT $1`, [limit]);
}

// ---------- Places ----------

export async function upsertPlace(input: {
  id?: string;
  name?: string;
  address?: string;
  url?: string;
  notes?: string;
}): Promise<Place> {
  const s = await sealer();
  if (input.id) {
    const [place] = await q<Place>(
      `UPDATE places SET
         name = COALESCE($2, name),
         address = COALESCE($3, address),
         url = COALESCE($4, url),
         notes = COALESCE($5, notes),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.id, input.name ?? null, s.maybe(input.address ?? null), s.maybe(input.url ?? null), s.maybe(input.notes ?? null)],
    );
    if (!place) throw new AthenaInputError(`Place ${input.id} not found`, 404);
    return place;
  }
  if (!input.name) throw new AthenaInputError("A new place needs a name");
  const [place] = await q<Place>(
    `INSERT INTO places (name, address, url, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.name, s.text(input.address ?? ""), s.text(input.url ?? ""), s.text(input.notes ?? "")],
  );
  return place;
}

export async function listPlaces(limit = 200): Promise<Place[]> {
  return q<Place>(`SELECT * FROM places WHERE archived_at IS NULL ORDER BY name ASC LIMIT $1`, [limit]);
}

// ---------- Organisations ----------

export async function upsertOrganisation(input: {
  id?: string;
  name?: string;
  website?: string;
  notes?: string;
}): Promise<Organisation> {
  const s = await sealer();
  if (input.id) {
    const [org] = await q<Organisation>(
      `UPDATE organisations SET
         name = COALESCE($2, name),
         website = COALESCE($3, website),
         notes = COALESCE($4, notes),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.id, input.name ?? null, s.maybe(input.website ?? null), s.maybe(input.notes ?? null)],
    );
    if (!org) throw new AthenaInputError(`Organisation ${input.id} not found`, 404);
    return org;
  }
  if (!input.name) throw new AthenaInputError("A new organisation needs a name");
  const [org] = await q<Organisation>(
    `INSERT INTO organisations (name, website, notes) VALUES ($1, $2, $3) RETURNING *`,
    [input.name, s.text(input.website ?? ""), s.text(input.notes ?? "")],
  );
  return org;
}

export async function listOrganisations(limit = 200): Promise<Organisation[]> {
  return q<Organisation>(`SELECT * FROM organisations WHERE archived_at IS NULL ORDER BY name ASC LIMIT $1`, [limit]);
}

// ---------- Events & dates ----------

export interface EventInput {
  id?: string;
  title?: string;
  kind?: EventKind;
  /** "YYYY-MM-DD"; or "--MM-DD" for a yearly date whose year isn't known. */
  date?: string;
  /** "HH:MM" wall clock in `tz`; null makes it all-day. For a one-off it becomes `starts_at`. */
  time?: string | null;
  /** The UTC instant a timed one-off starts: ISO 8601 with Z or an offset. null = all-day. */
  starts_at?: string | null;
  /** The UTC instant a timed one-off ends: ISO 8601 with Z or an offset. null = not known. Left out: kept, moved with the start. */
  ends_at?: string | null;
  /** IANA zone that `date` + `time` are in (defaults to the owner's). */
  tz?: string;
  recurrence?: Recurrence;
  year_known?: boolean;
  remind_days_before?: number[];
  notes?: string;
  person_id?: string | null;
  source?: string | null;
  timed_push?: boolean;
}

/**
 * When a timed event ends: the end it was given if that's after the start; with none given,
 * the stored end, moved by as much as the start moved. Null for all-day and yearly events. Exported for tests.
 */
export function eventEnd(startsAt: string | null, given: string | null | undefined, existing: { starts_at: string | null; ends_at?: string | null } | null): string | null {
  if (!startsAt) return null;
  const start = Date.parse(startsAt);
  if (given !== undefined) return given !== null && Date.parse(given) > start ? new Date(Date.parse(given)).toISOString() : null;
  if (!existing?.ends_at || !existing.starts_at) return null;
  const end = start + (Date.parse(existing.ends_at) - Date.parse(existing.starts_at));
  return end > start ? new Date(end).toISOString() : null;
}

function normaliseEventDate(raw: string): { date: string; yearKnown: boolean } {
  return parseBirthday(raw, "date"); // same grammar: full date or --MM-DD
}

function normaliseTime(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new AthenaInputError(`Invalid time '${raw}': use HH:MM (24h)`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function normaliseRemind(days: number[] | undefined): number[] | undefined {
  if (!days) return undefined;
  const clean = [...new Set(days.map((d) => Math.floor(d)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 365))];
  return clean.sort((a, b) => a - b);
}

/** An ISO instant with Z/offset, or a zone-less "YYYY-MM-DDTHH:MM" read in `tz`. */
function parseInstant(raw: string, tz: string): Date {
  const v = raw.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v);
  const d = local ? zonedToInstant(local[1], local[2], tz) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new AthenaInputError(`Invalid start '${raw}': use ISO 8601, e.g. 2026-11-07T09:30:00Z`);
  return d;
}

/**
 * Create or update an event. Timed one-offs are stored as a UTC `starts_at`;
 * a `date` + `time` given instead is read in `tz` (the owner's zone unless
 * the caller says otherwise). Yearly events keep a wall-clock `time`.
 */
export async function upsertEvent(input: EventInput): Promise<AthenaEvent> {
  if (input.tz !== undefined && !isValidTimeZone(input.tz)) throw new AthenaInputError(`Unknown time zone '${input.tz}'`);
  const tz = input.tz ?? (await getOwnerTimeZone());
  const existing = input.id ? await getEvent(input.id, { includeArchived: true }) : null;
  if (input.id && !existing) throw new AthenaInputError(`Event ${input.id} not found`, 404);
  if (input.kind && !EVENT_KINDS.includes(input.kind)) throw new AthenaInputError(`Invalid event kind '${input.kind}'`);

  const parsed = input.date ? normaliseEventDate(input.date) : undefined;
  const time = normaliseTime(input.time);
  const instant = input.starts_at === undefined ? undefined : input.starts_at === null ? null : parseInstant(input.starts_at, tz);
  // A date without a known year only makes sense if it repeats.
  const recurrence: Recurrence = input.recurrence ?? (parsed && !parsed.yearKnown ? "yearly" : (existing?.recurrence ?? "none"));
  const yearKnown = input.year_known ?? parsed?.yearKnown ?? existing?.year_known ?? true;

  // Where the event currently sits, in this zone.
  const was = existing?.starts_at ? zonedParts(new Date(existing.starts_at), tz) : null;
  let day = parsed?.date ?? was?.date ?? existing?.date;
  let clock: string | null = was?.time ?? existing?.time ?? null;
  if (instant) {
    const p = zonedParts(instant, tz);
    day = recurrence === "yearly" && parsed ? parsed.date : p.date;
    clock = p.time;
  } else if (instant === null) clock = null;
  else if (time !== undefined) clock = time;

  if (!day) throw new AthenaInputError("A new event needs a date (YYYY-MM-DD, or --MM-DD for a yearly date)");
  const startsAt = recurrence === "none" && clock ? (instant ?? zonedToInstant(day, clock, tz)) : null;
  const wallTime = recurrence === "yearly" ? clock : null;
  const remind = normaliseRemind(input.remind_days_before);

  const values = {
    title: input.title ?? existing?.title,
    kind: input.kind ?? existing?.kind ?? "other",
    date: day,
    time: wallTime,
    starts_at: startsAt ? startsAt.toISOString() : null,
    recurrence,
    year_known: yearKnown,
    remind: remind ?? existing?.remind_days_before ?? [0],
    notes: input.notes ?? existing?.notes ?? "",
    person_id: input.person_id !== undefined ? input.person_id : (existing?.person_id ?? null),
    source: input.source !== undefined ? input.source : (existing?.source ?? null),
    timed_push: input.timed_push ?? existing?.timed_push ?? true,
  };
  if (!values.title) throw new AthenaInputError("A new event needs a title");
  const endsAt = eventEnd(values.starts_at, input.ends_at === undefined ? undefined : input.ends_at === null ? null : parseInstant(input.ends_at, tz).toISOString(), existing);
  const s = await sealer();
  // An update writes the title and notes it was given and leaves the stored ones as they are.
  const params = [
    existing ? s.maybe(input.title ?? null) : s.text(values.title),
    values.kind,
    values.date,
    values.time,
    values.starts_at,
    values.recurrence,
    values.year_known,
    values.remind,
    existing ? s.maybe(input.notes ?? null) : s.text(values.notes),
    values.person_id,
    values.source,
    values.timed_push,
    endsAt,
  ];
  const [row] = existing
    ? await q<{ id: string }>(
        `UPDATE events SET title = COALESCE($1, title), kind = $2, date = $3::date, time = $4::time, starts_at = $5::timestamptz,
           recurrence = $6, year_known = $7, remind_days_before = $8::int[], notes = COALESCE($9, notes), person_id = $10::uuid,
           source = $11, timed_push = $12, ends_at = $13::timestamptz, updated_at = now()
         WHERE id = $14 RETURNING id`,
        [...params, existing.id],
      )
    : await q<{ id: string }>(
        `INSERT INTO events (title, kind, date, time, starts_at, recurrence, year_known, remind_days_before, notes, person_id, source, timed_push, ends_at)
         VALUES ($1, $2, $3::date, $4::time, $5::timestamptz, $6, $7, $8::int[], $9, $10::uuid, $11, $12, $13::timestamptz)
         RETURNING id`,
        params,
      );
  return (await getEvent(row.id, { includeArchived: true }))!;
}

export async function getEvent(id: string, opts: { includeArchived?: boolean } = {}): Promise<AthenaEvent | null> {
  const [event] = await q<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 AND (${liveClause("events", opts.includeArchived)})`,
    [id],
  );
  return event ? eventOut(event) : null;
}

/** Live events (and only birthdays of live people), soonest stored date first. */
export async function listEvents(opts: { limit?: number } = {}): Promise<AthenaEvent[]> {
  const rows = await q<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE archived_at IS NULL
       AND (person_id IS NULL OR person_id IN (SELECT id FROM people WHERE archived_at IS NULL))
     ORDER BY COALESCE(starts_at, date::timestamp AT TIME ZONE 'UTC') ASC, time ASC NULLS FIRST
     LIMIT $1`,
    [opts.limit ?? 500],
  );
  return rows.map(eventOut);
}

/** Home, This week and reminders leave out invites you declined; Events still lists them. */
export const notDeclined = (e: Pick<AthenaEvent, "rsvp">): boolean => e.rsvp !== "declined";

export type UpcomingEvent = Occurrence<AthenaEvent>;

export interface Upcoming {
  today: string;
  /** The zone `today`, `occurs_on` and `time` are in. */
  tz: string;
  events: UpcomingEvent[];
  /** People overdue a catch-up (their cadence, else the default). */
  catch_ups: Person[];
}

/**
 * Coming up: birthdays/events in the next `days` days (this week by default)
 * plus overdue catch-ups, with days and times in `tz` (the owner's zone unless given).
 */
export async function listUpcoming(days = 6, now: Date = new Date(), tz?: string): Promise<Upcoming> {
  const zone = tz && isValidTimeZone(tz) ? tz : await getOwnerTimeZone();
  const today = zonedToday(now, zone);
  const [events, catchUps] = await Promise.all([listEvents(), listStalePeople()]);
  return { today, tz: zone, events: upcomingOccurrences(events.filter(notDeclined), today, days, zone), catch_ups: catchUps };
}

// ---------- Settings ----------

/** The owner's IANA time zone, as their device last reported it (see /api/settings). */
export async function getOwnerTimeZone(): Promise<string> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'timezone'`);
    return isValidTimeZone(row?.value) ? row.value : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export async function setOwnerTimeZone(tz: string): Promise<void> {
  if (!isValidTimeZone(tz)) throw new AthenaInputError(`Unknown time zone '${tz}'`);
  await q(
    `INSERT INTO settings (key, value) VALUES ('timezone', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(tz)],
  );
  // Repeating reminders follow straight away (the reminders run would catch up within 5 minutes anyway).
  await reminderTimeZone();
}

/**
 * The zone pending repeating reminders' `remind_at`s are lined up with (see
 * alignReminders). Missing means Europe/London: every reminder made before
 * Athena used the owner's zone was made in London time.
 */
const REMINDER_ZONE_KEY = "reminder_timezone";

/**
 * The owner's time zone, for anything that schedules or fires reminders. One
 * settings read; if the owner's zone has changed since pending repeating
 * reminders were lined up, they're moved to it first.
 */
export async function reminderTimeZone(): Promise<string> {
  let owner = DEFAULT_TZ;
  let lined = DEFAULT_TZ;
  try {
    const rows = await q<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key IN ('timezone', $1)`, [REMINDER_ZONE_KEY]);
    for (const row of rows) {
      if (!isValidTimeZone(row.value)) continue;
      if (row.key === "timezone") owner = row.value;
      else lined = row.value;
    }
  } catch {
    return DEFAULT_TZ;
  }
  if (owner !== lined) {
    try {
      await alignReminders(owner);
    } catch (error) {
      // They stay where they were until the next run tries again.
      console.error("Athena: couldn't move reminders to the owner's time zone", error);
    }
  }
  return owner;
}

/**
 * Keep pending repeating reminders at their time of day in `tz`: 08:00 in
 * London becomes 08:00 in New York when the owner gets there. One-off
 * reminders are fixed moments, like timed events, and stay put. Locked on
 * the settings row, so two callers never move them twice. Returns how many moved.
 */
export async function alignReminders(tz: string): Promise<number> {
  if (!isValidTimeZone(tz)) throw new AthenaInputError(`Unknown time zone '${tz}'`);
  return tx(async (run) => {
    await run(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`, [REMINDER_ZONE_KEY, JSON.stringify(DEFAULT_TZ)]);
    const [row] = await run<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1 FOR UPDATE`, [REMINDER_ZONE_KEY]);
    const from = isValidTimeZone(row?.value) ? row.value : DEFAULT_TZ;
    if (from === tz) return 0;
    const pending = await run<{ id: string; remind_at: string | Date }>(
      `SELECT id, remind_at FROM reminders WHERE done_at IS NULL AND repeat <> 'none'`,
    );
    for (const r of pending) {
      const moved = sameWallClock(new Date(r.remind_at), from, tz);
      await run(`UPDATE reminders SET remind_at = $2::timestamptz, updated_at = now() WHERE id = $1`, [r.id, moved.toISOString()]);
    }
    await run(`UPDATE settings SET value = $2::jsonb, updated_at = now() WHERE key = $1`, [REMINDER_ZONE_KEY, JSON.stringify(tz)]);
    return pending.length;
  });
}

// ---------- Search across kinds (@-mention suggestions) ----------

// A custom record shows its kind's name for one ("wine") as its subtitle, and
// only while that kind isn't archived: archiving a kind hides its records.
const ENTITY_UNION = `
  SELECT 'note' AS kind, id, title, type AS subtitle, updated_at, NULL::uuid AS kind_id FROM notes WHERE archived_at IS NULL
  UNION ALL SELECT 'person', id, name, relationship, updated_at, NULL FROM people WHERE archived_at IS NULL
  UNION ALL SELECT 'place', id, name, address, updated_at, NULL FROM places WHERE archived_at IS NULL
  UNION ALL SELECT 'organisation', id, name, website, updated_at, NULL FROM organisations WHERE archived_at IS NULL
  UNION ALL SELECT 'event', id, title, to_char(date, 'YYYY-MM-DD'), updated_at, NULL FROM events
    WHERE archived_at IS NULL
      AND (person_id IS NULL OR person_id IN (SELECT id FROM people WHERE archived_at IS NULL))
  UNION ALL SELECT 'project', id, name, status, updated_at, NULL FROM projects WHERE archived_at IS NULL
  UNION ALL SELECT 'record', r.id, r.title, k.one, r.updated_at, r.kind_id FROM custom_records r
    JOIN custom_kinds k ON k.id = r.kind_id AND k.archived_at IS NULL
    WHERE r.archived_at IS NULL
  UNION ALL SELECT 'saved', id, COALESCE(title, quote, note, site), COALESCE(thing, kind), updated_at, NULL FROM saved_items WHERE archived_at IS NULL
  UNION ALL SELECT 'commitment', id, title, CASE WHEN status = 'done' AND kind <> 'decision' THEN 'done' ELSE kind END, updated_at, NULL
    FROM commitments WHERE archived_at IS NULL AND status <> 'dropped'
  UNION ALL SELECT 'reading', id, title, kind, updated_at, NULL FROM reading_items WHERE archived_at IS NULL`;

/** A to-do's subtitle in words, from its kind (or "done"). */
const COMMITMENT_SUB: Record<string, string> = { todo: "To-do", done: "Done", i_owe: "I owe", waiting_on: "Waiting on", decision: "Decision" };

/** A row of ENTITY_UNION as callers see it: a record's subtitle reads "Wine"; kind_id only on records. */
function shapeRef<T extends EntityRef>(row: T): T {
  const sub = row.subtitle ?? "";
  const cap = sub.charAt(0).toUpperCase() + sub.slice(1);
  if (row.kind === "record") return { ...row, subtitle: cap };
  const { kind_id: _k, ...rest } = row;
  if (row.kind === "commitment") return { ...rest, subtitle: COMMITMENT_SUB[sub] ?? cap } as T;
  if (row.kind === "reading") return { ...rest, subtitle: sub === "tv" ? "TV" : cap } as T;
  if (row.kind === "saved") {
    // A quote or a note stands in for a missing title: its first line, cut short.
    const line = (row.title ?? "").split("\n")[0].trim();
    const title = isEncryptedPlaceholder(row.title) ? row.title : line.length > 80 ? `${line.slice(0, 79)}…` : line || "Saved item";
    return { ...rest, title, subtitle: cap } as T;
  }
  return rest as T;
}

/**
 * Name/title search across every kind (live only). Empty `query` returns the
 * most recently touched. Exact matches rank first, then prefix matches, then
 * the rest. Titles are encrypted, so a typed query is matched here.
 */
export async function searchEntities(
  query: string,
  opts: { kinds?: EntityType[]; limit?: number } = {},
): Promise<EntityRef[]> {
  // Saved items, to-dos and Watch & read titles only when asked for: @-mentions search them apart (lib/mentions-db.ts).
  const kinds = (opts.kinds && opts.kinds.length > 0 ? opts.kinds : PAGE_TYPES).filter((k) =>
    ENTITY_TYPES.includes(k),
  );
  const limit = opts.limit ?? 12;
  const term = query.trim().toLowerCase();
  const select = `SELECT kind, id, title, COALESCE(subtitle, '') AS subtitle, updated_at, kind_id FROM (${ENTITY_UNION}) ents WHERE kind = ANY($1::text[])`;
  if (!term) return (await q<EntityRef>(`${select} ORDER BY (kind = 'event'), updated_at DESC LIMIT $2`, [kinds, limit])).map(shapeRef);
  const tier = (title: string) => (title === term ? 0 : title.startsWith(term) ? 1 : 2);
  const at = (r: EntityRef) => new Date(r.updated_at).getTime();
  return (await q<EntityRef>(select, [kinds]))
    .filter((r) => !isEncryptedPlaceholder(r.title) && r.title.toLowerCase().includes(term))
    .sort(
      (a, b) =>
        tier(a.title.toLowerCase()) - tier(b.title.toLowerCase()) ||
        Number(a.kind === "event") - Number(b.kind === "event") ||
        at(b) - at(a),
    )
    .slice(0, limit)
    .map(shapeRef);
}

// ---------- Edges (the graph) ----------

export async function linkEntities(input: {
  sourceType: EntityType;
  sourceId: string;
  targetType: EntityType;
  targetId: string;
  relation?: string;
}): Promise<Edge> {
  const relation = input.relation ?? "relates_to";
  const [edge] = await q<Edge>(
    `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, origin)
     VALUES ($1, $2, $3, $4, $5, 'manual')
     ON CONFLICT (source_type, source_id, target_type, target_id, relation) DO NOTHING
     RETURNING *`,
    [input.sourceType, input.sourceId, input.targetType, input.targetId, relation],
  );
  const kinds = new Set([input.sourceType, input.targetType]);
  if (edge && kinds.has("note") && kinds.has("person")) {
    await dropLinkedPeopleTags(input.sourceType === "note" ? input.sourceId : input.targetId);
  }
  if (edge) return edge;
  // Already linked: return the existing edge rather than undefined.
  const [existing] = await q<Edge>(
    `SELECT * FROM edges WHERE source_type = $1 AND source_id = $2 AND target_type = $3 AND target_id = $4 AND relation = $5`,
    [input.sourceType, input.sourceId, input.targetType, input.targetId, relation],
  );
  return existing;
}

/**
 * Remove manual link(s) between two entities (all relations unless one is
 * given). Content links are derived from note bodies — edit the note to
 * remove those — so they are left alone. Returns how many edges went.
 */
export async function unlinkEntities(input: {
  sourceType: EntityType;
  sourceId: string;
  targetType: EntityType;
  targetId: string;
  relation?: string;
}): Promise<number> {
  const rows = await q<{ id: string }>(
    `DELETE FROM edges
     WHERE source_type = $1 AND source_id = $2 AND target_type = $3 AND target_id = $4
       AND origin = 'manual' AND ($5::text IS NULL OR relation = $5)
     RETURNING id`,
    [input.sourceType, input.sourceId, input.targetType, input.targetId, input.relation ?? null],
  );
  return rows.length;
}

/** Raw edges touching an entity, either direction (no archive filtering). */
export async function getConnections(type: EntityType, id: string): Promise<Edge[]> {
  return q<Edge>(
    `SELECT * FROM edges
     WHERE (source_type = $1 AND source_id = $2) OR (target_type = $1 AND target_id = $2)
     ORDER BY created_at DESC`,
    [type, id],
  );
}

/**
 * An entity's links with titles: `outgoing` (things it links to) and
 * `backlinks` (things linking to it, e.g. notes mentioning a person).
 * Anything archived — on the other end — is left out.
 */
export async function getConnectionsDetailed(
  kind: EntityType,
  id: string,
): Promise<{ outgoing: Connection[]; backlinks: Connection[]; through_notes: ThroughNote[] }> {
  const rows = await q<Connection & { direction: "out" | "in" }>(
    `WITH ents AS (${ENTITY_UNION})
     SELECT e.id AS edge_id, e.relation, e.origin, 'out' AS direction,
            x.kind, x.id, x.title, COALESCE(x.subtitle, '') AS subtitle, x.updated_at, x.kind_id
       FROM edges e JOIN ents x ON x.kind = e.target_type AND x.id = e.target_id
      WHERE e.source_type = $1 AND e.source_id = $2
     UNION ALL
     SELECT e.id, e.relation, e.origin, 'in',
            x.kind, x.id, x.title, COALESCE(x.subtitle, ''), x.updated_at, x.kind_id
       FROM edges e JOIN ents x ON x.kind = e.source_type AND x.id = e.source_id
      WHERE e.target_type = $1 AND e.target_id = $2
     ORDER BY updated_at DESC`,
    [kind, id],
  );
  const strip = ({ direction: _d, ...rest }: Connection & { direction: string }): Connection => shapeRef(rest);
  return {
    outgoing: rows.filter((r) => r.direction === "out").map(strip),
    backlinks: rows.filter((r) => r.direction === "in").map(strip),
    through_notes: kind === "note" || !isPageType(kind) ? [] : await itemsThroughNotes(kind, id),
  };
}

/** A saved item, to-do or Watch & read title linked to a page by way of a note that links to both. */
export interface ThroughNote extends EntityRef {
  /** The note (the newest, when several do). */
  note: { id: string; title: string };
}

/**
 * Saved items, to-dos and Watch & read titles mentioned in the live notes
 * linked to this page, either way round. Their edges all start at notes, so
 * this is how "Ideas for Rowan: @green dress" puts the dress on Rowan's
 * page. One row per item, through its newest note.
 */
async function itemsThroughNotes(kind: PageType, id: string): Promise<ThroughNote[]> {
  const rows = await q<EntityRef & { note_id: string; note_title: string }>(
    `WITH ents AS (${ENTITY_UNION}),
     linked AS (
       SELECT e.source_id AS note_id FROM edges e WHERE e.source_type = 'note' AND e.target_type = $1 AND e.target_id = $2
       UNION SELECT e.target_id FROM edges e WHERE e.target_type = 'note' AND e.source_type = $1 AND e.source_id = $2
     )
     SELECT DISTINCT ON (x.kind, x.id) x.kind, x.id, x.title, COALESCE(x.subtitle, '') AS subtitle, x.updated_at, x.kind_id,
            n.id AS note_id, n.title AS note_title
       FROM linked l
       JOIN notes n ON n.id = l.note_id AND n.archived_at IS NULL
       JOIN edges e ON e.source_type = 'note' AND e.source_id = n.id AND e.target_type = ANY($3::text[])
       JOIN ents x ON x.kind = e.target_type AND x.id = e.target_id
      ORDER BY x.kind, x.id, n.updated_at DESC`,
    [kind, id, ITEM_TYPES],
  );
  return rows
    .map(({ note_id, note_title, ...r }) => ({ ...shapeRef(r), note: { id: note_id, title: note_title } }))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/** For Ask's find tools: the live notes that mention each of these saved items, to-dos or Watch & read titles (newest first, up to 5 each). */
export async function notesMentioning(kind: ItemType, ids: string[]): Promise<Map<string, Array<{ id: string; title: string }>>> {
  const out = new Map<string, Array<{ id: string; title: string }>>();
  if (!ids.length) return out;
  const rows = await q<{ target_id: string; id: string; title: string }>(
    `SELECT e.target_id, n.id, n.title FROM edges e JOIN notes n ON n.id = e.source_id AND n.archived_at IS NULL
      WHERE e.source_type = 'note' AND e.target_type = $1 AND e.target_id = ANY($2::uuid[])
      ORDER BY n.updated_at DESC`,
    [kind, ids],
  );
  for (const r of rows) {
    const list = out.get(r.target_id) ?? [];
    if (list.length < 5 && !list.some((n) => n.id === r.id)) list.push({ id: r.id, title: r.title || "Untitled" });
    out.set(r.target_id, list);
  }
  return out;
}

/** settings key: the newest version of syncContentLinks every note's edges have been through. */
const CONTENT_LINKS_KEY = "backfill.content-links";
/** 1: saved items, to-dos and Watch & read titles became edges (migration 0044). */
export const CONTENT_LINKS_VERSION = 1;

/**
 * Re-run content-link sync over existing notes and records, once per
 * CONTENT_LINKS_VERSION (the backfill-content-links scheduled function).
 * Bodies are sealed, so it has to happen here rather than in SQL. Picks up
 * where it stopped when it runs out of time; returns how many it synced and
 * whether it's done.
 */
export async function backfillContentLinks(opts: { budgetMs?: number; batch?: number } = {}): Promise<{ synced: number; done: boolean }> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 20_000;
  const batch = opts.batch ?? 100;
  const [state] = await q<{ value: { version?: number; after?: string; from?: string } }>(`SELECT value FROM settings WHERE key = $1`, [CONTENT_LINKS_KEY]);
  const at = state?.value ?? {};
  if ((at.version ?? 0) >= CONTENT_LINKS_VERSION) return { synced: 0, done: true };
  let from: "note" | "record" = at.from === "record" ? "record" : "note";
  let after = at.after ?? "00000000-0000-0000-0000-000000000000";
  let synced = 0;
  const save = (value: unknown) =>
    q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
      CONTENT_LINKS_KEY,
      JSON.stringify(value),
    ]);
  for (;;) {
    const table = from === "note" ? "notes" : "custom_records";
    const rows = await q<{ id: string; body: string | null }>(`SELECT id, body FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`, [after, batch]);
    for (const r of rows) {
      // A body that can't be opened here (an old key missing) keeps the edges it has.
      if (r.body && !isEncryptedPlaceholder(r.body)) await syncContentLinks(r.id, r.body, from);
      after = r.id;
      synced++;
    }
    if (rows.length < batch) {
      if (from === "note") {
        from = "record";
        after = "00000000-0000-0000-0000-000000000000";
        continue;
      }
      await save({ version: CONTENT_LINKS_VERSION });
      return { synced, done: true };
    }
    if (Date.now() - started > budget) {
      await save({ version: at.version ?? 0, after, from });
      return { synced, done: false };
    }
  }
}

// ---------- Archive / unarchive / delete forever ----------

/** Tables for trips, bookings and purchases (migration 0015, lib/trips.ts). */
const LOGISTICS_TABLES: Record<LogisticsKind, string> = { trip: "trips", booking: "trip_bookings", purchase: "purchases" };

const isLogisticsKind = (kind: ArchivableKind): kind is LogisticsKind => (LOGISTICS_KINDS as readonly string[]).includes(kind);

/**
 * A trip's dates follow its live bookings: the first local day to the last.
 * Cancelled bookings count only when nothing else is left. Used by
 * lib/trips.ts and when a booking is archived, restored or deleted.
 */
export async function refreshTripDates(tripId: string): Promise<void> {
  await q(
    // A trip the owner added keeps the dates they gave it, stretched to fit its bookings.
    `UPDATE trips t SET starts_on = CASE WHEN t.source = 'manual' THEN LEAST(t.starts_on, d.s) ELSE d.s END,
       ends_on = CASE WHEN t.source = 'manual' THEN GREATEST(t.ends_on, d.e) ELSE d.e END, updated_at = now()
     FROM (
       SELECT min(start_date) AS s, max(GREATEST(start_date, COALESCE(end_date, start_date))) AS e
       FROM trip_bookings b
       WHERE b.trip_id = $1 AND b.archived_at IS NULL
         AND (b.status <> 'cancelled' OR NOT EXISTS (
               SELECT 1 FROM trip_bookings x WHERE x.trip_id = $1 AND x.archived_at IS NULL AND x.status <> 'cancelled'))
     ) d
     WHERE t.id = $1 AND d.s IS NOT NULL`,
    [tripId],
  );
}

/** After a booking is archived, restored or deleted, its trip's dates move to fit what's left. */
async function afterBookingChange(tripId: string | undefined): Promise<void> {
  if (tripId) await refreshTripDates(tripId);
}

/** Hide an item everywhere except the Archived page. Agents may do this. */
export async function archiveEntity(kind: ArchivableKind, id: string): Promise<boolean> {
  const table = tableFor(kind);
  const rows = await q<{ id: string }>(
    `UPDATE ${table} SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id`,
    [id],
  );
  if (rows.length > 0) {
    if (kind === "booking") await afterBookingChange((await q<{ trip_id: string }>(`SELECT trip_id FROM trip_bookings WHERE id = $1`, [id]))[0]?.trip_id);
    return true;
  }
  // Already archived counts as success; a missing id doesn't.
  const [exists] = await q<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [id]);
  return Boolean(exists);
}

/**
 * Restore one of the owner's own kinds, at the end of their order, unless a
 * live kind already goes by its name (names are sealed, so they're compared
 * here) or there are already as many kinds as Athena keeps.
 */
async function unarchiveKind(id: string): Promise<boolean> {
  return tx(async (run) => {
    await run(`SELECT pg_advisory_xact_lock(hashtext('athena:custom_kinds'))`);
    const [k] = await run<{ name: string; one: string; archived_at: string | null }>(`SELECT name, one, archived_at FROM custom_kinds WHERE id = $1 FOR UPDATE`, [id]);
    if (!k) return false;
    if (!k.archived_at) return true;
    const live = await run<{ name: string; one: string }>(`SELECT name, one FROM custom_kinds WHERE archived_at IS NULL`);
    const clash = live.find((o) => sameLabel(o.name, k.name) || sameLabel(o.one, k.one));
    if (clash) throw new AthenaInputError(`There's already a “${clash.name}” ${KIND_WORD.one}. Rename it first, then restore this one.`);
    if (live.length >= KIND_LIMITS.kinds) throw new AthenaInputError(`You can have up to ${KIND_LIMITS.kinds} ${KIND_WORD.many}. Archive one you don't use first.`);
    await run(
      `UPDATE custom_kinds SET archived_at = NULL, updated_at = now(),
         position = (SELECT COALESCE(max(position) + 1, 0) FROM custom_kinds WHERE archived_at IS NULL)
       WHERE id = $1`,
      [id],
    );
    return true;
  });
}

export async function unarchiveEntity(kind: ArchivableKind, id: string): Promise<boolean> {
  if (kind === "kind") return unarchiveKind(id);
  // A purchase you bring back stays, rather than being archived again for being delivered a while ago.
  const extra = kind === "purchase" ? ", stay_visible = true, archived_by_athena = false" : "";
  const rows = await q<{ id: string }>(
    `UPDATE ${tableFor(kind)} SET archived_at = NULL${extra} WHERE id = $1 RETURNING id`,
    [id],
  );
  if (rows.length > 0 && kind === "booking") await afterBookingChange((await q<{ trip_id: string }>(`SELECT trip_id FROM trip_bookings WHERE id = $1`, [id]))[0]?.trip_id);
  return rows.length > 0;
}

/**
 * Permanently delete an item and every edge referencing it, in one statement
 * (so atomically). Deleting a person also deletes their birthday event and its
 * edges; deleting a person, place or organisation deletes the facts about it.
 * Its custom field values (lib/custom-fields.ts) go in the same statement.
 * A custom record takes its edges and values with it; one of the owner's own
 * kinds takes every record of it (and their edges and values) and its fields.
 * App-only: deliberately not exposed through MCP.
 */
export async function deleteEntityForever(kind: ArchivableKind, id: string): Promise<boolean> {
  if (kind === "record") {
    const rows = await q<{ id: string }>(
      `WITH gone_edges AS (
         DELETE FROM edges WHERE (source_type = 'record' AND source_id = $1::uuid) OR (target_type = 'record' AND target_id = $1::uuid) RETURNING 1
       ),
       gone_values AS (
         DELETE FROM custom_values v USING custom_records r
         WHERE r.id = $1::uuid AND v.entity_id = r.id AND v.entity_kind = 'custom:' || r.kind_id::text RETURNING 1
       )
       DELETE FROM custom_records WHERE id = $1::uuid RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
  if (kind === "kind") {
    const rows = await q<{ id: string }>(
      `WITH gone_records AS (DELETE FROM custom_records WHERE kind_id = $1::uuid RETURNING id),
       gone_edges AS (
         DELETE FROM edges
         WHERE (source_type = 'record' AND source_id IN (SELECT id FROM gone_records))
            OR (target_type = 'record' AND target_id IN (SELECT id FROM gone_records))
         RETURNING 1
       ),
       gone_values AS (DELETE FROM custom_values WHERE entity_kind = 'custom:' || $1::text RETURNING 1),
       gone_fields AS (DELETE FROM custom_fields WHERE kind = 'custom:' || $1::text RETURNING 1)
       DELETE FROM custom_kinds WHERE id = $1::uuid RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
  if (isLogisticsKind(kind)) {
    // A trip takes its bookings with it, a purchase its timeline (ON DELETE CASCADE).
    const rows = await q<{ id: string; trip_id?: string }>(
      `DELETE FROM ${LOGISTICS_TABLES[kind]} WHERE id = $1 RETURNING id${kind === "booking" ? ", trip_id" : ""}`,
      [id],
    );
    if (kind === "booking") await afterBookingChange(rows[0]?.trip_id);
    return rows.length > 0;
  }
  if (isMemoryKind(kind)) {
    const rows = await q<{ id: string }>(
      // A to-do or a Watch & read title can be in the graph (a note's mention, a to-do's own links): those edges go too.
      `WITH gone_values AS (DELETE FROM custom_values WHERE entity_kind = $2 AND entity_id = $1::uuid RETURNING 1),
       gone_edges AS (
         DELETE FROM edges
         WHERE $2 IN ('commitment', 'reading')
           AND ((source_type = $2 AND source_id = $1::uuid) OR (target_type = $2 AND target_id = $1::uuid))
         RETURNING 1
       )
       DELETE FROM ${MEMORY_TABLES[kind].table} WHERE id = $1::uuid RETURNING id`,
      [id, kind],
    );
    return rows.length > 0;
  }
  const table = TABLES[kind];
  const rows = await q<{ id: string }>(
    `WITH owned_events AS (
       DELETE FROM events WHERE $1 = 'person' AND person_id = $2::uuid RETURNING id
     ),
     gone_edges AS (
       DELETE FROM edges
       WHERE (source_type = $1 AND source_id = $2::uuid)
          OR (target_type = $1 AND target_id = $2::uuid)
          OR (source_type = 'event' AND source_id IN (SELECT id FROM owned_events))
          OR (target_type = 'event' AND target_id IN (SELECT id FROM owned_events))
       RETURNING id
     ),
     gone_facts AS (
       DELETE FROM facts WHERE subject_kind = $1 AND subject_id = $2::uuid RETURNING id
     ),
     gone_values AS (
       DELETE FROM custom_values
       WHERE (entity_kind = $1 AND entity_id = $2::uuid)
          OR (entity_kind = 'event' AND entity_id IN (SELECT id FROM owned_events))
       RETURNING 1
     )
     DELETE FROM ${table} WHERE id = $2::uuid RETURNING id`,
    [kind, id],
  );
  return rows.length > 0;
}

/**
 * Everything archived, newest first — the app's Archived page only. The
 * owner's own kinds come with how many records they hold; a record shows only
 * while its kind is live (an archived kind's records come back with it).
 */
export async function listArchived(limit = 500): Promise<ArchivedItem[]> {
  const parts = [
    ...PAGE_TYPES.filter((kind) => kind !== "record").map(
      (kind) =>
        `SELECT '${kind}' AS kind, id, ${TITLE_COLUMN[kind]} AS title, NULL::text AS detail, archived_at FROM ${TABLES[kind]} WHERE archived_at IS NOT NULL`,
    ),
    ...MEMORY_KINDS.map((kind) => {
      const { table, title, detail } = MEMORY_TABLES[kind];
      return `SELECT '${kind}' AS kind, id, ${title} AS title, ${detail ?? "NULL::text"} AS detail, archived_at FROM ${table} WHERE archived_at IS NOT NULL`;
    }),
    // A purchase reads as "Kindle Paperwhite from Amazon": its first item is the detail.
    `SELECT 'trip' AS kind, id, title, NULL::text AS detail, archived_at FROM trips WHERE archived_at IS NOT NULL`,
    `SELECT 'booking' AS kind, id, title, NULL::text AS detail, archived_at FROM trip_bookings WHERE archived_at IS NOT NULL`,
    `SELECT 'purchase' AS kind, id, retailer AS title, items[1] AS detail, archived_at FROM purchases WHERE archived_at IS NOT NULL`,
  ];
  const [rows, kinds, records] = await Promise.all([
    q<ArchivedItem & { detail: string | null }>(`${parts.join(" UNION ALL ")} ORDER BY archived_at DESC LIMIT $1`, [limit]),
    q<{ id: string; name: string; one: string; icon: string; archived_at: string; count: number }>(
      `SELECT k.id, k.name, k.one, k.icon, k.archived_at, (SELECT count(*)::int FROM custom_records r WHERE r.kind_id = k.id) AS count
       FROM custom_kinds k WHERE k.archived_at IS NOT NULL ORDER BY k.archived_at DESC LIMIT $1`,
      [limit],
    ),
    q<{ id: string; title: string; archived_at: string; kind_id: string; one: string; icon: string }>(
      `SELECT r.id, r.title, r.archived_at, r.kind_id, k.one, k.icon
       FROM custom_records r JOIN custom_kinds k ON k.id = r.kind_id AND k.archived_at IS NULL
       WHERE r.archived_at IS NOT NULL ORDER BY r.archived_at DESC LIMIT $1`,
      [limit],
    ),
  ]);
  const items: ArchivedItem[] = rows.map(({ detail, ...item }) => {
    if (item.kind === "interaction") return { ...item, title: (item.title || "Catch-up").slice(0, 120) };
    if (item.kind === "fact") return { ...item, title: `${item.title}: ${detail ?? ""}` };
    if (item.kind === "purchase") return { ...item, title: purchaseName({ retailer: item.title, items: detail ? [detail] : [] }) };
    return item;
  });
  for (const k of kinds) items.push({ kind: "kind", id: k.id, title: k.name, archived_at: k.archived_at, icon: k.icon, count: Number(k.count), detail: k.one });
  for (const r of records) {
    items.push({ kind: "record", id: r.id, title: r.title, archived_at: r.archived_at, kind_id: r.kind_id, icon: r.icon, detail: r.one.charAt(0).toUpperCase() + r.one.slice(1) });
  }
  const at = (i: ArchivedItem) => new Date(i.archived_at).getTime();
  return items.sort((a, b) => at(b) - at(a)).slice(0, limit);
}

// ---------- Push subscriptions + reminder log ----------

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** At most this many devices; a new one past it replaces the one unused longest. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/** `credential`: the fingerprint of the token or key the request carried (lib/push.ts). */
export async function savePushSubscription(sub: PushSubscriptionRow, credential: string): Promise<void> {
  await q(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, credential) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, credential = EXCLUDED.credential, updated_at = now()`,
    [sub.endpoint, sub.p256dh, sub.auth, credential],
  );
  await q(`DELETE FROM push_subscriptions WHERE endpoint IN (SELECT endpoint FROM push_subscriptions ORDER BY updated_at DESC, endpoint OFFSET $1)`, [MAX_PUSH_SUBSCRIPTIONS]);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await q(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

/** Drop every subscription not registered by one of these credentials (one with none recorded included). Returns how many went. */
export async function keepPushSubscriptionsOf(credentials: string[]): Promise<number> {
  const rows = await q<{ endpoint: string }>(`DELETE FROM push_subscriptions WHERE credential IS NULL OR NOT (credential = ANY($1::text[])) RETURNING endpoint`, [credentials]);
  return rows.length;
}

export async function listPushSubscriptions(): Promise<PushSubscriptionRow[]> {
  return q<PushSubscriptionRow>(`SELECT endpoint, p256dh, auth FROM push_subscriptions`);
}

/**
 * Claim a reminder key. Returns true exactly once per key, so concurrent or
 * retried scheduled runs never send the same reminder twice.
 */
export async function claimReminder(key: string): Promise<boolean> {
  const rows = await q<{ key: string }>(
    `INSERT INTO reminder_log (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key],
  );
  return rows.length > 0;
}

/**
 * claimReminder for a key built on a blind index. `older` is the same key
 * under data keys from before a rotation: a row under one of those means
 * it was sent, so it's moved to `key` and the claim fails.
 */
export async function claimIndexedReminder(key: string, older: string[]): Promise<boolean> {
  if (older.length) {
    const moved = await q<{ key: string }>(
      `UPDATE reminder_log SET key = $1
       WHERE key = (SELECT key FROM reminder_log WHERE key = ANY($2::text[]) LIMIT 1) AND NOT EXISTS (SELECT 1 FROM reminder_log WHERE key = $1)
       RETURNING key`,
      [key, older],
    );
    if (moved.length) return false;
  }
  return claimReminder(key);
}

/** reminder_log keys starting with any of these prefixes (plain text, no LIKE wildcards). */
export async function reminderKeysWithPrefix(prefixes: readonly string[]): Promise<string[]> {
  const rows = await q<{ key: string }>(`SELECT key FROM reminder_log WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE starts_with(key, p)) ORDER BY key LIMIT 500`, [[...prefixes]]);
  return rows.map((r) => r.key);
}

/** Move a claim to another key, keeping when it was sent. */
export async function rekeyReminder(from: string, to: string): Promise<void> {
  await q(`INSERT INTO reminder_log (key, sent_at) SELECT $2, sent_at FROM reminder_log WHERE key = $1 ON CONFLICT (key) DO NOTHING`, [from, to]);
  await q(`DELETE FROM reminder_log WHERE key = $1`, [from]);
}

/** Release a claim when the send it guarded failed, so the next run retries. */
export async function releaseReminder(key: string): Promise<void> {
  await q(`DELETE FROM reminder_log WHERE key = $1`, [key]);
}

// ---------- Custom reminders ----------

export interface Reminder {
  id: string;
  text: string;
  remind_at: string;
  repeat: ReminderRepeat;
  anchor_day: number;
  about_type: EntityType | null;
  about_id: string | null;
  /** The linked item's current name/title; null when unlinked, archived or deleted. */
  about_title: string | null;
  done_at: string | null;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  text?: string;
  /** An exact instant (ISO 8601 with offset). Or give `date` + `time`. */
  at?: Date;
  /** Local "YYYY-MM-DD" in `tz`; with `time`, instead of `at`. Defaults to today. */
  date?: string;
  /** Local "HH:MM" in `tz`; defaults to 09:00 when only `date` is given. */
  time?: string;
  /** IANA zone that `date` + `time` are in (defaults to the owner's). */
  tz?: string;
  repeat?: ReminderRepeat;
  /** What it's about; null clears it. */
  about?: { type: EntityType; id: string } | null;
  /** true marks it done; false reopens it. */
  done?: boolean;
}

const REMINDER_SELECT = `
  SELECT r.*,
    CASE r.about_type
      ${PAGE_TYPES.map(
        (k) =>
          `WHEN '${k}' THEN (SELECT ${TITLE_COLUMN[k]} FROM ${TABLES[k]} t WHERE t.id = r.about_id AND t.archived_at IS NULL)`,
      ).join("\n      ")}
    END AS about_title
  FROM reminders r`;

function reminderInstant(input: ReminderInput, tz: string): Date | undefined {
  if (input.at) {
    if (Number.isNaN(input.at.getTime())) throw new AthenaInputError("Invalid reminder time");
    return input.at;
  }
  if (input.date === undefined && input.time === undefined) return undefined;
  const date = input.date ?? zonedToday(new Date(), tz);
  const time = input.time ?? "09:00";
  const at = localToInstant(date, time, tz);
  if (!at) throw new AthenaInputError(`Invalid reminder date/time '${date} ${time}': use YYYY-MM-DD and HH:MM (24h)`);
  return at;
}

function reminderRepeat(raw: ReminderRepeat | undefined): ReminderRepeat | undefined {
  if (raw !== undefined && !REMINDER_REPEATS.includes(raw)) {
    throw new AthenaInputError(`Invalid repeat '${raw}': use one of ${REMINDER_REPEATS.join(", ")}`);
  }
  return raw;
}

function reminderAbout(about: ReminderInput["about"]): { type: EntityType; id: string } | null | undefined {
  if (about === undefined || about === null) return about;
  // Reminders open what they're about from a push; a custom record has no page there yet.
  if (!isPageType(about.type) || about.type === "record") throw new AthenaInputError(`Invalid reminder 'about' kind '${about.type}'`);
  if (!/^[0-9a-f-]{36}$/i.test(about.id)) throw new AthenaInputError("Invalid reminder 'about' id");
  return about;
}

export async function getReminder(id: string): Promise<Reminder | null> {
  const [row] = await q<Reminder>(`${REMINDER_SELECT} WHERE r.id = $1`, [id]);
  return row ?? null;
}

/**
 * Create a reminder (no `id`) or change one. Moving the time of a finished
 * reminder reopens it, since that only makes sense as "remind me again".
 */
export async function saveReminder(input: ReminderInput & { id?: string }): Promise<Reminder> {
  if (input.tz !== undefined && !isValidTimeZone(input.tz)) throw new AthenaInputError(`Unknown time zone '${input.tz}'`);
  // Only a new time needs a zone: one settings read, which also lines
  // repeating reminders up with the owner's zone before this one joins them.
  const timed = input.at !== undefined || input.date !== undefined || input.time !== undefined;
  const owner = timed ? await reminderTimeZone() : DEFAULT_TZ;
  const tz = input.tz ?? owner;
  if (input.id && !input.at && (input.date === undefined) !== (input.time === undefined)) {
    // Changing only the day or only the time keeps the other half.
    const existing = await getReminder(input.id);
    if (!existing) throw new AthenaInputError(`Reminder ${input.id} not found`, 404);
    const was = zonedParts(new Date(existing.remind_at), tz);
    input = { ...input, date: input.date ?? was.date, time: input.time ?? was.time };
  }
  const at = reminderInstant(input, tz);
  const repeat = reminderRepeat(input.repeat);
  const about = reminderAbout(input.about);
  const text = input.text?.trim();
  if (input.text !== undefined && !text) throw new AthenaInputError("A reminder needs some text");
  const anchorDay = at ? Number(zonedParts(at, tz).date.slice(8, 10)) : null;
  const s = await sealer();

  if (input.id) {
    const [row] = await q<{ id: string }>(
      `UPDATE reminders SET
         text = COALESCE($2, text),
         remind_at = COALESCE($3::timestamptz, remind_at),
         anchor_day = COALESCE($4::smallint, anchor_day),
         repeat = COALESCE($5, repeat),
         about_type = CASE WHEN $6::boolean THEN $7 ELSE about_type END,
         about_id = CASE WHEN $6::boolean THEN $8::uuid ELSE about_id END,
         done_at = CASE
           WHEN $9::boolean IS TRUE THEN COALESCE(done_at, now())
           WHEN $9::boolean IS FALSE OR $3::timestamptz IS NOT NULL THEN NULL
           ELSE done_at END,
         updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [
        input.id,
        s.maybe(text ?? null),
        at?.toISOString() ?? null,
        anchorDay,
        repeat ?? null,
        about !== undefined,
        about?.type ?? null,
        about?.id ?? null,
        input.done ?? null,
      ],
    );
    if (!row) throw new AthenaInputError(`Reminder ${input.id} not found`, 404);
    return (await getReminder(row.id))!;
  }

  if (!text) throw new AthenaInputError("A new reminder needs some text");
  if (!at) throw new AthenaInputError("A new reminder needs a time: 'at' (ISO 8601), or 'date' and/or 'time' (the owner's time zone)");
  const [row] = await q<{ id: string }>(
    `INSERT INTO reminders (text, remind_at, anchor_day, repeat, about_type, about_id)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6::uuid)
     RETURNING id`,
    [s.text(text), at.toISOString(), anchorDay, repeat ?? "none", about?.type ?? null, about?.id ?? null],
  );
  return (await getReminder(row.id))!;
}

/** Pending reminders soonest first, then (with `includeDone`) finished ones, most recent first. */
export async function listReminders(opts: { includeDone?: boolean; limit?: number } = {}): Promise<Reminder[]> {
  const limit = opts.limit ?? 200;
  const pending = await q<Reminder>(`${REMINDER_SELECT} WHERE r.done_at IS NULL ORDER BY r.remind_at ASC LIMIT $1`, [limit]);
  if (!opts.includeDone) return pending;
  const done = await q<Reminder>(`${REMINDER_SELECT} WHERE r.done_at IS NOT NULL ORDER BY r.done_at DESC LIMIT $1`, [
    Math.min(limit, 50),
  ]);
  return [...pending, ...done];
}

/** Pending reminders due at or before `now` (the reminders function). */
export async function listDueReminders(now: Date = new Date()): Promise<Reminder[]> {
  return q<Reminder>(`${REMINDER_SELECT} WHERE r.done_at IS NULL AND r.remind_at <= $1 ORDER BY r.remind_at ASC`, [
    now.toISOString(),
  ]);
}

/**
 * After a reminder fires: a one-off is finished; a repeating one moves on to
 * its next occurrence, at the same time of day in `tz` (the owner's zone).
 * Guarded on `remind_at` so a concurrent edit wins.
 */
export async function advanceReminder(r: Reminder, now: Date, tz: string): Promise<void> {
  const next = nextRemindAt(new Date(r.remind_at), r.repeat, now, r.anchor_day, tz);
  await q(
    `UPDATE reminders SET
       last_sent_at = $3,
       remind_at = COALESCE($4::timestamptz, remind_at),
       done_at = CASE WHEN $4::timestamptz IS NULL THEN $3::timestamptz ELSE NULL END,
       updated_at = now()
     WHERE id = $1 AND date_trunc('milliseconds', remind_at) = $2::timestamptz AND done_at IS NULL`,
    [r.id, new Date(r.remind_at).toISOString(), now.toISOString(), next?.toISOString() ?? null],
  );
}

/** Permanent delete — the app's own action only (MCP marks reminders done instead). */
export async function deleteReminder(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(`DELETE FROM reminders WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

// ---------- Metrics (time series) ----------

export async function upsertMetric(input: {
  metric: string;
  value: number;
  recordedAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<MetricPoint> {
  const sql = db();
  const [point] = await sql.sql<MetricPoint>`
    INSERT INTO metrics (metric, value, recorded_at, metadata)
    VALUES (
      ${input.metric},
      ${input.value},
      ${input.recordedAt ?? new Date()},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    RETURNING *
  `;
  return point;
}

export async function queryMetrics(
  metric: string,
  since?: Date,
  limit = 200,
): Promise<MetricPoint[]> {
  const sql = db();
  if (since) {
    return sql.sql<MetricPoint>`
      SELECT * FROM metrics
      WHERE metric = ${metric} AND recorded_at >= ${since}
      ORDER BY recorded_at ASC
      LIMIT ${limit}
    `;
  }
  return sql.sql<MetricPoint>`
    SELECT * FROM metrics WHERE metric = ${metric}
    ORDER BY recorded_at ASC
    LIMIT ${limit}
  `;
}

export async function listMetricNames(): Promise<string[]> {
  const sql = db();
  const rows = await sql.sql<{ metric: string }>`
    SELECT DISTINCT metric FROM metrics ORDER BY metric ASC
  `;
  return rows.map((r) => r.metric);
}

