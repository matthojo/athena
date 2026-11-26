/**
 * Thin fetch wrapper around the `/api/*` contract described in the project
 * brief. Called by: sync.ts (flush/pull), views/connect.ts (token + health
 * check), views/capture.ts (search + ask), views/dashboard.ts (metrics,
 * people). Every call here can fail (network down, backend not deployed yet)
 * — callers are expected to catch and fall back to the IndexedDB cache or
 * sample-data.ts rather than show a dead screen.
 *
 * Token storage: localStorage (synchronous, so every fetch can attach the
 * header without an await chain). The brief allows IndexedDB *or*
 * localStorage for this; localStorage is the pragmatic choice here since the
 * token must be read on the hot path of every request. What's stored is this
 * device's own key, never the master token (see "This device's key" below).
 */

import { followRun } from "../lib/ask-run";
import { retryAfterEvent, retryAfterSeconds } from "../lib/ask-retry";
import { wholeReply, type AskReply } from "../lib/ask-contract";
import { runAnywayFlag } from "./run-anyway";
import type { MailLabel, MailPreview, MailRules } from "../../../lib/mail-rules";
import type { NotificationPrefs } from "../../../lib/nudges";
import type { AnswerTurn } from "../../../lib/answer-text";
import type { TextEvent } from "../lib/ask-stream";
import type {
  AnyRecord,
  ApiKey,
  ArchivableKind,
  ArchivedItem,
  AskFile,
  AskThread,
  AskStep,
  Collection,
  CollectionRun,
  RunItem,
  Connector,
  ConnectorsState,
  Connections,
  DraftChannel,
  MessageDraft,
  EntityKind,
  EntityRef,
  Graph,
  Identity,
  IdentityKind,
  LogisticsKind,
  MemoryKind,
  MetricPoint,
  Note,
  NotePatch,
  NoteType,
  Person,
  PersonBrief,
  Purchase,
  PurchaseFields,
  Booking,
  BookingFields,
  PurchaseStatus,
  RecallHit,
  RecordKind,
  Reminder,
  ReminderInput,
  Suggestion,
  Trip,
  Upcoming,
  WeeklyReview,
  Rsvp,
  RsvpResult,
} from "../types";

const TOKEN_KEY = "athena.token";
const MODE_KEY = "athena.mode";
const API_BASE = "/api";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * "Sample mode": the user picked "Look around with sample data" on the Connect
 * screen instead of pasting a token. Persisted so an installed PWA's cold
 * launch (every launch reloads the page) doesn't bounce them back to Connect
 * every time. The dashboard's and Capture's "Sample data" status pill is the
 * documented way back out — see exitSampleMode().
 */
export function isSampleMode(): boolean {
  return localStorage.getItem(MODE_KEY) === "sample";
}

export function setSampleMode(): void {
  localStorage.setItem(MODE_KEY, "sample");
}

export function exitSampleMode(): void {
  localStorage.removeItem(MODE_KEY);
  clearToken();
  location.reload();
}

export function hasToken(): boolean {
  return !!getToken();
}

// ---------- This device's key ----------
// The app signs in with a full key made for this device (lib/api-keys.ts,
// athk_…), which Settings can remove. The master token is only ever used to
// make that key, and isn't kept.

/** A key Athena made (full or capture), as opposed to the master token. */
export const isApiKey = (token: string): boolean => /^ath[ck]_/.test(token);

/** What this device's key is called in Settings: "Athena app, Safari on iPhone". */
export function deviceName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux|CrOS/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const where = browser && os ? `${browser} on ${os}` : browser || os;
  return where ? `Athena app, ${where}` : "Athena app";
}

/** Make this device's key with the master token. The master token goes no further than this request. */
async function makeDeviceKey(master: string, init: RequestInit = {}): Promise<string> {
  const { token } = await requestWithMaster<{ token: string }>(master, "/api-keys", { ...init, method: "POST", body: JSON.stringify({ label: deviceName(), scope: "full" }) });
  if (!/^athk_/.test(token)) throw new ApiError("Athena didn't return a key");
  return token;
}

/**
 * Sign out: ask the server to remove this device's own key (DELETE
 * /api/api-keys/self, 204). Only ever sent with a full key, never with a
 * master token an older install might still hold. False when there was no key
 * to remove or the server didn't confirm.
 */
export async function removeOwnKey(): Promise<boolean> {
  const token = getToken();
  if (!token || !/^athk_/.test(token)) return false;
  const res = await fetch(`${API_BASE}/api-keys/self`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  return res.ok;
}

export type SignInResult = { ok: true } | { ok: false; reason: "refused" | "unreachable" | "error"; message?: string };

/**
 * Connect: a pasted key is kept as it is; a pasted master token is used once
 * to make this device's key, and only the key is kept.
 */
export async function signIn(pasted: string): Promise<SignInResult> {
  const token = pasted.trim();
  if (token.startsWith("athc_")) return { ok: false, reason: "error", message: "That's a capture key, which can't open the app. Paste a full key or your access token." };
  if (isApiKey(token)) {
    setToken(token);
    return { ok: true };
  }
  try {
    setToken(await makeDeviceKey(token));
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status === undefined) return { ok: false, reason: error instanceof ApiError ? "error" : "unreachable", message: error instanceof Error ? error.message : undefined };
    if (error.status === 401 || error.status === 403) return { ok: false, reason: "refused" };
    return { ok: false, reason: error.status >= 500 ? "unreachable" : "error", message: error.message };
  }
}

/** Whether this browser holds something other than a key Athena made: the master token an older install kept. */
export function holdsMasterToken(): boolean {
  const held = getToken();
  return !!held && !isApiKey(held);
}

/** How long launch waits for the swap before giving up on it. */
const SWAP_WAIT_MS = 8000;

/**
 * An install from before device keys still holds the master token. On launch
 * (main.ts, before anything else uses it) it's swapped once for this device's
 * key when the browser is online. Offline, or if the swap fails, it's dropped
 * and Connect asks again: the master token isn't kept, or used for anything
 * else. Sample mode makes no request and drops it too. Resolves to whether a
 * key was made. One tab at a time, so two don't make two keys.
 */
export async function swapMasterForKey(online: boolean = typeof navigator === "undefined" || navigator.onLine !== false): Promise<boolean> {
  const swap = async () => {
    const held = getToken();
    if (!held || isApiKey(held)) return false;
    if (online && !isSampleMode()) {
      try {
        setToken(await makeDeviceKey(held, { signal: AbortSignal.timeout(SWAP_WAIT_MS) }));
        return true;
      } catch {
        // Dropped below.
      }
    }
    if (getToken() === held) clearToken();
    return false;
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request("athena-key-swap", swap) : swap();
}

export class ApiError extends Error {
  /** `retryAfter`: a 429's Retry-After, in seconds, when it gave one (lib/ask-retry.ts). */
  constructor(message: string, public status?: number, public retryAfter?: number) {
    super(message);
  }
}

/** URL collection for each kind (mirrors netlify/functions/api.ts). */
export const COLLECTION: Record<EntityKind, string> = {
  note: "notes",
  person: "people",
  place: "places",
  organisation: "organisations",
  event: "events",
  project: "projects",
  record: "records",
};

/** URL collection for each layer-2 kind (lib/memory.ts). */
export const MEMORY_COLLECTION: Record<MemoryKind, string> = {
  commitment: "commitments",
  interaction: "interactions",
  fact: "facts",
  asset: "assets",
  reading: "reading",
  goal: "goals",
};

/** URL collection for trips, bookings and purchases (lib/trips.ts). */
export const LOGISTICS_COLLECTION: Record<LogisticsKind, string> = {
  trip: "trips",
  booking: "bookings",
  purchase: "purchases",
};

const collectionFor = (kind: ArchivableKind) =>
  kind === "kind"
    ? "kinds"
    : kind in LOGISTICS_COLLECTION
    ? LOGISTICS_COLLECTION[kind as LogisticsKind]
    : kind in MEMORY_COLLECTION
      ? MEMORY_COLLECTION[kind as MemoryKind]
      : COLLECTION[kind as EntityKind];

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return send<T>(getToken(), path, init);
}

/**
 * One call with the master token the owner has just typed (Settings → API
 * keys: listing, making and removing keys answer 403 `master_required` to a
 * device key). The token is used for this request only and never stored.
 */
export function requestWithMaster<T>(master: string, path: string, init?: RequestInit): Promise<T> {
  return send<T>(master.trim(), path, init);
}

async function send<T>(token: string | null, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON; keep the status line
    }
    throw new ApiError(message, res.status, retryAfterSeconds(res.headers.get("Retry-After")));
  }
  return (await res.json()) as T;
}

/**
 * Where encryption at rest stands (lib/encryption.ts): "locked" on a deploy
 * preview, which can't read the encrypted data; "encrypting" while existing
 * data is being sealed after the key is set.
 */
export async function fetchEncryption(): Promise<{ state: "off" | "encrypting" | "on" | "locked"; remaining: number }> {
  return request("/encryption");
}

export async function checkHealth(): Promise<boolean> {
  try {
    const result = await request<{ ok: boolean }>("/health");
    return !!result.ok;
  } catch {
    return false;
  }
}

export async function createNote(input: NotePatch & { body: string }): Promise<Note> {
  return request<Note>("/notes", { method: "POST", body: JSON.stringify(input) });
}

export async function fetchNotes(
  params: { since?: string; type?: NoteType; limit?: number; includeArchived?: boolean } = {}
): Promise<Note[]> {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.includeArchived) qs.set("include_archived", "1");
  if (params.type) qs.set("type", params.type);
  if (params.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  const { notes } = await request<{ notes: Note[] }>(`/notes${query ? `?${query}` : ""}`);
  return notes;
}

/** How a streamed Ask reply is followed: its words as they're written, and Stop (aborting stops the server too). */
export interface ReplyStream {
  onText?: (e: TextEvent) => void;
  signal?: AbortSignal;
  /** A skill the owner picked with "/" (its id). */
  skill?: string;
  /** The conversation, for What Ask did (the written answer). */
  threadId?: string;
  /** This reply's run, an id the app chose: sent again under it, the server follows the run and never repeats it (lib/ask-run.ts). */
  run?: string;
  /** One of the Team's assistants this conversation is with; the server answers as it. */
  assistantId?: string;
  /** This message only, in place of the chosen thinking model: the owner picked it when warned the chosen one can't see a photo. */
  model?: import("../../../lib/model-types").ModelRef;
}

/** The server keeps Ask's runs going without the app (netlify/server/assistant/runs.ts). Known once it has said so. */
let keepsRuns = false;
export const serverKeepsRuns = (): boolean => keepsRuns;

/** Ask opened: wake the server and let it get ready (the connected accounts, today's context). It answers at once. */
export async function warmAsk(): Promise<void> {
  try {
    keepsRuns = (await request<{ runs?: boolean }>("/assistant/warm", { method: "POST" })).runs === true || keepsRuns;
  } catch {
    // Not there (an older server), offline or signed out: a question still works.
  }
}

/** A reply the app has only the run's id for (it was closed part-way, or its connection dropped): follow it, or how it ended. ApiError 404 when the server doesn't know it. */
export async function resumeRun(run: string, onStep: (step: AskStep) => void, live: ReplyStream = {}): Promise<AskReply> {
  return wholeReply(await streamed<unknown>(`/assistant/runs/${run}`, { method: "GET", signal: live.signal }, onStep, live.onText, run));
}

/** Either signal ends it (Stop, or the answer's time limit). */
function eitherSignal(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a || !b) return a ?? b;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  return c.signal;
}

/**
 * Ask: one message to Athena's one assistant (POST /api/assistant, lib/answer.ts runAsk). It answers from Athena,
 * the connected accounts and the web, and makes, plans or prepares whatever the message asked to be changed, as one
 * reply. Spends AI Gateway credits. With onStep, its steps arrive as it works.
 */
export async function askAthena(question: string, history: AnswerTurn[], onStep?: (step: AskStep) => void, files: string[] = [], earlier: string[] = [], live: ReplyStream = {}): Promise<AskReply> {
  const init = { method: "POST", body: JSON.stringify({ question, history, ...runAnywayFlag(question), ...(files.length ? { files } : {}), ...(earlier.length ? { earlier } : {}), ...(live.skill ? { skill: live.skill } : {}), ...(live.threadId ? { thread_id: live.threadId } : {}), ...(live.assistantId ? { assistantId: live.assistantId } : {}), ...(live.model ? { model: live.model } : {}) }), signal: answerSignal(live, !!onStep) };
  return wholeReply(await (onStep ? streamed<unknown>("/assistant", init, onStep, live.onText, live.run) : request<unknown>("/assistant", init)));
}

/**
 * How long the app waits for a written answer. A run the server keeps has no clock here: the server has its
 * own hard stop, and the app may be in the background for longer than any limit. Otherwise it's the server's
 * two minutes and a little more.
 */
function answerSignal(live: ReplyStream, streaming: boolean): AbortSignal | undefined {
  return streaming && live.run && keepsRuns ? live.signal : eitherSignal(AbortSignal.timeout(150_000), live.signal);
}

// ---------- "Let Ask search the web" ----------

const SAMPLE_ASK_WEB = "athena.sample.askWeb";

/** Whether Ask may search the web when your own notes and accounts don't answer (GET /api/profile/ask-web). On by default. */
export async function loadAskWeb(): Promise<boolean> {
  if (isSampleMode()) return localStorage.getItem(SAMPLE_ASK_WEB) !== "off";
  return (await request<{ on: boolean }>("/profile/ask-web")).on !== false;
}

export async function setAskWeb(on: boolean): Promise<boolean> {
  if (isSampleMode()) {
    localStorage.setItem(SAMPLE_ASK_WEB, on ? "on" : "off");
    return on;
  }
  return (await request<{ on: boolean }>("/profile/ask-web", { method: "PUT", body: JSON.stringify({ on }) })).on;
}

/** A streamed reply stopped before it finished (the connection dropped, or the server was cut off). Nothing's known about how it ended. */
export class StreamBroken extends Error {
  constructor() {
    super("The reply stopped part-way");
    this.name = "StreamBroken";
  }
}

/**
 * The same request with Accept: application/x-ndjson: the server sends a
 * {type:"step"} line per step, {type:"text"} lines with the reply's words as
 * they're written, then {type:"done", reply} or {type:"error"}
 * (netlify/functions/api.ts). A server that answers with plain JSON is read
 * as before. Throws ApiError for an error, StreamBroken if it stops early.
 */
async function streamed<T>(path: string, init: RequestInit, onStep: (step: AskStep) => void, onText?: (e: TextEvent) => void, run?: string): Promise<T> {
  if (!run) return streamOnce<T>(path, init, onStep, onText);
  // Under a run id: a dropped connection is followed up, not failed (lib/ask-run.ts), once the server is known to keep runs.
  const stop = init.signal ?? undefined;
  // Stop reaches the server too: the run would otherwise carry on without the app.
  const tellServer = () => void (keepsRuns && request(`/assistant/runs/${run}`, { method: "DELETE" }).catch(() => undefined));
  stop?.addEventListener("abort", tellServer, { once: true });
  try {
    return await followRun<T>((heard) => streamOnce<T>(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Ask-Run": run } }, onStep, onText, heard), {
      signal: stop,
      // No connection, one that went quiet, or the platform answering for a server that's restarting.
      dropped: (error) => keepsRuns && (error instanceof StreamBroken || error instanceof TypeError || (error instanceof ApiError && (error.status === 502 || error.status === 504))),
    });
  } finally {
    stop?.removeEventListener("abort", tellServer);
  }
}

/** The server sends a blank line every 10 seconds, and its first headers within 20: quieter than this, the connection has gone. */
const QUIET_MS = 35_000;

/** One connection's worth of a streamed reply. `heard` (a followed run): called whenever the server says anything. */
async function streamOnce<T>(path: string, init: RequestInit, onStep: (step: AskStep) => void, onText?: (e: TextEvent) => void, heard?: () => void): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/x-ndjson, application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // A followed run gives up on a connection that's gone quiet, and is then sent again.
  const quiet = heard ? new AbortController() : null;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeard = Date.now();
  const listen = () => {
    if (!quiet) return;
    lastHeard = Date.now();
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => quiet.abort(), QUIET_MS);
  };
  // Back in the foreground: timers were asleep too, so check straight away rather than wait one out.
  const onShow = () => document.visibilityState === "visible" && Date.now() - lastHeard > QUIET_MS / 2 && quiet?.abort();
  const unlisten = () => {
    clearTimeout(quietTimer);
    if (quiet) document.removeEventListener("visibilitychange", onShow);
  };
  if (quiet) document.addEventListener("visibilitychange", onShow);
  listen();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: eitherSignal(init.signal ?? undefined, quiet?.signal) });
  } catch (error) {
    unlisten();
    if (quiet?.signal.aborted && !init.signal?.aborted) throw new StreamBroken();
    throw error;
  }
  if (res.headers.get("x-ask-run")) keepsRuns = true;
  heard?.();
  listen();
  if (!res.ok) {
    unlisten();
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON; keep the status line
    }
    throw new ApiError(message, res.status, retryAfterSeconds(res.headers.get("Retry-After")));
  }
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) {
    unlisten();
    return (await res.json()) as T;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      listen();
      buffered += value;
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        heard?.();
        let event: { type?: string; reply?: unknown; status?: number; message?: string; retry_after?: unknown; delta?: unknown; reset?: unknown } & Partial<AskStep>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "step" && typeof event.id === "string" && typeof event.text === "string") {
          onStep({ id: event.id, text: event.text, done: !!event.done, acts: !!event.acts, dropped: !!event.dropped, changes: Array.isArray(event.changes) ? event.changes : undefined });
        } else if (event.type === "text") {
          // The reply's words as they're written (lib/ask-stream.ts).
          if (event.reset === true) onText?.({ reset: true });
          else if (typeof event.delta === "string") onText?.({ delta: event.delta });
        } else if (event.type === "done") {
          void reader.cancel().catch(() => undefined);
          return event.reply as T;
        } else if (event.type === "error") {
          void reader.cancel().catch(() => undefined);
          // A busy server says how long to wait in the event itself (`retry_after`, seconds): a stream has no header for it.
          throw new ApiError(event.message || "Something went wrong", event.status || 500, retryAfterEvent(event.retry_after));
        }
      }
    }
  } catch (error) {
    // Gone quiet (our own abort) is a dropped connection, not a Stop.
    const gaveUp = !!quiet?.signal.aborted && !init.signal?.aborted;
    if (!gaveUp && (error instanceof ApiError || (error as { name?: string })?.name === "TimeoutError" || (error as { name?: string })?.name === "AbortError")) throw error;
  } finally {
    unlisten();
  }
  throw new StreamBroken();
}

/** Ask's conversations changed since a sync (server clock), with every live id (lib/ask-threads.ts). */
export async function fetchAskThreads(since?: string): Promise<{ threads: AskThread[]; ids: string[]; now: string }> {
  return request(`/ask-threads${since ? `?${new URLSearchParams({ since }).toString()}` : ""}`);
}

/** Save a whole conversation; the server keeps the newer of the two and returns it. */
export async function saveAskThread(thread: AskThread): Promise<AskThread> {
  const { id, title, messages, archived_at, created_at, updated_at, assistant_id } = thread;
  // A conversation with a Team assistant says whose it is, so every device files it under that assistant.
  return request(`/ask-threads/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ title, messages, archived_at: archived_at ?? null, created_at, updated_at, ...(assistant_id ? { assistant_id } : {}) }) });
}

export async function deleteAskThread(id: string): Promise<void> {
  await request(`/ask-threads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Have Athena write a message (for a to-do, or to a person about something), on a channel or the usual one. Nothing is saved or sent. */
export async function composeDraft(req: {
  commitment_id?: string;
  person_id?: string;
  recipient_name?: string;
  about?: string;
  channel?: DraftChannel;
  instruction?: string;
  previous?: { subject: string; body: string; channel?: DraftChannel };
}): Promise<MessageDraft> {
  return request("/assistant/draft", { method: "POST", body: JSON.stringify(req) });
}

/** Put a draft in Gmail or Outlook Drafts (an account with drafts turned on). Athena never sends. */
export async function saveDraftToMail(input: {
  connector_id: string;
  to: string[];
  subject: string;
  body: string;
  reply: MessageDraft["reply"];
}): Promise<NonNullable<MessageDraft["saved"]>> {
  return request("/assistant/save-draft", { method: "POST", body: JSON.stringify(input) });
}
/** The old name. */
export const saveDraftToGmail = saveDraftToMail;

/** Reverse one change from an assistant reply (archive what it made, or restore what it changed). */
export async function undoAssistantChange(undo: Record<string, unknown>, activityId?: string): Promise<void> {
  // Sample mode's receipts change nothing, so there's nothing to take back.
  if (isSampleMode()) return;
  await request("/assistant/undo", { method: "POST", body: JSON.stringify({ undo, ...(activityId ? { activity_id: activityId } : {}) }) });
}

/** One live note; a 404 (ApiError) when it's archived or gone. */
export async function fetchNote(id: string): Promise<Note> {
  return request<Note>(`/notes/${encodeURIComponent(id)}`);
}

/** The server returns full note rows (lib/db.ts searchNotesByKeyword), not a reduced shape. */
export async function search(q: string, limit = 20): Promise<Note[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  const { results } = await request<{ results: Note[] }>(`/search?${qs.toString()}`);
  return results;
}

export async function fetchMetricNames(): Promise<string[]> {
  const { metrics } = await request<{ metrics: string[] }>("/metrics");
  return metrics;
}

export async function fetchMetricPoints(
  metric: string,
  params: { since?: string; limit?: number } = {}
): Promise<MetricPoint[]> {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  const { points } = await request<{ points: MetricPoint[] }>(
    `/metrics/${encodeURIComponent(metric)}${query ? `?${query}` : ""}`
  );
  return points;
}

export async function fetchPeople(): Promise<Person[]> {
  const { people } = await request<{ people: Person[] }>("/people");
  return people;
}

export async function fetchStalePeople(days = 60): Promise<Person[]> {
  const { people } = await request<{ people: Person[] }>(`/people/stale?days=${days}`);
  return people;
}

/**
 * `editor`: the change was typed in the note editor (sync.ts's queued edits).
 * The server groups those into at most one kept version per ten minutes; the
 * header goes on these note PATCH requests and nowhere else.
 */
export async function updateNote(id: string, patch: NotePatch, opts: { editor?: boolean } = {}): Promise<Note> {
  return request<Note>(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch), headers: opts.editor ? { "X-Athena-Editor": "1" } : undefined });
}

/** Permanent delete — the app's manual, confirmed action only. */
export async function deleteEntity(kind: ArchivableKind, id: string, opts: { files?: boolean } = {}): Promise<void> {
  // files: a note's files go too, even where a conversation still has them.
  await request(`/${collectionFor(kind)}/${encodeURIComponent(id)}${opts.files ? "?files=delete" : ""}`, { method: "DELETE" });
}

export async function setArchived(kind: ArchivableKind, id: string, archived: boolean): Promise<void> {
  await request(`/${collectionFor(kind)}/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`, { method: "POST" });
}

export async function searchEntities(q: string, kinds: EntityKind[] = [], limit = 8): Promise<EntityRef[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  if (kinds.length) qs.set("kinds", kinds.join(","));
  const { results } = await request<{ results: EntityRef[] }>(`/entities/search?${qs.toString()}`);
  return results;
}

export async function fetchConnections(kind: EntityKind, id: string): Promise<Connections> {
  return request<Connections>(`/connections/${kind}/${encodeURIComponent(id)}`);
}

/** Every live node and the links between them (the Graph page). */
export async function fetchGraph(): Promise<Graph> {
  return request<Graph>("/graph");
}

/** Create (or, with `id` in the body, update) a person/place/organisation/event/project. */
export async function saveRecord<T>(kind: Exclude<EntityKind, "note">, input: Record<string, unknown>, id?: string): Promise<T> {
  return id
    ? request<T>(`/${COLLECTION[kind]}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })
    : request<T>(`/${COLLECTION[kind]}`, { method: "POST", body: JSON.stringify(input) });
}

/** Your answer to an invite: saved in Athena, and sent to the calendar when its account allows it. */
export async function answerEvent(id: string, answer: Rsvp, opts: { series?: boolean } = {}): Promise<RsvpResult> {
  return request<RsvpResult>(`/events/${encodeURIComponent(id)}/rsvp`, { method: "POST", body: JSON.stringify(opts.series ? { answer, series: true } : { answer }) });
}

export async function listRecords(kind: RecordKind): Promise<AnyRecord[]> {
  const { items } = await request<{ items: AnyRecord[] }>(`/${COLLECTION[kind]}?limit=500`);
  return items;
}

export async function getRecord(kind: RecordKind, id: string): Promise<AnyRecord> {
  return request<AnyRecord>(`/${COLLECTION[kind]}/${encodeURIComponent(id)}`);
}

/** Coming up, with days and times in this device's time zone. */
export async function fetchUpcoming(days = 6, tz?: string): Promise<Upcoming> {
  const qs = new URLSearchParams({ days: String(days) });
  if (tz) qs.set("tz", tz);
  return request<Upcoming>(`/upcoming?${qs.toString()}`);
}

/** Tell the server which time zone the owner is in (it runs the briefing and "daily at" times in it). */
export async function saveTimeZone(timezone: string): Promise<void> {
  await request("/settings", { method: "PUT", body: JSON.stringify({ timezone }) });
}

/** The owner's settings that are the same on every device. */
export async function fetchSettings(): Promise<{ timezone: string; mood_style?: string; draft_channels?: DraftChannel[]; theme?: { choice?: unknown; themes?: unknown } }> {
  return request("/settings");
}

/** The messaging apps the owner uses for drafts, for every device (lib/draft-prefs.ts on the server). */
export async function saveDraftChannelsSetting(draft_channels: DraftChannel[]): Promise<void> {
  await request("/settings", { method: "PUT", body: JSON.stringify({ draft_channels }) });
}

/** The chosen theme and the owner's own themes, for every device (lib/theme-prefs.ts on the server). */
export async function saveThemeSetting(theme: { choice: string; themes: unknown[] }): Promise<void> {
  await request("/settings", { method: "PUT", body: JSON.stringify({ theme }) });
}

/** The Days mood style, for every device (lib/day-prefs.ts on the server). */
export async function saveMoodStyleSetting(mood_style: string): Promise<void> {
  await request("/settings", { method: "PUT", body: JSON.stringify({ mood_style }) });
}

export async function fetchArchived(): Promise<ArchivedItem[]> {
  const { items } = await request<{ items: ArchivedItem[] }>("/archived");
  return items;
}

// ---------- layer 2 ----------

export async function listMemory<T>(kind: MemoryKind, params: Record<string, string> = {}): Promise<T[]> {
  const qs = new URLSearchParams({ limit: "500", ...params });
  const { items } = await request<{ items: T[] }>(`/${MEMORY_COLLECTION[kind]}?${qs.toString()}`);
  return items;
}

/** Create (no id) or update a commitment, interaction, fact, asset, reading item or goal. */
export async function saveMemory<T>(kind: MemoryKind, input: Record<string, unknown>, id?: string): Promise<T> {
  return id
    ? request<T>(`/${MEMORY_COLLECTION[kind]}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })
    : request<T>(`/${MEMORY_COLLECTION[kind]}`, { method: "POST", body: JSON.stringify(input) });
}

export async function fetchPersonBrief(id: string): Promise<PersonBrief> {
  return request<PersonBrief>(`/people/${encodeURIComponent(id)}/brief`);
}

export async function mergePeople(keepId: string, duplicateId: string): Promise<Person> {
  return request<Person>(`/people/${encodeURIComponent(keepId)}/merge`, { method: "POST", body: JSON.stringify({ duplicate_id: duplicateId }) });
}

export async function addIdentity(input: { person_id: string; kind: IdentityKind; value: string }): Promise<Identity> {
  return request<Identity>("/identities", { method: "POST", body: JSON.stringify(input) });
}

export async function removeIdentity(id: string): Promise<void> {
  await request(`/identities/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchSuggestions(): Promise<Suggestion[]> {
  const { items } = await request<{ items: Suggestion[] }>("/suggestions?status=pending");
  return items;
}

export async function resolveSuggestion(id: string, action: "accept" | "reject" | "done", edits?: Record<string, unknown>): Promise<{ suggestion: Suggestion; result?: unknown }> {
  return request(`/suggestions/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(edits ? { edits } : {}) });
}

/** Ignore emails like this one: a mail rule on its account; returns what left the Inbox with it (lib/suggestion-ignore.ts). */
export async function ignoreSuggestion(id: string, rule: { kind: "sender" | "subject"; value: string }): Promise<{ rule: { kind: "sender" | "subject"; value: string }; accounts: string[]; dismissed: string[] }> {
  return request(`/suggestions/${encodeURIComponent(id)}/ignore`, { method: "POST", body: JSON.stringify(rule) });
}

export async function recall(q: string, limit = 20): Promise<RecallHit[]> {
  const { results } = await request<{ results: RecallHit[] }>(`/recall?${new URLSearchParams({ q, limit: String(limit) }).toString()}`);
  return results;
}

/** `tz`: this device's zone, so the week's days and its "next week" match what the app shows. */
export async function fetchWeeklyReview(start?: string, tz?: string): Promise<WeeklyReview> {
  const qs = new URLSearchParams();
  if (start) qs.set("start", start);
  if (tz) qs.set("tz", tz);
  const query = qs.toString();
  return request<WeeklyReview>(`/review/week${query ? `?${query}` : ""}`);
}

/** The server's VAPID public key, or null when push isn't configured. */
export async function fetchPushKey(): Promise<string | null> {
  const { key } = await request<{ key: string | null }>("/push/key");
  return key;
}

export async function savePushSubscription(sub: PushSubscriptionJSON): Promise<void> {
  await request("/push/subscribe", { method: "POST", body: JSON.stringify(sub) });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await request("/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) });
}

export async function sendTestPush(): Promise<{ sent: number; pruned: number; failed: number }> {
  return request("/push/test", { method: "POST" });
}

/** What reaches the owner's devices and when (Settings → Notifications, lib/nudges.ts). */
export async function fetchNotificationPrefs(): Promise<NotificationPrefs> {
  return request("/push/settings");
}

export async function saveNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  return request("/push/settings", { method: "PUT", body: JSON.stringify(patch) });
}

// ---------- trips and purchases ----------

export async function fetchTrips(): Promise<Trip[]> {
  const { items } = await request<{ items: Trip[] }>("/trips?limit=500");
  return items;
}

export async function fetchTrip(id: string): Promise<Trip> {
  return request<Trip>(`/trips/${encodeURIComponent(id)}`);
}

export type TripPatch = { title?: string; notes?: string; starts_on?: string | null; ends_on?: string | null };

export async function updateTrip(id: string, patch: TripPatch): Promise<Trip> {
  return request<Trip>(`/trips/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** A trip you add: a place and its dates. */
export async function createTrip(input: { title: string; starts_on: string | null; ends_on: string | null; notes?: string }): Promise<Trip> {
  return request<Trip>("/trips", { method: "POST", body: JSON.stringify(input) });
}

/** A booking you add to a trip. */
export async function createBooking(tripId: string, fields: Partial<BookingFields>): Promise<{ booking: Booking; trip: Trip }> {
  return request<{ booking: Booking; trip: Trip }>("/bookings", { method: "POST", body: JSON.stringify({ ...fields, trip_id: tripId }) });
}

export async function updateBooking(id: string, patch: Partial<BookingFields>): Promise<Booking> {
  return request<Booking>(`/bookings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** An order you add. */
export async function createPurchase(fields: Partial<PurchaseFields> & { retailer: string }): Promise<Purchase> {
  return request<Purchase>("/purchases", { method: "POST", body: JSON.stringify(fields) });
}

export async function updatePurchase(id: string, patch: Partial<PurchaseFields>): Promise<Purchase> {
  return request<Purchase>(`/purchases/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function fetchPurchases(): Promise<Purchase[]> {
  const { items } = await request<{ items: Purchase[] }>("/purchases?limit=500");
  return items;
}

export async function fetchPurchase(id: string): Promise<Purchase> {
  return request<Purchase>(`/purchases/${encodeURIComponent(id)}`);
}

/** The owner saying where a parcel has got to ("It arrived"). */
export async function setPurchaseStatus(id: string, status: PurchaseStatus): Promise<Purchase> {
  return request<Purchase>(`/purchases/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
}

// ---------- custom reminders ----------

export async function fetchReminders(includeDone = false): Promise<Reminder[]> {
  const { reminders } = await request<{ reminders: Reminder[] }>(`/reminders${includeDone ? "?include_done=1" : ""}`);
  return reminders;
}

/** Create a reminder, or change one when `id` is given. */
export async function saveReminder(input: ReminderInput, id?: string): Promise<Reminder> {
  return id
    ? request<Reminder>(`/reminders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })
    : request<Reminder>("/reminders", { method: "POST", body: JSON.stringify(input) });
}

export async function deleteReminder(id: string): Promise<void> {
  await request(`/reminders/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------- voice ----------

/**
 * Speech to text (POST /api/voice/transcribe). The recording goes up as the
 * raw body with its own audio type, not JSON, and only the text comes back;
 * the server keeps neither.
 */
export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const headers = new Headers({ "Content-Type": audio.type || "audio/webm" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/voice/transcribe`, { method: "POST", headers, body: audio, signal });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON (e.g. the platform's own 429 page); keep the status line
    }
    throw new ApiError(message, res.status);
  }
  const { text } = (await res.json()) as { text: string };
  return text;
}

// ---------- Connectors and collections ----------

export async function fetchConnectors(): Promise<ConnectorsState> {
  return request<ConnectorsState>("/connectors");
}

export async function createConnector(input: Record<string, unknown>): Promise<Connector> {
  return request<Connector>("/connectors", { method: "POST", body: JSON.stringify(input) });
}

export async function updateConnector(id: string, patch: Record<string, unknown>): Promise<Connector> {
  return request<Connector>(`/connectors/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** A fields address filled in from the service (Octopus's meters on an account number), with a key just pasted or the account's own. */
export async function findConnectorAddress(input: { provider: string; query: string; token?: string; connector_id?: string }): Promise<Array<{ group: string; values: Record<string, string>; label: string }>> {
  return (await request<{ choices: Array<{ group: string; values: Record<string, string>; label: string }> }>("/connectors/find-address", { method: "POST", body: JSON.stringify(input) })).choices;
}

export async function deleteConnector(id: string): Promise<void> {
  await request(`/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  return (await request<{ keys: ApiKey[] }>("/api-keys")).keys;
}

/** A new API key. `token` is the only time the key itself is ever sent to the app. */
export async function makeApiKey(label: string, scope: ApiKey["scope"]): Promise<{ key: ApiKey; token: string }> {
  return request("/api-keys", { method: "POST", body: JSON.stringify({ label, scope }) });
}

export async function removeApiKey(id: string): Promise<void> {
  await request(`/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Start signing in: returns the provider page to open, or `authorized` when no browser step was needed. */
export async function signInConnector(id: string): Promise<{ authorization_url?: string; authorized?: boolean }> {
  return request(`/connectors/${encodeURIComponent(id)}/sign-in`, { method: "POST" });
}

/** A calendar account (Google, Outlook, iCloud): one calendar on it, and whether Athena reads it. */
export interface CalendarChoice {
  id: string;
  name: string;
  color?: string;
  /** The account's main calendar (Google's primary, Outlook's default). */
  primary?: boolean;
  shared: boolean;
  /** Who shared it, when the calendar says. */
  owner?: string;
  /** Your own calendar, shared with other people. */
  sharedByYou: boolean;
  /** A public calendar you subscribe to (holidays, sports). */
  subscribed?: boolean;
  /** Events in the next 30 days. */
  upcoming: number;
  chosen: boolean;
}

export async function getCalendars(id: string): Promise<{ calendars: CalendarChoice[] }> {
  return request<{ calendars: CalendarChoice[] }>(`/connectors/${encodeURIComponent(id)}/calendars`);
}

/** Gmail and Outlook: the owner's mail rules, and emails they kept from runs this week. */
export async function getMailRules(id: string): Promise<{ rules: MailRules; unreadable: boolean; skipped_week: number }> {
  return request(`/connectors/${encodeURIComponent(id)}/mail`);
}

/** The account's labels or folders a rule can name. */
export async function getMailLabels(id: string): Promise<MailLabel[]> {
  return (await request<{ labels: MailLabel[] }>(`/connectors/${encodeURIComponent(id)}/mail/labels`)).labels;
}

/** The last 24 hours under these rules, and the busiest senders: counts only, no email is read. */
export async function previewMailRules(id: string, rules: MailRules): Promise<MailPreview> {
  return request<MailPreview>(`/connectors/${encodeURIComponent(id)}/mail/preview`, { method: "POST", body: JSON.stringify({ rules }) });
}

export async function checkConnector(id: string): Promise<Connector> {
  return request<Connector>(`/connectors/${encodeURIComponent(id)}/check`, { method: "POST" });
}

export async function saveCollection(input: Record<string, unknown>, id?: string): Promise<Collection> {
  return id
    ? request<Collection>(`/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })
    : request<Collection>("/collections", { method: "POST", body: JSON.stringify(input) });
}

export async function deleteCollection(id: string): Promise<void> {
  await request(`/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runCollection(id: string): Promise<CollectionRun> {
  return request<CollectionRun>(`/collections/${encodeURIComponent(id)}/run`, { method: "POST" });
}

export async function fetchRuns(id: string): Promise<CollectionRun[]> {
  const { runs } = await request<{ runs: CollectionRun[] }>(`/collections/${encodeURIComponent(id)}/runs`);
  return runs;
}

/** What one run saved, newest-made first (at most 200). */
export async function fetchRunItems(collectionId: string, runId: string): Promise<RunItem[]> {
  const { items } = await request<{ items: RunItem[] }>(`/collections/${encodeURIComponent(collectionId)}/runs/${encodeURIComponent(runId)}/items`);
  return items;
}

// ---------- Files (lib/files.ts) ----------

/**
 * Keep a file on the server, linked to the Ask conversation or note it was
 * added to. Multipart, so it goes without the JSON header; `onProgress`
 * reports 0–1 as it uploads (XHR: fetch can't report upload progress).
 */
export function uploadFile(
  input: { id: string; file: Blob; name: string; thumb?: Blob | null; width?: number; height?: number; link: { thread: string } | { note: string } },
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<AskFile> {
  const form = new FormData();
  form.set("id", input.id);
  form.set("file", input.file, input.name);
  if (input.thumb) form.set("thumb", input.thumb, "thumb.jpg");
  if (input.width) form.set("width", String(input.width));
  if (input.height) form.set("height", String(input.height));
  if ("thread" in input.link) form.set("thread", input.link.thread);
  else form.set("note", input.link.note);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/files`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: (AskFile & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else reject(new ApiError(body?.error ?? `${xhr.status} ${xhr.statusText}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("You're offline", 0));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

/** A file's bytes (or an image's small preview), through the token. */
export async function fetchFileBlob(id: string, thumb = false): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}${thumb ? "/thumb" : ""}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  return res.blob();
}

/** Taken out of a message before it was sent. */
export async function removeFileFromThread(id: string, thread: string): Promise<void> {
  await request(`/files/${encodeURIComponent(id)}?${new URLSearchParams({ thread })}`, { method: "DELETE" });
}

export async function fetchNoteFiles(noteId: string): Promise<AskFile[]> {
  return (await request<{ files: AskFile[] }>(`/notes/${encodeURIComponent(noteId)}/files`)).files;
}

export async function attachNoteFile(noteId: string, fileId: string): Promise<AskFile[]> {
  return (await request<{ files: AskFile[] }>(`/notes/${encodeURIComponent(noteId)}/files`, { method: "POST", body: JSON.stringify({ file_id: fileId }) })).files;
}

export async function detachNoteFile(noteId: string, fileId: string): Promise<void> {
  await request(`/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}
