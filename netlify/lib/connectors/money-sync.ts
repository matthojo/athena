/**
 * Bank accounts and the energy meters into sealed days, with no model in
 * between (lib/money.ts). The Home collection's hourly run calls
 * syncMoneyHome (netlify/lib/home/home-run.ts); so does a Life log run, before
 * Claude starts, for an account no enabled Home reads (an older Life log, or
 * Home turned off). Monzo's, Starling's and Octopus's tools are never offered
 * to Claude (runner.ts skips them, as it does Swarm), so amounts, merchants
 * and when you're home never leave Athena.
 *
 * Each run, per account:
 *  1. Re-reads the last RECENT_DAYS whole days and replaces them, so a
 *     pending payment that settled, a refund or a late meter reading is put
 *     right.
 *  2. Backfills older days, a step a run, with how far it got kept in
 *     settings (`money_backfill`):
 *     - Monzo: everything, if the run is within 5 minutes of the owner
 *       approving Athena in the Monzo app (the only time Monzo allows it);
 *       otherwise the 89 days Monzo allows. Once.
 *     - Starling: a month a run, back BACKFILL_MONTHS months.
 *     - Octopus: as many months as fit before the run's deadline, back
 *       OCTOPUS_HISTORY_MONTHS (octopus-history.ts) or to the first month
 *       with no readings. The background history load (backfill.ts) reads
 *       the same months on connect; while it's running the run leaves the
 *       history to it, and once it's done so is the run's.
 *
 * The meters' account, when its address carries the Octopus account number,
 * also has its tariff and prices read once a day for House's costs
 * (readOctopusTariffs, kept sealed by lib/tariff-store.ts).
 *
 * Then regular payments are worked out again from the sealed days, with
 * Starling's direct debit mandates when the token can read them
 * (lib/recurring.ts, refreshRecurring in lib/money.ts).
 *
 * The run summary gets counts of days only: never an amount, a merchant or a
 * kWh figure.
 */
import { qRaw } from "../../../lib/db";
import { addDays, zonedToday } from "../../../lib/dates";
import { dayList, moneyDays, refreshRecurring, saveHomeDays, saveMoneyDays, type MoneySource, type MoneyTxn } from "../../../lib/money";
import type { Mandate } from "../../../lib/recurring";
import { isSealedSync } from "../../../lib/presets/life";
import { callTool, type OpenConnector } from "./mcp-client";
import { getConnectorWithSecrets } from "../../../lib/connectors";
import { clearTariffStore, loadTariffStore, saveTariffStore } from "../../../lib/tariff-store";
import { metersOf } from "../../../lib/presets/octopus-meters";
import { readOctopusTariffs } from "./octopus-direct";
import { stepBack } from "./octopus-history";
import { getBackfill } from "./backfill";

export const RECENT_DAYS = 7;
export const BACKFILL_MONTHS = 24;
const STATE_KEY = "money_backfill";

interface BackfillState {
  /** YYYY-MM-DD: everything before this is still to read. */
  before?: string;
  done?: boolean;
}

async function loadState(): Promise<Record<string, BackfillState>> {
  const [row] = await qRaw<{ value: Record<string, BackfillState> }>(`SELECT value FROM settings WHERE key = $1`, [STATE_KEY]);
  return row?.value ?? {};
}

async function saveState(state: Record<string, BackfillState>): Promise<void> {
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [STATE_KEY, JSON.stringify(state)]);
}

/** Start an account's history again (its meters changed under Edit): the next runs backfill what's new. */
export async function forgetBackfill(connectorId: string): Promise<void> {
  const state = await loadState();
  if (!(connectorId in state)) return;
  delete state[connectorId];
  await saveState(state);
}

async function call<T>(open: OpenConnector, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = await callTool(open, tool, args);
  if (r.isError) throw new Error(r.text);
  return JSON.parse(r.text) as T;
}

/** Every page of a paged tool. */
async function paged<T>(open: OpenConnector, tool: string, args: Record<string, unknown>, cap = 20_000): Promise<{ items: T[]; cut_to?: string }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let cut_to: string | undefined;
  for (;;) {
    const page = await call<{ items: T[]; next_cursor?: string; cut_to?: string }>(open, tool, { ...args, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cut_to ??= page.cut_to;
    cursor = page.next_cursor;
    if (!cursor || items.length >= cap) return { items, cut_to };
  }
}

/** Monthly steps backwards for tools that take at most 31 days. */
async function byMonth<T>(open: OpenConnector, tool: string, from: string, to: string): Promise<T[]> {
  const out: T[] = [];
  for (let end = to; end > from; ) {
    const start = addDays(end, -30) < from ? from : addDays(end, -30);
    const page = await call<{ items: T[] }>(open, tool, { after: start, before: end });
    out.push(...page.items);
    end = start;
  }
  return out;
}

export interface MoneySyncResult {
  service: string;
  days: number;
  changed: number;
  linked?: number;
  backfilled: boolean;
  /** The tariff was read again today (Octopus with an account number). */
  tariff?: "read" | "failed";
}

/**
 * The tariff and its prices, at most once a day, while the address carries
 * an account number; dropped when it no longer does. Never throws: costs are
 * extra, and the kWh are already saved.
 */
export async function refreshTariff(open: OpenConnector, today: string): Promise<"read" | "failed" | undefined> {
  try {
    let account: string | undefined;
    try {
      account = metersOf(open.connector.url).account;
    } catch {
      account = undefined;
    }
    const kept = await loadTariffStore().catch(() => null);
    if (!account) {
      if (kept) await clearTariffStore();
      return undefined;
    }
    if (kept && kept.fetched_on === today && kept.account === account) return undefined;
    const full = await getConnectorWithSecrets(open.connector.id);
    if (!full) return "failed";
    const store = await readOctopusTariffs(full.connector.url, full.secrets, today);
    if (!store) return undefined;
    await saveTariffStore(store);
    return "read";
  } catch {
    return "failed";
  }
}

const sourceOf = (provider: string): MoneySource => (provider === "starling" ? "starling" : "monzo");

/** One bank account: the recent days replaced, then a step of backfill. */
export async function syncBank(open: OpenConnector, ctx: { now: Date; tz: string; deadline: number }): Promise<MoneySyncResult> {
  const source = sourceOf(open.connector.provider);
  const tool = source === "monzo" ? "transactions" : "feed";
  const today = zonedToday(ctx.now, ctx.tz);
  const first = addDays(today, -(RECENT_DAYS - 1));
  const tomorrow = addDays(today, 1);
  const recent = source === "monzo" ? (await paged<MoneyTxn>(open, tool, { after: first, before: tomorrow })).items : await byMonth<MoneyTxn>(open, tool, first, tomorrow);
  const r1 = await saveMoneyDays(source, moneyDays(recent, ctx.tz, dayList(first, today)), { tz: ctx.tz });
  const out: MoneySyncResult = { service: source === "monzo" ? "Monzo" : "Starling", days: r1.days, changed: r1.changed, linked: r1.linked, backfilled: false };

  const state = await loadState();
  const mine = state[open.connector.id] ?? {};
  if (mine.done || Date.now() > ctx.deadline) return out;
  let older: MoneyTxn[];
  if (source === "monzo") {
    // No `after`: within 5 minutes of approval Monzo gives everything; after that the tool cuts it to 89 days.
    older = (await paged<MoneyTxn>(open, tool, { before: first })).items;
    state[open.connector.id] = { done: true };
  } else {
    const before = mine.before ?? first;
    const start = addDays(before, -30);
    older = await byMonth<MoneyTxn>(open, tool, start, before);
    const floor = addDays(today, -BACKFILL_MONTHS * 30);
    state[open.connector.id] = start <= floor ? { done: true } : { before: start };
  }
  const days = moneyDays(older, ctx.tz);
  const r2 = await saveMoneyDays(source, days, { tz: ctx.tz });
  await saveState(state);
  out.days += r2.days;
  out.changed += r2.changed;
  out.linked = (out.linked ?? 0) + r2.linked;
  out.backfilled = !!state[open.connector.id].done;
  return out;
}

/** Starling's direct debit mandates; undefined when they couldn't be read, so the kept ones stand. */
async function readMandates(open: OpenConnector): Promise<Mandate[] | undefined> {
  try {
    const r = await call<{ items: Mandate[]; unavailable?: string }>(open, "mandates", {});
    return r.unavailable ? [] : r.items;
  } catch {
    return undefined;
  }
}

/** One day from the consumption tool: each fuel only when the account has its meter. */
interface ConsumptionDay {
  date: string;
  kwh?: number;
  gas_kwh?: number;
  half_hours?: number[];
}

/**
 * The meters (electricity, gas or both: whichever the account has, read by
 * the consumption tool): the last few days replaced (readings arrive a day
 * or so late), then as many months of history as fit before the deadline.
 */
export async function syncMeter(open: OpenConnector, ctx: { now: Date; tz: string; deadline: number }): Promise<MoneySyncResult> {
  const today = zonedToday(ctx.now, ctx.tz);
  const first = addDays(today, -3);
  const toMap = (items: ConsumptionDay[]) => new Map(items.map(({ date, ...d }) => [date, d]));
  const recent = await call<{ items: ConsumptionDay[] }>(open, "consumption", { after: first, before: today });
  const r1 = await saveHomeDays("octopus", toMap(recent.items), { tz: ctx.tz });
  const out: MoneySyncResult = { service: "Octopus Energy", days: r1.days, changed: r1.changed, backfilled: false };
  const tariff = await refreshTariff(open, today);
  if (tariff) out.tariff = tariff;
  const state = await loadState();
  const mine = state[open.connector.id] ?? {};
  if (mine.done || Date.now() > ctx.deadline) return out;
  // The background load has it, or has finished it.
  const load = await getBackfill(open.connector.id).catch(() => null);
  if (load?.state === "done") {
    state[open.connector.id] = { done: true };
    await saveState(state);
    out.backfilled = true;
    return out;
  }
  if (load?.state === "running" && load.lease_until && load.lease_until > new Date().toISOString()) return out;
  const r = await stepBack(mine, {
    today,
    first,
    deadline: ctx.deadline,
    read: async (after, before) => toMap((await call<{ items: ConsumptionDay[] }>(open, "consumption", { after, before })).items),
    save: async (days, next) => {
      const r2 = await saveHomeDays("octopus", days, { tz: ctx.tz });
      out.days += r2.days;
      state[open.connector.id] = next;
      await saveState(state);
      return r2.changed;
    },
  });
  out.changed += r.changed;
  out.backfilled = !!r.state.done;
  return out;
}

/**
 * Each bank account and meter synced: in a Home run, or before a Life log
 * run's Claude. The answer is a line for the run summary, with counts of days
 * only, or "".
 */
export async function syncMoneyHome(opened: OpenConnector[], ctx: { now: Date; tz: string; budgetMs?: number; report?: (id: string, r: MoneySyncResult | { failed: string }) => void }): Promise<string> {
  const deadline = Date.now() + (ctx.budgetMs ?? 60_000);
  const said: string[] = [];
  let banks = 0;
  let mandates: Mandate[] | undefined;
  for (const open of opened.filter((o) => isSealedSync(o.connector.provider))) {
    try {
      const r = open.connector.provider === "octopus" ? await syncMeter(open, { ...ctx, deadline }) : await syncBank(open, { ...ctx, deadline });
      ctx.report?.(open.connector.id, r);
      said.push(`${r.service}: ${r.changed} ${r.changed === 1 ? "day" : "days"} updated${r.backfilled ? ", history done" : ""}${r.tariff === "read" ? ", tariff read" : r.tariff === "failed" ? ", tariff couldn't be read" : ""}.`);
      if (open.connector.provider !== "octopus") banks++;
      if (open.connector.provider === "starling") {
        const read = await readMandates(open);
        if (read) mandates = [...(mandates ?? []), ...read];
      }
    } catch (error) {
      ctx.report?.(open.connector.id, { failed: error instanceof Error ? error.message : "unknown problem" });
      said.push(`${open.connector.name} couldn't be read: ${error instanceof Error ? error.message : "unknown problem"}.`);
    }
  }
  // Regular payments, worked out again from the sealed days (lib/recurring.ts). A count only in the summary.
  if (banks) {
    try {
      const n = await refreshRecurring(zonedToday(ctx.now, ctx.tz), mandates ? { mandates } : {});
      said.push(`Regular payments: ${n}.`);
    } catch (error) {
      said.push(`Regular payments couldn't be worked out: ${error instanceof Error ? error.message : "unknown problem"}.`);
    }
  }
  return said.join(" ");
}

