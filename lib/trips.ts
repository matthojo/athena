/**
 * Trips and purchases (migration 0015), from booking and order emails.
 *
 * A trip groups its bookings (flights, trains, hotel stays, car hire, event
 * tickets) by where it's to and when. A booking is saved again when an email
 * changes it — a new time, a cancellation — and that updates it in place:
 * bookings are matched by their reference (and which part of the booking they
 * are, for a reference covering an outbound and a return). A purchase is an
 * order and where its delivery has got to, with a short timeline; later
 * emails for the same order number (or tracking number) move it along.
 *
 * Same rules as lib/db.ts and lib/memory.ts: the SQL lives here, text is
 * sealed on write and opened by q(), archived rows are hidden from every read
 * except the Archived page (archive and delete-forever are in lib/db.ts), and
 * nothing here deletes. References, order and tracking numbers are encrypted,
 * so they're found by blind index and compared here after decrypting.
 *
 * Never a price, total or card detail: purchases have no column for one
 * (finance is its own tier, docs: security/encryption).
 */
import { AthenaInputError, getOwnerTimeZone, lookupIndexes, q, refreshTripDates, sealer, type Sealer } from "./db";
import { addDays, daysBetween, isValidDate, isValidTimeZone, zonedParts, zonedToInstant, zonedToday } from "./dates";
import {
  BOOKING_KINDS,
  BOOKING_STATUSES,
  PURCHASE_STATUSES,
  SETTLED_STATUSES,
  TRANSPORT,
  normaliseReference,
  placeKey,
  sameRetailer,
  type BookingKind,
  type BookingStatus,
  type PurchaseStatus,
} from "./trip-text";

export type { BookingKind, BookingStatus, PurchaseStatus } from "./trip-text";

// ---------- shapes ----------

export interface Booking {
  id: string;
  trip_id: string;
  kind: BookingKind;
  status: BookingStatus;
  title: string;
  provider: string;
  reference: string;
  /** Which part of a booking with several ("outbound", "return"); "" when there's one. */
  segment: string;
  /** Local day it starts, in `start_tz`. */
  start_date: string;
  /** UTC instant, when the time is known. */
  starts_at: string | null;
  start_tz: string;
  start_place: string;
  start_city: string;
  end_date: string | null;
  ends_at: string | null;
  end_tz: string;
  end_place: string;
  end_city: string;
  seat: string;
  details: string;
  email_link: string;
  /** The start before the last change, for "moved from 07:10". */
  previous_starts_at: string | null;
  /** When an email cancelled it, and the link to that email (the owner may have added the booking). */
  cancelled_at: string | null;
  cancel_email_link: string;
  /** Fields the owner changed by hand (BookingFields names): later emails leave them alone. */
  owner_edited: string[];
  source: string | null;
  source_ref: string | null;
  confidence: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Trip {
  id: string;
  /** Where it's to: "Lisbon". */
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  notes: string;
  source: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Live bookings, in the order they happen. */
  bookings: Booking[];
}

export interface PurchaseUpdate {
  id: string;
  status: PurchaseStatus;
  at: string;
  detail: string;
  email_link: string;
}

export interface Purchase {
  id: string;
  retailer: string;
  items: string[];
  order_number: string;
  ordered_on: string | null;
  status: PurchaseStatus;
  status_at: string;
  expected_on: string | null;
  delivered_at: string | null;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  email_link: string;
  /** Fields the owner changed by hand (PurchaseFields names): later emails leave them alone. */
  owner_edited: string[];
  source: string | null;
  source_ref: string | null;
  confidence: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Oldest first. */
  updates: PurchaseUpdate[];
}

/** `source` on what the owner added by hand (the form, or Ask). */
export const MANUAL = "manual";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Timestamps come back from the driver as Date objects; the API and the wording want ISO strings. */
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new AthenaInputError(`Invalid ${label} '${value}': must be one of ${allowed.join(", ")}`);
  return value as T;
}

function confidence(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) throw new AthenaInputError("confidence must be between 0 and 1");
  return raw;
}

const clean = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ");

function localDate(raw: string | null | undefined, label: string): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const s = raw.trim();
  if (!s) return null;
  if (!isValidDate(s)) throw new AthenaInputError(`Invalid ${label} '${raw}': use YYYY-MM-DD`);
  return s;
}

/**
 * A local time at a place: "2026-03-12T07:10" (read in `tz`), "2026-03-12"
 * (just the day), or an ISO instant with Z or an offset.
 */
export function parseLocal(raw: string, tz: string, label: string): { date: string; at: Date | null } {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (!isValidDate(s)) throw new AthenaInputError(`Invalid ${label} '${raw}'`);
    return { date: s, at: null };
  }
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (local) {
    if (!isValidDate(local[1]) || Number(local[2]) > 23 || Number(local[3]) > 59) throw new AthenaInputError(`Invalid ${label} '${raw}'`);
    return { date: local[1], at: zonedToInstant(local[1], `${local[2]}:${local[3]}`, tz) };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const at = new Date(s);
    if (!Number.isNaN(at.getTime())) return { date: zonedParts(at, tz).date, at };
  }
  throw new AthenaInputError(`Invalid ${label} '${raw}': use the local time there, YYYY-MM-DDTHH:MM (or YYYY-MM-DD for just the day)`);
}

// ---------- reading ----------

const TRIP_COLUMNS = `t.id, t.title, to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.ends_on, 'YYYY-MM-DD') AS ends_on,
  t.notes, t.source, t.archived_at, t.created_at, t.updated_at`;

const BOOKING_COLUMNS = `b.id, b.trip_id, b.kind, b.status, b.title, b.provider, b.reference, b.segment,
  to_char(b.start_date, 'YYYY-MM-DD') AS start_date, b.starts_at, b.start_tz, b.start_place, b.start_city,
  to_char(b.end_date, 'YYYY-MM-DD') AS end_date, b.ends_at, b.end_tz, b.end_place, b.end_city,
  b.seat, b.details, b.email_link, b.cancelled_at, b.cancel_email_link, b.previous_starts_at, b.owner_edited, b.source, b.source_ref, b.confidence,
  b.archived_at, b.created_at, b.updated_at`;

function bookingRow(r: Booking): Booking {
  return {
    ...r,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    previous_starts_at: iso(r.previous_starts_at),
    cancelled_at: iso(r.cancelled_at),
    archived_at: iso(r.archived_at),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

function tripRow(r: Omit<Trip, "bookings">, bookings: Booking[]): Trip {
  return { ...r, archived_at: iso(r.archived_at), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!, bookings };
}

/** When a booking happens, for ordering: its instant, or mid-afternoon on its day when there's no time. */
function bookingOrder(b: Booking): number {
  if (b.starts_at) return Date.parse(b.starts_at);
  return zonedToInstant(b.start_date, "15:00", b.start_tz && isValidTimeZone(b.start_tz) ? b.start_tz : "UTC").getTime();
}

async function bookingsFor(tripIds: string[]): Promise<Map<string, Booking[]>> {
  const out = new Map<string, Booking[]>();
  if (!tripIds.length) return out;
  const rows = (await q<Booking>(`SELECT ${BOOKING_COLUMNS} FROM trip_bookings b WHERE b.trip_id = ANY($1::uuid[]) AND b.archived_at IS NULL`, [tripIds])).map(bookingRow);
  rows.sort((a, b) => bookingOrder(a) - bookingOrder(b));
  for (const b of rows) out.set(b.trip_id, [...(out.get(b.trip_id) ?? []), b]);
  return out;
}

export async function getTrip(id: string, opts: { includeArchived?: boolean } = {}): Promise<Trip | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await q<Omit<Trip, "bookings">>(`SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.id = $1 AND ($2::boolean OR t.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  if (!row) return null;
  return tripRow(row, (await bookingsFor([id])).get(id) ?? []);
}

/**
 * Live trips with their bookings: upcoming and in progress first (soonest
 * first), then past ones (most recent first). `upcomingOnly` leaves out
 * trips that ended before the owner's today.
 */
export async function listTrips(opts: { upcomingOnly?: boolean; limit?: number; today?: string } = {}): Promise<Trip[]> {
  const today = opts.today ?? zonedToday(new Date(), await getOwnerTimeZone());
  const rows = await q<Omit<Trip, "bookings">>(
    `SELECT ${TRIP_COLUMNS} FROM trips t
     WHERE t.archived_at IS NULL AND (NOT $1::boolean OR t.ends_on IS NULL OR t.ends_on >= $2::date)`,
    [opts.upcomingOnly ?? false, today],
  );
  const bookings = await bookingsFor(rows.map((r) => r.id));
  const trips = rows.map((r) => tripRow(r, bookings.get(r.id) ?? []));
  const upcoming = trips.filter((t) => !t.ends_on || t.ends_on >= today).sort((a, b) => (a.starts_on ?? "").localeCompare(b.starts_on ?? ""));
  const past = trips.filter((t) => t.ends_on && t.ends_on < today).sort((a, b) => b.ends_on!.localeCompare(a.ends_on!));
  return [...upcoming, ...past].slice(0, opts.limit ?? 200);
}

/** Timed bookings starting in [from, to): the booking pushes. Cancelled ones, and anything archived, are left out. */
export async function listBookingsStarting(from: Date, to: Date): Promise<Booking[]> {
  return (
    await q<Booking>(
      `SELECT ${BOOKING_COLUMNS} FROM trip_bookings b JOIN trips t ON t.id = b.trip_id AND t.archived_at IS NULL
       WHERE b.archived_at IS NULL AND b.status <> 'cancelled' AND b.starts_at >= $1 AND b.starts_at < $2
       ORDER BY b.starts_at`,
      [from.toISOString(), to.toISOString()],
    )
  ).map(bookingRow);
}

export async function getBooking(id: string, opts: { includeArchived?: boolean } = {}): Promise<Booking | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await q<Booking>(`SELECT ${BOOKING_COLUMNS} FROM trip_bookings b WHERE b.id = $1 AND ($2::boolean OR b.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return row ? bookingRow(row) : null;
}

/** A field the owner typed: trimmed, and no longer than its column is meant to hold. */
function owned(v: string | undefined, max: number, label: string): string | undefined {
  if (v === undefined) return undefined;
  const c = clean(v);
  if (c.length > max) throw new AthenaInputError(`${label} is too long (${max} characters at most)`);
  return c;
}

/** Start and end days for a trip the owner set: either may be missing, and the end can't come first. */
function tripDays(starts: string | null | undefined, ends: string | null | undefined): { starts: string | null; ends: string | null } {
  const a = localDate(starts, "start date") ?? null;
  const b = localDate(ends, "end date") ?? null;
  if (a && b && b < a) throw new AthenaInputError("The trip ends before it starts");
  return { starts: a ?? b, ends: b ?? a };
}

export interface TripFields {
  /** Where it's to: "Lisbon". */
  title: string;
  starts_on?: string | null;
  ends_on?: string | null;
  notes?: string;
}

/** A trip the owner adds: a place and (if they know them) its dates. Its bookings are added to it after. */
export async function createTrip(input: TripFields): Promise<Trip> {
  const title = owned(input.title, 120, "The trip's name");
  if (!title) throw new AthenaInputError("A trip needs a name");
  const { starts, ends } = tripDays(input.starts_on, input.ends_on);
  const s = await sealer();
  const [row] = await q<{ id: string }>(`INSERT INTO trips (title, starts_on, ends_on, notes, source) VALUES ($1, $2::date, $3::date, $4, $5) RETURNING id`, [
    s.text(title),
    starts,
    ends,
    s.text((input.notes ?? "").trim()),
    MANUAL,
  ]);
  return (await getTrip(row.id))!;
}

/**
 * The owner renaming a trip, adding notes or, on a trip they added, moving
 * its dates. A trip from email takes its dates from its bookings.
 */
export async function updateTrip(id: string, patch: { title?: string; notes?: string; starts_on?: string | null; ends_on?: string | null }): Promise<Trip> {
  const title = patch.title === undefined ? null : owned(patch.title, 120, "The trip's name")!;
  if (title === "") throw new AthenaInputError("A trip needs a name");
  const datesGiven = patch.starts_on !== undefined || patch.ends_on !== undefined;
  const current = datesGiven ? await getTrip(id, { includeArchived: true }) : null;
  if (datesGiven && !current) throw new AthenaInputError(`Trip ${id} not found`, 404);
  if (current && current.source !== MANUAL) throw new AthenaInputError("This trip's dates follow its bookings. Change a booking instead.");
  const days = current
    ? tripDays(patch.starts_on === undefined ? current.starts_on : patch.starts_on, patch.ends_on === undefined ? current.ends_on : patch.ends_on)
    : null;
  const s = await sealer();
  const [row] = await q<{ id: string }>(
    `UPDATE trips SET title = COALESCE($2, title), notes = COALESCE($3, notes),
       starts_on = CASE WHEN $4::boolean THEN $5::date ELSE starts_on END,
       ends_on = CASE WHEN $4::boolean THEN $6::date ELSE ends_on END,
       updated_at = now() WHERE id = $1 RETURNING id`,
    [id, s.maybe(title), s.maybe(patch.notes ?? null), !!days, days?.starts ?? null, days?.ends ?? null],
  );
  if (!row) throw new AthenaInputError(`Trip ${id} not found`, 404);
  // Bookings outside the new dates still count: the trip stretches to hold them.
  if (days) await refreshTripDates(id);
  return (await getTrip(id, { includeArchived: true }))!;
}

// ---------- saving a booking ----------

export interface BookingInput {
  /** Update this booking (from a list Athena gave back), rather than matching by reference. */
  booking_id?: string;
  /** Put a new booking in this trip, rather than grouping it automatically. */
  trip_id?: string;
  kind: BookingKind;
  status?: BookingStatus;
  title: string;
  provider?: string;
  reference?: string;
  segment?: string;
  /** Local time where it starts: "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" for the day only. */
  start_local: string;
  /** IANA zone of where it starts. */
  start_tz: string;
  start_place?: string;
  start_city?: string;
  end_local?: string;
  end_tz?: string;
  end_place?: string;
  end_city?: string;
  seat?: string;
  details?: string;
  email_link?: string;
  /** The city or place the trip is to (for a flight home, where you're coming back from). */
  trip_destination?: string;
  source?: string | null;
  source_ref?: string | null;
  confidence?: number | null;
}

/** A booking's text fields an email can fill in. */
type BookingText = "title" | "provider" | "segment" | "start_place" | "start_city" | "end_place" | "end_city" | "seat" | "details" | "email_link";

export interface SavedBooking {
  action: "created" | "updated" | "skipped";
  /** Why it was skipped: the owner archived the booking or its trip. */
  reason?: string;
  booking: Booking | null;
  trip: Trip | null;
  /** A new trip was started for it (so undoing the booking means the trip too). */
  new_trip?: boolean;
  /** Other bookings under the same reference, so a caller can pick one by id next time. */
  same_reference: Array<{ id: string; segment: string; title: string; start_date: string; status: BookingStatus }>;
}

interface Candidate {
  id: string;
  trip_id: string;
  kind: BookingKind;
  reference: string;
  segment: string;
  title: string;
  start_date: string;
  status: BookingStatus;
  archived: boolean;
  trip_archived: boolean;
  source: string | null;
}

/** Every booking (archived too) with this reference: by blind index, or by value for rows sealed before a key existed. */
async function withReference(ref: string): Promise<Candidate[]> {
  if (!ref) return [];
  const rows = await q<Candidate>(
    `SELECT b.id, b.trip_id, b.kind, b.reference, b.segment, b.title, to_char(b.start_date, 'YYYY-MM-DD') AS start_date, b.status,
            b.archived_at IS NOT NULL AS archived, t.archived_at IS NOT NULL AS trip_archived, b.source
     FROM trip_bookings b JOIN trips t ON t.id = b.trip_id
     WHERE b.reference_bidx = ANY($1::text[]) OR (b.reference_bidx IS NULL AND b.reference <> '')
     ORDER BY b.created_at`,
    [lookupIndexes("booking", ref)],
  );
  return rows.filter((r) => normaliseReference(r.reference) === ref);
}

const segmentKey = (s: string) => placeKey(s);

/**
 * Which existing booking an email is about. Same reference and kind, then:
 * the same segment when both name one; otherwise a booking starting within a
 * day (a moved time is the same leg; a return a week later is not).
 */
function matchBooking(candidates: Candidate[], kind: BookingKind, segment: string, startDate: string): Candidate | null {
  const same = candidates.filter((c) => c.kind === kind);
  const seg = segmentKey(segment);
  const named = seg ? same.find((c) => segmentKey(c.segment) === seg) : undefined;
  if (named) return named;
  const near = same
    .filter((c) => !(seg && segmentKey(c.segment)) && Math.abs(daysBetween(c.start_date, startDate)) <= 1)
    .sort((a, b) => Math.abs(daysBetween(a.start_date, startDate)) - Math.abs(daysBetween(b.start_date, startDate)));
  return near[0] ?? null;
}

/**
 * The saved booking an email's booking would update, if there is one: the
 * one named, else the same reference matched the way saveBooking matches.
 * The Inbox says "Update booking" rather than "Add to Trips".
 */
export async function bookingFor(input: Partial<Pick<BookingInput, "booking_id" | "kind" | "reference" | "segment" | "start_local">>): Promise<{ id: string; title: string; status: BookingStatus; owner_archived: boolean } | null> {
  const found = async (): Promise<Candidate | null> => {
    if (input.booking_id) {
      if (!UUID_RE.test(input.booking_id)) return null;
      const [row] = await q<Candidate>(
        `SELECT b.id, b.trip_id, b.kind, b.reference, b.segment, b.title, to_char(b.start_date, 'YYYY-MM-DD') AS start_date, b.status,
                b.archived_at IS NOT NULL AS archived, t.archived_at IS NOT NULL AS trip_archived, b.source
         FROM trip_bookings b JOIN trips t ON t.id = b.trip_id WHERE b.id = $1`,
        [input.booking_id],
      );
      return row ?? null;
    }
    const kind = input.kind && BOOKING_KINDS.includes(input.kind) ? input.kind : null;
    const ref = normaliseReference(input.reference ?? "");
    const day = /^\d{4}-\d{2}-\d{2}/.exec(input.start_local ?? "")?.[0];
    if (!kind || !ref || !day) return null;
    return matchBooking(await withReference(ref), kind, clean(input.segment), day);
  };
  const b = await found();
  return b ? { id: b.id, title: b.title, status: b.status, owner_archived: b.archived || b.trip_archived } : null;
}

/**
 * The trip a new booking belongs to. A live trip to the same place whose
 * dates are within three days of it; else one whose dates overlap it and that
 * shares a city with it (the flight home leaves from where you stayed);
 * else, if exactly one trip overlaps it, that one. Otherwise a new trip.
 */
async function tripFor(input: BookingInput, start: { date: string }, end: { date: string } | null, s: Sealer): Promise<{ id: string; created: boolean }> {
  const bStart = start.date;
  const bEnd = end && end.date > start.date ? end.date : start.date;
  const startCity = clean(input.start_city);
  const endCity = clean(input.end_city);
  const destination = clean(input.trip_destination) || (TRANSPORT.has(input.kind) ? endCity : startCity) || startCity || endCity;
  const dest = placeKey(destination);
  const cities = [startCity, endCity, destination].map(placeKey).filter(Boolean);

  const trips = await q<Omit<Trip, "bookings">>(
    `SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.archived_at IS NULL AND (t.ends_on IS NULL OR t.ends_on >= $1::date - 7)`,
    [bStart],
  );
  const bookings = await bookingsFor(trips.map((t) => t.id));
  let best: { id: string; score: number; gap: number } | null = null;
  const overlapping: string[] = [];
  for (const t of trips) {
    const tStart = t.starts_on ?? bStart;
    const tEnd = t.ends_on ?? tStart;
    const overlap = bStart <= tEnd && bEnd >= tStart;
    const near = bStart <= addDays(tEnd, 3) && bEnd >= addDays(tStart, -3);
    const title = placeKey(t.title);
    const tripCities = new Set([title, ...(bookings.get(t.id) ?? []).flatMap((b) => [placeKey(b.start_city), placeKey(b.end_city)])].filter(Boolean));
    const destMatch = !!dest && !!title && (title === dest || title.includes(dest) || dest.includes(title));
    const cityMatch = cities.some((c) => tripCities.has(c));
    const score = destMatch && near ? 3 : overlap && cityMatch ? 2 : 0;
    if (overlap) overlapping.push(t.id);
    const gap = Math.abs(daysBetween(tStart, bStart));
    if (score && (!best || score > best.score || (score === best.score && gap < best.gap))) best = { id: t.id, score, gap };
  }
  if (best) return { id: best.id, created: false };
  if (overlapping.length === 1) return { id: overlapping[0], created: false };

  const title = destination || clean(input.title) || "Trip";
  const [row] = await q<{ id: string }>(
    `INSERT INTO trips (title, starts_on, ends_on, source) VALUES ($1, $2::date, $3::date, $4) RETURNING id`,
    [s.text(title), bStart, bEnd, input.source ?? MANUAL],
  );
  return { id: row.id, created: true };
}

/**
 * Save a booking from an email: create it (grouped into a trip), or update
 * the one already saved for the same reference — a moved time marks it
 * changed and keeps the old start, a cancellation marks it cancelled.
 * Fields an update leaves empty keep what's there. A booking (or trip) the
 * owner archived is left alone.
 */
export async function saveBooking(input: BookingInput, opts: { byOwner?: boolean } = {}): Promise<SavedBooking> {
  const kind = oneOf(input.kind, BOOKING_KINDS, "kind");
  if (!kind) throw new AthenaInputError("A booking needs a kind");
  const status = oneOf(input.status, BOOKING_STATUSES, "status");
  const title = clean(input.title);
  if (!title) throw new AthenaInputError("A booking needs a title");
  const startTz = clean(input.start_tz);
  if (!isValidTimeZone(startTz)) throw new AthenaInputError(`Unknown time zone '${input.start_tz}': use an IANA zone like Europe/Lisbon`);
  const endTz = clean(input.end_tz) || startTz;
  if (!isValidTimeZone(endTz)) throw new AthenaInputError(`Unknown time zone '${input.end_tz}': use an IANA zone like Europe/Lisbon`);
  const start = parseLocal(input.start_local, startTz, "start");
  const end = input.end_local ? parseLocal(input.end_local, endTz, "end") : null;
  if (end?.at && start.at && end.at.getTime() < start.at.getTime()) throw new AthenaInputError("It ends before it starts. Check the end time and its time zone");
  if (input.trip_id && !UUID_RE.test(input.trip_id)) throw new AthenaInputError(`Invalid trip id '${input.trip_id}'`);
  const conf = confidence(input.confidence);
  const ref = normaliseReference(input.reference ?? "");
  const s = await sealer();

  // The owner adding one never merges into another by reference: they said it's new.
  const candidates = opts.byOwner ? [] : await withReference(ref);
  let existing: Candidate | null = null;
  if (input.booking_id) {
    const b = await getBooking(input.booking_id, { includeArchived: true });
    if (!b) throw new AthenaInputError(`Booking ${input.booking_id} not found`, 404);
    const [t] = await q<{ archived: boolean }>(`SELECT archived_at IS NOT NULL AS archived FROM trips WHERE id = $1`, [b.trip_id]);
    existing = { ...b, archived: !!b.archived_at, trip_archived: !!t?.archived };
  } else {
    existing = matchBooking(candidates, kind, clean(input.segment), start.date);
  }
  const others = (except: string | null) =>
    candidates
      .filter((c) => c.id !== except && !c.archived && !c.trip_archived)
      .map((c) => ({ id: c.id, segment: c.segment, title: c.title, start_date: c.start_date, status: c.status }));

  if (existing && (existing.archived || existing.trip_archived)) {
    return {
      action: "skipped",
      reason: existing.archived ? "The owner archived this booking." : "The owner archived this trip.",
      booking: null,
      trip: null,
      same_reference: others(existing.id),
    };
  }

  // Text an update leaves out (or sends empty) keeps what's there.
  const text = (v: string | undefined) => {
    const c = clean(v);
    return c ? s.text(c) : null;
  };

  if (existing) {
    const current = (await getBooking(existing.id, { includeArchived: true }))!;
    // What an email may change. A booking the owner added only gains what it's missing (a seat, a
    // terminal, the email); anything else is theirs. Fields the owner changed by hand stay as they are.
    const yours = current.source === MANUAL && !opts.byOwner;
    const edited = new Set(opts.byOwner ? [] : current.owner_edited);
    const may = (f: BookingText) => !edited.has(f) && (!yours || current[f] === "");
    const startLocked = yours || edited.has("start_local") || edited.has("start_tz");
    const endLocked = edited.has("end_local") || edited.has("end_tz") || (yours && current.end_date !== null);
    const was = current.starts_at ? Date.parse(current.starts_at) : null;
    const now = start.at ? start.at.getTime() : null;
    // Moved: a different start time, or a different day. Adding a time to the same day isn't a change.
    const moved = !startLocked && (now !== null && was !== null ? Math.abs(was - now) >= 60_000 : current.start_date !== start.date);
    let nextStatus: BookingStatus = current.status;
    // A cancellation always comes through, on a booking you added or whose status you set too.
    if (status === "cancelled") nextStatus = "cancelled";
    else if (yours || edited.has("status")) nextStatus = current.status;
    else if (moved || status === "changed") nextStatus = "changed";
    // Booked again after a cancellation.
    else if (status === "confirmed" && current.status === "cancelled") nextStatus = "confirmed";
    const maybe = (f: BookingText, v: string | undefined) => (may(f) ? text(v) : null);
    await q(
      `UPDATE trip_bookings SET
         status = $2,
         title = COALESCE($3, title), provider = COALESCE($4, provider), segment = COALESCE($5, segment),
         start_date = $6::date, starts_at = COALESCE($7::timestamptz, CASE WHEN $8::boolean THEN NULL ELSE starts_at END),
         start_tz = $9, start_place = COALESCE($10, start_place), start_city = COALESCE($11, start_city),
         end_date = COALESCE($12::date, end_date), ends_at = COALESCE($13::timestamptz, ends_at),
         end_tz = COALESCE($14, end_tz), end_place = COALESCE($15, end_place), end_city = COALESCE($16, end_city),
         seat = COALESCE($17, seat), details = COALESCE($18, details), email_link = COALESCE($19, email_link),
         previous_starts_at = CASE WHEN $20::boolean THEN starts_at ELSE previous_starts_at END,
         reference = CASE WHEN reference = '' THEN COALESCE($21, reference) ELSE reference END,
         reference_bidx = CASE WHEN reference = '' THEN COALESCE($22, reference_bidx) ELSE reference_bidx END,
         source_ref = COALESCE($23, source_ref), confidence = COALESCE($24, confidence),
         cancelled_at = CASE WHEN $2 <> 'cancelled' THEN NULL WHEN $25::boolean THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
         cancel_email_link = CASE WHEN $2 <> 'cancelled' THEN '' WHEN $25::boolean AND $26::text IS NOT NULL THEN $26 ELSE cancel_email_link END,
         updated_at = now()
       WHERE id = $1`,
      [
        existing.id,
        nextStatus,
        yours ? null : maybe("title", title),
        maybe("provider", input.provider),
        maybe("segment", input.segment),
        startLocked ? current.start_date : start.date,
        startLocked ? null : start.at?.toISOString() ?? null,
        // A day-only start replacing a timed one: the time is no longer known.
        start.at === null && moved,
        s.text(startLocked ? current.start_tz : startTz),
        maybe("start_place", input.start_place),
        maybe("start_city", input.start_city),
        endLocked ? null : end?.date ?? null,
        endLocked ? null : end?.at?.toISOString() ?? null,
        endLocked || !input.end_local ? null : s.text(endTz),
        maybe("end_place", input.end_place),
        maybe("end_city", input.end_city),
        maybe("seat", input.seat),
        maybe("details", input.details),
        maybe("email_link", input.email_link),
        moved && was !== null,
        edited.has("reference") ? null : text(input.reference),
        ref && !edited.has("reference") ? s.index("booking", ref) : null,
        yours ? null : input.source_ref ?? null,
        yours ? null : conf,
        // Which email cancelled it, so the booking can say so.
        !opts.byOwner && status === "cancelled",
        text(input.email_link),
      ],
    );
    await refreshTripDates(existing.trip_id);
    return {
      action: "updated",
      booking: await getBooking(existing.id, { includeArchived: true }),
      trip: await getTrip(existing.trip_id, { includeArchived: true }),
      same_reference: others(existing.id),
    };
  }

  // New: into the trip it belongs to (an explicit one, the one its reference is already in, or by place and dates).
  let tripId = input.trip_id ?? null;
  if (tripId) {
    const [t] = await q<{ id: string }>(`SELECT id FROM trips WHERE id = $1 AND archived_at IS NULL`, [tripId]);
    if (!t) throw new AthenaInputError(`Trip ${tripId} not found`, 404);
  }
  tripId ??= candidates.find((c) => !c.archived && !c.trip_archived)?.trip_id ?? null;
  let newTrip = false;
  if (!tripId) {
    const found = await tripFor({ ...input, kind }, start, end, s);
    tripId = found.id;
    newTrip = found.created;
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO trip_bookings (trip_id, kind, status, title, provider, reference, reference_bidx, segment,
       start_date, starts_at, start_tz, start_place, start_city, end_date, ends_at, end_tz, end_place, end_city,
       seat, details, email_link, source, source_ref, confidence, cancelled_at, cancel_email_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::timestamptz, $11, $12, $13, $14::date, $15::timestamptz, $16, $17, $18,
       $19, $20, $21, $22, $23, $24,
       CASE WHEN $25::boolean THEN now() END, CASE WHEN $25::boolean THEN $21 ELSE '' END)
     RETURNING id`,
    [
      tripId,
      kind,
      status ?? "confirmed",
      s.text(title),
      s.text(clean(input.provider)),
      s.text(clean(input.reference)),
      ref ? s.index("booking", ref) : null,
      s.text(clean(input.segment)),
      start.date,
      start.at?.toISOString() ?? null,
      s.text(startTz),
      s.text(clean(input.start_place)),
      s.text(clean(input.start_city)),
      end?.date ?? null,
      end?.at?.toISOString() ?? null,
      s.text(input.end_local ? endTz : ""),
      s.text(clean(input.end_place)),
      s.text(clean(input.end_city)),
      s.text(clean(input.seat)),
      s.text(clean(input.details)),
      s.text(clean(input.email_link)),
      input.source ?? "manual",
      input.source_ref ?? null,
      conf,
      !opts.byOwner && status === "cancelled",
    ],
  );
  await refreshTripDates(tripId);
  return {
    action: "created",
    new_trip: newTrip,
    booking: await getBooking(row.id, { includeArchived: true }),
    trip: await getTrip(tripId, { includeArchived: true }),
    same_reference: others(row.id),
  };
}

// ---------- purchases ----------

const PURCHASE_COLUMNS = `p.id, p.retailer, p.items, p.order_number, to_char(p.ordered_on, 'YYYY-MM-DD') AS ordered_on, p.status, p.status_at,
  to_char(p.expected_on, 'YYYY-MM-DD') AS expected_on, p.delivered_at, p.carrier, p.tracking_number, p.tracking_url, p.email_link,
  p.owner_edited, p.source, p.source_ref, p.confidence, p.archived_at, p.created_at, p.updated_at`;

type PurchaseRow = Omit<Purchase, "updates">;

async function withUpdates(rows: PurchaseRow[]): Promise<Purchase[]> {
  if (!rows.length) return [];
  const updates = await q<PurchaseUpdate & { purchase_id: string }>(
    `SELECT id, purchase_id, status, at, detail, email_link FROM purchase_updates WHERE purchase_id = ANY($1::uuid[]) ORDER BY at, created_at`,
    [rows.map((r) => r.id)],
  );
  const by = new Map<string, PurchaseUpdate[]>();
  for (const { purchase_id, ...u } of updates) by.set(purchase_id, [...(by.get(purchase_id) ?? []), { ...u, at: iso(u.at)! }]);
  return rows.map((r) => ({
    ...r,
    status_at: iso(r.status_at)!,
    delivered_at: iso(r.delivered_at),
    archived_at: iso(r.archived_at),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    updates: by.get(r.id) ?? [],
  }));
}

export async function getPurchase(id: string, opts: { includeArchived?: boolean } = {}): Promise<Purchase | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await q<PurchaseRow>(`SELECT ${PURCHASE_COLUMNS} FROM purchases p WHERE p.id = $1 AND ($2::boolean OR p.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return (await withUpdates(rows))[0] ?? null;
}

/**
 * Live purchases: still on their way first (soonest expected first), then
 * the settled ones (delivered, returned, refunded, cancelled), most recent first.
 */
export async function listPurchases(opts: { inProgressOnly?: boolean; limit?: number } = {}): Promise<Purchase[]> {
  const rows = await q<PurchaseRow>(
    `SELECT ${PURCHASE_COLUMNS} FROM purchases p
     WHERE p.archived_at IS NULL AND (NOT $1::boolean OR NOT (p.status = ANY($2::text[])))`,
    [opts.inProgressOnly ?? false, SETTLED_STATUSES],
  );
  const settled = (p: PurchaseRow) => SETTLED_STATUSES.includes(p.status);
  const time = (v: unknown) => Date.parse(iso(v) ?? "") || 0;
  rows.sort((a, b) => {
    if (settled(a) !== settled(b)) return settled(a) ? 1 : -1;
    if (!settled(a)) return (a.expected_on ?? "9999").localeCompare(b.expected_on ?? "9999") || time(b.status_at) - time(a.status_at);
    return time(b.status_at) - time(a.status_at);
  });
  return withUpdates(rows.slice(0, opts.limit ?? 300));
}

export interface PurchaseInput {
  /** Update this purchase (from an earlier answer), rather than matching by order number. */
  purchase_id?: string;
  retailer?: string;
  order_number?: string;
  items?: string[];
  ordered_on?: string | null;
  status: PurchaseStatus;
  /** When this status happened: the email's time, ISO 8601. Defaults to now. */
  status_at?: string;
  expected_on?: string | null;
  carrier?: string;
  tracking_number?: string;
  tracking_url?: string;
  /** One short line for the timeline: "Left with a neighbour", "New delivery day Thursday". */
  detail?: string;
  email_link?: string;
  source?: string | null;
  source_ref?: string | null;
  confidence?: number | null;
}

export interface SavedPurchase {
  action: "created" | "updated" | "restored" | "skipped";
  reason?: string;
  purchase: Purchase | null;
}

interface PurchaseCandidate {
  id: string;
  retailer: string;
  order_number: string;
  tracking_number: string;
  status: PurchaseStatus;
  status_at: string;
  archived: boolean;
  archived_by_athena: boolean;
  source: string | null;
}

/** The purchase an email is about: the same order number at the same shop, else the same tracking number. */
async function findPurchase(order: string, tracking: string, retailer: string): Promise<PurchaseCandidate | null> {
  if (!order && !tracking) return null;
  const rows = await q<PurchaseCandidate>(
    `SELECT id, retailer, order_number, tracking_number, status, status_at, archived_at IS NOT NULL AS archived, archived_by_athena, source
     FROM purchases
     WHERE order_bidx = ANY($1::text[]) OR tracking_bidx = ANY($2::text[])
        OR (order_bidx IS NULL AND tracking_bidx IS NULL AND (order_number <> '' OR tracking_number <> ''))
     ORDER BY archived_at NULLS FIRST, created_at DESC`,
    [order ? lookupIndexes("order", order) : [], tracking ? lookupIndexes("tracking", tracking) : []],
  );
  const byOrder = order ? rows.filter((r) => normaliseReference(r.order_number) === order && sameRetailer(r.retailer, retailer)) : [];
  if (byOrder.length) return byOrder[0];
  const byTracking = tracking ? rows.filter((r) => normaliseReference(r.tracking_number) === tracking) : [];
  return byTracking[0] ?? null;
}

/**
 * The saved order a delivery update would move on, if there is one: the one
 * named, else the same order or tracking number, as savePurchase matches.
 * The Inbox says "Update status" rather than "Add to Purchases".
 */
export async function purchaseFor(input: Partial<Pick<PurchaseInput, "purchase_id" | "order_number" | "tracking_number" | "retailer">>): Promise<{ id: string; status: PurchaseStatus; owner_archived: boolean } | null> {
  let row: PurchaseCandidate | null = null;
  if (input.purchase_id) {
    if (!UUID_RE.test(input.purchase_id)) return null;
    [row] = await q<PurchaseCandidate>(
      `SELECT id, retailer, order_number, tracking_number, status, status_at, archived_at IS NOT NULL AS archived, archived_by_athena, source FROM purchases WHERE id = $1`,
      [input.purchase_id],
    );
  } else {
    row = await findPurchase(normaliseReference(input.order_number ?? ""), normaliseReference(input.tracking_number ?? ""), clean(input.retailer));
  }
  return row ? { id: row.id, status: row.status, owner_archived: row.archived && !row.archived_by_athena } : null;
}

/**
 * Save an order or a delivery update. The first email for an order creates
 * it; later ones for the same order number (or tracking number) move its
 * status on — unless they're older than what's already known, which only
 * adds them to the timeline — and fill in carrier, tracking and expected day.
 * Something the owner archived is left alone; something Athena archived
 * after delivery comes back if it moves again (a return, a refund).
 */
export async function savePurchase(input: PurchaseInput, opts: { byOwner?: boolean; keepArchived?: boolean } = {}): Promise<SavedPurchase> {
  const status = oneOf(input.status, PURCHASE_STATUSES, "status");
  if (!status) throw new AthenaInputError("A purchase update needs a status");
  const at = input.status_at ? new Date(input.status_at) : new Date();
  if (Number.isNaN(at.getTime())) throw new AthenaInputError(`Invalid status_at '${input.status_at}': use an ISO 8601 time`);
  const ordered = localDate(input.ordered_on, "ordered_on");
  const expected = localDate(input.expected_on, "expected_on");
  const conf = confidence(input.confidence);
  const retailer = clean(input.retailer);
  const order = normaliseReference(input.order_number ?? "");
  const tracking = normaliseReference(input.tracking_number ?? "");
  const items = (input.items ?? []).map(clean).filter(Boolean).slice(0, 30);
  const s = await sealer();

  let existing: PurchaseCandidate | null = null;
  if (input.purchase_id) {
    if (!UUID_RE.test(input.purchase_id)) throw new AthenaInputError(`Invalid purchase id '${input.purchase_id}'`);
    const [row] = await q<PurchaseCandidate>(
      `SELECT id, retailer, order_number, tracking_number, status, status_at, archived_at IS NOT NULL AS archived, archived_by_athena, source FROM purchases WHERE id = $1`,
      [input.purchase_id],
    );
    if (!row) throw new AthenaInputError(`Purchase ${input.purchase_id} not found`, 404);
    existing = row;
  } else existing = await findPurchase(order, tracking, retailer);

  if (!existing) {
    if (!retailer) throw new AthenaInputError("A new purchase needs the retailer");
    if (!order && !tracking) throw new AthenaInputError("A new purchase needs its order number (or, for a carrier's email, the tracking number)");
    const [row] = await q<{ id: string }>(
      `INSERT INTO purchases (retailer, items, order_number, order_bidx, ordered_on, status, status_at, expected_on, delivered_at,
         carrier, tracking_number, tracking_bidx, tracking_url, email_link, source, source_ref, confidence)
       VALUES ($1, $2::text[], $3, $4, $5::date, $6, $7::timestamptz, $8::date, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        s.text(retailer),
        s.list(items),
        s.text(clean(input.order_number)),
        order ? s.index("order", order) : null,
        ordered ?? (status === "ordered" ? zonedParts(at, await getOwnerTimeZone()).date : null),
        status,
        at.toISOString(),
        expected ?? null,
        status === "delivered" ? at.toISOString() : null,
        s.text(clean(input.carrier)),
        s.text(clean(input.tracking_number)),
        tracking ? s.index("tracking", tracking) : null,
        s.text(clean(input.tracking_url)),
        s.text(clean(input.email_link)),
        input.source ?? "manual",
        input.source_ref ?? null,
        conf,
      ],
    );
    await addUpdate(row.id, status, at, input, s);
    return { action: "created", purchase: await getPurchase(row.id, { includeArchived: true }) };
  }

  if (existing.archived && !existing.archived_by_athena) {
    return { action: "skipped", reason: "The owner archived this purchase.", purchase: null };
  }
  // A file import (the Amazon export) fills in history: it never brings back an order that settled and left.
  if (existing.archived && opts.keepArchived) {
    return { action: "skipped", reason: "Already settled and put away.", purchase: null };
  }
  const restoring = existing.archived;
  // An email older than what's known (a rerun reading the dispatch notice after the delivery one) only joins the timeline.
  // The owner saying where it's got to always wins.
  // An order the owner added keeps their shop, items, order number and days: an email only moves its
  // status on and brings the carrier and tracking. Fields the owner changed by hand stay as they are,
  // except that a status they set can still move forward ("Dispatched" to "Delivered").
  const [own] = await q<{ owner_edited: string[] }>(`SELECT owner_edited FROM purchases WHERE id = $1`, [existing.id]);
  const yours = existing.source === MANUAL && !opts.byOwner;
  const edited = new Set(opts.byOwner ? [] : own?.owner_edited ?? []);
  const may = (f: keyof PurchaseFields) => !edited.has(f) && !(yours && OWNER_ORDER_FIELDS.has(f));
  const forwardOnly = yours || edited.has("status");
  // For those, a step forward applies whenever its email was sent: the time on a status you set is when you
  // set it, so yesterday's "Dispatched" still moves on an order you added this morning.
  const later = at.getTime() >= Date.parse(iso(existing.status_at)!);
  // A cancellation always comes through, even on an order you added or whose status you set.
  const newer = opts.byOwner || (forwardOnly && status === "cancelled") || (forwardOnly ? isForward(existing.status, status) && (STAGE[status] > STAGE[existing.status] || later) : later);
  const text = (v: string | undefined) => {
    const c = clean(v);
    return c ? s.text(c) : null;
  };
  const allowed = (f: keyof PurchaseFields, v: string | undefined) => (may(f) ? text(v) : null);
  const merged = items.length && may("items")
    ? await (async () => {
        const [cur] = await q<{ items: string[] }>(`SELECT items FROM purchases WHERE id = $1`, [existing!.id]);
        // An item that went back ("Kettle (returned)", from the Amazon export) takes the plain one's place.
        const have = (cur?.items ?? []).map((i) => items.find((x) => x.toLowerCase() === `${i}${RETURNED}`.toLowerCase()) ?? i);
        const keys = new Set(have.map((i) => i.toLowerCase()));
        return [...have, ...items.filter((i) => !keys.has(i.toLowerCase()))];
      })()
    : null;
  await q(
    `UPDATE purchases SET
       status = CASE WHEN $2::boolean THEN $3 ELSE status END,
       status_at = CASE WHEN $2::boolean THEN $4::timestamptz ELSE status_at END,
       delivered_at = CASE WHEN $2::boolean AND $3 = 'delivered' THEN $4::timestamptz ELSE delivered_at END,
       expected_on = CASE WHEN $5::date IS NOT NULL AND ($2::boolean OR expected_on IS NULL) THEN $5::date ELSE expected_on END,
       retailer = CASE WHEN retailer = '' THEN COALESCE($6, retailer) ELSE retailer END,
       items = COALESCE($7::text[], items),
       order_number = CASE WHEN order_number = '' THEN COALESCE($8, order_number) ELSE order_number END,
       order_bidx = CASE WHEN order_number = '' THEN COALESCE($9, order_bidx) ELSE order_bidx END,
       ordered_on = COALESCE(ordered_on, $10::date),
       carrier = COALESCE($11, carrier),
       tracking_number = COALESCE($12, tracking_number),
       tracking_bidx = COALESCE($13, tracking_bidx),
       tracking_url = COALESCE($14, tracking_url),
       email_link = CASE WHEN email_link = '' THEN COALESCE($15, email_link) ELSE email_link END,
       source_ref = COALESCE($16, source_ref),
       confidence = COALESCE($17, confidence),
       archived_at = CASE WHEN $18::boolean THEN NULL ELSE archived_at END,
       archived_by_athena = CASE WHEN $18::boolean THEN false ELSE archived_by_athena END,
       updated_at = now()
     WHERE id = $1`,
    [
      existing.id,
      newer,
      status,
      at.toISOString(),
      may("expected_on") ? expected ?? null : null,
      allowed("retailer", input.retailer),
      merged ? s.list(merged) : null,
      allowed("order_number", input.order_number),
      order && may("order_number") ? s.index("order", order) : null,
      may("ordered_on") ? ordered ?? null : null,
      allowed("carrier", input.carrier),
      allowed("tracking_number", input.tracking_number),
      tracking && may("tracking_number") ? s.index("tracking", tracking) : null,
      allowed("tracking_url", input.tracking_url),
      text(input.email_link),
      yours ? null : input.source_ref ?? null,
      yours ? null : conf,
      restoring,
    ],
  );
  await addUpdate(existing.id, status, at, input, s);
  return { action: restoring ? "restored" : "updated", purchase: await getPurchase(existing.id, { includeArchived: true }) };
}

/** How an import marks an item that went back (lib/amazon-export.ts RETURNED_SUFFIX). */
const RETURNED = " (returned)";

/** What an email never changes on an order the owner added. */
const OWNER_ORDER_FIELDS = new Set<keyof PurchaseFields>(["retailer", "items", "order_number", "ordered_on", "expected_on"]);

/** How far along an order is, so an email can only move one forward (a late "Dispatched" after "Delivered" doesn't). */
const STAGE: Record<PurchaseStatus, number> = { ordered: 0, dispatched: 1, delayed: 1, out_for_delivery: 2, delivered: 3, cancelled: 3, returned: 4, refunded: 5 };
const isForward = (from: PurchaseStatus, to: PurchaseStatus) => from === to || STAGE[to] > STAGE[from] || (STAGE[to] === STAGE[from] && STAGE[to] === 1);

/** One step on the timeline; the same status within 12 hours is the same step (a rerun, a second email about it). */
async function addUpdate(purchaseId: string, status: PurchaseStatus, at: Date, input: PurchaseInput, s: Sealer): Promise<void> {
  const [same] = await q<{ id: string }>(
    `SELECT id FROM purchase_updates WHERE purchase_id = $1 AND status = $2 AND abs(extract(epoch FROM at - $3::timestamptz)) < 43200 LIMIT 1`,
    [purchaseId, status, at.toISOString()],
  );
  const detail = clean(input.detail);
  const link = clean(input.email_link);
  if (same) {
    if (detail || link) {
      await q(`UPDATE purchase_updates SET detail = COALESCE($2, detail), email_link = COALESCE($3, email_link) WHERE id = $1`, [
        same.id,
        detail ? s.text(detail) : null,
        link ? s.text(link) : null,
      ]);
    }
    return;
  }
  await q(`INSERT INTO purchase_updates (purchase_id, status, at, detail, email_link) VALUES ($1, $2, $3::timestamptz, $4, $5)`, [
    purchaseId,
    status,
    at.toISOString(),
    s.text(detail),
    s.text(link),
  ]);
}

/** The owner saying where something's got to ("It arrived"). */
export async function setPurchaseStatus(id: string, status: PurchaseStatus): Promise<Purchase> {
  const saved = await savePurchase({ purchase_id: id, status, detail: "Marked by you", source_ref: null }, { byOwner: true });
  if (!saved.purchase) throw new AthenaInputError(`Purchase ${id} not found`, 404);
  return saved.purchase;
}

/**
 * Settled purchases quietly leave 30 days after they settled: archived (never
 * deleted), marked as Athena's doing so a later email can bring them back.
 * Ones the owner restored, and ones the owner added, stay put. Returns how many went.
 */
export async function archiveSettledPurchases(now: Date = new Date(), days = 30): Promise<number> {
  const rows = await q<{ id: string }>(
    `UPDATE purchases SET archived_at = $1::timestamptz, archived_by_athena = true
     WHERE archived_at IS NULL AND NOT stay_visible AND source IS DISTINCT FROM 'manual' AND status = ANY($2::text[])
       AND status_at < $1::timestamptz - make_interval(days => $3::int)
     RETURNING id`,
    [now.toISOString(), SETTLED_STATUSES, days],
  );
  return rows.length;
}

// ---------- the owner's day ----------

/** Today in the owner's zone, and the zone: what the briefing, pushes and MCP reads use. */
export async function ownerToday(now: Date = new Date()): Promise<{ today: string; tz: string }> {
  const tz = await getOwnerTimeZone();
  return { today: zonedToday(now, tz), tz };
}

// ---------- the owner's own bookings and orders ----------

/** A booking as the owner edits it: local times where it happens, like the collector gives them. */
export interface BookingFields {
  kind: BookingKind;
  status: BookingStatus;
  title: string;
  provider: string;
  reference: string;
  segment: string;
  /** "YYYY-MM-DDTHH:MM" in start_tz, or "YYYY-MM-DD" for the day only. */
  start_local: string;
  start_tz: string;
  start_place: string;
  start_city: string;
  /** "" when there's no end. */
  end_local: string;
  end_tz: string;
  end_place: string;
  end_city: string;
  seat: string;
  details: string;
}

const localOf = (date: string | null, at: string | null, tz: string): string => {
  if (!date) return "";
  if (!at) return date;
  const p = zonedParts(new Date(at), tz && isValidTimeZone(tz) ? tz : "UTC");
  return `${p.date}T${p.time}`;
};

/** A booking's fields as the owner sees them, for a form or an Undo. */
export function bookingFields(b: Booking): BookingFields {
  return {
    kind: b.kind,
    status: b.status,
    title: b.title,
    provider: b.provider,
    reference: b.reference,
    segment: b.segment,
    start_local: localOf(b.start_date, b.starts_at, b.start_tz),
    start_tz: b.start_tz,
    start_place: b.start_place,
    start_city: b.start_city,
    end_local: localOf(b.end_date, b.ends_at, b.end_tz || b.start_tz),
    end_tz: b.end_tz,
    end_place: b.end_place,
    end_city: b.end_city,
    seat: b.seat,
    details: b.details,
  };
}

/**
 * A booking the owner adds, in a trip they name or (with none) grouped like an email's.
 * If an email already brought in the same booking (same reference, kind and day), the two
 * become one: what the owner gave replaces the email's, and stays theirs; the rest is kept.
 * `before` is then what it was, for an Undo.
 */
export async function addBooking(
  input: Omit<BookingInput, "booking_id" | "source" | "source_ref" | "confidence">,
): Promise<SavedBooking & { before?: { fields: BookingFields; edited: string[] } }> {
  checkBookingText(input);
  const kind = oneOf(input.kind, BOOKING_KINDS, "kind");
  const ref = normaliseReference(input.reference ?? "");
  const startTz = clean(input.start_tz);
  if (kind && ref && isValidTimeZone(startTz)) {
    const start = parseLocal(input.start_local, startTz, "start");
    const candidates = (await withReference(ref)).filter((c) => !c.archived && !c.trip_archived);
    const match = matchBooking(candidates, kind, clean(input.segment), start.date);
    if (match && match.source !== MANUAL) {
      const current = (await getBooking(match.id))!;
      const given = Object.fromEntries(
        Object.entries({ ...input, kind }).filter(([k, v]) => k in bookingFields(current) && typeof v === "string" && clean(v) !== ""),
      ) as Partial<BookingFields>;
      const before = { fields: bookingFields(current), edited: current.owner_edited };
      const booking = await editBooking(match.id, given);
      return {
        action: "updated",
        booking,
        trip: await getTrip(booking.trip_id, { includeArchived: true }),
        same_reference: candidates.filter((c) => c.id !== match.id).map((c) => ({ id: c.id, segment: c.segment, title: c.title, start_date: c.start_date, status: c.status })),
        before,
      };
    }
  }
  return saveBooking({ ...input, source: MANUAL, source_ref: null, confidence: null }, { byOwner: true });
}

function checkBookingText(input: Partial<BookingFields> & { trip_destination?: string }) {
  owned(input.title, 160, "The booking's name");
  owned(input.provider, 120, "Who it's with");
  owned(input.reference, 80, "The reference");
  owned(input.segment, 60, "The part");
  owned(input.start_place, 200, "Where it starts");
  owned(input.start_city, 80, "The city");
  owned(input.end_place, 200, "Where it ends");
  owned(input.end_city, 80, "The city");
  owned(input.seat, 60, "The seat");
  owned(input.details, 300, "The details");
  owned(input.trip_destination, 120, "The trip's name");
}

/**
 * The owner changing a booking, any booking (email ones too): what they give
 * replaces what's there, "" clears it, and a new time is a correction, not a
 * schedule change, so it isn't marked "Time changed".
 */
export async function editBooking(id: string, patch: Partial<BookingFields>, opts: { edited?: string[] } = {}): Promise<Booking> {
  const current = await getBooking(id, { includeArchived: true });
  if (!current) throw new AthenaInputError(`Booking ${id} not found`, 404);
  checkBookingText(patch);
  const f = { ...bookingFields(current), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as BookingFields;
  const kind = oneOf(f.kind, BOOKING_KINDS, "kind")!;
  const status = oneOf(f.status, BOOKING_STATUSES, "status")!;
  const title = clean(f.title);
  if (!title) throw new AthenaInputError("A booking needs a name");
  const startTz = clean(f.start_tz);
  if (!isValidTimeZone(startTz)) throw new AthenaInputError(`Unknown time zone '${f.start_tz}': use an IANA zone like Europe/Lisbon`);
  const endTz = clean(f.end_tz) || startTz;
  if (!isValidTimeZone(endTz)) throw new AthenaInputError(`Unknown time zone '${f.end_tz}': use an IANA zone like Europe/Lisbon`);
  if (!clean(f.start_local)) throw new AthenaInputError("A booking needs a start day");
  const start = parseLocal(f.start_local, startTz, "start");
  const end = clean(f.end_local) ? parseLocal(f.end_local, endTz, "end") : null;
  if (end && end.date < start.date) throw new AthenaInputError("It ends before it starts. Check the end day");
  if (end?.at && start.at && end.at.getTime() < start.at.getTime()) throw new AthenaInputError("It ends before it starts. Check the end time and its time zone");
  const ref = normaliseReference(f.reference);
  // What the owner changed stays theirs: later emails leave those fields alone (an Undo puts back exactly what was).
  const was = bookingFields(current);
  const changed = (Object.keys(was) as Array<keyof BookingFields>).filter((k) => k in patch && clean(String(f[k] ?? "")) !== clean(String(was[k] ?? "")));
  const edited = opts.edited ?? [...new Set([...current.owner_edited, ...changed])];
  const s = await sealer();
  await q(
    `UPDATE trip_bookings SET kind = $2, status = $3, title = $4, provider = $5, reference = $6, reference_bidx = $7, segment = $8,
       start_date = $9::date, starts_at = $10::timestamptz, start_tz = $11, start_place = $12, start_city = $13,
       end_date = $14::date, ends_at = $15::timestamptz, end_tz = $16, end_place = $17, end_city = $18,
       seat = $19, details = $20, owner_edited = $21::text[],
       cancelled_at = CASE WHEN $3 = 'cancelled' THEN cancelled_at END,
       cancel_email_link = CASE WHEN $3 = 'cancelled' THEN cancel_email_link ELSE '' END,
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      kind,
      status,
      s.text(title),
      s.text(clean(f.provider)),
      s.text(clean(f.reference)),
      ref ? s.index("booking", ref) : null,
      s.text(clean(f.segment)),
      start.date,
      start.at?.toISOString() ?? null,
      s.text(startTz),
      s.text(clean(f.start_place)),
      s.text(clean(f.start_city)),
      end?.date ?? null,
      end?.at?.toISOString() ?? null,
      s.text(end ? endTz : ""),
      s.text(clean(f.end_place)),
      s.text(clean(f.end_city)),
      s.text(clean(f.seat)),
      s.text(clean(f.details)),
      edited,
    ],
  );
  await refreshTripDates(current.trip_id);
  return (await getBooking(id, { includeArchived: true }))!;
}

/** An order as the owner edits it. Never a price. */
export interface PurchaseFields {
  retailer: string;
  items: string[];
  order_number: string;
  ordered_on: string | null;
  expected_on: string | null;
  status: PurchaseStatus;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
}

export function purchaseFields(p: Purchase): PurchaseFields {
  return {
    retailer: p.retailer,
    items: p.items,
    order_number: p.order_number,
    ordered_on: p.ordered_on,
    expected_on: p.expected_on,
    status: p.status,
    carrier: p.carrier,
    tracking_number: p.tracking_number,
    tracking_url: p.tracking_url,
  };
}

/** Checks what the owner typed and gives it back tidied. */
function ownedPurchase(f: PurchaseFields): PurchaseFields {
  const retailer = owned(f.retailer, 120, "The shop's name")!;
  if (!retailer) throw new AthenaInputError("An order needs the shop it's from");
  const items = (f.items ?? []).map((i) => owned(i, 200, "An item's name")!).filter(Boolean);
  if (items.length > 30) throw new AthenaInputError("30 items at most");
  const link = owned(f.tracking_url, 500, "The tracking link")!;
  if (link && !/^https?:\/\//i.test(link) && !/^[\w-]+(\.[\w-]+)+(\/|$)/.test(link)) throw new AthenaInputError("The tracking link should be a web address, starting https://");
  const ordered = localDate(f.ordered_on, "ordered day") ?? null;
  const expected = localDate(f.expected_on, "expected day") ?? null;
  return {
    retailer,
    items,
    order_number: owned(f.order_number, 80, "The order number")!,
    ordered_on: ordered,
    expected_on: expected,
    status: oneOf(f.status, PURCHASE_STATUSES, "status")!,
    carrier: owned(f.carrier, 80, "The carrier")!,
    tracking_number: owned(f.tracking_number, 80, "The tracking number")!,
    tracking_url: link && !/^https?:\/\//i.test(link) ? `https://${link}` : link,
  };
}

/**
 * An order the owner adds: a shop, what's in it and when it's due. Its order number may come later, or never.
 * If an email already brought in the same order (same shop and order number), the two become one: what the
 * owner gave replaces the email's and stays theirs. `before` is then what it was, for an Undo.
 */
export async function createPurchase(
  input: Partial<PurchaseFields> & { retailer: string },
): Promise<{ purchase: Purchase; before: { fields: PurchaseFields; edited: string[] } | null }> {
  const order = normaliseReference(input.order_number ?? "");
  const match = order ? await findPurchase(order, "", clean(input.retailer)) : null;
  if (match && !match.archived && match.source !== MANUAL) {
    const current = (await getPurchase(match.id))!;
    const given = Object.fromEntries(
      Object.entries(input).filter(([k, v]) => k in purchaseFields(current) && v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)),
    ) as Partial<PurchaseFields>;
    // The form's "Ordered" doesn't take back a delivery the email already knows about.
    if (given.status && !isForward(current.status, given.status)) delete given.status;
    const before = { fields: purchaseFields(current), edited: current.owner_edited };
    return { purchase: await editPurchase(match.id, given, { detail: "Added by you" }), before };
  }
  return { purchase: await addPurchase(input), before: null };
}

async function addPurchase(input: Partial<PurchaseFields> & { retailer: string }): Promise<Purchase> {
  const f = ownedPurchase({
    retailer: input.retailer,
    items: input.items ?? [],
    order_number: input.order_number ?? "",
    ordered_on: input.ordered_on ?? null,
    expected_on: input.expected_on ?? null,
    status: input.status ?? "ordered",
    carrier: input.carrier ?? "",
    tracking_number: input.tracking_number ?? "",
    tracking_url: input.tracking_url ?? "",
  });
  const order = normaliseReference(f.order_number);
  const tracking = normaliseReference(f.tracking_number);
  const now = new Date();
  const s = await sealer();
  const [row] = await q<{ id: string }>(
    `INSERT INTO purchases (retailer, items, order_number, order_bidx, ordered_on, status, status_at, expected_on, delivered_at,
       carrier, tracking_number, tracking_bidx, tracking_url, source)
     VALUES ($1, $2::text[], $3, $4, $5::date, $6, $7::timestamptz, $8::date, $9::timestamptz, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      s.text(f.retailer),
      s.list(f.items),
      s.text(f.order_number),
      order ? s.index("order", order) : null,
      f.ordered_on ?? (f.status === "ordered" ? zonedParts(now, await getOwnerTimeZone()).date : null),
      f.status,
      now.toISOString(),
      f.expected_on,
      f.status === "delivered" ? now.toISOString() : null,
      s.text(f.carrier),
      s.text(f.tracking_number),
      tracking ? s.index("tracking", tracking) : null,
      s.text(f.tracking_url),
      MANUAL,
    ],
  );
  await addUpdate(row.id, f.status, now, { status: f.status, detail: "Added by you" }, s);
  return (await getPurchase(row.id, { includeArchived: true }))!;
}

/**
 * The owner changing an order, any order (email ones too): what they give
 * replaces what's there and "" clears it. A new status joins the timeline.
 */
export async function editPurchase(id: string, patch: Partial<PurchaseFields>, opts: { detail?: string; edited?: string[] } = {}): Promise<Purchase> {
  const current = await getPurchase(id, { includeArchived: true });
  if (!current) throw new AthenaInputError(`Purchase ${id} not found`, 404);
  const f = ownedPurchase({ ...purchaseFields(current), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as PurchaseFields);
  const moved = f.status !== current.status;
  // What the owner changed stays theirs: later emails leave those fields alone (an Undo puts back exactly what was).
  const was = purchaseFields(current);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
  const changed = (Object.keys(was) as Array<keyof PurchaseFields>).filter((k) => k in patch && !same(f[k], was[k]));
  const edited = opts.edited ?? [...new Set([...current.owner_edited, ...changed])];
  const now = new Date();
  const order = normaliseReference(f.order_number);
  const tracking = normaliseReference(f.tracking_number);
  const s = await sealer();
  await q(
    `UPDATE purchases SET retailer = $2, items = $3::text[], order_number = $4, order_bidx = $5, ordered_on = $6::date, expected_on = $7::date,
       carrier = $8, tracking_number = $9, tracking_bidx = $10, tracking_url = $11,
       status = $12,
       status_at = CASE WHEN $13::boolean THEN $14::timestamptz ELSE status_at END,
       delivered_at = CASE WHEN $13::boolean THEN (CASE WHEN $12 = 'delivered' THEN $14::timestamptz ELSE NULL END) ELSE delivered_at END,
       owner_edited = $15::text[], updated_at = now()
     WHERE id = $1`,
    [
      id,
      s.text(f.retailer),
      s.list(f.items),
      s.text(f.order_number),
      order ? s.index("order", order) : null,
      f.ordered_on,
      f.expected_on,
      s.text(f.carrier),
      s.text(f.tracking_number),
      tracking ? s.index("tracking", tracking) : null,
      s.text(f.tracking_url),
      f.status,
      moved,
      now.toISOString(),
      edited,
    ],
  );
  if (moved) await addUpdate(id, f.status, now, { status: f.status, detail: opts.detail ?? "Marked by you" }, s);
  return (await getPurchase(id, { includeArchived: true }))!;
}
