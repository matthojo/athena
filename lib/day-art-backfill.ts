/**
 * The art backfill: on each collect tick (netlify/functions/collect.ts), a few
 * Days entries without art get it, within a budget. It covers old Life log
 * entries converted into Days, and anything attachDayArt didn't reach while a
 * run saved its entries.
 *
 * The store is the Days entries table (migration 0032), through lib/days.ts's
 * `entriesWithoutArt` and `setEntryArt`. Each tick first runs the one-off
 * `repairEntryLinks` (a no-op once done), which turns links written into an
 * entry's words into its url.
 */
import { dataKeyConfigured } from "./data-box";
import { qRaw } from "./db";
import { entriesWithoutArt, repairEntryLinks, setEntryArt } from "./days";
import { fillDayArt, type DayArtStore, type FillResult } from "./art";

/** The Days store: lib/days.ts's own queries (only kinds that ever get art, never places). */
export const daysStore: DayArtStore = { entriesWithoutArt, setEntryArt };

/** Default per tick: scheduled functions get 30 seconds, and claiming collections takes well under one. */
export const BACKFILL_BUDGET_MS = 12_000;

/** One tick's worth. Never throws; quiet when there's nothing to do. */
export async function backfillDayArt(opts: { budgetMs?: number; store?: DayArtStore } = {}): Promise<FillResult | null> {
  if (!dataKeyConfigured()) return null;
  try {
    // Is there a Days table yet? (Not before claude/days-data is merged.)
    const [has] = await qRaw<{ t: string | null }>(`SELECT to_regclass('day_entries')::text AS t`);
    if (!has?.t && !opts.store) return null;
  } catch {
    return null;
  }
  // One-off, before the art: entries whose link was written into their words get it as url, so art is found by it.
  if (!opts.store) await repairEntryLinks().catch((error) => console.warn("Athena days: link repair failed", error));
  const result = await fillDayArt(opts.store ?? daysStore, { budgetMs: opts.budgetMs ?? BACKFILL_BUDGET_MS, limit: 400 });
  if (result.found) console.log(`Athena art: ${result.found} day ${result.found === 1 ? "entry" : "entries"} got art`);
  return result;
}
