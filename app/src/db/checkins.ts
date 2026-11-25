/**
 * Check-ins for the app: the routes in lib/checkin-types.ts. Settings are
 * read (and kept for offline) and saved whole; a day's check-in is read,
 * answered one question at a time, and finished.
 *
 * Answers are optimistic, like db/habits.ts: the change shows at once (every
 * listener repaints from the local state), then it's sent. Offline, it waits
 * in IndexedDB ("checkin-outbox") and goes on the next `online`, answers
 * before the "done" that followed them; the PUT is idempotent, so sending one
 * twice is harmless. The last copy of each check-in seen is kept too, so the
 * flow opens with no signal. Sample mode answers from db/sample-checkins.ts
 * and never touches the network.
 */

import { ApiError, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { withAnswer } from "../components/checkin-rules";
import type { Checkin, CheckinKind, CheckinSettings, CheckinSettingsView, CheckinSummary, CheckinTrends, CheckinValue, DeeperReply } from "../../../lib/checkin-types";

export type { Checkin, CheckinKind, CheckinSettings, CheckinSettingsView, CheckinSummary, CheckinTrends, CheckinValue };

const sample = () => import("./sample-checkins");
const OUTBOX = "checkin-outbox";
const SETTINGS_KEY = "checkin-settings";
const cacheKey = (date: string, kind: CheckinKind) => `checkin:${date}:${kind}`;
const path = (date: string, kind: CheckinKind) => `/checkins/${encodeURIComponent(date)}/${kind}`;

type Listener = () => void;
const listeners = new Set<Listener>();
export function onCheckinsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());
/** A check-in or the set-up changed on another device or through MCP (app/src/live): views read again. */
export const checkinsChanged = changed;

/** Not sent yet. "date|kind|question id" → the answer (null: taken back), or "date|kind|" → done. */
type Queued = { value: CheckinValue | null; at: string } | { done: true; at: string };
const pending = new Map<string, Queued>();

const isOffline = (error: unknown) => !(error instanceof ApiError) || error.status === 0;

function withPending(c: Checkin): Checkin {
  let out = c;
  for (const [k, q] of pending) {
    const [date, kind, id] = k.split("|");
    if (date !== c.date || kind !== c.kind) continue;
    if ("done" in q) out = { ...out, status: "done", done_at: out.done_at ?? q.at };
    else out = withAnswer(out, id, q.value, q.at);
  }
  return out;
}

// ---------- Settings ----------

export async function loadCheckinSettings(): Promise<CheckinSettingsView> {
  if (isSampleMode()) return (await sample()).sampleCheckinSettings();
  try {
    const view = await request<CheckinSettingsView>("/checkins/settings");
    void setMeta(SETTINGS_KEY, JSON.stringify(view)).catch(() => undefined);
    return view;
  } catch (error) {
    const cached = await getMeta(SETTINGS_KEY).catch(() => undefined);
    if (cached && isOffline(error)) return JSON.parse(cached) as CheckinSettingsView;
    throw error;
  }
}

/** Save the whole set-up. Needs a connection; throws when there's none. */
export async function saveCheckinSettings(next: CheckinSettings): Promise<CheckinSettingsView> {
  const body: CheckinSettings = { morning: next.morning, evening: next.evening, own: next.own };
  const view = isSampleMode() ? await (await sample()).saveSampleCheckinSettings(body) : await request<CheckinSettingsView>("/checkins/settings", { method: "PUT", body: JSON.stringify(body) });
  if (!isSampleMode()) void setMeta(SETTINGS_KEY, JSON.stringify(view)).catch(() => undefined);
  changed();
  return view;
}

// ---------- A day's check-in ----------

export async function loadCheckin(date: string, kind: CheckinKind): Promise<Checkin> {
  if (isSampleMode()) return withPending(await (await sample()).sampleCheckin(date, kind));
  try {
    const c = await request<Checkin>(path(date, kind));
    void setMeta(cacheKey(date, kind), JSON.stringify(c)).catch(() => undefined);
    return withPending(c);
  } catch (error) {
    const cached = await getMeta(cacheKey(date, kind)).catch(() => undefined);
    if (cached && isOffline(error)) return withPending(JSON.parse(cached) as Checkin);
    throw error;
  }
}

/** Days with a check-in, for a dot or a streak (at most 400 days). */
export async function loadCheckinRange(from: string, to: string): Promise<CheckinSummary[]> {
  if (isSampleMode()) return (await sample()).sampleCheckinRange(from, to);
  return request<CheckinSummary[]>(`/checkins?${new URLSearchParams({ from, to })}`);
}

/**
 * The scale answers and picks over a range, for Health → Wellness (at most two years). Not kept on
 * the device, like Health's figures; throws when there's no connection.
 */
export async function loadCheckinTrends(from: string, to: string): Promise<CheckinTrends> {
  if (isSampleMode()) return (await sample()).sampleCheckinTrends(from, to);
  return request<CheckinTrends>(`/checkins/trends?${new URLSearchParams({ from, to })}`);
}

/** Keep the cached copy in step with a change made here, so an offline reopen shows it. */
async function patchCache(date: string, kind: CheckinKind, fn: (c: Checkin) => Checkin): Promise<void> {
  if (isSampleMode()) return;
  const cached = await getMeta(cacheKey(date, kind)).catch(() => undefined);
  if (cached) await setMeta(cacheKey(date, kind), JSON.stringify(fn(JSON.parse(cached) as Checkin))).catch(() => undefined);
}

async function readOutbox(): Promise<Record<string, Queued>> {
  try {
    return JSON.parse((await getMeta(OUTBOX)) ?? "{}") as Record<string, Queued>;
  } catch {
    return {};
  }
}

/** Changes to the outbox, one at a time: the last answer and "done" land together, and neither may overwrite the other. */
let boxTurn: Promise<void> = Promise.resolve();
function changeOutbox(fn: (box: Record<string, Queued>) => boolean): Promise<void> {
  const turn = boxTurn.then(async () => {
    const box = await readOutbox();
    if (fn(box)) await setMeta(OUTBOX, JSON.stringify(box)).catch(() => undefined);
  });
  boxTurn = turn.catch(() => undefined);
  return turn;
}

const queue = (k: string, q: Queued) =>
  changeOutbox((box) => {
    box[k] = q;
    return true;
  });

async function send(k: string, q: Queued): Promise<void> {
  const [date, kind, id] = k.split("|") as [string, CheckinKind, string];
  if (isSampleMode()) {
    const s = await sample();
    if ("done" in q) await s.finishSampleCheckin(date, kind);
    else await s.answerSampleCheckin(date, kind, id, q.value);
    return;
  }
  if ("done" in q) await request<Checkin>(`${path(date, kind)}/done`, { method: "POST" });
  else if (q.value === null) await request<Checkin>(`${path(date, kind)}/answers/${encodeURIComponent(id)}`, { method: "DELETE" });
  else await request<Checkin>(`${path(date, kind)}/answers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(q.value) });
}

async function optimistic(k: string, q: Queued, cache: (c: Checkin) => Checkin): Promise<"saved" | "queued"> {
  const [date, kind] = k.split("|") as [string, CheckinKind];
  const was = pending.get(k);
  pending.set(k, q);
  changed();
  void patchCache(date, kind, cache);
  try {
    await send(k, q);
    if (pending.get(k) === q) pending.delete(k);
    // An older copy still queued from offline would overwrite this one when it goes.
    await changeOutbox((box) => k in box && delete box[k]);
    return "saved";
  } catch (error) {
    if (!isOffline(error)) {
      if (pending.get(k) === q) {
        if (was) pending.set(k, was);
        else pending.delete(k);
      }
      changed();
      throw error;
    }
    // No connection: keep it, send it when there is one.
    await queue(k, q);
    return "queued";
  }
}

/**
 * Answer one question (null takes the answer back out). Shows at once;
 * resolves when it's saved, or queued because there's no connection. Throws
 * only when the server refused it, after putting things back.
 */
export function answerCheckin(date: string, kind: CheckinKind, questionId: string, value: CheckinValue | null): Promise<"saved" | "queued"> {
  const at = new Date().toISOString();
  return optimistic(`${date}|${kind}|${questionId}`, { value, at }, (c) => withAnswer(c, questionId, value, at));
}

/** Mark the check-in done (POST done). Offline it waits behind the answers. */
export function finishCheckin(date: string, kind: CheckinKind): Promise<"saved" | "queued"> {
  const at = new Date().toISOString();
  return optimistic(`${date}|${kind}|`, { done: true, at }, (c) => ({ ...c, status: "done", done_at: c.done_at ?? at }));
}

/** Athena's one follow-up to a written answer. Null when the model isn't set up, didn't answer, or there's no connection. */
export async function askDeeper(date: string, kind: CheckinKind, questionId: string, text: string): Promise<string | null> {
  if (isSampleMode()) return (await (await sample()).sampleDeeper(text)).question;
  if (typeof navigator !== "undefined" && !navigator.onLine) return null;
  try {
    const reply = await request<DeeperReply>(`${path(date, kind)}/deeper`, { method: "POST", body: JSON.stringify({ question_id: questionId, text }) });
    return reply.question ?? null;
  } catch {
    return null;
  }
}

/** Anything still waiting to go. */
export const checkinsWaiting = (): number => pending.size;

let flushing = false;
/** Send what's queued, in the order it was queued. Called on load and on `online`. */
export async function flushCheckinOutbox(): Promise<void> {
  if (flushing || isSampleMode()) return;
  flushing = true;
  try {
    const box = await readOutbox();
    for (const [k, q] of Object.entries(box)) {
      try {
        await send(k, q);
      } catch (error) {
        if (isOffline(error)) return; // still offline
        // Refused (a removed question, a bad value): drop it rather than block the rest.
      }
      // Only this copy: a newer one queued meanwhile stays.
      await changeOutbox((now) => now[k]?.at === q.at && delete now[k]);
      if (pending.get(k)?.at === q.at) pending.delete(k);
    }
    changed();
  } finally {
    flushing = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flushCheckinOutbox());
  void readOutbox().then((box) => {
    for (const [k, q] of Object.entries(box)) pending.set(k, q);
    if (Object.keys(box).length) void flushCheckinOutbox();
  });
}
