/**
 * Rich links' data on the device (docs/notes/rich-links-stage2s.md). The
 * editor (stage 2E) draws links in notes from what this gives it:
 *
 *  - loadPreview(url): a web page's card. This device's copy first, keyed
 *    by normalisePreviewUrl, then GET /api/link-preview. The picture and
 *    favicon are kept in Cache Storage like Saved's pictures, so a card
 *    shows offline. The server is asked again after a day (an hour for a
 *    failed preview), and its copy replaces this one when it's newer.
 *  - liveCard(kind, id): a thing in Athena as it is now, from the app's own
 *    stores (which fall back to this device's copies offline). The last good
 *    card is kept too, and comes back with `stale: true` when nothing fresher
 *    can be had.
 *  - onLiveChange(fn): told when anything a live card shows may have changed.
 *  - The context menu's actions: toggleTodo, logCatchUp, markWatched and
 *    Saved's own actions (savedMoves, moveSaved). Each returns { undo }.
 *
 * Sample mode never touches the network: previews come from a few bundled
 * samples (or a plain card from the address), and live cards from the
 * sample data, with a drawn map and a last visit for places.
 */

import { ApiError, getToken, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { findNote, onNotes } from "./data";
import { findRecord, loadRecords, onRecordsChange, saveRecord } from "./records";
import { loadCommitments, loadReading, logInteraction, onMemoryChange, saveCommitment, saveReading, setMemoryArchived } from "./memory";
import { getSavedItem, loadSavedActions, onSavedChange, runSavedAction, savedImageUrl, undoSavedAction, type ActionResult, type SavedActions } from "./saved";
import { findCustomRecord, kindById, onKindsChange } from "./custom-kinds";
import { mentionById } from "./mentions";
import { deviceZone } from "../lib/time";
import { embedFor } from "../../../lib/embeds";
import { openMapUrl as mapLink } from "../lib/map-app";
import { normalisePreviewUrl } from "../../../lib/link-preview-url";
import type { LinkKind } from "../../../lib/links";
import type { LinkPreview } from "../../../lib/link-previews";
import {
  asStale,
  clockFor,
  eventCard,
  hostOf,
  noteCard,
  personCard,
  placeCard,
  plainCard,
  previewPictureKey,
  previewPlan,
  savedCard,
  serverIsNewer,
  todoCard,
  watchCard,
  type LiveCard,
  type LivePicture,
  type StoredPreview,
} from "./rich-links-rules";
import type { Commitment, InteractionChannel, Person, ReadingItem } from "../types";

export type { LinkPreview, LiveCard, LivePicture };
export type { EventCard, NoteCard, PersonCard, PlaceCard, PlainCard, SavedCard, TodoCard, WatchCard } from "./rich-links-rules";
export type { ActionResult, SavedActions };

/** What every context-menu action returns: Undo for the toast, when it can be undone. */
export interface ActionDone {
  undo?: () => Promise<void>;
}

const online = () => typeof navigator === "undefined" || navigator.onLine;

// ---------- link previews ----------

const PREVIEWS = "athena-link-previews-v1";
const jsonKey = (url: string) => `/link-preview-json/${encodeURIComponent(url)}`;

async function cache(): Promise<Cache | null> {
  try {
    return await caches.open(PREVIEWS);
  } catch {
    return null; // no Cache Storage here (a private window): previews just aren't kept
  }
}

async function readStored(url: string): Promise<StoredPreview | null> {
  try {
    const hit = await (await cache())?.match(jsonKey(url));
    return hit ? ((await hit.json()) as StoredPreview) : null;
  } catch {
    return null;
  }
}

async function writeStored(url: string, stored: StoredPreview): Promise<void> {
  try {
    await (await cache())?.put(jsonKey(url), new Response(JSON.stringify(stored), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // not kept here: fine
  }
}

const objectUrls = new Map<string, string>();

/** A preview's picture or favicon as an object URL: from this device, or fetched once with the token and kept. Null when it can't be had now. */
async function pictureUrl(preview: LinkPreview, which: "image" | "favicon"): Promise<string | null> {
  const src = which === "image" ? preview.image_url : preview.favicon_url;
  if (!src) return null;
  const key = previewPictureKey(preview, which);
  if (!key) return src; // a sample's own file
  const ready = objectUrls.get(key);
  if (ready) return ready;
  const c = await cache();
  let blob: Blob | null = null;
  try {
    const hit = await c?.match(key);
    if (hit) blob = await hit.blob();
  } catch {
    blob = null;
  }
  if (!blob && online()) {
    const token = getToken();
    const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
    if (!res?.ok) return null;
    blob = await res.blob();
    await c?.put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/webp" } })).catch(() => undefined);
  }
  if (!blob) return null;
  const made = URL.createObjectURL(blob);
  objectUrls.set(key, made);
  return made;
}

/** Forget the pictures of a copy that's been replaced (their ?v= changed). */
async function dropPictures(old: LinkPreview, next: LinkPreview): Promise<void> {
  const c = await cache();
  for (const which of ["image", "favicon"] as const) {
    const key = previewPictureKey(old, which);
    if (!key || key === previewPictureKey(next, which)) continue;
    const u = objectUrls.get(key);
    if (u) URL.revokeObjectURL(u);
    objectUrls.delete(key);
    await c?.delete(key).catch(() => undefined);
  }
}

/** The preview as the card draws it: pictures as object URLs this device holds, and the embed from today's rules. */
async function forShowing(p: LinkPreview): Promise<LinkPreview> {
  const [image_url, favicon_url] = await Promise.all([pictureUrl(p, "image"), pictureUrl(p, "favicon")]);
  return {
    ...p,
    image_url,
    favicon_url,
    image_w: image_url ? p.image_w : null,
    image_h: image_url ? p.image_h : null,
    image_tone: image_url ? p.image_tone : null,
    shape: image_url ? p.shape : null,
    embed: embedFor(p.url),
  };
}

async function askServer(url: string, refresh: boolean): Promise<LinkPreview | null> {
  const qs = new URLSearchParams({ url });
  if (refresh) qs.set("refresh", "1");
  try {
    return await request<LinkPreview>(`/link-preview?${qs}`);
  } catch (error) {
    // 400: not a web address. 429 and 503 and no connection: nothing new to be had now.
    if (error instanceof ApiError && error.status === 400) return null;
    throw error;
  }
}

const previewsInFlight = new Map<string, Promise<LinkPreview | null>>();

/**
 * A web page's preview for its card: image_url and favicon_url are object
 * URLs this device holds (or null), ready for an <img>. Null when the
 * address isn't a web address, or there's nothing here and no connection.
 * Pass refresh for the failed card's Try again.
 */
export function loadPreview(url: string, opts: { refresh?: boolean } = {}): Promise<LinkPreview | null> {
  const key = normalisePreviewUrl(url);
  if (!key) return Promise.resolve(null);
  if (isSampleMode()) return import("./sample-rich-links").then((m) => m.samplePreview(key));
  const flight = `${key}\u0000${opts.refresh ? 1 : 0}`;
  let pending = previewsInFlight.get(flight);
  if (!pending) {
    pending = (async () => {
      const stored = await readStored(key);
      const plan = previewPlan(stored, { online: online(), refresh: opts.refresh });
      if (plan === "none") return null;
      if (plan === "cached") return forShowing(stored!.preview);
      let server: LinkPreview | null;
      try {
        server = await askServer(key, !!opts.refresh);
      } catch {
        return stored ? forShowing(stored.preview) : null;
      }
      if (!server) return null;
      const keep = !stored || serverIsNewer(stored.preview, server) ? server : stored.preview;
      if (stored && keep === server) await dropPictures(stored.preview, server);
      await writeStored(key, { preview: keep, checked_at: Date.now() });
      return forShowing(keep);
    })().finally(() => previewsInFlight.delete(flight));
    previewsInFlight.set(flight, pending);
  }
  return pending;
}

// ---------- live cards ----------

const LIVE_KEY = (kind: LinkKind, id: string) => `richLive:${kind}:${id}`;

async function keptCard(kind: LinkKind, id: string): Promise<LiveCard | null> {
  try {
    const raw = await getMeta(LIVE_KEY(kind, id));
    if (!raw) return null;
    const card = asStale(JSON.parse(raw) as LiveCard);
    // The maps app may have changed in Settings since this card was kept.
    if (card.kind === "place") card.openMapUrl = mapLink({ query: card.address || card.name });
    return card;
  } catch {
    return null;
  }
}

/** Keep the last good card, without its object URLs (they don't outlive the page). */
async function keepCard(card: LiveCard): Promise<void> {
  const plain: LiveCard = { ...card, stale: false };
  const strip = (p: LivePicture | null) => (p && p.src.startsWith("blob:") ? null : p);
  if (plain.kind === "person") plain.photo = strip(plain.photo);
  if (plain.kind === "watch") plain.cover = strip(plain.cover);
  if (plain.kind === "saved") plain.image = strip(plain.image);
  if (plain.kind === "place" && plain.mapUrl?.startsWith("blob:")) plain.mapUrl = null;
  await setMeta(LIVE_KEY(card.kind, card.id), JSON.stringify(plain)).catch(() => undefined);
}

const ART_CACHE = "athena-art-v1";

/** Watch & read art, through the same cache as components/art-img.ts. */
async function artPicture(art: ReadingItem["art"]): Promise<LivePicture | null> {
  if (!art) return null;
  const key = `/art-cache/${art.id}/sm`;
  let blob: Blob | null = null;
  try {
    const hit = await (await caches.open(ART_CACHE)).match(key);
    if (hit) blob = await hit.blob();
  } catch {
    blob = null;
  }
  if (!blob && online()) {
    try {
      const { fetchArtBlob } = await import("./art-api");
      blob = await fetchArtBlob(art.id, "sm");
      await (await caches.open(ART_CACHE)).put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/webp" } })).catch(() => undefined);
    } catch {
      blob = null;
    }
  }
  return blob ? { src: URL.createObjectURL(blob), w: art.w, h: art.h, tone: art.tone ?? null } : null;
}

const MAP_CACHE = "athena-maps-v1";
const MAP_REFRESH_MS = 24 * 3_600_000;

/** Athena's still of a Place (GET /api/places/:id/map), kept on the device and asked for again after a day. Null when there's no spot or no key. */
async function placeMapUrl(id: string): Promise<string | null> {
  const theme = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const key = `/place-map-cache/${id}/${theme}/card`;
  let c: Cache | null = null;
  try {
    c = await caches.open(MAP_CACHE);
  } catch {
    c = null;
  }
  const hit = await c?.match(key).catch(() => undefined);
  const keptAt = Number(hit?.headers.get("X-Kept-At")) || 0;
  if (hit && (!online() || Date.now() - keptAt < MAP_REFRESH_MS)) return URL.createObjectURL(await hit.blob());
  if (!online()) return null;
  const token = getToken();
  const res = await fetch(`/api/places/${encodeURIComponent(id)}/map?${new URLSearchParams({ theme, size: "card" })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
  if (!res?.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) {
    // No spot, no key, or the server's down: the last still if there is one.
    return hit ? URL.createObjectURL(await hit.blob()) : null;
  }
  const blob = await res.blob();
  await c?.put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/webp", "X-Kept-At": String(Date.now()) } })).catch(() => undefined);
  return URL.createObjectURL(blob);
}

/** The last day you were at a Place, from GET /api/places/:id/visits; null when it can't be had. */
async function lastVisit(id: string): Promise<string | null> {
  if (!online()) return null;
  try {
    return (await request<{ visits: { last: string | null } | null }>(`/places/${encodeURIComponent(id)}/visits`)).visits?.last ?? null;
  } catch {
    return null;
  }
}

/** One card, fresh from the stores; null when the thing isn't there. */
async function readCard(kind: LinkKind, id: string, kept: LiveCard | null): Promise<LiveCard | null> {
  const clock = clockFor(deviceZone());
  const sample = isSampleMode();
  switch (kind) {
    case "person": {
      const p = await findRecord("person", id);
      return p ? personCard(p, clock) : null;
    }
    case "place": {
      const p = await findRecord("place", id);
      if (!p) return null;
      const openMapUrl = mapLink({ query: p.address || p.name });
      if (sample) {
        const s = await import("./sample-rich-links");
        return placeCard(p, { mapUrl: s.sampleMapStill(p.name), openMapUrl, lastVisit: s.sampleLastVisit(p.id, clock.today) });
      }
      const [mapUrl, visit] = await Promise.all([placeMapUrl(p.id), lastVisit(p.id)]);
      const keptVisit = kept?.kind === "place" ? kept.lastVisit : null;
      return placeCard(p, { mapUrl, openMapUrl, lastVisit: visit ?? keptVisit });
    }
    case "todo": {
      const c = (await loadCommitments()).items.find((x) => x.id === id);
      return c ? todoCard(c, clock) : null;
    }
    case "watch": {
      const r = (await loadReading()).items.find((x) => x.id === id);
      if (!r) return null;
      const cover = sample ? (await import("./sample-rich-links")).sampleCover(r) : await artPicture(r.art);
      return watchCard(r, { cover });
    }
    case "saved": {
      const s = await getSavedItem(id).catch((error) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
      if (!s) return null;
      const src = await savedImageUrl(s, "sm");
      return savedCard(s, { image: src ? { src, w: s.image_w, h: s.image_h, tone: s.image_tone } : null });
    }
    case "event": {
      const e = await findRecord("event", id);
      if (!e) return null;
      const places = /athena:\/\/place\//.test(e.notes ?? "") ? (await loadRecords("place")).items : [];
      return eventCard(e, clock, { placeName: (pid) => places.find((x) => x.id === pid)?.name ?? null });
    }
    case "note": {
      const n = await findNote(id);
      return n ? noteCard(n) : null;
    }
    case "organisation": {
      const o = await findRecord("organisation", id);
      return o ? plainCard("organisation", o.id, o.name, hostOf(o.website) || "Organisation", { archived: !!o.archived_at }) : null;
    }
    case "record": {
      const r = await findCustomRecord(id);
      if (!r) return null;
      const one = kindById(r.kind_id)?.one ?? "";
      return plainCard("record", r.id, r.title, one ? one.charAt(0).toUpperCase() + one.slice(1) : "", { archived: !!r.archived_at });
    }
    case "project": {
      const m = await mentionById("project", id);
      return m ? plainCard("project", m.id, m.title, m.subtitle || "Project") : null;
    }
  }
}

/**
 * A thing in Athena as its live card shows it. Offline, or when the read
 * fails, the last card this device kept comes back with `stale: true`. Null
 * when the thing doesn't exist (or was deleted) and nothing was kept.
 */
export async function liveCard(kind: LinkKind, id: string): Promise<LiveCard | null> {
  const key = id.toLowerCase();
  const kept = isSampleMode() ? null : await keptCard(kind, key);
  let card: LiveCard | null;
  try {
    card = await readCard(kind, key, kept);
  } catch {
    return kept;
  }
  if (!card) return online() ? null : kept;
  if (isSampleMode()) return card;
  if (!online()) return { ...card, stale: true };
  void keepCard(card);
  return card;
}

/**
 * Told when anything a live card shows may have changed: people, places,
 * events and organisations, to-dos, catch-ups and Watch & read, Saved,
 * notes, and the owner's own records. Several changes at once call fn
 * once. Returns the unsubscribe.
 */
export function onLiveChange(fn: () => void): () => void {
  let queued = false;
  const ping = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn();
    });
  };
  let first = true;
  const offs = [
    onRecordsChange(ping),
    onMemoryChange(ping),
    onSavedChange(ping),
    onKindsChange(ping),
    // onNotes calls straight away with what it has; only later changes count.
    onNotes(() => (first ? (first = false) : ping())),
  ];
  queueMicrotask(() => (first = false));
  return () => offs.forEach((off) => off());
}

// ---------- the context menu's actions ----------

/** Tick a to-do, or untick it. Undo puts it back as it was. */
export async function toggleTodo(id: string): Promise<ActionDone & { done: boolean }> {
  const c: Commitment | undefined = (await loadCommitments()).items.find((x) => x.id === id);
  if (!c) throw new ApiError("Not found", 404);
  const before = c.status;
  const next = before === "done" ? "open" : "done";
  await saveCommitment({ status: next }, id);
  return { done: next === "done", undo: async () => void (await saveCommitment({ status: before }, id)) };
}

/**
 * Log a catch-up with someone, now. Their last catch-up moves to today.
 * Undo archives the catch-up and puts their last catch-up date back.
 */
export async function logCatchUp(personId: string, opts: { channel?: InteractionChannel; summary?: string; at?: string } = {}): Promise<ActionDone> {
  const person: Person | null = await findRecord("person", personId);
  if (!person) throw new ApiError("Not found", 404);
  const before = person.last_contacted_at;
  const saved = await logInteraction({ person_ids: [personId], channel: opts.channel ?? "other", summary: opts.summary ?? "", ...(opts.at ? { at: opts.at } : {}) });
  return {
    undo: async () => {
      await setMemoryArchived("interaction", saved.id, true);
      await saveRecord("person", { last_contacted_at: before }, personId);
    },
  };
}

/** Mark a Watch & read title finished. Undo puts its status back. */
export async function markWatched(id: string): Promise<ActionDone> {
  const r = (await loadReading()).items.find((x) => x.id === id);
  if (!r) throw new ApiError("Not found", 404);
  const before = r.status;
  if (before === "done") return {};
  await saveReading({ status: "done" }, id);
  return { undo: async () => void (await saveReading({ status: before }, id)) };
}

/**
 * Saved's "Move to…": the actions Saved already has for an item (Move to
 * Watch & read, Gift idea for…, Add to a list or note, Save to Places, Make
 * a to-do, Link to…), with the one that fits best first, and where it's
 * filed now, if anywhere. lib/saved-action-rules.ts has the list.
 */
export function savedMoves(id: string): Promise<SavedActions> {
  return loadSavedActions(id);
}

/** Run one of Saved's actions on an item. Undo reverses it (and puts a filed item back). */
export async function moveSaved(id: string, action: string, params: Record<string, unknown> = {}): Promise<ActionDone & { result: ActionResult }> {
  const { result } = await runSavedAction(id, action, params);
  return { result, undo: async () => void (await undoSavedAction(id, result.filed ? undefined : result.undo)) };
}
