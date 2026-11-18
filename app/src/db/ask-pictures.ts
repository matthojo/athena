/**
 * Pictures Ask made and the owner undid (owner, 17 Nov 2026): archived like everything else (SECURITY.md §7).
 * Undo takes a picture out of its conversation and puts it on the Archived page; Restore puts it back where it
 * was; Delete for good removes it (a note that has it keeps it).
 *
 * The server keeps it as an archived link between the conversation and the file (lib/images.ts). The
 * conversation, kept on the device and synced, says which pictures are undone: restoring or deleting one here
 * updates the conversation too, so it shows the picture again, or that it was deleted.
 *
 * Sample mode keeps its archived pictures on this device.
 */
import { ApiError, isSampleMode, request } from "./api";
import { getThread, saveThread } from "./ask-threads";
import type { AskFile, AskThread } from "../types";
import type { ModelRef } from "../../../lib/model-types";
import type { Effective } from "./sample-models";

export interface ArchivedPicture {
  file: AskFile;
  thread_id: string;
  archived_at: string;
  /** How many notes have it: deleting it for good leaves it on them. */
  on_notes: number;
}

/** Undo's key for a made picture, as the conversation keeps it (views/ask.ts changeKey). */
export const pictureKey = (fileId: string) => `picture:${fileId}:created`;

const listeners = new Set<() => void>();
export function onPicturesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn());

// ---------- Sample mode: on this device ----------

const SAMPLE_KEY = "athena.sample.archivedPictures";
function sampleList(): ArchivedPicture[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAMPLE_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as ArchivedPicture[]) : [];
  } catch {
    return [];
  }
}
function sampleKeep(list: ArchivedPicture[]): void {
  try {
    localStorage.setItem(SAMPLE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the list lives as long as the page.
  }
}

/** Sample mode's Undo: the picture goes on this device's Archived list. (The server does this itself for a real Undo.) */
export function archiveSamplePicture(threadId: string, file: AskFile, onNotes = 0): void {
  const rest = sampleList().filter((p) => !(p.thread_id === threadId && p.file.id === file.id));
  sampleKeep([{ file, thread_id: threadId, archived_at: new Date().toISOString(), on_notes: onNotes }, ...rest]);
  notify();
}

// ---------- Which picture model ----------

/** The picture model for a chat, from AI models' effective settings: an assistant's own (null is "No pictures"), else the owner's; null is off. */
export function pictureModelFor(effective: Pick<Effective, "image" | "assistants"> | null | undefined, assistantId: string | null): ModelRef | null {
  if (!effective) return null;
  const own = assistantId ? effective.assistants?.[assistantId] : undefined;
  return (own ? own.image : effective.image)?.ref ?? null;
}

// ---------- The Archived page ----------

/** Archived pictures, most recently archived first. Offline (or a server without the route yet): none. */
export async function listArchivedPictures(): Promise<ArchivedPicture[]> {
  if (isSampleMode()) return sampleList().sort((a, b) => b.archived_at.localeCompare(a.archived_at));
  try {
    return (await request<{ pictures: ArchivedPicture[] }>("/pictures/archived")).pictures;
  } catch {
    return [];
  }
}

/** Back in its conversation. `thread: false` when the open conversation updates itself. */
export async function restorePicture(p: Pick<ArchivedPicture, "thread_id" | "file">, opts: { thread?: boolean } = {}): Promise<void> {
  if (isSampleMode()) sampleKeep(sampleList().filter((x) => !(x.thread_id === p.thread_id && x.file.id === p.file.id)));
  else {
    try {
      await request(`/pictures/${encodeURIComponent(p.thread_id)}/${encodeURIComponent(p.file.id)}/restore`, { method: "POST" });
    } catch (e) {
      // Already back (restored from another device): the conversation still needs to show it.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  if (opts.thread !== false) await updateThread(p.thread_id, (t) => showPicture(t, p.file.id, "restore"));
  notify();
}

/** Deleted for good: the conversation shows it was. */
export async function deletePictureForGood(p: Pick<ArchivedPicture, "thread_id" | "file">): Promise<void> {
  if (isSampleMode()) sampleKeep(sampleList().filter((x) => !(x.thread_id === p.thread_id && x.file.id === p.file.id)));
  else await request(`/pictures/${encodeURIComponent(p.thread_id)}/${encodeURIComponent(p.file.id)}`, { method: "DELETE" });
  await updateThread(p.thread_id, (t) => showPicture(t, p.file.id, "delete"));
  notify();
}

async function updateThread(id: string, change: (t: AskThread) => AskThread | null): Promise<void> {
  const t = await getThread(id).catch(() => null);
  const next = t ? change(t) : null;
  if (next) await saveThread({ ...next, updated_at: new Date().toISOString() });
}

// ---------- The conversation (pure, for tests) ----------

type Loose = Record<string, unknown>;

/**
 * The conversation with one picture restored (Undo taken back, so it shows again) or deleted (shown as deleted).
 * Every version of every reply that made it, whichever way the reply was kept. Null when nothing changed.
 */
export function showPicture(t: AskThread, fileId: string, how: "restore" | "delete"): AskThread | null {
  let changed = false;
  const key = pictureKey(fileId);
  const fix = (m: Loose): Loose => {
    let out = m;
    const versions = Array.isArray(m.versions) ? (m.versions as Loose[]) : null;
    if (versions) {
      const next = versions.map(fix);
      if (next.some((v, i) => v !== versions[i])) out = { ...out, versions: next };
    }
    const reply = m.reply && typeof m.reply === "object" ? (m.reply as Loose) : null;
    const pics = (Array.isArray(m.pictures) ? m.pictures : Array.isArray(reply?.pictures) ? reply!.pictures : null) as Array<{ file: AskFile }> | null;
    if (!pics?.some((p) => p.file?.id === fileId)) return out;
    const undone = Array.isArray(m.undone) ? (m.undone as string[]) : [];
    if (how === "restore") {
      if (!undone.includes(key)) return out;
      changed = true;
      return { ...out, undone: undone.filter((k) => k !== key) };
    }
    const gone = pics.map((p) => (p.file.id === fileId ? { ...p, file: { ...p.file, removed: true, has_thumb: false } } : p));
    changed = true;
    return Array.isArray(m.pictures) ? { ...out, pictures: gone } : { ...out, reply: { ...reply, pictures: gone } };
  };
  const messages = (t.messages as unknown as Loose[]).map(fix);
  return changed ? { ...t, messages: messages as unknown as AskThread["messages"] } : null;
}
