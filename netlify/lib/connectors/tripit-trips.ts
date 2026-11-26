/**
 * TripIt into Trips: at the start of a run, before Claude, each TripIt
 * account's trips are copied into Athena's Trips through the same writer the
 * email digest uses (lib/trips.ts saveBooking). No model is involved:
 * TripIt's data is already structured.
 *
 *  - First runs after connecting: every past trip, once, up to
 *    tripitImport.pagesPerRun of TripIt's pages a run. Where it got to is
 *    kept in the account's sealed credentials after each page, so a run cut
 *    short or a big history carries on next time. The run summary says how far.
 *  - Every run: everything upcoming, and trips that ended in the last PAST_DAYS.
 *
 * Each booking is found again by TripIt's id for it (source_ref
 * "tripit:air:<object>:<segment>"…), so the import and later runs never
 * duplicate a booking, and one an email already saved under the same
 * reference is the one filled in. A booking or trip the owner archived is
 * left alone (saveBooking skips it). Nothing is written to TripIt.
 */
import { getConnectorWithSecrets, updateConnectorSecrets } from "../../../lib/connectors";
import { q } from "../../../lib/db";
import { saveBooking } from "../../../lib/trips";
import { callTool, type OpenConnector } from "./mcp-client";
import type { TripItBooking } from "./tripit-direct";

/** Past trips are read back this far, so a late change to a trip just taken still lands. */
export const PAST_DAYS = 30;
/** Pages of past trips (25 each) the one-time import reads in a run. Tests lower it. */
export const tripitImport = { pagesPerRun: 20 };
const MAX_BOOKINGS = 200;

/** How far the one-time import of past trips has got, sealed with the account's credentials. */
export interface ImportState {
  /** TripIt's next page of past trips to read. */
  next: number;
  done: boolean;
  /** Past trips imported so far. */
  trips: number;
}

export interface Copied {
  created: number;
  updated: number;
  skipped: number;
  /** The one-time import, when it ran this time. */
  imported?: { trips: number; total: number; done: boolean };
}

type Listed = { trips?: Array<{ end_date?: string; bookings?: TripItBooking[] }>; next_cursor?: string; total_pages?: number };

async function read(open: OpenConnector, when: "upcoming" | "past", cursor?: string): Promise<Listed> {
  const r = await callTool(open, "list_trips", { when, ...(cursor ? { cursor } : {}) });
  if (r.isError) throw new Error(r.text);
  return JSON.parse(r.text) as Listed;
}

const stateOf = (s: unknown): ImportState | undefined => (s as { tripitImport?: ImportState } | undefined)?.tripitImport;

/** Save each booking once a run, however many passes read it (the import and the recent past share page 1). */
async function save(bookings: TripItBooking[], source: string, out: Copied, seen: Set<string>): Promise<void> {
  for (const b of bookings) {
    const { id, ...fields } = b;
    if (seen.has(id)) continue;
    seen.add(id);
    const [mine] = await q<{ id: string }>(`SELECT id FROM trip_bookings WHERE source_ref = $1 ORDER BY created_at LIMIT 1`, [id]);
    const saved = await saveBooking({ ...fields, booking_id: mine?.id, source, source_ref: id, confidence: 1 });
    out[saved.action]++;
  }
}

/** Every past trip, once, from where the last run got to; saved page by page. */
async function importPast(open: OpenConnector, source: string, out: Copied, seen: Set<string>): Promise<void> {
  const id = open.connector.id;
  const state: ImportState = { next: 1, done: false, trips: 0, ...stateOf((await getConnectorWithSecrets(id))?.secrets) };
  if (state.done) return;
  let total = 0;
  for (let n = 0; n < tripitImport.pagesPerRun; n++) {
    const r = await read(open, "past", String(state.next));
    total = r.total_pages ?? total;
    const trips = r.trips ?? [];
    await save(trips.flatMap((t) => t.bookings ?? []), source, out, seen);
    state.trips += trips.length;
    state.next += 1;
    state.done = !r.next_cursor;
    await updateConnectorSecrets(id, (s) => void ((s as { tripitImport?: ImportState }).tripitImport = { ...state }));
    if (state.done) break;
  }
  out.imported = { trips: state.trips, total, done: state.done };
}

/** Copy one TripIt account's trips into Trips. `source` is the collection's (bookings show where they came from). */
export async function copyTripItTrips(open: OpenConnector, source: string, now = new Date()): Promise<Copied> {
  const out: Copied = { created: 0, updated: 0, skipped: 0 };
  const seen = new Set<string>();
  await importPast(open, source, out, seen);
  const since = new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString().slice(0, 10);
  const bookings: TripItBooking[] = [];
  for (const t of (await read(open, "upcoming")).trips ?? []) bookings.push(...(t.bookings ?? []));
  // Past trips come newest first: stop at the first that ended before the cut-off.
  let cursor: string | undefined;
  past: for (let page = 0; page < 3; page++) {
    const r = await read(open, "past", cursor);
    for (const t of r.trips ?? []) {
      if (t.end_date && t.end_date < since) break past;
      bookings.push(...(t.bookings ?? []));
    }
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  await save(bookings.slice(0, MAX_BOOKINGS), source, out, seen);
  return out;
}

const trips = (n: number) => `${n} past trip${n === 1 ? "" : "s"}`;

/** The run summary's line about the import: "TripIt: 500 past trips in Trips so far. The rest come on the next run." */
export function importLine(name: string, imported: NonNullable<Copied["imported"]>): string {
  if (imported.done) return `${name}: all ${trips(imported.trips)} are in Trips.`;
  return `${name}: ${trips(imported.trips)} in Trips so far. The rest come on the next run.`;
}

/**
 * Every TripIt account a run opened whose list_trips the owner allows, copied; a failure is logged and the run goes on.
 * Returns the line for the run summary while a past-trips import is running, or null.
 */
export async function copyTripItAccounts(opened: OpenConnector[], allowed: Map<OpenConnector, Set<string>>, source: string, stats: { bookings_created?: number; bookings_updated?: number; tripit_bookings?: number }, now = new Date()): Promise<string | null> {
  const lines: string[] = [];
  for (const open of opened) {
    if (open.connector.provider !== "tripit" || !allowed.get(open)?.has("list_trips")) continue;
    try {
      const r = await copyTripItTrips(open, source, now);
      stats.bookings_created = (stats.bookings_created ?? 0) + r.created;
      stats.bookings_updated = (stats.bookings_updated ?? 0) + r.updated;
      stats.tripit_bookings = (stats.tripit_bookings ?? 0) + r.created;
      if (r.imported) lines.push(importLine(open.connector.name, r.imported));
    } catch (error) {
      console.error("Athena connectors: copying TripIt trips failed", error instanceof Error ? error.message : error);
    }
  }
  return lines.length ? lines.join("\n") : null;
}
