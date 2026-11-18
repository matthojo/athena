/**
 * Tracking over REST (lib/trackers-store.ts; rules in lib/trackers.ts; the contract is lib/tracker-types.ts).
 * The app's full key or token only (the caller checks). Everything the owner does here is theirs: set_by and
 * checked_by "owner".
 *
 *  - GET /api/trackers?saved_id=<id> | ?standalone=1 | (all) → { trackers } (TrackersResponse), each with its
 *    points oldest first and its summary.
 *  - POST /api/trackers (TrackerInput) → 201 { tracker }; the same preset or label on the same thing → 200 with
 *    the one already there.
 *  - GET /api/trackers/:id → { tracker }. PATCH (name, url, label, prefix, suffix, states, direction,
 *    assistant_id, target; target null clears) → { tracker, was }. DELETE → { ok: true }: stopped, with its checks
 *    (Undo: POST /api/trackers/:id/restore → { tracker }).
 *  - POST /api/trackers/:id/points (TrackerPointInput) → 201 { point, news, tracker }: a check the owner made.
 *  - DELETE /api/trackers/:id/points/:pointId → { ok: true } (never the save point: 409). POST
 *    …/:pointId/restore → { ok: true }.
 */
import { TrackerInputError } from "../../../lib/trackers";
import type { TrackerInput, TrackerPointInput, TrackerPointResponse, TrackerResponse, TrackersResponse } from "../../../lib/tracker-types";
import { createTracker, getTracker, listTrackers, pointTracker, recordPoint, removePoint, removeTracker, restorePoint, restoreTracker, updateTracker } from "../../../lib/trackers-store";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER = { by: "owner" as const };

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const b = (await req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** A refusal the owner can read: 404 for what isn't there, 400 for the rest. */
function refused(json: Json, error: unknown): Response {
  if (error instanceof TrackerInputError) return json({ error: error.message }, /isn't there/.test(error.message) ? 404 : 400);
  throw error;
}

export async function handleTrackerRoutes(req: Request, url: URL, segments: string[], json: Json): Promise<Response | null> {
  // segments: ["api", "trackers", id?, "points" | "restore"?, pointId?, "restore"?]
  const [, , id, part, pointId, verb] = segments;
  if (!id) {
    if (req.method === "GET") {
      const saved = url.searchParams.get("saved_id");
      if (saved !== null && !UUID.test(saved)) return json({ error: "saved_id: a saved item's id" }, 400);
      const out: TrackersResponse = { trackers: await listTrackers(saved ? { saved_id: saved } : url.searchParams.get("standalone") === "1" ? { standalone: true } : {}) };
      return json(out);
    }
    if (req.method === "POST") {
      const b = await body(req);
      if (!b) return json({ error: "Send JSON: a preset, or a label and kind" }, 400);
      try {
        const { tracker, existed } = await createTracker(b as TrackerInput, OWNER);
        const out: TrackerResponse = { tracker };
        return json(out, existed ? 200 : 201);
      } catch (error) {
        return refused(json, error);
      }
    }
    return null;
  }
  if (!UUID.test(id)) return json({ error: "Not found" }, 404);

  if (!part && segments.length === 3) {
    if (req.method === "GET") {
      const tracker = await getTracker(id);
      return tracker ? json({ tracker } satisfies TrackerResponse) : json({ error: "Not found" }, 404);
    }
    if (req.method === "PATCH") {
      const b = await body(req);
      if (!b) return json({ error: "Send JSON: what to change" }, 400);
      try {
        const done = await updateTracker(id, b, OWNER);
        return done ? json(done) : json({ error: "Not found" }, 404);
      } catch (error) {
        return refused(json, error);
      }
    }
    if (req.method === "DELETE") return (await removeTracker(id)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    return null;
  }

  if (part === "restore" && segments.length === 4 && req.method === "POST") {
    if (!(await restoreTracker(id))) return json({ error: "Not found" }, 404);
    return json({ tracker: (await getTracker(id))! } satisfies TrackerResponse);
  }

  if (part === "points") {
    if (segments.length === 4 && req.method === "POST") {
      const b = await body(req);
      if (!b) return json({ error: "Send JSON: { value, source?, url?, checked_at? }" }, 400);
      const input = b as unknown as TrackerPointInput & { currency?: unknown };
      try {
        const r = await recordPoint(id, { value: input.value, source: input.source, url: input.url, currency: input.currency, checked_at: input.checked_at }, OWNER);
        return json({ point: r.point, news: r.news, tracker: r.tracker } satisfies TrackerPointResponse, 201);
      } catch (error) {
        return refused(json, error);
      }
    }
    if (!pointId || !UUID.test(pointId)) return json({ error: "Not found" }, 404);
    // The check must be on the tracker named.
    const on = await pointTracker(pointId);
    if (!on || on.tracker_id !== id) return json({ error: "Not found" }, 404);
    if (segments.length === 5 && req.method === "DELETE") {
      if (on.checked_by === "save") return json({ error: "The price when you saved it can't be removed: the other checks are compared with it." }, 409);
      return (await removePoint(pointId)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    }
    if (segments.length === 6 && verb === "restore" && req.method === "POST") return (await restorePoint(pointId)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }
  return null;
}
