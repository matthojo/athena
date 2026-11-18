/**
 * Ask's chats on this device: every conversation, kept in IndexedDB
 * (`ask_threads`) so they open offline, and synced with the server
 * (lib/ask-threads.ts) so the same chats are on every device.
 *
 * Writes land here first, marked `dirty` (or `deleted`), then go up a few
 * moments later, or on the next sync if the device is offline. A save sends
 * the whole chat and the newest edit wins. A pull takes what changed since
 * the last one (server clock) and drops chats deleted elsewhere: anything
 * the server no longer lists that isn't waiting to go up.
 *
 * Sample mode never touches the network (like sync.ts): chats live in
 * IndexedDB only.
 */

import { mentionsToText } from "../../../lib/mentions";
import { del, get, getAll, getMeta, put, setMeta } from "./idb";
import * as api from "./api";
import { ApiError, isSampleMode } from "./api";
import type { AskThread, SavedAskMessage } from "../types";

const STORE = "ask_threads";

interface LocalThread extends AskThread {
  /** Changed here and not yet saved on the server. */
  dirty?: boolean;
  /** Deleted here; the server delete hasn't gone through yet. */
  deleted?: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Chats changed (here or by a sync). */
export function onThreadsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

const strip = ({ dirty: _d, deleted: _x, ...t }: LocalThread): AskThread => t;

/** Who a conversation is with: one of the Team's assistants (its id), or null for Athena. */
export const threadAssistant = (t: Pick<AskThread, "assistant_id">): string | null => t.assistant_id || null;

/**
 * Which conversations a list shows: "all" of them, Athena's own (null; an
 * assistant's chats stay out of Ask's main list), or one assistant's (its id).
 */
export type ThreadFilter = "all" | string | null;

export function filterThreads<T extends Pick<AskThread, "assistant_id">>(threads: T[], who: ThreadFilter): T[] {
  return who === "all" ? threads : threads.filter((t) => threadAssistant(t) === who);
}

/**
 * A copy from the server, keeping who the conversation is with when the
 * server didn't say (it may not keep `assistant_id` yet).
 */
export function keepAssistant<T extends AskThread>(remote: T, local: Pick<AskThread, "assistant_id"> | undefined): T {
  if (remote.assistant_id !== undefined || !local?.assistant_id) return remote;
  return { ...remote, assistant_id: local.assistant_id };
}

/** Every live conversation on this device, most recently active first; `who` narrows it (filterThreads). */
export async function listThreads(who: ThreadFilter = "all"): Promise<AskThread[]> {
  const all = await getAll<LocalThread>(STORE).catch(() => [] as LocalThread[]);
  return filterThreads(
    all.filter((t) => !t.deleted && !t.archived_at && t.messages.length),
    who
  )
    .map(strip)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getThread(id: string): Promise<AskThread | null> {
  const t = await get<LocalThread>(STORE, id).catch(() => undefined);
  return t && !t.deleted && !t.archived_at ? strip(t) : null;
}

/** Its name: the owner's own, else its first message. */
export function threadTitle(t: Pick<AskThread, "title" | "messages">): string {
  if (t.title.trim()) return t.title.trim();
  const first = t.messages.find((m) => m.role === "me");
  const text = first?.role === "me" ? mentionsToText(first.text).replace(/\s+/g, " ").trim() : "";
  // A photo or PDF sent on its own: named after the file.
  const file = first?.role === "me" ? first.files?.[0]?.name : undefined;
  return text || file || "New conversation";
}

/** Save a chat on this device and send it up shortly. */
export async function saveThread(thread: AskThread): Promise<void> {
  if (thread.locked) return;
  await put<LocalThread>(STORE, { ...thread, dirty: !isSampleMode() });
  notify();
  schedulePush();
}

export async function renameThread(id: string, title: string): Promise<AskThread | null> {
  const t = await getThread(id);
  if (!t || t.locked) return t;
  const renamed = { ...t, title: title.trim().slice(0, 120), updated_at: new Date().toISOString() };
  await saveThread(renamed);
  return renamed;
}

/** Archived conversations, most recently archived first (the Archived page). */
export async function listArchivedThreads(): Promise<AskThread[]> {
  const all = await getAll<LocalThread>(STORE).catch(() => [] as LocalThread[]);
  return all
    .filter((t) => !t.deleted && t.archived_at)
    .map(strip)
    .sort((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? ""));
}

/** Archive (or restore) a conversation everywhere: hidden from Ask, kept on the Archived page. */
export async function setThreadArchived(id: string, archived: boolean): Promise<AskThread | null> {
  const t = await get<LocalThread>(STORE, id);
  if (!t || t.deleted || t.locked) return null;
  const now = new Date().toISOString();
  const next: AskThread = { ...strip(t), archived_at: archived ? now : null, updated_at: now };
  await saveThread(next);
  return next;
}

/** Delete a conversation for good, everywhere (from the Archived page). One that never reached the server just goes. */
export async function deleteThread(id: string): Promise<void> {
  const t = await get<LocalThread>(STORE, id);
  if (!t) return;
  if (isSampleMode()) await del(STORE, id);
  else await put<LocalThread>(STORE, { ...t, deleted: true, dirty: true });
  notify();
  schedulePush();
}

/**
 * Files deleted for good (with a note): every conversation that showed one
 * keeps its place but marks it removed, without its summary. Synced like
 * any change, so other devices show it removed too.
 */
export async function markFilesRemoved(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const gone = new Set(ids);
  const all = await getAll<LocalThread>(STORE).catch(() => [] as LocalThread[]);
  for (const t of all) {
    if (t.deleted || t.locked) continue;
    let changed = false;
    const messages = t.messages.map((m) => {
      if (m.role !== "me" || !m.files?.some((f) => gone.has(f.id) && !f.removed)) return m;
      changed = true;
      return { ...m, files: m.files.map((f) => (gone.has(f.id) ? { ...f, removed: true, summary: null, has_thumb: false } : f)) };
    });
    if (changed) await saveThread({ ...strip(t), messages });
  }
}

// ---------- the chat Ask opens on ----------

const CURRENT = "askCurrent";

/** This device's last open chat, with when it was opened. */
export async function lastOpened(): Promise<{ id: string; at: string } | null> {
  try {
    const raw = await getMeta(CURRENT);
    return raw ? (JSON.parse(raw) as { id: string; at: string }) : null;
  } catch {
    return null;
  }
}

export async function setLastOpened(id: string | null): Promise<void> {
  await setMeta(CURRENT, id ? JSON.stringify({ id, at: new Date().toISOString() }) : "").catch(() => undefined);
}

/**
 * The conversation Ask reopens on: the one last opened here, unless another
 * has been used since (on this device or another), then that one. None
 * after 12 hours away: Ask starts fresh.
 */
export async function threadToOpen(): Promise<AskThread | null> {
  const [threads, last] = await Promise.all([listThreads(), lastOpened()]);
  const newest = threads[0] ?? null;
  const pick = !last ? newest : (() => {
    const opened = threads.find((t) => t.id === last.id);
    if (!opened) return newest;
    return newest && newest.updated_at > last.at ? newest : opened;
  })();
  // After 12 hours away, Ask starts a fresh conversation; the last one waits in the list.
  if (!pick) return null;
  const lastUse = last?.id === pick.id && last.at > pick.updated_at ? last.at : pick.updated_at;
  return isStale(lastUse) ? null : pick;
}

/** How long Ask keeps you in a conversation you've left: after this, it opens on a new one. */
export const FRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/** Not used for 12 hours or more. */
export function isStale(iso: string, now = Date.now()): boolean {
  return now - Date.parse(iso) >= FRESH_AFTER_MS;
}

// ---------- sync ----------

let pushTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePush() {
  if (isSampleMode()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void pushThreads(), 800);
}

let pushing: Promise<void> | null = null;

/** Send what changed here. Stops at the first failure that a retry could fix. */
export function pushThreads(): Promise<void> {
  if (isSampleMode()) return Promise.resolve();
  pushing ??= (async () => {
    const waiting = (await getAll<LocalThread>(STORE)).filter((t) => t.dirty && !t.locked);
    for (const t of waiting) {
      try {
        if (t.deleted) {
          await api.deleteAskThread(t.id);
          const now = await get<LocalThread>(STORE, t.id);
          if (now?.deleted) await del(STORE, t.id);
          continue;
        }
        const saved = await api.saveAskThread(strip(t));
        const now = await get<LocalThread>(STORE, t.id);
        // Changed again while this was on its way: it goes on the next push.
        if (!now || now.deleted || now.updated_at !== t.updated_at) continue;
        await put<LocalThread>(STORE, saved.updated_at > t.updated_at ? keepAssistant(saved, now) : { ...now, dirty: false });
        if (saved.updated_at > t.updated_at) notify();
      } catch (error) {
        // A save the server refuses outright (too long, malformed) would block the queue: keep it here only.
        if (error instanceof ApiError && error.status && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) {
          console.warn("Athena: a chat couldn't be saved on the server:", error.message);
          const now = await get<LocalThread>(STORE, t.id);
          if (now && now.updated_at === t.updated_at) await put<LocalThread>(STORE, { ...now, dirty: false });
          continue;
        }
        return;
      }
    }
  })().finally(() => (pushing = null));
  return pushing;
}

const SYNC_AT = "askThreadsSyncAt";

/** Take chats changed elsewhere since the last pull, and drop the ones deleted elsewhere. */
export async function pullThreads(): Promise<void> {
  if (isSampleMode()) return;
  const since = await getMeta(SYNC_AT);
  const { threads, ids, now } = await api.fetchAskThreads(since || undefined);
  let changed = false;
  for (const remote of threads) {
    const local = await get<LocalThread>(STORE, remote.id);
    if (local?.dirty && local.updated_at >= remote.updated_at) continue;
    if (local && !local.dirty && local.updated_at === remote.updated_at && local.title === remote.title) continue;
    await put<LocalThread>(STORE, keepAssistant(remote, local));
    changed = true;
  }
  const live = new Set(ids);
  for (const local of await getAll<LocalThread>(STORE)) {
    if (!local.dirty && !live.has(local.id)) {
      await del(STORE, local.id);
      changed = true;
    }
  }
  await setMeta(SYNC_AT, now);
  if (changed) notify();
}

/** Push, then pull. Called from sync.ts's runSync (app open, back online) and when Ask opens. */
export async function syncAskThreads(): Promise<void> {
  if (isSampleMode()) return;
  try {
    await pushThreads();
    await pullThreads();
  } catch {
    // Offline or the API isn't there: the chats on this device stand.
  }
}

// ---------- search ----------

export interface ThreadMatch {
  thread: AskThread;
  /** A line from the conversation around the first match ("" when only its name matched). */
  snippet: string;
  /** How many of the words matched. */
  score: number;
  /** Which words matched. */
  hits: string[];
}

/** Worth showing as related: two words matched, or one specific one (five letters or more). */
export const relevant = (m: ThreadMatch) => m.score >= 2 || m.hits.some((w) => w.length >= 5);

/** What was said in a conversation, line by line: your words, replies and written answers (never the notes they found). */
export function threadLines(t: AskThread): string[] {
  const lines: string[] = [];
  for (const m of t.messages) {
    // A file matches by its name and by the summary Athena wrote when it first read it.
    if (m.role === "me") lines.push(mentionsToText(m.text), ...(m.files ?? []).flatMap((f) => (f.removed ? [] : [f.name, f.summary ?? ""])));
    else if (m.role === "assistant" && m.reply) lines.push(unmarked(mentionsToText(m.reply.text)));
    else if (m.role === "answer" && m.text) lines.push(unmarked(m.text.replace(/\s?\[\d[\d,\s–-]*\]/g, "")));
  }
  return lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** A reply's words without what Ask draws them from: a list line's dash or number, and the stars around bold. */
const unmarked = (text: string) => text.replace(/^[ \t]*(?:[-•]|\d{1,3}\.)[ \t]+/gm, "").replace(/\*\*/g, "");

function around(line: string, word: string, width = 110): string {
  const i = line.toLowerCase().indexOf(word);
  if (i < 0 || line.length <= width) return line.slice(0, width);
  const start = Math.max(0, i - 30);
  return `${start ? "…" : ""}${line.slice(start, start + width).trim()}${start + width < line.length ? "…" : ""}`;
}

/**
 * Live conversations that mention these words, best first. `every`: each
 * word must appear (the list's search box); otherwise any will do, ranked by
 * how many (Ask and the search bar). Runs on this device, offline too.
 */
export async function searchThreads(words: string[], opts: { every?: boolean; limit?: number; except?: string | null } = {}): Promise<ThreadMatch[]> {
  const terms = [...new Set(words.map((w) => w.toLowerCase().trim()).filter((w) => w.length > 1))];
  if (!terms.length) return [];
  const out: ThreadMatch[] = [];
  for (const thread of await listThreads()) {
    if (thread.id === opts.except) continue;
    const name = threadTitle(thread).toLowerCase();
    const lines = threadLines(thread);
    const all = `${name}\n${lines.join("\n").toLowerCase()}`;
    const hits = terms.filter((t) => all.includes(t));
    if (!hits.length || (opts.every && hits.length < terms.length)) continue;
    // Show the line that matched, unless the name already says it.
    const inLines = lines.find((l) => hits.some((t) => l.toLowerCase().includes(t)) && l.toLowerCase() !== name);
    const word = hits.find((t) => inLines?.toLowerCase().includes(t)) ?? hits[0];
    out.push({ thread, snippet: inLines ? around(inLines, word) : "", score: hits.length, hits });
  }
  out.sort((a, b) => b.score - a.score || b.thread.updated_at.localeCompare(a.thread.updated_at));
  return out.slice(0, opts.limit ?? 50);
}

// ---------- what an answer saved to Athena (ask-import.ts) ----------

/** One line of the receipt under an answer, as POST /api/assistant/import gave it. */
export interface KeptReceiptLine {
  kind: string;
  title: string;
  href: string;
  undo: Array<Record<string, unknown>>;
  from: string;
}

/** The receipt kept with a saved answer: its lines, the counts under them, and which lines were undone. */
export interface KeptReceipt {
  saved: KeptReceiptLine[];
  review: number;
  already: number;
  failed: string[];
  over_cap: number;
  /** Lines undone, by index. */
  undone: number[];
}

/** A saved answer with its receipt. Older answers have none. */
export type SavedAnswer = Extract<SavedAskMessage, { role: "answer" }> & { receipt?: KeptReceipt };

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** What goes into the conversation: the receipt as it ended, with what was undone here. */
export function keepReceipt(r: Omit<KeptReceipt, "undone">, undone: Iterable<number>): KeptReceipt {
  return { saved: r.saved, review: r.review, already: r.already, failed: r.failed, over_cap: r.over_cap, undone: [...undone].sort((a, b) => a - b) };
}

/** A kept receipt read back, or null when there's none or it isn't one (an older answer, another build's shape). */
export function receiptFromKept(raw: unknown): KeptReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.saved)) return null;
  const saved = r.saved.filter(
    (l): l is KeptReceiptLine =>
      !!l && typeof l === "object" && typeof (l as KeptReceiptLine).title === "string" && typeof (l as KeptReceiptLine).href === "string" && typeof (l as KeptReceiptLine).kind === "string" && Array.isArray((l as KeptReceiptLine).undo),
  ).map((l) => ({ kind: l.kind, title: l.title, href: l.href, undo: l.undo, from: typeof l.from === "string" ? l.from : "" }));
  if (saved.length !== r.saved.length) return null;
  const undone = Array.isArray(r.undone) ? r.undone.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < saved.length) : [];
  return {
    saved,
    review: count(r.review),
    already: count(r.already),
    failed: Array.isArray(r.failed) ? r.failed.filter((x): x is string => typeof x === "string") : [],
    over_cap: count(r.over_cap),
    undone: [...new Set(undone)].sort((a, b) => a - b),
  };
}

// ---------- opening one from elsewhere (the search bar) ----------

let openRequest: string | null = null;

/** Ask should open this conversation next time it renders. */
export function requestOpen(id: string): void {
  openRequest = id;
  void setLastOpened(id);
}

export function takeOpenRequest(): string | null {
  const id = openRequest;
  openRequest = null;
  return id;
}
