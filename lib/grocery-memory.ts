/**
 * What the grocery list remembers (migration 0096; the reasoning is pure, in
 * lib/grocery-usuals.ts):
 *
 *  - "Done shopping" files the ticked lines as one shop (grocery_trips and
 *    grocery_bought) instead of deleting them, with the order the aisles were
 *    ticked in when the ticks look like a walk round a shop. "Undo" puts the
 *    lines back, ticked.
 *  - From those shops: the usuals due now, offered at the top of the list,
 *    and the aisles in the owner's own order.
 *  - A usual can be skipped until it's next due, and Settings → Recipes can
 *    forget every shop.
 *
 * Sealed (ENCRYPTED in lib/encryption.ts): what was bought, and what a skip
 * is for. Readable: dates, amounts, units, aisles and counts. Nothing here
 * calls a model.
 */
import { AthenaInputError, getOwnerTimeZone, q, qRaw, sealer, tx } from "./db";
import { zonedParts, zonedToday } from "./dates";
import { dueUsuals, learnedOrder, learnUsuals, skipUntil, walkOrder, type BoughtEntry, type Usual } from "./grocery-usuals";
import { itemKey } from "./recipe-units";
import type { Aisle } from "./grocery";

/** How far back usuals look. A year and a bit: enough for a habit, not every shop ever. */
const LOOK_BACK_DAYS = 400;
const MAX_ROWS = 4000;
/** A shop said to be done offline may arrive late; anything older than this is filed as now. */
const LATE_MS = 3 * 86_400_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const amount = (n: unknown) => (n === null || n === undefined ? null : Math.round(Number(n) * 10_000) / 10_000);

export interface ShopDone {
  /** The shop's id, for Undo. Null when nothing was ticked. */
  trip_id: string | null;
  count: number;
}

/** When the owner said they were done: their own time when it's believable, else now. */
function doneAt(raw: unknown, now: number): Date {
  if (typeof raw !== "string") return new Date(now);
  const t = Date.parse(raw);
  return Number.isFinite(t) && t <= now + 60_000 && t >= now - LATE_MS ? new Date(t) : new Date(now);
}

/** File the ticked lines as a shop and take them off the list. */
export async function finishShopping(raw: unknown = {}, now = Date.now()): Promise<ShopDone> {
  const b = (raw && typeof raw === "object" ? raw : {}) as { at?: unknown };
  const at = doneAt(b.at, now);
  const s = await sealer();
  return tx(async (run) => {
    const rows = await run<{ id: string; item: string; quantity: string | null; unit: string | null; aisle: string; recipe_ids: string[] | null; own: boolean; ticked_at: Date | string }>(
      `SELECT id, item, quantity, unit, aisle, recipe_ids, own, ticked_at FROM grocery_items WHERE ticked_at IS NOT NULL ORDER BY ticked_at, id FOR UPDATE`,
    );
    if (!rows.length) return { trip_id: null, count: 0 };
    const order = walkOrder(rows.map((r) => ({ aisle: r.aisle, at: new Date(r.ticked_at).getTime() })));
    const [trip] = await run<{ id: string }>(`INSERT INTO grocery_trips (done_at, item_count, aisle_order) VALUES ($1, $2, $3::text[]) RETURNING id`, [at, rows.length, order]);
    for (const r of rows) {
      await run(
        `INSERT INTO grocery_bought (trip_id, item, quantity, unit, aisle, recipe_ids, own, ticked_at, bought_at) VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9)`,
        [trip.id, s.text(r.item), amount(r.quantity), r.unit, r.aisle, r.recipe_ids ?? [], r.own, r.ticked_at, at],
      );
    }
    await run(`DELETE FROM grocery_items WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
    return { trip_id: trip.id, count: rows.length };
  });
}

/** Undo "Done shopping": the shop's lines go back on the list, ticked, and the shop is forgotten. */
export async function undoShopping(tripId: string): Promise<boolean> {
  if (!UUID_RE.test(tripId)) return false;
  const s = await sealer();
  return tx(async (run) => {
    const rows = await run<{ item: string; quantity: string | null; unit: string | null; aisle: string; recipe_ids: string[] | null; own: boolean; ticked_at: Date | string | null; bought_at: Date | string }>(
      `SELECT item, quantity, unit, aisle, recipe_ids, own, ticked_at, bought_at FROM grocery_bought WHERE trip_id = $1 ORDER BY created_at, id`,
      [tripId],
    );
    const gone = await run<{ id: string }>(`DELETE FROM grocery_trips WHERE id = $1 RETURNING id`, [tripId]);
    if (!gone.length) return false;
    for (const r of rows) {
      await run(`INSERT INTO grocery_items (item, quantity, unit, aisle, recipe_ids, own, ticked_at) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)`, [
        s.text(r.item),
        amount(r.quantity),
        r.unit,
        r.aisle,
        r.recipe_ids ?? [],
        r.own,
        // Each line as it was ticked, so filing the shop again still sees the walk round it.
        r.ticked_at ?? r.bought_at,
      ]);
    }
    return true;
  });
}

/** Shops within the look-back, as the reasoning reads them. */
async function boughtLately(tz: string): Promise<BoughtEntry[]> {
  const rows = await q<{ item: string; quantity: string | null; unit: string | null; aisle: string; bought_at: Date | string }>(
    `SELECT item, quantity, unit, aisle, bought_at FROM grocery_bought WHERE bought_at > now() - ($1 || ' days')::interval ORDER BY bought_at DESC LIMIT $2`,
    [String(LOOK_BACK_DAYS), MAX_ROWS],
  );
  return rows.map((r) => ({ item: r.item, quantity: amount(r.quantity), unit: r.unit, aisle: r.aisle, day: zonedParts(new Date(r.bought_at), tz).date }));
}

async function skipsFrom(today: string): Promise<Array<{ item: string; until: string }>> {
  return q<{ item: string; until: string }>(`SELECT item, to_char(until, 'YYYY-MM-DD') AS until FROM grocery_skips WHERE until > $1::date`, [today]);
}

/**
 * Past shops as last read, kept while nothing about them changes: a tick or a
 * new line changes nothing here, so the list answers without opening every
 * past shop again. The mark is counts and times only; a shop filed, undone or
 * forgotten, or a usual skipped, moves it (from any device or function).
 */
let memo: { mark: string; bought: BoughtEntry[]; skipped: Array<{ item: string; until: string }>; order: Aisle[] | null } | null = null;

async function pastShops(tz: string, today: string) {
  const [{ mark }] = await q<{ mark: string }>(
    `SELECT concat_ws('|', (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM grocery_trips), (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') FROM grocery_skips)) AS mark`,
  );
  const key = `${today}|${tz}|${mark}`;
  if (memo?.mark === key) return memo;
  const [bought, skipped, walks] = await Promise.all([
    boughtLately(tz),
    skipsFrom(today),
    q<{ aisle_order: string[] }>(`SELECT aisle_order FROM grocery_trips WHERE cardinality(aisle_order) > 0 ORDER BY done_at DESC LIMIT 6`),
  ]);
  memo = { mark: key, bought, skipped, order: learnedOrder(walks.map((w) => w.aisle_order)) };
  return memo;
}

/** What the list shows beside its lines: usuals due now and the owner's aisle order. */
export async function groceryMemory(onList: string[], opts: { usuals?: boolean } = {}): Promise<{ usuals: Usual[]; order: Aisle[] | null }> {
  const tz = await getOwnerTimeZone();
  const today = zonedToday(new Date(), tz);
  const past = await pastShops(tz, today);
  return {
    usuals: opts.usuals === false ? [] : dueUsuals(past.bought, { today, onList, skipped: past.skipped }),
    order: past.order,
  };
}

/** "Not this time": the usual isn't offered again until it would next be due. */
export async function skipUsual(raw: unknown): Promise<{ until: string }> {
  const item = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!item || item.length > 200) throw new AthenaInputError("item: the usual to skip, up to 200 characters");
  const tz = await getOwnerTimeZone();
  const today = zonedToday(new Date(), tz);
  const usual = learnUsuals(await boughtLately(tz), today).find((u) => u.key === itemKey(item));
  const until = skipUntil({ every: usual?.every ?? 7 }, today);
  const s = await sealer();
  await qRaw(`DELETE FROM grocery_skips WHERE until <= $1::date`, [today]);
  await qRaw(`INSERT INTO grocery_skips (item, until) VALUES ($1, $2::date)`, [s.text(item), until]);
  return { until };
}

/** Settings → Recipes: how many shops the list remembers. */
export async function groceryHistory(): Promise<{ shops: number; since: string | null }> {
  const [row] = await q<{ shops: string; first: Date | string | null }>(`SELECT count(*)::text AS shops, min(done_at) AS first FROM grocery_trips`);
  // The first shop's date where the owner is, not the database's UTC.
  const since = row?.first ? zonedParts(new Date(row.first), await getOwnerTimeZone()).date : null;
  return { shops: Number(row?.shops ?? 0), since };
}

/** Forget every shop, and every skip with them. The list itself stays. */
export async function forgetGroceryHistory(): Promise<{ shops: number }> {
  return tx(async (run) => {
    const gone = await run<{ id: string }>(`DELETE FROM grocery_trips RETURNING id`);
    await run(`DELETE FROM grocery_bought`);
    await run(`DELETE FROM grocery_skips`);
    return { shops: gone.length };
  });
}
