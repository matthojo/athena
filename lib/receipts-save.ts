/**
 * Saving a ride or takeaway receipt (lib/receipts.ts) from the email
 * collection's athena_receipt tool (netlify/lib/connectors/runner.ts).
 *
 * One receipt writes:
 *  - a Day entry ("other", source = the service, external_id = the receipt's
 *    ref), through writeEntries, so the same receipt again updates it;
 *  - for a food order, a purchase (retailer = the restaurant, order number =
 *    the ref, dishes, no prices), through savePurchase, so the on-its-way and
 *    delivered emails move the same purchase along;
 *  - the fare or total, sealed: one sensitive_blobs row per day, domain
 *    'finance', source 'receipts', keyed inside by service and ref. Not
 *    domain 'money': lib/money.ts reads every money row as a bank's day, and
 *    the bank feed already counts this spend.
 *  - a ride's pick-up and drop-off addresses and the Places they are, sealed:
 *    one row per day, domain 'location', source 'rides'. lib/places-visits.ts
 *    reads its own sources by name ('timeline', 'swarm', 'day'), so this row
 *    sits beside them untouched; after a key rotation the backfill re-seals
 *    both with every other day row (lib/encryption.ts ENCRYPTED).
 *
 * Labels say the day and what it is, never an amount or a place.
 */

import { openStrict, sealText } from "./data-box";
import { zonedToInstant } from "./dates";
import type { EntryInput, WriteContext, WriteResult } from "./days";
import type { PurchaseInput, SavedPurchase } from "./trips";
import { foodEntry, foodPurchase, parseReceipt, rideEntry, sealedAmount, sealedRide, SERVICE_NAME, type PlaceRef, type Receipt, type ReceiptEmail } from "./receipts";

export const AMOUNTS_DOMAIN = "finance";
export const AMOUNTS_SOURCE = "receipts";
export const RIDES_DOMAIN = "location";
export const RIDES_SOURCE = "rides";

type SealedDomain = typeof AMOUNTS_DOMAIN | typeof RIDES_DOMAIN;

/** Where a receipt is written. The database by default (dbStore); tests pass their own. */
export interface ReceiptStore {
  places(): Promise<PlaceRef[]>;
  writeEntries(items: Array<{ date: string; entry: EntryInput }>, ctx: WriteContext): Promise<WriteResult>;
  savePurchase(input: PurchaseInput): Promise<SavedPurchase>;
  readSealed(domain: SealedDomain, source: string, day: string): Promise<string | null>;
  writeSealed(row: { domain: SealedDomain; source: string; day: string; label: string; ciphertext: string; recordedAt: string }): Promise<void>;
}

export interface ReceiptResult {
  action: "saved" | "not_a_receipt";
  /** "ride" or "food". */
  type?: Receipt["type"];
  service?: string;
  day?: string;
  /** What the day shows: the entry's title and subtitle. */
  entry?: { title: string; subtitle?: string; action: "created" | "updated" | "unchanged" | "skipped" };
  purchase?: { id: string; action: SavedPurchase["action"]; status: string };
  /** Whether the amount and the ride's addresses went to their sealed rows ("unchanged" when already there). */
  sealed: { amount: "saved" | "unchanged" | "none"; places: "saved" | "unchanged" | "none" };
}

/** Add or replace one keyed value in a day's sealed record. False when it's already there as it is. */
async function sealInto(store: ReceiptStore, domain: SealedDomain, source: string, label: string, day: string, key: string, value: unknown, tz: string): Promise<boolean> {
  const prev = await store.readSealed(domain, source, day);
  let record: Record<string, unknown> = {};
  if (prev) {
    // A row that won't open is left alone rather than overwritten with a guess.
    record = JSON.parse(openStrict(prev)) as Record<string, unknown>;
  }
  if (JSON.stringify(record[key]) === JSON.stringify(value)) return false;
  record[key] = value;
  await store.writeSealed({ domain, source, day, label, ciphertext: sealText(JSON.stringify(record)), recordedAt: zonedToInstant(day, "12:00", tz).toISOString() });
  return true;
}

/**
 * Read one email and, if it's a ride or takeaway receipt, save it.
 * `source` is the collection's source ("email-digest-personal"); the entry's
 * source is the service, so the day says "Uber", not the collection.
 */
export async function saveReceipt(
  email: ReceiptEmail,
  opts: { tz: string; source: string; sourceRef: string; runId?: string; store?: ReceiptStore },
): Promise<ReceiptResult> {
  const r = parseReceipt(email, { tz: opts.tz });
  if (!r) return { action: "not_a_receipt", sealed: { amount: "none", places: "none" } };
  const store = opts.store ?? (await dbStore());
  const places = r.type === "ride" ? await store.places() : [];
  const out: ReceiptResult = { action: "saved", type: r.type, service: SERVICE_NAME[r.service], day: r.day, sealed: { amount: "none", places: "none" } };

  // Sealed first: if the key is missing this throws before anything readable is written without its figure.
  const amount = sealedAmount(r);
  if (amount) out.sealed.amount = (await sealInto(store, AMOUNTS_DOMAIN, AMOUNTS_SOURCE, `Receipts · ${r.day}`, r.day, amount.key, amount.value, opts.tz)) ? "saved" : "unchanged";
  if (r.type === "ride") {
    const ends = sealedRide(r, places);
    if (ends) out.sealed.places = (await sealInto(store, RIDES_DOMAIN, RIDES_SOURCE, `Rides · ${r.day}`, r.day, ends.key, ends.value, opts.tz)) ? "saved" : "unchanged";
  }

  // A takeaway's on-its-way and delivered emails don't list the dishes: the day keeps the order's line.
  const entry = r.type === "ride" ? rideEntry(r, places, opts.tz) : r.items.length ? foodEntry(r, opts.tz) : null;
  if (entry) {
    const w = await store.writeEntries([{ date: r.day, entry }], { collection: opts.source, ...(opts.runId ? { runId: opts.runId } : {}) });
    const action = w.created ? "created" : w.updated ? "updated" : w.skipped ? "skipped" : "unchanged";
    out.entry = { title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), action };
  }
  if (r.type === "food") {
    const saved = await store.savePurchase({ ...foodPurchase(r, email), source: opts.source, source_ref: opts.sourceRef, confidence: 1 });
    if (saved.purchase) out.purchase = { id: saved.purchase.id, action: saved.action, status: saved.purchase.status };
    else out.purchase = { id: "", action: saved.action, status: r.status };
  }
  return out;
}

/** The database: Places from the Library, entries and purchases through their own modules, sealed rows by (domain, source, day). */
export async function dbStore(): Promise<ReceiptStore> {
  const [{ listPlaces, qRaw }, days, trips] = await Promise.all([import("./db"), import("./days"), import("./trips")]);
  return {
    places: async () => (await listPlaces(500)).map((p) => ({ id: p.id, name: p.name, address: p.address || undefined })),
    writeEntries: (items, ctx) => days.writeEntries(items, ctx),
    savePurchase: (input) => trips.savePurchase(input),
    readSealed: async (domain, source, day) => {
      const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = $1 AND source = $2 AND day = $3::date`, [domain, source, day]);
      return row?.ciphertext ?? null;
    },
    writeSealed: async (row) => {
      await qRaw(
        `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
         VALUES ($1, $2, $3, $4::timestamptz, $5::date, $6)
         ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, label = EXCLUDED.label, recorded_at = EXCLUDED.recorded_at`,
        [row.domain, row.label, row.ciphertext, row.recordedAt, row.day, row.source],
      );
    },
  };
}
