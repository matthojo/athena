/**
 * Dollars into the owner's own currency, for AI spend (lib/spend.ts). Prices are published in dollars
 * (lib/model-prices.ts); the owner reads and sets their budget in the currency their profile's Region names.
 *
 * The rates come once a day from a free service that needs no key (open.er-api.com, which updates daily) and are
 * kept in the plain `settings` row `fx_rate`. When the service can't be reached, the last rates are used and
 * marked stale after two days; a failed fetch isn't tried again for an hour. Nothing here throws.
 */
import { qRaw } from "./db";

export const FX_KEY = "fx_rate";
export const FX_URL = "https://open.er-api.com/v6/latest/USD";

/** Older than this, a rate is shown with its date ("Rate from 14 Nov"). */
export const STALE_MS = 48 * 3_600_000;
const RETRY_MS = 3_600_000;

/** The `fx_rate` row: units of each currency to one dollar. */
export interface FxRow {
  rates: Record<string, number>;
  /** When these rates were fetched (ISO). */
  fetched_at: string;
  /** When a fetch last failed (ISO), so a dead service is asked once an hour at most. */
  failed_at?: string;
}

/** A rate the app can show: units of `currency` to $1, when it was fetched, and whether that's old. */
export interface Rate {
  currency: string;
  value: number;
  as_of: string;
  stale: boolean;
}

const DOLLAR: Omit<Rate, "as_of"> = { currency: "USD", value: 1, stale: false };

/** The service's answer, read: only three-letter codes with positive finite rates. Null for anything else. */
export function readRates(body: unknown): Record<string, number> | null {
  const b = body as { result?: unknown; base_code?: unknown; rates?: unknown } | null;
  if (!b || b.result !== "success" || b.base_code !== "USD" || !b.rates || typeof b.rates !== "object") return null;
  const out: Record<string, number> = {};
  for (const [code, v] of Object.entries(b.rates as Record<string, unknown>)) {
    if (/^[A-Z]{3}$/.test(code) && typeof v === "number" && Number.isFinite(v) && v > 0) out[code] = v;
  }
  return out.USD === 1 ? out : null;
}

function readRow(value: unknown): FxRow | null {
  const v = value as FxRow | null;
  if (!v || typeof v !== "object" || !v.rates || typeof v.fetched_at !== "string" || Number.isNaN(Date.parse(v.fetched_at))) return null;
  return v;
}

/** Does the row need fetching again: fetched before today (UTC), and no failure in the last hour? */
export function due(row: FxRow | null, now: Date): boolean {
  if (row?.failed_at && now.getTime() - Date.parse(row.failed_at) < RETRY_MS) return false;
  if (!row) return true;
  return row.fetched_at.slice(0, 10) < now.toISOString().slice(0, 10);
}

/** One rate from a row. Null when the row has none for that currency. */
export function rateFrom(row: FxRow | null, currency: string, now: Date): Rate | null {
  if (currency === "USD") return { ...DOLLAR, as_of: row?.fetched_at ?? now.toISOString() };
  const value = row?.rates[currency];
  if (!row || !value) return null;
  return { currency, value, as_of: row.fetched_at, stale: now.getTime() - Date.parse(row.fetched_at) > STALE_MS };
}

export interface FxDeps {
  fetch?: typeof fetch;
  now?: Date;
  /** Use what's kept, even when it's due: for the budget check before a model call, which mustn't wait on the service. */
  noFetch?: boolean;
}

let memo: { row: FxRow | null; at: number } | null = null;
/** Tests and a fresh fetch start from the database again. */
export function forgetRates(): void {
  memo = null;
}

async function save(row: FxRow): Promise<void> {
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [FX_KEY, JSON.stringify(row)]);
}

/**
 * Today's rates: the kept row, fetched again first when it's from before today. A fetch that fails keeps the last
 * rates (and says when it failed). Read once a minute at most from the database.
 */
export async function loadRates(deps: FxDeps = {}): Promise<FxRow | null> {
  const now = deps.now ?? new Date();
  if (memo && now.getTime() - memo.at < 60_000 && (deps.noFetch || !due(memo.row, now))) return memo.row;
  let row: FxRow | null = null;
  try {
    const [r] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [FX_KEY]);
    row = readRow(r?.value);
  } catch {
    return memo?.row ?? null;
  }
  if (!deps.noFetch && due(row, now)) {
    let rates: Record<string, number> | null = null;
    try {
      const res = await (deps.fetch ?? fetch)(FX_URL, { signal: AbortSignal.timeout(4_000), headers: { Accept: "application/json" } });
      rates = res.ok ? readRates(await res.json()) : null;
    } catch {
      rates = null;
    }
    const next: FxRow | null = rates ? { rates, fetched_at: now.toISOString() } : row ? { ...row, failed_at: now.toISOString() } : null;
    if (!rates) console.warn("Athena spend: exchange rates couldn't be fetched; using the last ones kept");
    if (next) {
      row = next;
      await save(next).catch(() => undefined);
    }
  }
  memo = { row, at: now.getTime() };
  return row;
}

/** Units of `currency` to $1, or null when Athena has never had a rate for it. */
export async function loadRate(currency: string, deps: FxDeps = {}): Promise<Rate | null> {
  if (currency === "USD") return { ...DOLLAR, as_of: (deps.now ?? new Date()).toISOString() };
  return rateFrom(await loadRates(deps), currency, deps.now ?? new Date());
}
