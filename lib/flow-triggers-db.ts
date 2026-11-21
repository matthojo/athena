/**
 * The database side of flows' triggers (lib/flow-triggers.ts): the claims
 * (migration 0081), the calendar a "before" trigger reads, the values an
 * event's record carries, and the pass the reminders job calls.
 *
 * The engine plugs itself in with useFlowEngine({ source, starter }), from
 * lib/flow-engine.ts. Until it has, runFlowTriggers does nothing and claims nothing, so events wait
 * for it (Team prunes them after a week either way). Events are read, run,
 * then marked seen (`flow_claimed_at`); each flow's run for each event is a
 * fire (`event:<id>`) in `flow_trigger_fires`, so an event a plain flow left
 * for the next pass never starts another flow twice.
 */
import { getConnectionsDetailed, getEvent, getPerson, listEvents, notDeclined, qRaw, type AthenaEvent } from "./db";
import { getAsset, listAssets } from "./memory";
import { getBooking, getPurchase } from "./trips";
import { daysBetween, upcomingOccurrences, zonedToday } from "./dates";
import { isEncryptedPlaceholder } from "./encrypted";
import { onOwnerEvent, toEventRow, type EventRowRaw } from "./team-triggers";
import { queueFlowRuns, startFlowEvent, type DatedItem, type FlowCalendar, type FlowClaims, type FlowTriggerDeps, type QueuedFlowRun, type TimedItem } from "./flow-triggers";
import type { TeamEventRow } from "./team-events";
import type { FlowSource, FlowStarter } from "./flow-types";

/** Fires are kept this long: well past any window in which one could come round again. */
export const FIRE_DAYS = 7;
const HOUR = 3_600_000;
const readable = (s: string | null | undefined): s is string => !!s && !isEncryptedPlaceholder(s);

// ---------- claims ----------

export const dbFlowClaims: FlowClaims = {
  async fire(flowId, key, at) {
    const rows = await qRaw<{ flow_id: string }>(
      `INSERT INTO flow_trigger_fires (flow_id, fire_key, fire_at) VALUES ($1, $2, $3::timestamptz) ON CONFLICT DO NOTHING RETURNING flow_id`,
      [flowId, key, at.toISOString()],
    );
    return rows.length > 0;
  },
  async release(flowId, key) {
    await qRaw(`DELETE FROM flow_trigger_fires WHERE flow_id = $1 AND fire_key = $2`, [flowId, key]);
  },
  async pending(limit) {
    // Read, not marked: a plain flow may leave some for the next pass. Fires stop a run starting twice.
    const rows = await qRaw<EventRowRaw>(
      `SELECT id, kind, ref_id, ref_kind, facets, created_at, processed_at FROM team_events WHERE flow_claimed_at IS NULL ORDER BY id LIMIT $1`,
      [limit],
    );
    return rows.map(toEventRow).sort((a, b) => Number(a.id) - Number(b.id));
  },
  async seen(ids) {
    if (!ids.length) return;
    await qRaw(`UPDATE team_events SET flow_claimed_at = now() WHERE id = ANY($1::bigint[]) AND flow_claimed_at IS NULL`, [ids]);
  },
  async event(id) {
    const [r] = await qRaw<EventRowRaw>(
      `SELECT id, kind, ref_id, ref_kind, facets, created_at, processed_at FROM team_events WHERE id = $1::bigint AND flow_claimed_at IS NULL`,
      [id],
    );
    return r ? toEventRow(r) : null;
  },
  async prune(now) {
    const rows = await qRaw<{ flow_id: string }>(`DELETE FROM flow_trigger_fires WHERE fire_at < $1 RETURNING flow_id`, [new Date(now.getTime() - FIRE_DAYS * 24 * HOUR).toISOString()]);
    return rows.length;
  },
};

// ---------- the calendar ----------

/** People from People linked to an event: its own person (not a birthday's) and linked people. */
async function eventPeople(e: AthenaEvent): Promise<Array<{ id: string; name: string }>> {
  const links = await getConnectionsDetailed("event", e.id).catch(() => null);
  const linked = links ? [...links.outgoing, ...links.backlinks].filter((c) => c.kind === "person" && readable(c.title)) : [];
  const out = new Map(linked.map((c) => [c.id, { id: c.id, name: c.title }]));
  if (e.person_id && e.kind !== "birthday" && !out.has(e.person_id)) {
    const p = await getPerson(e.person_id).catch(() => null);
    if (p && readable(p.name)) out.set(p.id, { id: p.id, name: p.name });
  }
  return [...out.values()];
}

/** The calendar as flows read it, in the owner's zone. */
export function dbFlowCalendar(tz: string): FlowCalendar {
  let cached: Promise<AthenaEvent[]> | null = null;
  const events = () => (cached ??= listEvents().then((es) => es.filter(notDeclined)));
  return {
    async timed(from, to) {
      const start = zonedToday(from, tz);
      const span = Math.max(1, daysBetween(start, zonedToday(to, tz)) + 1);
      const occ = upcomingOccurrences((await events()).filter((e) => e.kind !== "birthday" && e.kind !== "anniversary"), start, span, tz);
      const out: TimedItem[] = [];
      for (const x of occ) {
        if (!x.starts_at || !readable(x.event.title)) continue;
        const s = Date.parse(x.starts_at);
        if (s < from.getTime() || s > to.getTime()) continue;
        // Added after it happened: an import of history, not something coming up.
        if (Date.parse(x.event.created_at) > s + HOUR) continue;
        out.push({ id: x.event.id, title: x.event.title, starts_at: x.starts_at, people: await eventPeople(x.event) });
      }
      return out;
    },
    async dated(dates) {
      if (!dates.length) return [];
      const want = new Set(dates);
      const first = [...dates].sort()[0];
      const span = daysBetween(first, [...dates].sort().slice(-1)[0]) + 1;
      const out: DatedItem[] = [];
      for (const x of upcomingOccurrences(await events(), first, span, tz)) {
        if (!want.has(x.occurs_on) || !readable(x.event.title)) continue;
        const e = x.event;
        let person: DatedItem["person"] = null;
        if (e.person_id && (e.kind === "birthday" || e.kind === "anniversary")) {
          const p = await getPerson(e.person_id).catch(() => null);
          if (p && readable(p.name)) person = { id: p.id, name: p.name };
        }
        out.push({ source: "event", id: e.id, title: e.title, kind: e.kind, date: x.occurs_on, person, years: x.years });
      }
      for (const a of await listAssets(1000).catch(() => [])) {
        if (!a.renews_on || !want.has(a.renews_on) || !readable(a.name)) continue;
        out.push({ source: "renewal", id: a.id, title: a.name, kind: "renewal", date: a.renews_on, company: readable(a.provider) ? a.provider : null });
      }
      return out;
    },
  };
}

// ---------- what an event's record carries ----------

/** Values from the record an event points at: a renewal's company and date, an order's shop, a booking's start. */
export async function dbItemValues(ev: TeamEventRow): Promise<Record<string, unknown>> {
  if (!ev.ref_id) return {};
  switch (ev.ref_kind) {
    case "asset": {
      const a = await getAsset(ev.ref_id);
      if (!a) return {};
      return { item: readable(a.name) ? a.name : null, company: readable(a.provider) ? { id: null, name: a.provider } : null, renewal_date: a.renews_on };
    }
    case "purchase": {
      const p = await getPurchase(ev.ref_id);
      if (!p) return {};
      const items = p.items.filter(readable).join(", ");
      return { item: items || (readable(p.retailer) ? p.retailer : null), company: readable(p.retailer) ? { id: null, name: p.retailer } : null, delivery_date: p.expected_on };
    }
    case "booking": {
      const b = await getBooking(ev.ref_id);
      if (!b) return {};
      return { item: { id: b.trip_id, title: readable(b.title) ? b.title : null }, booking: readable(b.title) ? b.title : null, company: readable(b.provider) ? { id: null, name: b.provider } : null, starts_at: b.starts_at };
    }
    case "event": {
      const e = await getEvent(ev.ref_id);
      if (!e) return {};
      return { item: { id: e.id, title: readable(e.title) ? e.title : null }, date: e.date };
    }
    default:
      return {};
  }
}

// ---------- the engine, and the pass ----------

let engine: { source: FlowSource; starter: FlowStarter } | null = null;
let unhook: (() => void) | null = null;

/** The database deps for a pass in `tz`, with the engine given. */
export function flowTriggerDeps(e: { source: FlowSource; starter: FlowStarter }, tz: string): FlowTriggerDeps {
  return { ...e, tz, claims: dbFlowClaims, calendar: dbFlowCalendar(tz), items: (ev) => dbItemValues(ev) };
}

/**
 * The engine plugs itself in: the reminders pass starts its runs, and the
 * owner's own events (startTeamEvent) start flows at once. Call once, when
 * the engine's module loads. Returns a function that unplugs it.
 */
export function useFlowEngine(e: { source: FlowSource; starter: FlowStarter }): () => void {
  unhook?.();
  engine = e;
  unhook = onOwnerEvent((id) => startFlowEvent({ ...e, claims: dbFlowClaims, items: (ev) => dbItemValues(ev) }, id));
  return () => {
    unhook?.();
    unhook = null;
    engine = null;
  };
}

/** The reminders job's one call per pass. Null while no engine is plugged in. */
export async function runFlowTriggers(now: Date, tz: string): Promise<QueuedFlowRun[] | null> {
  if (!engine) return null;
  return queueFlowRuns(flowTriggerDeps(engine, tz), now);
}

