/**
 * Saved for the app (lib/saved.ts on the server):
 * GET /api/saved for the Library page and a day, GET /api/saved/:id for the
 * reader, POST /api/saved from the share target and the page's own box,
 * PATCH and DELETE to edit, archive and remove. Images come through the
 * token as object URLs and are kept in Cache Storage, like artwork.
 *
 * Actions (lib/saved-actions.ts): GET /api/saved/:id/actions, POST
 * /api/saved/:id/actions/:action, POST /api/saved/:id/actions/undo.
 *
 * Sample mode answers from db/sample-saved.ts and never touches the network.
 */

import { ApiError, getToken, isSampleMode, request } from "./api";
import { refreshNotes } from "./data";
import { memoryChanged } from "./memory";
import { recordsChanged } from "./records";
import type { SavedFiled, SavedItem, SavedKind } from "../../../lib/saved-rules";
import type { ActionInfo, ActionParam } from "../../../lib/saved-action-rules";

export type { ActionInfo, ActionParam, SavedFiled, SavedItem, SavedKind };

export interface SavedPage {
  items: Array<SavedItem & { match?: string }>;
  counts: Record<SavedKind | "all" | "filed", number>;
  more: boolean;
}

export interface SavedQuery {
  kind?: SavedKind | null;
  q?: string;
  day?: string;
  before?: string;
  limit?: number;
  /** Only what an action filed. */
  filed?: boolean;
}

export interface NewSaved {
  url?: string;
  text?: string;
  title?: string;
  note?: string;
  image?: Blob | null;
  source: "share-target" | "app";
  client_id?: string;
}

const sample = () => import("./sample-saved");

type Listener = () => void;
const listeners = new Set<Listener>();
export function onSavedChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());
/** Saved items changed somewhere else (the live channel): everyone reload. */
export const savedChanged = changed;

/**
 * An action changes things outside Saved on the server: a line on a note or
 * list, a to-do, a Watch & read item, a place. Reload them, as Ask does after
 * its changes, or an open note keeps showing the copy on this device.
 */
function changedOutside(): void {
  void refreshNotes();
  memoryChanged();
  recordsChanged();
}

export async function loadSaved(query: SavedQuery = {}): Promise<SavedPage> {
  if (isSampleMode()) return (await sample()).sampleSavedPage(query);
  const p = new URLSearchParams();
  if (query.kind) p.set("kind", query.kind);
  if (query.q) p.set("q", query.q);
  if (query.day) p.set("day", query.day);
  if (query.before) p.set("before", query.before);
  if (query.limit) p.set("limit", String(query.limit));
  if (query.filed) p.set("filed", "1");
  return request<SavedPage>(`/saved${p.size ? `?${p}` : ""}`);
}

export async function getSavedItem(id: string): Promise<SavedItem> {
  if (isSampleMode()) {
    const item = (await sample()).sampleSavedItem(id);
    if (!item) throw new ApiError("Not found", 404);
    return item;
  }
  return request<SavedItem>(`/saved/${encodeURIComponent(id)}`);
}

export async function saveNew(input: NewSaved): Promise<{ id: string; item: SavedItem; existing: boolean }> {
  if (isSampleMode()) {
    const item = (await sample()).sampleSaveNew(input);
    changed();
    return { id: item.id, item, existing: false };
  }
  const form = new FormData();
  for (const k of ["url", "text", "title", "note", "source", "client_id"] as const) if (input[k]) form.set(k, input[k] as string);
  if (input.image) form.set("image", input.image, "image");
  const token = getToken();
  const res = await fetch("/api/saved", { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = (await res.json().catch(() => ({}))) as { id?: string; item?: SavedItem; error?: string };
  if (!res.ok || !body.item) throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  changed();
  return { id: body.item.id, item: body.item, existing: res.status === 200 };
}

export async function patchSaved(id: string, patch: { title?: string | null; note?: string | null; tags?: string[]; archived?: boolean }): Promise<SavedItem> {
  const out = isSampleMode() ? (await sample()).sampleSavedPatch(id, patch) : await request<SavedItem>(`/saved/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  changed();
  return out;
}

export async function removeSaved(id: string): Promise<void> {
  if (isSampleMode()) (await sample()).sampleSavedDelete(id);
  else await request(`/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
  changed();
}

export async function refetchSaved(id: string): Promise<SavedItem> {
  if (isSampleMode()) return getSavedItem(id);
  const out = await request<SavedItem>(`/saved/${encodeURIComponent(id)}/refetch`, { method: "POST" });
  changed();
  return out;
}

// ---------- images ----------

const CACHE = "athena-saved-v1";
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();

/**
 * Whether an image address is Athena's own API, the only place this device's key is sent: a path on this site under
 * /api/. A full address, even one naming this site, a protocol-relative one or a backslash doesn't count.
 */
export const isOwnApiPath = (url: string): boolean => url.startsWith("/api/") && !url.includes("\\");

/** An object URL for an item's image (or the sample's own file). Null when it can't be had now. */
export function savedImageUrl(item: Pick<SavedItem, "id" | "image_url">, size: "sm" | "lg"): Promise<string | null> {
  const src = item.image_url;
  if (!src) return Promise.resolve(null);
  // Not the API's: a sample's own file, or a picture made on this device. Shown as it is, with no key.
  if (!src.startsWith("/api/")) return Promise.resolve(src);
  if (!isOwnApiPath(src)) return Promise.resolve(null);
  const key = `/saved-cache/${item.id}/${size}`;
  const ready = urls.get(key);
  if (ready) return Promise.resolve(ready);
  let pending = loading.get(key);
  if (!pending) {
    pending = (async () => {
      let blob: Blob | null = null;
      try {
        const hit = await (await caches.open(CACHE)).match(key);
        if (hit) blob = await hit.blob();
      } catch {
        /* no Cache Storage here */
      }
      if (!blob) {
        const token = getToken();
        const res = await fetch(`${src}?size=${size}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
        if (!res?.ok) return null;
        blob = await res.blob();
        void caches.open(CACHE).then((c) => c.put(key, new Response(blob, { headers: { "Content-Type": "image/webp" } }))).catch(() => undefined);
      }
      const url = URL.createObjectURL(blob);
      urls.set(key, url);
      return url;
    })().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** Forget this device's copy of a removed item's image. */
export function forgetSavedImage(id: string): void {
  for (const size of ["sm", "lg"]) {
    const key = `/saved-cache/${id}/${size}`;
    const url = urls.get(key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(key);
    void caches.open(CACHE).then((c) => c.delete(key)).catch(() => undefined);
  }
}

// ---------- actions ----------

export interface SavedActions {
  actions: ActionInfo[];
  filed: SavedFiled | null;
  links: Array<{ kind: string; id: string; title: string }>;
}

export interface ActionResult {
  label: string;
  href: string | null;
  filed: boolean;
  /** Hand it back to undo an action that didn't file (a link). */
  undo: unknown;
  done: string;
}

export async function loadSavedActions(id: string): Promise<SavedActions> {
  if (isSampleMode()) return (await sample()).sampleSavedActions(id);
  return request<SavedActions>(`/saved/${encodeURIComponent(id)}/actions`);
}

export async function runSavedAction(id: string, action: string, params: Record<string, unknown> = {}): Promise<{ item: SavedItem; result: ActionResult }> {
  const out = isSampleMode()
    ? (await sample()).sampleRunAction(id, action, params)
    : await request<{ item: SavedItem; result: ActionResult }>(`/saved/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { method: "POST", body: JSON.stringify({ params }) });
  changed();
  if (!isSampleMode()) changedOutside();
  return out;
}

/** Put a filed item back (its other side reversed too), or reverse an action that didn't file (pass its undo). */
export async function undoSavedAction(id: string, undo?: unknown): Promise<SavedItem> {
  const out = isSampleMode()
    ? (await sample()).sampleUndoAction(id, undo)
    : (await request<{ item: SavedItem }>(`/saved/${encodeURIComponent(id)}/actions/undo`, { method: "POST", body: JSON.stringify(undo === undefined ? {} : { undo }) })).item;
  changed();
  if (!isSampleMode()) changedOutside();
  return out;
}
