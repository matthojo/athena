/**
 * What the live channel watches. Writes happen in functions (api.ts, mcp.ts,
 * background runs), so the server learns of them from the database: one cheap
 * query reads a watermark (newest timestamp + row count) per table, and a
 * kind whose watermark moved has changed. Nothing here reads personal
 * content: timestamps, counts and ids only.
 */
import { createHash } from "node:crypto";

export const LIVE_KINDS = ["note", "record", "memory", "logistics", "custom", "saved", "thread", "nudge", "run", "backfill", "day", "habit", "recipe", "checkin"] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

/** One table behind a kind. Every string is a constant from this file, never input. */
export interface Source {
  kind: LiveKind;
  table: string;
  /** When a row last changed. */
  at: string;
  /** The id an event carries for a changed row. */
  id: string;
  where?: string;
}

const rows = (kind: LiveKind, tables: string[], at = "updated_at", id = "id"): Source[] => tables.map((table) => ({ kind, table, at, id }));

export const SOURCES: readonly Source[] = [
  ...rows("note", ["notes"]),
  ...rows("record", ["people", "projects", "places", "organisations", "events"]),
  ...rows("memory", ["commitments", "interactions", "facts", "assets", "reading_items", "goals"]),
  { kind: "memory", table: "suggestions", at: "greatest(created_at, resolved_at)", id: "id" },
  ...rows("logistics", ["trips", "trip_bookings", "purchases"]),
  ...rows("custom", ["custom_kinds", "custom_fields", "custom_records"]),
  ...rows("saved", ["saved_items"]),
  ...rows("thread", ["ask_threads"]),
  { kind: "nudge", table: "nudges", at: "greatest(created_at, dismissed_at)", id: "id" },
  // A run's event names its collection: that is what the app loads runs by.
  { kind: "run", table: "collection_runs", at: "greatest(created_at, started_at, finished_at)", id: "collection_id" },
  // History loads keep their progress in settings as history_load.<connector id>.
  { kind: "backfill", table: "settings", at: "updated_at", id: "substring(key from 14)", where: "key LIKE 'history\\_load.%'" },
  // Days: an event names the day by its date. A photo added to a day also touches its `days` row.
  ...rows("day", ["days", "day_entries"], "updated_at", "to_char(date, 'YYYY-MM-DD')"),
  ...rows("habit", ["habits"]),
  // A tick is a 'habit' day entry written by Athena (lib/own-habits.ts); its event names the day too.
  { kind: "habit", table: "day_entries", at: "updated_at", id: "to_char(date, 'YYYY-MM-DD')", where: "kind = 'habit' AND source = 'athena'" },
  ...rows("recipe", ["recipes", "grocery_items"]),
  { kind: "recipe", table: "recipe_cooked", at: "created_at", id: "recipe_id" },
  // A shop filed or undone, and a usual skipped, change what the grocery list offers.
  ...rows("recipe", ["grocery_trips", "grocery_skips"], "created_at"),
  { kind: "recipe", table: "meal_plan", at: "updated_at", id: "to_char(day, 'YYYY-MM-DD')" },
  // The recipe settings (units, what's always in the cupboard) are one settings row.
  { kind: "recipe", table: "settings", at: "updated_at", id: "key", where: "key = 'recipes'" },
  // Check-ins: an event names the day by its date; the settings are one settings row.
  ...rows("checkin", ["checkins"], "updated_at", "to_char(date, 'YYYY-MM-DD')"),
  { kind: "checkin", table: "settings", at: "updated_at", id: "key", where: "key = 'checkins'" },
];

/** A source's watermark: its newest timestamp (null when empty) and row count, as text. */
export interface Watermark {
  at: string | null;
  n: string;
}

/** One query for every source's watermark; row `i` is the source's index. */
export function watermarkSql(sources: readonly Source[] = SOURCES): string {
  return sources.map((s, i) => `SELECT ${i} AS i, max(${s.at})::text AS at, count(*)::text AS n FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ""}`).join(" UNION ALL ");
}

/** Ids of rows changed after each given watermark (parameter i+1 is `since[i].at`), newest first, at most `limit` a source. */
export function changedIdsSql(since: Array<{ source: Source; i: number }>, limit = 20): string {
  return since
    .map(({ source: s, i }, p) => `(SELECT ${i} AS i, (${s.id})::text AS id FROM ${s.table} WHERE ${s.at} > $${p + 1}::timestamptz${s.where ? ` AND ${s.where}` : ""} ORDER BY ${s.at} DESC LIMIT ${limit})`)
    .join(" UNION ALL ");
}

export interface Reading {
  /** Watermarks by source index. */
  marks: Watermark[];
  /** One short opaque mark per kind: equal marks mean nothing changed. */
  kinds: Record<LiveKind, string>;
}

export function toReading(found: Array<{ i: number | string; at: string | null; n: string | number }>, sources: readonly Source[] = SOURCES): Reading {
  const marks: Watermark[] = sources.map(() => ({ at: null, n: "0" }));
  for (const r of found) if (marks[Number(r.i)]) marks[Number(r.i)] = { at: r.at ?? null, n: String(r.n) };
  const kinds = {} as Record<LiveKind, string>;
  for (const kind of LIVE_KINDS) {
    const text = sources.map((s, i) => (s.kind === kind ? `${marks[i].at}|${marks[i].n}` : "")).join(";");
    kinds[kind] = createHash("sha256").update(text).digest("hex").slice(0, 12);
  }
  return { marks, kinds };
}

/** The kinds that differ between two readings, each with the sources whose newest timestamp moved (those have ids to fetch). */
export function changedKinds(prev: Reading, next: Reading, sources: readonly Source[] = SOURCES): Array<{ kind: LiveKind; moved: Array<{ source: Source; i: number; since: string }> }> {
  return LIVE_KINDS.filter((kind) => prev.kinds[kind] !== next.kinds[kind]).map((kind) => ({
    kind,
    moved: sources.flatMap((source, i) =>
      source.kind === kind && next.marks[i].at !== null && next.marks[i].at !== prev.marks[i].at ? [{ source, i, since: prev.marks[i].at ?? "-infinity" }] : [],
    ),
  }));
}

export interface Change {
  kind: LiveKind;
  ids: string[];
}

type Query = <T>(text: string, params?: unknown[]) => Promise<T[]>;

export async function readWatermarks(query: Query, sources: readonly Source[] = SOURCES): Promise<Reading> {
  return toReading(await query<{ i: number; at: string | null; n: string }>(watermarkSql(sources)), sources);
}

/** What changed between two readings, with the ids of changed rows where the database can name them (a delete has none). */
export async function readChanges(query: Query, prev: Reading, next: Reading, sources: readonly Source[] = SOURCES): Promise<Change[]> {
  const changed = changedKinds(prev, next, sources);
  const moved = changed.flatMap((c) => c.moved);
  const found = moved.length ? await query<{ i: number; id: string | null }>(changedIdsSql(moved), moved.map((m) => m.since)) : [];
  return changed.map(({ kind }) => ({
    kind,
    ids: [...new Set(found.filter((r) => sources[Number(r.i)]?.kind === kind && r.id).map((r) => r.id as string))],
  }));
}
