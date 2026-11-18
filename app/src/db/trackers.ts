/**
 * Tracking for the app (lib/tracker-types.ts is the contract; the server is
 * the sibling's netlify/ routes): GET /api/trackers (one item's, those on
 * their own, or all), POST to start one, PATCH to change it or its target,
 * DELETE to stop; POST …/points for a check the owner made, DELETE
 * …/points/<id> and POST …/points/<id>/restore for Undo. Sample mode
 * answers from db/sample-trackers.ts, a fake of the same routes.
 *
 * Lists are kept for the session (the reader, Saved's cards, an assistant's
 * page and a reply ask for the same ones) and dropped on any change here.
 *
 * Stopping a tracker deletes it at once; the toast's Undo restores it with
 * every check (POST /api/trackers/<id>/restore, added by the server).
 */
import { isSampleMode, request } from "./api";
import { getSavedItem } from "./saved";
import type { TrackerInput, TrackerPoint, TrackerPointInput, TrackerResponse, TrackersResponse, TrackerTarget, TrackerView } from "../../../lib/tracker-types";
import { cleanNumber } from "../lib/tracker-words";

export type { TrackerView, TrackerPoint };

export type TrackerQuery = { saved_id?: string; standalone?: boolean };

const cache = new Map<string, Promise<TrackerView[]>>();
const listeners = new Set<() => void>();

const keyOf = (q: TrackerQuery) => (q.saved_id ? `item:${q.saved_id}` : q.standalone ? "standalone" : "all");
const json = (body: unknown): RequestInit => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sample = () => import("./sample-trackers");

/** Fires when anything tracked changes here. */
export function onTrackersChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed() {
  cache.clear();
  listeners.forEach((fn) => fn());
}

/** One item's trackers, those on their own, or all, oldest first. */
export function listTrackers(q: TrackerQuery = {}, opts: { fresh?: boolean } = {}): Promise<TrackerView[]> {
  const key = keyOf(q);
  if (opts.fresh) cache.delete(key);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (isSampleMode()) return (await sample()).sampleListTrackers(q);
      const qs = q.saved_id ? `?saved_id=${encodeURIComponent(q.saved_id)}` : q.standalone ? "?standalone=1" : "";
      return (await request<TrackersResponse>(`/trackers${qs}`)).trackers;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** One tracker by id (GET /api/trackers/<id>). Null when it isn't there. */
export async function getTracker(id: string): Promise<TrackerView | null> {
  if (isSampleMode()) return (await listTrackers()).find((t) => t.id === id) ?? null;
  try {
    return (await request<TrackerResponse>(`/trackers/${encodeURIComponent(id)}`)).tracker;
  } catch {
    return null;
  }
}

/** Start tracking: a preset ("price", "stock") or one the owner described. */
export async function createTracker(input: TrackerInput): Promise<TrackerView> {
  let out: TrackerView;
  if (isSampleMode()) {
    const item = input.saved_id ? await getSavedItem(input.saved_id) : null;
    out = await (await sample()).sampleCreateTracker(input, item);
  } else out = (await request<TrackerResponse>("/trackers", { method: "POST", ...json(input) })).tracker;
  changed();
  return out;
}

/** Change a tracker: its name, link, label or target. */
export async function updateTracker(id: string, patch: TrackerInput): Promise<TrackerView> {
  const out = isSampleMode() ? await (await sample()).samplePatchTracker(id, patch) : (await request<TrackerResponse>(`/trackers/${encodeURIComponent(id)}`, { method: "PATCH", ...json(patch) })).tracker;
  changed();
  return out;
}

/** "Tell me when…": set or replace the target. Returns the one it replaced, for Undo. */
export async function setTarget(t: TrackerView, target: Pick<TrackerTarget, "op" | "value">): Promise<TrackerView> {
  const value = t.kind === "number" && target.op !== "change" ? cleanNumber(target.value) : target.op === "change" ? "" : target.value;
  return updateTracker(t.id, { target: { op: target.op, value } });
}

/** Clear the target. */
export function clearTarget(t: TrackerView): Promise<TrackerView> {
  return updateTracker(t.id, { target: null });
}

/** Stop tracking (DELETE). Returns Undo, which brings it back with every check (POST …/restore). */
export async function stopTracking(t: Pick<TrackerView, "id">): Promise<() => Promise<void>> {
  if (isSampleMode()) await (await sample()).sampleDeleteTracker(t.id);
  else await request(`/trackers/${encodeURIComponent(t.id)}`, { method: "DELETE" });
  changed();
  return async () => {
    if (isSampleMode()) await (await sample()).sampleRestoreTracker(t.id);
    else await request<TrackerResponse>(`/trackers/${encodeURIComponent(t.id)}/restore`, { method: "POST" });
    changed();
  };
}

/** A check the owner made: the value as the page showed it, where, and its link when there is one. */
export async function addCheck(t: TrackerView, input: TrackerPointInput): Promise<TrackerPoint> {
  const clean: TrackerPointInput = { value: t.kind === "number" ? cleanNumber(input.value) : input.value, source: input.source?.trim() || null, url: cleanLink(input.url), ...(t.currency ? { currency: t.currency } : {}) };
  const out = isSampleMode() ? await (await sample()).sampleAddPoint(t.id, clean) : (await request<{ point: TrackerPoint }>(`/trackers/${encodeURIComponent(t.id)}/points`, { method: "POST", ...json(clean) })).point;
  changed();
  return out;
}

/** Remove one check (never the one kept at save). */
export async function removeCheck(p: Pick<TrackerPoint, "id" | "tracker_id">): Promise<void> {
  if (isSampleMode()) (await sample()).sampleRemovePoint(p.id);
  else await request(`/trackers/${encodeURIComponent(p.tracker_id)}/points/${encodeURIComponent(p.id)}`, { method: "DELETE" });
  changed();
}

/** Bring a removed check back (Undo). */
export async function restoreCheck(p: Pick<TrackerPoint, "id" | "tracker_id">): Promise<void> {
  if (isSampleMode()) (await sample()).sampleRestorePoint(p.id);
  else await request(`/trackers/${encodeURIComponent(p.tracker_id)}/points/${encodeURIComponent(p.id)}/restore`, { method: "POST" });
  changed();
}

/** A link the owner typed: http(s), no credentials, or nothing. Throws for anything else. */
export function cleanLink(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    throw new Error("url: a link to the page, like https://…");
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || s.length > 2000) throw new Error("url: a link to the page, like https://…");
  return u.toString();
}
