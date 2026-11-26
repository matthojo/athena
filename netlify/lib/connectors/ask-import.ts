/**
 * Ask saves what it found: when an answer rests on an item in a connected
 * account that Athena doesn't have, usually because it's from before Athena
 * started collecting (January's flights, booked by email in December), that
 * item is saved straight away, with no extra tap, the way the account's
 * collection would have saved it.
 *
 * lib/answer.ts returns the cited account items as `imports`; the app sends
 * them to POST /api/assistant/import once the answer is on screen, and shows
 * what this returns under it: each thing saved, a link to it, and Undo
 * (archive, through /api/assistant/undo).
 *
 * Nothing new is extracted here: each item goes through runner.ts's
 * collectOneItem, the collection pipeline for one item (its recipe, NOTE_STYLE,
 * provenance, and the Review inbox for finds under 0.8). An item Athena already
 * has (by its id in collected_items or a record's source_ref, as collections
 * match) is skipped, so asking twice saves nothing twice, and a later
 * collection meeting the same item updates what's here.
 *
 * At most MAX_IMPORTS_PER_ANSWER items per answer, saved at once. Five because
 * an answer cites at most eight sources and the usual case (a return flight and
 * a hotel, or an order and its delivery) is two or three; each item is its own
 * model loop, and five in parallel stays inside AI Gateway's per-minute spend
 * and the request's time. More would mean an answer that leans on a long list,
 * which is a question for a collection, not for Ask.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { onServer } from "../../../lib/ai";
import { q } from "../../../lib/db";
import { LIVE_ONLY_PROVIDERS, type ImportCandidate } from "../../../lib/answer";
import { collectOneItem, type OneItemResult, type OneItemWrite } from "./runner";
import type { OpenConnector } from "./mcp-client";

export const MAX_IMPORTS_PER_ANSWER = 5;
/** The whole import, including each item's model calls. */
const IMPORT_BUDGET_MS = 45_000;
/** On the Netlify Server (lib/ai.ts onServer), where no function limit applies. */
const SERVER_IMPORT_BUDGET_MS = 3 * 60_000;

/** One line of the receipt under an answer. */
export interface ImportedItem {
  kind: "trip" | "booking" | "purchase" | "note" | "event" | "todo" | "detail" | "catch_up" | "reading" | "day";
  title: string;
  /** Where it opens in the app. */
  href: string;
  /** What Undo archives (POST /api/assistant/undo, one op each); empty when it can't be undone from here. */
  undo: Array<{ op: "archive"; kind: string; id: string } | { op: "archive_day_import"; run_id: string }>;
  /** The account it came from: "Gmail (work)". */
  from: string;
}

export interface ImportReceipt {
  saved: ImportedItem[];
  /** Finds sent to the Review inbox. */
  review: number;
  /** Cited items Athena already had. */
  already: number;
  /** Items that couldn't be saved, by title. */
  failed: string[];
  /** Cited items left for a collection, past the cap. */
  over_cap: number;
}

/** POST /api/assistant/import's `imports`, checked. */
export function parseImports(raw: unknown): ImportCandidate[] {
  if (!Array.isArray(raw)) return [];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.connector_id === "string" && UUID.test(c.connector_id) && typeof c.url === "string" && c.url.startsWith("https://"))
    .map((c) => ({
      connector_id: String(c.connector_id),
      provider: String(c.provider ?? "").slice(0, 60),
      url: String(c.url).slice(0, 2000),
      kind: String(c.kind ?? "page") as ImportCandidate["kind"],
      title: String(c.title ?? "").slice(0, 200),
      date: typeof c.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : null,
    }))
    .slice(0, 20);
}

const param = (url: URL, name: string) => url.searchParams.get(name) ?? new URLSearchParams(url.hash.replace(/^#[^?]*\?/, "")).get(name);

/** The id a collection files an item under, from its link: a Gmail thread, a calendar event, a Granola meeting, a Linear issue. Null when the link doesn't say. */
export function itemIdFrom(provider: string, link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  switch (provider) {
    case "gmail":
      return /#[^/]+\/([A-Za-z0-9_-]+)$/.exec(url.hash)?.[1] ?? null;
    case "fastmail":
      // app.fastmail.com/mail/Inbox/<thread>.<message> (fastmail-mail.ts viewUrl): the thread.
      return /\/mail\/[^/]+\/([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(url.pathname)?.[1] ?? null;
    case "outlook-mail":
    case "outlook-calendar":
      return param(url, "ItemID");
    case "google-calendar": {
      const eid = param(url, "eid");
      if (!eid) return null;
      try {
        return Buffer.from(eid.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split(" ")[0] || null;
      } catch {
        return null;
      }
    }
    case "granola":
      return /\/d\/([0-9a-f-]{36})/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
    case "linear":
      return /\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(url.pathname)?.[1] ?? null;
    default:
      return null;
  }
}

/**
 * Does Athena have this item already? Matched as collections match: its id in
 * collected_items (notes, events), the end of a record's source_ref
 * ("<source>:<id>", for to-dos, catch-ups, details, bookings, orders and Review
 * inbox finds), or a day entry from it.
 */
export async function alreadyInAthena(ids: string[]): Promise<boolean> {
  const keys = [...new Set(ids.filter(Boolean))];
  if (!keys.length) return false;
  const ref = `substring(source_ref from position(':' in source_ref) + 1) = ANY($1::text[])`;
  const [row] = await q<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM collected_items WHERE external_id = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM trip_bookings WHERE ${ref})
         OR EXISTS (SELECT 1 FROM purchases WHERE ${ref})
         OR EXISTS (SELECT 1 FROM commitments WHERE ${ref})
         OR EXISTS (SELECT 1 FROM interactions WHERE ${ref})
         OR EXISTS (SELECT 1 FROM facts WHERE ${ref})
         OR EXISTS (SELECT 1 FROM suggestions WHERE ${ref})
         OR EXISTS (SELECT 1 FROM day_entries WHERE external_id = ANY($1::text[])) AS found`,
    [keys],
  );
  return !!row?.found;
}

export interface ImportDeps {
  /** One item through the collection pipeline; tests pass their own model and accounts through it. */
  collect?: typeof collectOneItem;
  client?: Anthropic;
  open?: (id: string) => Promise<OpenConnector>;
  now?: Date;
  /** Does Athena have an item with any of these ids? alreadyInAthena when left out. */
  has?: (ids: string[]) => Promise<boolean>;
  /** The owner's name for each account, for the receipt; looked up when left out. */
  accountName?: (connectorId: string) => Promise<string>;
  /** The account's stored provider; looked up when left out. */
  providerOf?: (connectorId: string) => Promise<string>;
}

/** The account's provider as stored, not as the app said. */
async function providerOf(connectorId: string): Promise<string> {
  return (await q<{ provider: string }>(`SELECT provider FROM connectors WHERE id = $1`, [connectorId]))[0]?.provider ?? "";
}

/** Save what an answer cited from the accounts that Athena doesn't have, at most MAX_IMPORTS_PER_ANSWER, all at once. */
export async function importAnswerItems(candidates: ImportCandidate[], deps: ImportDeps = {}): Promise<ImportReceipt> {
  const receipt: ImportReceipt = { saved: [], review: 0, already: 0, failed: [], over_cap: 0 };
  const seen = new Set<string>();
  const todo: Array<ImportCandidate & { externalId: string | null }> = [];
  for (const c of candidates) {
    // Linear and GitHub are read live only: nothing from them is saved here, whatever the app sent (lib/answer.ts).
    // An account that can't be looked up isn't imported from either.
    const stored = await (deps.providerOf ?? providerOf)(c.connector_id).catch(() => null);
    if (!stored || LIVE_ONLY_PROVIDERS.has(stored) || LIVE_ONLY_PROVIDERS.has(c.provider)) continue;
    const externalId = itemIdFrom(c.provider, c.url);
    const key = `${c.connector_id}:${externalId ?? c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await (deps.has ?? alreadyInAthena)([c.url, ...(externalId ? [externalId] : [])])) {
      receipt.already++;
      continue;
    }
    if (todo.length >= MAX_IMPORTS_PER_ANSWER) {
      receipt.over_cap++;
      continue;
    }
    todo.push({ ...c, externalId });
  }
  if (!todo.length) return receipt;

  const collect = deps.collect ?? collectOneItem;
  const deadline = Date.now() + (onServer() ? SERVER_IMPORT_BUDGET_MS : IMPORT_BUDGET_MS);
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) names.set(id, deps.accountName ? await deps.accountName(id) : ((await q<{ name: string }>(`SELECT name FROM connectors WHERE id = $1`, [id]))[0]?.name ?? "your account"));
    return names.get(id)!;
  };
  const results = await Promise.all(
    todo.map(async (c) => {
      const importId = randomUUID();
      try {
        const r = await collect(
          { connectorId: c.connector_id, url: c.url, externalId: c.externalId, title: c.title, date: c.date },
          { importId, now: deps.now, deadline, client: deps.client, open: deps.open },
        );
        return { c, r, from: await nameOf(c.connector_id), importId };
      } catch (error) {
        console.warn("Athena import: couldn't save an item from Ask", error instanceof Error ? error.message : error);
        return { c, r: null, from: "", importId };
      }
    }),
  );
  for (const { c, r, from, importId } of results) {
    if (!r) {
      receipt.failed.push(c.title || "An item");
      continue;
    }
    receipt.review += r.review;
    receipt.saved.push(...receiptItems(r, from, importId));
  }
  return receipt;
}

const HREF: Partial<Record<OneItemWrite["kind"], (w: OneItemWrite) => string>> = {
  note: (w) => `#/notes/${encodeURIComponent(w.id)}`,
  event: (w) => `#/events/${encodeURIComponent(w.id)}`,
  booking: (w) => `#/trips/${encodeURIComponent(w.trip?.id ?? "")}`,
  purchase: (w) => `#/purchases/${encodeURIComponent(w.id)}`,
  commitment: () => "#/loops",
  interaction: (w) => (w.person ? `#/people/${encodeURIComponent(w.person)}` : "#/people"),
  fact: (w) => (w.person ? `#/people/${encodeURIComponent(w.person)}` : "#/people"),
  reading: () => "#/reading",
  day: (w) => `#/days/${w.id}`,
};

const KIND: Partial<Record<OneItemWrite["kind"], ImportedItem["kind"]>> = {
  note: "note", event: "event", booking: "booking", purchase: "purchase", commitment: "todo", interaction: "catch_up", fact: "detail", reading: "reading", day: "day",
};

/** One item's writes as receipt lines: a trip's bookings become one line for the trip, whose Undo takes them (and the trip, when this started it). */
export function receiptItems(r: OneItemResult, from: string, importId?: string): ImportedItem[] {
  const out: ImportedItem[] = [];
  const trips = new Map<string, ImportedItem>();
  for (const w of r.writes) {
    if (w.kind === "booking" && w.trip) {
      let line = trips.get(w.trip.id);
      if (!line) {
        line = { kind: "trip", title: w.trip.name, href: `#/trips/${encodeURIComponent(w.trip.id)}`, undo: [], from };
        trips.set(w.trip.id, line);
        out.push(line);
      }
      line.undo.push({ op: "archive", kind: "booking", id: w.id });
      if (w.trip.created && !line.undo.some((u) => "kind" in u && u.kind === "trip")) line.undo.push({ op: "archive", kind: "trip", id: w.trip.id });
      continue;
    }
    const kind = KIND[w.kind];
    if (!kind) continue;
    // Day entries go by the import that saved them (day_entries.run_id); the day itself stays.
    const undo: ImportedItem["undo"] = w.kind !== "day" ? [{ op: "archive", kind: w.kind, id: w.id }] : importId ? [{ op: "archive_day_import", run_id: importId }] : [];
    out.push({ kind, title: w.title, href: HREF[w.kind]!(w), undo, from });
  }
  // The trip's own archive last, after its bookings.
  const isTrip = (u: ImportedItem["undo"][number]) => ("kind" in u && u.kind === "trip" ? 1 : 0);
  for (const line of trips.values()) line.undo.sort((a, b) => isTrip(a) - isTrip(b));
  return out;
}
