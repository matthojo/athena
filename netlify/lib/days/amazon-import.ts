/**
 * The Amazon data export, into Purchases, Days and Watch & read. The app
 * reads the zip on the device (lib/amazon-export.ts) and sends it here in
 * parts, each safe to repeat:
 *
 *  - GET  /api/days/import/amazon     { collection, source, last_import }
 *  - POST /api/days/import/amazon     { part: "orders", orders, file }
 *        Each order through savePurchase (retailer Amazon, source
 *        amazon_export, the order id as order number and source_ref), so an
 *        order an email already saved is the same purchase: its item names
 *        are filled in, an item that went back reads "(returned)". An order
 *        that settled and was put away stays away. Prices never go on the
 *        purchase: they're sealed with finance, one row per order day
 *        (sensitive_blobs, domain finance, source amazon), and dropped when
 *        there's no data key.
 *  - POST … { part: "media", days, file }
 *        Kindle (read), Audible (listened) and Prime Video (watched) as Day
 *        entries through importToDays, ids from lib/day-imports.ts.
 *  - POST … { part: "finished", finished }
 *        Books the export says were finished, into Watch & read as read
 *        (lib/watch-read-sync.ts: a status the owner set stays).
 *  - POST … { part: "undo", entries, purchases, watch_read, finance }
 *        What this import created, archived: entries hidden, purchases and
 *        Watch & read items archived, and finance rows it made removed.
 *
 * Every create reports its ids so the app can offer Undo. Nothing here logs
 * an amount or a title.
 */
import { AthenaInputError, archiveEntity, qRaw } from "../../../lib/db";
import { dataKeyConfigured, openStrict, sealText } from "../../../lib/data-box";
import { isValidDate, zonedToInstant } from "../../../lib/dates";
import { extKeys, touchDays } from "../../../lib/days";
import { savePurchase } from "../../../lib/trips";
import { syncWatchRead, type WatchReadInput } from "../../../lib/watch-read-sync";
import { AMAZON_SOURCES, amazonEntries } from "../../../lib/day-imports";
import { itemLabel, ORDERS_PER_REQUEST, type AmazonOrder, type FinishedTitle, type MediaDay, type MediaItem, type MediaSource, type OrderItem, type OrderStatus } from "../../../lib/amazon-export";
import { importToDays, lastImport, rememberImport, type FoldResult } from "../connectors/youtube-history";
import { importTarget } from "./import-routes";

export const AMAZON_MEMO = "file-amazon";
export const SOURCE = "amazon_export";
const MAX_DAYS = 120;
const MAX_ITEMS = 600;
const MAX_FINISHED = 2000;
const MAX_UNDO = 5000;

type Json = (data: unknown, status?: number) => Response;

const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const KEY = /^[\p{L}\p{N}_:.-]{1,160}$/u;
const ORDER = /^[A-Za-z0-9-]{3,60}$/;
const STATUSES: readonly OrderStatus[] = ["ordered", "dispatched", "delivered", "cancelled", "returned"];
const SOURCES: readonly string[] = AMAZON_SOURCES;
const day = (v: unknown) => (typeof v === "string" && isValidDate(v) ? v : undefined);

// ---------- Reading what the app sends ----------

export function readOrders(raw: unknown): AmazonOrder[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("orders: send at least one");
  if (raw.length > ORDERS_PER_REQUEST) throw new AthenaInputError(`orders: at most ${ORDERS_PER_REQUEST} per request`);
  return raw.map((x): AmazonOrder => {
    const o = (x ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!ORDER.test(id)) throw new AthenaInputError("orders: each needs its order id");
    const d = day(o.day);
    if (!d) throw new AthenaInputError(`orders: ${id} needs a day (YYYY-MM-DD)`);
    const status = STATUSES.find((s) => s === o.status);
    if (!status) throw new AthenaInputError(`orders: ${id} has no status`);
    const at = typeof o.statusAt === "string" && !Number.isNaN(Date.parse(o.statusAt)) ? new Date(o.statusAt).toISOString() : `${d}T12:00:00.000Z`;
    if (!Array.isArray(o.items) || !o.items.length || o.items.length > 60) throw new AthenaInputError(`orders: ${id} needs its items`);
    const items = o.items.map((i): OrderItem => {
      const it = (i ?? {}) as Record<string, unknown>;
      const name = str(it.name, 300);
      const key = typeof it.key === "string" && KEY.test(it.key) ? it.key : "";
      if (!name || !key) throw new AthenaInputError(`orders: ${id} has an item without a name`);
      const quantity = typeof it.quantity === "number" && Number.isInteger(it.quantity) && it.quantity > 0 ? Math.min(it.quantity, 999) : 1;
      const p = (it.price ?? null) as { amount?: unknown; currency?: unknown } | null;
      const price =
        p && typeof p.amount === "number" && Number.isFinite(p.amount) && Math.abs(p.amount) < 1e7
          ? { amount: Math.round(p.amount * 100) / 100, currency: typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency) ? p.currency : "" }
          : undefined;
      return { key, name, quantity, ...(price ? { price } : {}), ...(it.returned === true ? { returned: true } : {}) };
    });
    return {
      id,
      day: d,
      status,
      statusAt: at,
      items,
      ...(o.digital === true ? { digital: true } : {}),
      ...(o.partReturned === true ? { partReturned: true } : {}),
    };
  });
}

export function readMediaDays(raw: unknown): MediaDay[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("days: send at least one day");
  if (raw.length > MAX_DAYS) throw new AthenaInputError(`days: at most ${MAX_DAYS} per request`);
  const seen = new Set<string>();
  let total = 0;
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const d = day(o.day);
    if (!d) throw new AthenaInputError("days: each needs a day (YYYY-MM-DD)");
    if (seen.has(d)) throw new AthenaInputError(`days: ${d} is in this request twice`);
    seen.add(d);
    if (!Array.isArray(o.items) || !o.items.length) throw new AthenaInputError(`days: ${d} has nothing in it`);
    total += o.items.length;
    if (total > MAX_ITEMS) throw new AthenaInputError(`days: at most ${MAX_ITEMS} items per request`);
    return {
      day: d,
      items: o.items.map((i): MediaItem => {
        const it = (i ?? {}) as Record<string, unknown>;
        const source = SOURCES.includes(it.source as string) ? (it.source as MediaSource) : null;
        const key = typeof it.key === "string" && KEY.test(it.key) ? it.key : "";
        const title = str(it.title, 300);
        if (!source || !key || !title) throw new AthenaInputError(`days: ${d} has something without a source, id or title`);
        const subtitle = str(it.subtitle, 200);
        const minutes = typeof it.minutes === "number" && Number.isFinite(it.minutes) && it.minutes >= 1 && it.minutes <= 1440 ? Math.round(it.minutes) : undefined;
        return { source, key, title, ...(subtitle ? { subtitle } : {}), ...(minutes ? { minutes } : {}), ...(it.show === true ? { show: true } : {}) };
      }),
    };
  });
}

export function readFinished(raw: unknown): FinishedTitle[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("finished: send at least one");
  if (raw.length > MAX_FINISHED) throw new AthenaInputError(`finished: at most ${MAX_FINISHED} per request`);
  return raw.map((x): FinishedTitle => {
    const o = (x ?? {}) as Record<string, unknown>;
    const source = o.source === "kindle" || o.source === "audible" ? o.source : null;
    const asin = typeof o.asin === "string" && /^[A-Z0-9]{6,20}$/.test(o.asin) ? o.asin : "";
    const title = str(o.title, 300);
    if (!source || !asin || !title) throw new AthenaInputError("finished: each needs its source, ASIN and title");
    const author = str(o.author, 120);
    const d = day(o.day);
    return { source, asin, title, ...(author ? { author } : {}), ...(d ? { day: d } : {}) };
  });
}

// ---------- Orders ----------

export interface OrdersResult {
  created: number;
  /** Orders Athena already had (from an email, or this export before): filled in where something was missing. */
  existing: number;
  /** Orders you'd archived, or that settled and were put away: left alone. */
  skipped: number;
  /** Order days whose prices were sealed with finance. */
  prices_sealed: number;
  /** For Undo. */
  ids: { purchases: string[]; finance: string[] };
}

interface SealedDay {
  orders: Record<string, { digital?: boolean; items: Record<string, { name: string; quantity: number; amount: number; currency: string; returned?: boolean }> }>;
}

/** One sealed finance row per order day: what each item cost. Returns the days it made new. */
async function sealPrices(orders: AmazonOrder[]): Promise<{ sealed: number; created: string[] }> {
  const priced = orders.filter((o) => o.items.some((i) => i.price));
  if (!priced.length || !dataKeyConfigured()) return { sealed: 0, created: [] };
  const byDay = new Map<string, AmazonOrder[]>();
  for (const o of priced) byDay.set(o.day, [...(byDay.get(o.day) ?? []), o]);
  const created: string[] = [];
  let sealed = 0;
  for (const [d, list] of byDay) {
    const [prev] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'finance' AND source = 'amazon' AND day = $1::date`, [d]);
    let value: SealedDay = { orders: {} };
    if (prev) {
      try {
        value = JSON.parse(openStrict(prev.ciphertext)) as SealedDay;
      } catch {
        // A row that won't open is left as it is, never overwritten.
        continue;
      }
    }
    const before = JSON.stringify(value);
    for (const o of list) {
      const entry = (value.orders[o.id] ??= { ...(o.digital ? { digital: true } : {}), items: {} });
      for (const i of o.items) if (i.price) entry.items[i.key] = { name: i.name, quantity: i.quantity, amount: i.price.amount, currency: i.price.currency, ...(i.returned ? { returned: true } : {}) };
    }
    if (JSON.stringify(value) === before) continue;
    await qRaw(
      `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
       VALUES ('finance', $1, $2, $3::timestamptz, $4::date, 'amazon')
       ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, recorded_at = EXCLUDED.recorded_at`,
      [`Amazon orders · ${d}`, sealText(JSON.stringify(value)), zonedToInstant(d, "12:00", "UTC").toISOString(), d],
    );
    if (!prev) created.push(d);
    sealed++;
  }
  return { sealed, created };
}

const DETAIL = (o: AmazonOrder) => (o.digital ? "Digital order, from your Amazon export" : o.partReturned ? "Part of this order went back" : "From your Amazon export");

export async function importOrders(orders: AmazonOrder[]): Promise<OrdersResult> {
  const out: OrdersResult = { created: 0, existing: 0, skipped: 0, prices_sealed: 0, ids: { purchases: [], finance: [] } };
  for (const o of orders) {
    const saved = await savePurchase(
      {
        retailer: "Amazon",
        order_number: o.id,
        items: o.items.map(itemLabel),
        ordered_on: o.day,
        status: o.status,
        status_at: o.statusAt,
        detail: DETAIL(o),
        source: SOURCE,
        source_ref: o.id,
        confidence: 1,
      },
      { keepArchived: true },
    );
    if (saved.action === "created" && saved.purchase) {
      out.created++;
      out.ids.purchases.push(saved.purchase.id);
    } else if (saved.action === "skipped") out.skipped++;
    else out.existing++;
  }
  const prices = await sealPrices(orders);
  out.prices_sealed = prices.sealed;
  out.ids.finance = prices.created;
  return out;
}

// ---------- Kindle, Audible, Prime Video ----------

export interface MediaResult extends FoldResult {
  added: number;
  /** Entries added, per source. */
  by_source: Record<MediaSource, number>;
  /** Days that gained one, per source (batches are whole days, so these add up across requests). */
  days_by_source: Record<MediaSource, number>;
  ids: { entries: Array<{ source: MediaSource; external_id: string }> };
}

export async function importMedia(days: MediaDay[], opts: { now?: Date } = {}): Promise<MediaResult> {
  const target = await importTarget();
  const { outcomes, ...fold } = await importToDays(target, days, amazonEntries, { metric: null, from: "import-amazon", now: opts.now });
  const created = outcomes.filter((o) => o.action === "created");
  const by_source: Record<MediaSource, number> = { kindle: 0, audible: 0, prime_video: 0 };
  const perDay: Record<MediaSource, Set<string>> = { kindle: new Set(), audible: new Set(), prime_video: new Set() };
  for (const c of created) {
    by_source[c.entry.source as MediaSource]++;
    perDay[c.entry.source as MediaSource].add(c.day);
  }
  const days_by_source: Record<MediaSource, number> = { kindle: perDay.kindle.size, audible: perDay.audible.size, prime_video: perDay.prime_video.size };
  return { ...fold, added: created.length, by_source, days_by_source, ids: { entries: created.map((c) => ({ source: c.entry.source as MediaSource, external_id: c.entry.external_id })) } };
}

export interface FinishedResult {
  created: number;
  updated: number;
  ids: { watch_read: string[] };
}

export async function importFinished(list: FinishedTitle[], opts: { now?: Date } = {}): Promise<FinishedResult> {
  const target = await importTarget();
  const inputs: WatchReadInput[] = list.map((f) => ({
    kind: "book",
    title: f.title,
    ...(f.author ? { maker: f.author } : {}),
    status: "done",
    ...(f.day ? { at: f.day } : {}),
    external_id: `${f.source}:${f.asin}`,
    source: f.source,
  }));
  const synced = await syncWatchRead(inputs, { collection: target.source, now: opts.now });
  const made = synced.filter((s) => s.action === "created");
  return { created: made.length, updated: synced.filter((s) => s.action === "updated").length, ids: { watch_read: made.map((s) => s.id).filter((id): id is string => !!id) } };
}

// ---------- Undo ----------

export interface UndoResult {
  entries: number;
  purchases: number;
  watch_read: number;
  finance: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** Archive what one import created. Entries are hidden (a later import leaves them hidden). */
export async function undoImport(raw: Record<string, unknown>): Promise<UndoResult> {
  const entries = list(raw.entries)
    .map((e) => (e ?? {}) as { source?: unknown; external_id?: unknown })
    .filter((e): e is { source: MediaSource; external_id: string } => SOURCES.includes(e.source as string) && typeof e.external_id === "string" && KEY.test(e.external_id));
  const purchases = list(raw.purchases).filter((id): id is string => typeof id === "string" && UUID.test(id));
  const watch = list(raw.watch_read).filter((id): id is string => typeof id === "string" && UUID.test(id));
  const finance = list(raw.finance).filter((d): d is string => typeof d === "string" && isValidDate(d));
  if (entries.length + purchases.length + watch.length + finance.length > MAX_UNDO) throw new AthenaInputError(`undo: at most ${MAX_UNDO} per request`);
  const out: UndoResult = { entries: 0, purchases: 0, watch_read: 0, finance: 0 };
  const touched = new Set<string>();
  for (const s of AMAZON_SOURCES) {
    const keys = entries.filter((e) => e.source === s).flatMap((e) => extKeys(s, e.external_id));
    if (!keys.length) continue;
    const rows = await qRaw<{ date: string }>(
      `UPDATE day_entries SET archived_at = now(), updated_at = now() WHERE source = $1 AND ext_key = ANY($2::text[]) AND archived_at IS NULL RETURNING to_char(date, 'YYYY-MM-DD') AS date`,
      [s, keys],
    );
    out.entries += rows.length;
    for (const r of rows) touched.add(r.date);
  }
  if (touched.size) await touchDays([...touched]);
  for (const id of purchases) if (await archiveEntity("purchase", id)) out.purchases++;
  for (const id of watch) if (await archiveEntity("reading", id)) out.watch_read++;
  if (finance.length) {
    const gone = await qRaw<{ id: string }>(`DELETE FROM sensitive_blobs WHERE domain = 'finance' AND source = 'amazon' AND day = ANY($1::date[]) RETURNING id`, [finance]);
    out.finance = gone.length;
  }
  return out;
}

// ---------- Route ----------

/** /api/days/import/amazon, from handleImportRoutes. */
export async function handleAmazonImport(req: Request, body: () => Promise<Record<string, unknown>>, json: Json): Promise<Response> {
  if (req.method === "GET") {
    const target = await importTarget();
    return json({ collection: target.collection, source: target.source, last_import: await lastImport(AMAZON_MEMO) });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await body();
  switch (b.part) {
    case "orders": {
      const r = await importOrders(readOrders(b.orders));
      await rememberImport(AMAZON_MEMO, b.file);
      return json(r);
    }
    case "media": {
      const r = await importMedia(readMediaDays(b.days));
      await rememberImport(AMAZON_MEMO, b.file);
      return json(r);
    }
    case "finished":
      return json(await importFinished(readFinished(b.finished)));
    case "undo":
      return json(await undoImport(b));
    default:
      throw new AthenaInputError("part: one of orders, media, finished, undo");
  }
}
