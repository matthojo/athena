/**
 * Swarm check-ins into sealed visits, each night, with no model in between
 * (lib/places-visits.ts). A Life log run calls syncPlaces before Claude
 * starts; Swarm's tool is never offered to Claude, so where you've been
 * never leaves Athena except as place names in the day note.
 *
 * Each run:
 *  1. Re-reads the last RECENT_DAYS whole days and replaces them, so an
 *     edited or deleted check-in is put right.
 *  2. Backfills older check-ins a page at a time, oldest-reached point kept
 *     in settings (`swarm_backfill`), until Swarm has no more.
 *  3. Spends what's left of its budget naming days still waiting
 *     (Nominatim, one lookup a second) and filling in their weather.
 */
import { qRaw } from "../../../lib/db";
import { addDays, zonedToInstant, zonedToday } from "../../../lib/dates";
import { localDay } from "../../../lib/places-timeline";
import { nameWaitingDays, saveCheckins, type Checkin } from "../../../lib/places-visits";
import { callTool, type OpenConnector } from "./mcp-client";
import type { SwarmCheckin } from "./swarm-direct";

export const RECENT_DAYS = 3;
/** Older check-ins read per night, at most. */
export const BACKFILL_PER_RUN = 2_000;
const STATE_KEY = "swarm_backfill";

interface BackfillState {
  /** Epoch ms: everything before this is still to read. */
  before?: number;
  done?: boolean;
}

async function loadState(): Promise<Record<string, BackfillState>> {
  const [row] = await qRaw<{ value: Record<string, BackfillState> }>(`SELECT value FROM settings WHERE key = $1`, [STATE_KEY]);
  return row?.value ?? {};
}

async function saveState(state: Record<string, BackfillState>): Promise<void> {
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [STATE_KEY, JSON.stringify(state)]);
}

/** Every check-in in the window, through the account's own tool, following its cursor. */
async function readAll(open: OpenConnector, args: Record<string, unknown>, cap: number): Promise<{ items: SwarmCheckin[]; more: boolean }> {
  const items: SwarmCheckin[] = [];
  let cursor: string | undefined;
  for (;;) {
    const r = await callTool(open, "checkins", { ...args, ...(cursor ? { cursor } : {}) });
    if (r.isError) throw new Error(r.text);
    const page = JSON.parse(r.text) as { items: SwarmCheckin[]; next_cursor?: string };
    items.push(...page.items);
    cursor = page.next_cursor;
    if (!cursor) return { items, more: false };
    if (items.length >= cap) return { items, more: true };
  }
}

const toCheckin = (c: SwarmCheckin): Checkin => {
  const out: Checkin = { id: c.id, at: c.at, lat: c.lat, lng: c.lng, venue: c.venue };
  if (c.venue_id) out.venue_id = c.venue_id;
  if (c.category) out.category = c.category;
  if (c.town) out.town = c.town;
  return out;
};

function byDay(items: SwarmCheckin[], tz: string, days: string[] = []): Map<string, Checkin[]> {
  const out = new Map<string, Checkin[]>(days.map((d) => [d, []]));
  for (const c of items) {
    const d = localDay(c.at, tz);
    out.set(d, [...(out.get(d) ?? []), toCheckin(c)]);
  }
  return out;
}

export interface PlacesSync {
  checkins: number;
  days: number;
  backfilled: boolean;
  named: number;
}

/** One Swarm account: the recent days replaced, then older pages merged in. */
export async function syncSwarm(open: OpenConnector, ctx: { now: Date; tz: string; lifeLogSource: string; deadline: number }): Promise<PlacesSync> {
  const today = zonedToday(ctx.now, ctx.tz);
  const first = addDays(today, -RECENT_DAYS);
  const recentDays = Array.from({ length: RECENT_DAYS + 1 }, (_, i) => addDays(first, i));
  const after = zonedToInstant(first, "00:00", ctx.tz).getTime();
  const recent = await readAll(open, { after: new Date(after).toISOString() }, 5_000);
  const r1 = await saveCheckins(byDay(recent.items, ctx.tz, recentDays), "replace", { now: ctx.now, tz: ctx.tz, lifeLogSource: ctx.lifeLogSource, deadline: ctx.deadline });
  const out: PlacesSync = { checkins: recent.items.length, days: r1.changed, backfilled: false, named: r1.lookups };

  const state = await loadState();
  const mine = state[open.connector.id] ?? {};
  if (!mine.done && Date.now() < ctx.deadline) {
    const before = mine.before ?? after;
    const older = await readAll(open, { before: new Date(before).toISOString() }, BACKFILL_PER_RUN);
    // A cut-off mid-day would leave that day half read: keep only whole days, unless that's all there is.
    const oldest = older.items.length ? Math.min(...older.items.map((c) => Date.parse(c.at))) : before;
    const cutDay = older.more ? localDay(new Date(oldest).toISOString(), ctx.tz) : null;
    const keep = cutDay ? older.items.filter((c) => localDay(c.at, ctx.tz) > cutDay) : older.items;
    const nextBefore = cutDay && keep.length ? zonedToInstant(addDays(cutDay, 1), "00:00", ctx.tz).getTime() : oldest;
    const r2 = await saveCheckins(byDay(keep.length ? keep : older.items, ctx.tz), "merge", { now: ctx.now, tz: ctx.tz, lifeLogSource: ctx.lifeLogSource, deadline: ctx.deadline });
    state[open.connector.id] = older.more ? { before: keep.length ? nextBefore : oldest } : { done: true };
    await saveState(state);
    out.checkins += older.items.length;
    out.days += r2.changed;
    out.backfilled = !older.more;
  }
  return out;
}

/**
 * Before a Life log run's Claude: each Swarm account synced, then names and
 * weather for days still waiting. The answer is a line for the run summary,
 * with counts only, or "" when there's nothing to say.
 */
export async function syncPlaces(opened: OpenConnector[], ctx: { now: Date; tz: string; lifeLogSource: string; budgetMs?: number }): Promise<string> {
  const deadline = Date.now() + (ctx.budgetMs ?? 90_000);
  const said: string[] = [];
  for (const open of opened.filter((o) => o.connector.provider === "swarm")) {
    try {
      const r = await syncSwarm(open, { ...ctx, deadline });
      said.push(`Swarm: ${r.checkins} ${r.checkins === 1 ? "check-in" : "check-ins"} read, ${r.days} ${r.days === 1 ? "day" : "days"} updated.`);
    } catch (error) {
      said.push(`Swarm couldn't be read: ${error instanceof Error ? error.message : "unknown problem"}.`);
    }
  }
  const left = deadline - Date.now();
  if (left > 2_000) {
    const n = await nameWaitingDays(left, { now: ctx.now, tz: ctx.tz }).catch(() => null);
    if (n?.lookups) said.push(`Named ${n.lookups} ${n.lookups === 1 ? "place" : "places"}${n.waiting ? `, ${n.waiting} ${n.waiting === 1 ? "day" : "days"} still waiting` : ""}.`);
  }
  return said.join(" ");
}
