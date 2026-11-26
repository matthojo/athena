/**
 * Team events (`team_events`): something arrived in Athena that
 * an assistant's event trigger may want. A collected item (the collector,
 * netlify/lib/connectors/runner.ts), a saved link or a saved action run on it
 * (lib/saved.ts, lib/saved-actions.ts), or a note made with tags (the API and
 * MCP note create).
 *
 * A collected item's hook only inserts a row; the reminders job matches rows
 * to triggers every 5 minutes (lib/team-triggers.ts), where batching matters.
 * Things the owner does (a save, a saved action, a tagged note) go through
 * startTeamEvent instead, which matches the row and hands its runs off at once. `facets` holds only what a filter matches
 * on: short strings and flags, never a secret or body text. Even so they're the owner's words (a note's title, an
 * email's subject, a saved page's host), so the column is one sealed JSON string under the data key, like
 * commitments.steps (lib/encryption.ts ENCRYPTED), and filters match in code, after facetsOf. Emitting never
 * throws into the caller: a failed insert is logged and dropped. Rows are kept
 * for EVENT_DAYS.
 */
import { qRaw, sealer } from "./db";
import type { EventSource } from "./team-types";

export const EVENT_DAYS = 7;
const MAX_FACET = 200;
const MAX_TAGS = 20;

export type TeamEventFacets = Record<string, string | boolean | string[] | undefined | null>;

export interface TeamEventRow {
  id: string;
  kind: EventSource;
  ref_id: string | null;
  ref_kind: string | null;
  facets: Record<string, string | boolean | string[]>;
  created_at: string;
  /** When Team's pass (or an owner's action) claimed it, as Flows reads it: an assistant's job flow leaves an event Team claimed before the flow was made to Team (lib/flow-triggers.ts). */
  processed_at?: string | null;
}

/** Only short strings, flags and short string lists, lowercased where they're names. Pure. */
export function cleanFacets(raw: TeamEventFacets): Record<string, string | boolean | string[]> {
  const out: Record<string, string | boolean | string[]> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(k) || v == null) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") {
      const s = v.replace(/\s+/g, " ").trim().slice(0, MAX_FACET);
      if (s) out[k] = s;
    } else if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === "string").map((x) => x.trim().replace(/^#/, "").slice(0, 80)).filter(Boolean).slice(0, MAX_TAGS);
      if (list.length) out[k] = list;
    }
  }
  return out;
}

/**
 * A row's facets as q() hands them back: JSON text once sealed (q opens it), an object from before encryption, or
 * nothing. Anything else, such as a value that wouldn't open, is no facets rather than an error. Pure.
 */
export function facetsOf(raw: unknown): Record<string, string | boolean | string[]> {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string | boolean | string[]>) : {};
}

/** The host of a link, without "www.": "amazon.co.uk". Pure. */
export function urlHost(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** What a collected item is, from its account's provider: a Linear note is an issue, a Gmail one an email. Pure. */
export function collectedKind(provider: string | undefined, stored: "note" | "event" | "todo", noteType?: string): string {
  if (stored === "event") return "event";
  if (stored === "todo") return "todo";
  const p = (provider ?? "").toLowerCase();
  if (/calendar/.test(p)) return "event";
  if (/linear|jira|github|gitlab|asana|trello/.test(p)) return "issue";
  if (/gmail|outlook|mail|imap/.test(p)) return "email";
  if (/slack|teams|discord/.test(p)) return "message";
  return noteType && noteType !== "note" ? noteType : "note";
}

/** Keep one event; its id, or null when it couldn't be kept. Never throws: a hook must not break what it's hooked into. */
export async function emitTeamEvent(kind: EventSource, refId: string | null, refKind: string | null, facets: TeamEventFacets = {}): Promise<string | null> {
  try {
    const s = await sealer();
    const [row] = await qRaw<{ id: string | number }>(`INSERT INTO team_events (kind, ref_id, ref_kind, facets) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`, [kind, refId, refKind, s.json(cleanFacets(facets))]);
    return row ? String(row.id) : null;
  } catch (error) {
    console.error("Athena team: couldn't keep an event", (error as Error)?.message?.slice(0, 120));
    return null;
  }
}

/** Drop events older than EVENT_DAYS. */
export async function pruneTeamEvents(now = new Date()): Promise<number> {
  const rows = await qRaw<{ id: string }>(`DELETE FROM team_events WHERE created_at < $1 RETURNING id`, [new Date(now.getTime() - EVENT_DAYS * 86_400_000).toISOString()]);
  return rows.length;
}
