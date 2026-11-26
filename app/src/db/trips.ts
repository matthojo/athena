/**
 * Trips and purchases on the device, on the same degrade chain as
 * db/memory.ts: live API -> device cache -> bundled sample data. The email
 * collection writes them, and you add your own: here you add and edit trips,
 * bookings and orders, say a parcel arrived, and archive or restore. Like records, changes need a connection; sample mode
 * keeps its edits on this device, layered over the sample data.
 */

import * as api from "./api";
import { ApiError, isSampleMode } from "./api";
import { getMeta, setMeta } from "./idb";
import { OfflineError } from "./records";
import { samplePurchases, sampleTrips } from "./sample-trips";
import { localToday } from "../lib/time";
import type { ArchivedItem, Booking, BookingFields, ConnectionState, LogisticsKind, Purchase, PurchaseFields, PurchaseStatus, Trip } from "../types";
import { PURCHASE_STATUSES, normaliseReference, purchaseName } from "../../../lib/trip-text";
import { zonedToInstant } from "../../../lib/dates";

// ---------- change notifications ----------

type Topic = "trip" | "purchase" | "all";
const subs = new Set<(topic: Topic) => void>();

export function onLogisticsChange(fn: (topic: Topic) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(topic: Topic) {
  subs.forEach((fn) => fn(topic));
}

/** Something outside this module (Ask's assistant) changed a trip or a purchase: everyone reload. */
export const logisticsChanged = () => emit("all");

// ---------- sample-mode overlay ----------

type Overlay = Record<string, Trip | Purchase>;
const OVERLAY = "sampleLogistics";
const DELETED = "sampleLogisticsDeleted";

async function overlay(): Promise<Overlay> {
  return JSON.parse((await getMeta(OVERLAY)) ?? "{}") as Overlay;
}

async function deleted(): Promise<Set<string>> {
  return new Set(JSON.parse((await getMeta(DELETED)) ?? "[]") as string[]);
}

/** Ones you added in sample mode: in the overlay, with nothing under them. */
function added<T extends Trip | Purchase>(o: Overlay, prefix: string, base: Array<{ id: string }>): T[] {
  const known = new Set(base.map((x) => `${prefix}:${x.id}`));
  return Object.entries(o)
    .filter(([k]) => k.startsWith(`${prefix}:`) && !known.has(k))
    .map(([, v]) => v as T);
}

async function sampleAllTrips(): Promise<Trip[]> {
  const [o, gone] = await Promise.all([overlay(), deleted()]);
  const base = sampleTrips();
  return [...base, ...added<Trip>(o, "trip", base)]
    .map((t) => (o[`trip:${t.id}`] as Trip | undefined) ?? t)
    .filter((t) => !gone.has(`trip:${t.id}`))
    .map((t) => ({ ...t, bookings: t.bookings.filter((b) => !gone.has(`booking:${b.id}`)) }));
}

async function sampleAllPurchases(): Promise<Purchase[]> {
  const [o, gone] = await Promise.all([overlay(), deleted()]);
  const base = samplePurchases();
  return [...base, ...added<Purchase>(o, "purchase", base)]
    .map((p) => (o[`purchase:${p.id}`] as Purchase | undefined) ?? p)
    .filter((p) => !gone.has(`purchase:${p.id}`));
}

async function sampleWrite(key: string, row: Trip | Purchase): Promise<void> {
  const o = await overlay();
  o[key] = row;
  await setMeta(OVERLAY, JSON.stringify(o));
}

/** Run an API write, turning network failures (not API errors) into OfflineError. */
async function online<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.onLine) throw new OfflineError();
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new OfflineError();
  }
}

const nowIso = () => new Date().toISOString();

/** What the server returns: live trips with their live bookings, upcoming first, then past (most recent first). */
function liveTrips(trips: Trip[], today = localToday()): Trip[] {
  const live = trips.filter((t) => !t.archived_at).map((t) => ({ ...t, bookings: t.bookings.filter((b) => !b.archived_at) }));
  const upcoming = live.filter((t) => !t.ends_on || t.ends_on >= today).sort((a, b) => (a.starts_on ?? "").localeCompare(b.starts_on ?? ""));
  const past = live.filter((t) => t.ends_on && t.ends_on < today).sort((a, b) => b.ends_on!.localeCompare(a.ends_on!));
  return [...upcoming, ...past];
}

// ---------- reads ----------

export async function loadTrips(): Promise<{ items: Trip[]; state: ConnectionState }> {
  if (isSampleMode()) return { items: liveTrips(await sampleAllTrips()), state: "sample" };
  try {
    const items = await api.fetchTrips();
    await setMeta("logistics:trips", JSON.stringify(items));
    return { items, state: "online" };
  } catch {
    const cached = await getMeta("logistics:trips");
    if (cached) return { items: JSON.parse(cached) as Trip[], state: "offline" };
    return { items: [], state: "offline" };
  }
}

export async function loadPurchases(): Promise<{ items: Purchase[]; state: ConnectionState }> {
  if (isSampleMode()) return { items: (await sampleAllPurchases()).filter((p) => !p.archived_at), state: "sample" };
  try {
    const items = await api.fetchPurchases();
    await setMeta("logistics:purchases", JSON.stringify(items));
    return { items, state: "online" };
  } catch {
    const cached = await getMeta("logistics:purchases");
    if (cached) return { items: JSON.parse(cached) as Purchase[], state: "offline" };
    return { items: [], state: "offline" };
  }
}

export async function findTrip(id: string): Promise<Trip | null> {
  if (isSampleMode()) return liveTrips(await sampleAllTrips()).find((t) => t.id === id) ?? null;
  try {
    return await api.fetchTrip(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    const cached = await getMeta("logistics:trips");
    return ((cached ? (JSON.parse(cached) as Trip[]) : []).find((t) => t.id === id) as Trip) ?? null;
  }
}

export async function findPurchase(id: string): Promise<Purchase | null> {
  if (isSampleMode()) return (await sampleAllPurchases()).find((p) => p.id === id && !p.archived_at) ?? null;
  try {
    return await api.fetchPurchase(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    const cached = await getMeta("logistics:purchases");
    return ((cached ? (JSON.parse(cached) as Purchase[]) : []).find((p) => p.id === id) as Purchase) ?? null;
  }
}

// ---------- writes ----------

/** Rename a trip, change its notes or, on one you added, its dates. */
export async function updateTrip(id: string, patch: api.TripPatch): Promise<Trip> {
  if (isSampleMode()) {
    const trip = (await sampleAllTrips()).find((t) => t.id === id);
    if (!trip) throw new Error("That trip has gone");
    const next = { ...trip, ...patch, updated_at: nowIso() };
    await sampleWrite(`trip:${id}`, next);
    emit("trip");
    return next;
  }
  const saved = await online(() => api.updateTrip(id, patch));
  emit("trip");
  return saved;
}

// ---------- what you add ----------

/** Sample mode works these out here; the server does the same in lib/trips.ts. */
function sampleBooking(fields: BookingFields, base: Pick<Booking, "id" | "trip_id" | "created_at" | "previous_starts_at" | "email_link" | "cancelled_at" | "cancel_email_link" | "source" | "source_ref" | "confidence" | "archived_at">): Booking {
  const at = (local: string, tz: string) => {
    const [date, time] = local.split("T");
    return { date, at: time ? zonedToInstant(date, time, tz).toISOString() : null };
  };
  const s = at(fields.start_local, fields.start_tz);
  const e = fields.end_local ? at(fields.end_local, fields.end_tz || fields.start_tz) : null;
  return {
    ...base,
    ...fields,
    start_date: s.date,
    starts_at: s.at,
    end_date: e?.date ?? null,
    ends_at: e?.at ?? null,
    end_tz: e ? fields.end_tz || fields.start_tz : "",
    // Setting the status yourself clears "Cancelled by email", as the server does.
    cancelled_at: fields.status === "cancelled" ? base.cancelled_at : null,
    cancel_email_link: fields.status === "cancelled" ? base.cancel_email_link : "",
    updated_at: nowIso(),
  };
}

/** A trip's dates, stretched to hold its bookings (as the server does for one you added). */
function fitDates(t: Trip): Trip {
  const days = t.bookings.filter((b) => !b.archived_at).flatMap((b) => [b.start_date, b.end_date ?? b.start_date]).sort();
  if (!days.length) return t;
  const starts_on = !t.starts_on || days[0] < t.starts_on ? days[0] : t.starts_on;
  const ends_on = !t.ends_on || days[days.length - 1] > t.ends_on ? days[days.length - 1] : t.ends_on;
  return { ...t, starts_on, ends_on };
}

const sortBookings = (list: Booking[]) => [...list].sort((a, b) => (a.starts_at ?? `${a.start_date}T15:00`).localeCompare(b.starts_at ?? `${b.start_date}T15:00`));

/** A trip you add. */
export async function createTrip(input: { title: string; starts_on: string | null; ends_on: string | null; notes?: string }): Promise<Trip> {
  if (isSampleMode()) {
    const at = nowIso();
    const trip: Trip = { id: crypto.randomUUID(), title: input.title.trim(), starts_on: input.starts_on || input.ends_on, ends_on: input.ends_on || input.starts_on, notes: input.notes ?? "", source: "manual", archived_at: null, created_at: at, updated_at: at, bookings: [] };
    await sampleWrite(`trip:${trip.id}`, trip);
    emit("trip");
    return trip;
  }
  const saved = await online(() => api.createTrip(input));
  emit("trip");
  return saved;
}

/** A booking you add to a trip. */
export async function addBooking(tripId: string, fields: BookingFields): Promise<{ booking: Booking; trip: Trip }> {
  if (isSampleMode()) {
    const trip = (await sampleAllTrips()).find((t) => t.id === tripId);
    if (!trip) throw new Error("That trip has gone");
    const at = nowIso();
    const booking = sampleBooking(fields, { id: crypto.randomUUID(), trip_id: tripId, created_at: at, previous_starts_at: null, email_link: "", cancelled_at: null, cancel_email_link: "", source: "manual", source_ref: null, confidence: null, archived_at: null });
    const next = fitDates({ ...trip, bookings: sortBookings([...trip.bookings, booking]), updated_at: at });
    await sampleWrite(`trip:${tripId}`, next);
    emit("trip");
    return { booking, trip: next };
  }
  const saved = await online(() => api.createBooking(tripId, fields));
  emit("trip");
  return saved;
}

/** Change any booking, email ones too. */
export async function editBooking(booking: Booking, fields: BookingFields): Promise<Booking> {
  if (isSampleMode()) {
    const trip = (await sampleAllTrips()).find((t) => t.id === booking.trip_id);
    if (!trip) throw new Error("That trip has gone");
    const next = sampleBooking(fields, booking);
    await sampleWrite(`trip:${trip.id}`, fitDates({ ...trip, bookings: sortBookings(trip.bookings.map((b) => (b.id === booking.id ? next : b))) }));
    emit("trip");
    return next;
  }
  const saved = await online(() => api.updateBooking(booking.id, fields));
  emit("trip");
  return saved;
}

/** An order you add. */
export async function createPurchase(fields: PurchaseFields): Promise<Purchase> {
  if (isSampleMode()) {
    const at = nowIso();
    const p: Purchase = {
      id: crypto.randomUUID(),
      ...fields,
      ordered_on: fields.ordered_on ?? localToday(),
      status_at: at,
      delivered_at: fields.status === "delivered" ? at : null,
      email_link: "",
      source: "manual",
      source_ref: null,
      confidence: null,
      archived_at: null,
      created_at: at,
      updated_at: at,
      updates: [{ id: crypto.randomUUID(), status: fields.status, at, detail: "Added by you", email_link: "" }],
    };
    await sampleWrite(`purchase:${p.id}`, p);
    emit("purchase");
    return p;
  }
  const saved = await online(() => api.createPurchase(fields));
  emit("purchase");
  return saved;
}

/** Sample mode: the order an Inbox find is about, by its order or tracking number (lib/trips.ts purchaseFor). */
export async function sampleOrderFor(payload: Record<string, unknown>): Promise<Purchase | null> {
  const ref = (v: unknown) => (typeof v === "string" ? normaliseReference(v) : "");
  const order = ref(payload.order_number);
  const tracking = ref(payload.tracking_number);
  if (!order && !tracking) return null;
  const all = await sampleAllPurchases();
  return all.find((p) => !p.archived_at && order && ref(p.order_number) === order) ?? all.find((p) => !p.archived_at && tracking && ref(p.tracking_number) === tracking) ?? null;
}

/** Sample mode: an order from the Inbox accepted. The one it's about moves on, with the email's line; otherwise it's a new order. */
export async function sampleSaveFoundPurchase(payload: Record<string, unknown>): Promise<void> {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const status = (PURCHASE_STATUSES as readonly string[]).includes(text(payload.status)) ? (payload.status as PurchaseStatus) : "ordered";
  const existing = await sampleOrderFor(payload);
  if (!existing) {
    await createPurchase({
      retailer: text(payload.retailer) || "Shop",
      items: Array.isArray(payload.items) ? payload.items.filter((i): i is string => typeof i === "string") : [],
      order_number: text(payload.order_number),
      ordered_on: null,
      expected_on: null,
      status,
      carrier: text(payload.carrier),
      tracking_number: text(payload.tracking_number),
      tracking_url: text(payload.tracking_url),
    });
    return;
  }
  const at = nowIso();
  const moved = status !== existing.status;
  const next: Purchase = {
    ...existing,
    updated_at: at,
    ...(moved ? { status, status_at: at, delivered_at: status === "delivered" ? at : existing.delivered_at } : {}),
    updates: [...existing.updates, { id: crypto.randomUUID(), status, at, detail: text(payload.detail), email_link: "" }],
  };
  await sampleWrite(`purchase:${existing.id}`, next);
  emit("purchase");
}

/** Change any order, email ones too: its shop, items, dates or tracking. */
export async function editPurchase(id: string, fields: Partial<PurchaseFields>): Promise<Purchase> {
  if (isSampleMode()) {
    const p = (await sampleAllPurchases()).find((x) => x.id === id);
    if (!p) throw new Error("That purchase has gone");
    const at = nowIso();
    const moved = fields.status && fields.status !== p.status;
    const next: Purchase = {
      ...p,
      ...fields,
      updated_at: at,
      ...(moved ? { status_at: at, delivered_at: fields.status === "delivered" ? at : null, updates: [...p.updates, { id: crypto.randomUUID(), status: fields.status!, at, detail: "Marked by you", email_link: "" }] } : {}),
    };
    await sampleWrite(`purchase:${id}`, next);
    emit("purchase");
    return next;
  }
  const saved = await online(() => api.updatePurchase(id, fields));
  emit("purchase");
  return saved;
}

/** You saying where a parcel has got to: "It arrived". */
export async function setPurchaseStatus(id: string, status: PurchaseStatus): Promise<Purchase> {
  if (isSampleMode()) {
    const p = (await sampleAllPurchases()).find((x) => x.id === id);
    if (!p) throw new Error("That purchase has gone");
    const at = nowIso();
    const next: Purchase = {
      ...p,
      status,
      status_at: at,
      delivered_at: status === "delivered" ? at : p.delivered_at,
      updated_at: at,
      updates: [...p.updates, { id: crypto.randomUUID(), status, at, detail: "Marked by you", email_link: "" }],
    };
    await sampleWrite(`purchase:${id}`, next);
    emit("purchase");
    return next;
  }
  const saved = await online(() => api.setPurchaseStatus(id, status));
  emit("purchase");
  return saved;
}

/** Archive or restore a trip, one booking, or a purchase. */
export async function setLogisticsArchived(kind: LogisticsKind, id: string, archived: boolean): Promise<void> {
  if (isSampleMode()) {
    const stamp = archived ? nowIso() : null;
    if (kind === "purchase") {
      const p = (await sampleAllPurchases()).find((x) => x.id === id);
      if (p) await sampleWrite(`purchase:${id}`, { ...p, archived_at: stamp });
    } else {
      const trips = await sampleAllTrips();
      const trip = kind === "trip" ? trips.find((t) => t.id === id) : trips.find((t) => t.bookings.some((b) => b.id === id));
      if (trip) {
        const next =
          kind === "trip"
            ? { ...trip, archived_at: stamp }
            : { ...trip, bookings: trip.bookings.map((b): Booking => (b.id === id ? { ...b, archived_at: stamp } : b)) };
        await sampleWrite(`trip:${trip.id}`, next);
      }
    }
    emit(kind === "purchase" ? "purchase" : "trip");
    return;
  }
  await online(() => api.setArchived(kind, id, archived));
  emit(kind === "purchase" ? "purchase" : "trip");
}

/** Permanent delete: the Archived page's confirmed action only. */
export async function deleteLogisticsForever(kind: LogisticsKind, id: string): Promise<void> {
  if (isSampleMode()) {
    const gone = await deleted();
    gone.add(`${kind}:${id}`);
    await setMeta(DELETED, JSON.stringify([...gone]));
    emit(kind === "purchase" ? "purchase" : "trip");
    return;
  }
  await online(() => api.deleteEntity(kind, id));
  emit(kind === "purchase" ? "purchase" : "trip");
}

/** Archived trips, bookings and purchases in sample mode (the server's Archived list already includes them). */
export async function sampleArchivedLogistics(): Promise<ArchivedItem[]> {
  const out: ArchivedItem[] = [];
  for (const t of await sampleAllTrips()) {
    if (t.archived_at) out.push({ kind: "trip", id: t.id, title: t.title, archived_at: t.archived_at });
    for (const b of t.bookings) if (b.archived_at) out.push({ kind: "booking", id: b.id, title: b.title, archived_at: b.archived_at });
  }
  for (const p of await sampleAllPurchases()) {
    if (p.archived_at) out.push({ kind: "purchase", id: p.id, title: purchaseName(p), archived_at: p.archived_at });
  }
  return out;
}
