/**
 * Fill in each pending suggestion's `existing` (lib/suggestion-target.ts):
 * the saved thing accepting would update, found the way accepting finds it.
 * A lookup that fails leaves `existing` empty, so the card reads as adding.
 */
import { q } from "./db";
import type { Suggestion } from "./memory";
import type { SuggestionTarget } from "./suggestion-target";
import { bookingFor, purchaseFor } from "./trips";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A record named by id in the payload (an agent proposing an edit): its name. */
async function named(table: "commitments" | "events" | "people", column: "title" | "name", id: unknown): Promise<SuggestionTarget | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const [row] = await q<{ id: string; name: string }>(`SELECT id, ${column} AS name FROM ${table} WHERE id = $1 AND archived_at IS NULL`, [id]);
  return row ? { id: row.id, name: row.name } : null;
}

async function targetOf(s: Suggestion): Promise<SuggestionTarget | null> {
  const p = s.payload ?? {};
  switch (s.op) {
    case "purchase": {
      const found = await purchaseFor({ purchase_id: str(p.purchase_id), order_number: str(p.order_number), tracking_number: str(p.tracking_number), retailer: str(p.retailer) });
      // One the owner archived is left alone, so there's nothing to update.
      return found && !found.owner_archived ? { id: found.id, status: found.status } : null;
    }
    case "booking": {
      const found = await bookingFor({
        booking_id: str(p.booking_id),
        kind: str(p.kind) as Parameters<typeof bookingFor>[0]["kind"],
        reference: str(p.reference),
        segment: str(p.segment),
        start_local: str(p.start_local),
      });
      return found && !found.owner_archived ? { id: found.id, name: found.title, status: found.status } : null;
    }
    case "fact": {
      const key = str(p.key);
      const value = str(p.value);
      const kind = p.subject_kind;
      if (!key || !value || (kind !== "me" && (typeof p.subject_id !== "string" || !UUID_RE.test(p.subject_id)))) return null;
      const [current] = await q<{ id: string; value: string }>(
        `SELECT id, value FROM facts
         WHERE subject_kind = $1 AND subject_id IS NOT DISTINCT FROM $2::uuid AND lower(key) = lower($3)
           AND superseded_at IS NULL AND archived_at IS NULL
         ORDER BY observed_at DESC LIMIT 1`,
        [kind, kind === "me" ? null : p.subject_id, key],
      );
      // The same value already saved: accepting changes nothing, so it reads as remembering.
      return current && current.value.trim().toLowerCase() !== value.trim().toLowerCase() ? { id: current.id, value: current.value } : null;
    }
    case "commitment":
      return named("commitments", "title", p.id);
    case "event":
      return named("events", "title", p.id);
    case "person":
      return named("people", "name", p.id);
    default:
      return null;
  }
}

export async function withTargets(items: Suggestion[]): Promise<Suggestion[]> {
  return Promise.all(
    items.map(async (s) => {
      if (s.status !== "pending") return s;
      try {
        return { ...s, existing: await targetOf(s) };
      } catch {
        return { ...s, existing: null };
      }
    }),
  );
}
