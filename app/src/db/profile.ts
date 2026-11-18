/**
 * The owner's profile on the device (lib/profile.ts on the server): the
 * values by section, the setup wizard's progress, and a value's history.
 *
 * Same degrade chain as the rest: live API (cached), the cache offline, the
 * sample profile in sample mode (db/memory.ts keeps its facts). Saves work
 * offline like a habit tick (db/habits.ts): they show at once, and with no
 * connection they wait in an outbox on this device (`queued`) and go when
 * the connection is back. Only a refusal from the server throws.
 */

import { ApiError, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { addFact, onMemoryChange, sampleForgetOwner, sampleOwnerFacts } from "./memory";
import { applySetupChange, EMPTY_SETUP, groupProfile, profileField, type ProfileSection, type ProfileSetup, type SetupChange } from "../lib/profile-catalogue";
import type { ConnectionState, Fact } from "../types";

export interface ProfileEdit {
  key: string;
  /** Empty forgets the current value. */
  value: string;
}

/** A section as the app shows it: a field still in the outbox is `pending`. */
export type ProfileSectionView = Omit<ProfileSection, "fields"> & { fields: Array<ProfileSection["fields"][number] & { pending?: boolean }> };

const CACHE = "profile";
const SETUP_CACHE = "profile-setup";
const OUTBOX = "profile-outbox";
const SETUP_OUTBOX = "profile-setup-outbox";
const SAMPLE_SETUP = "sampleProfileSetup";

type Listener = () => void;
const listeners = new Set<Listener>();
export function onProfileChange(fn: Listener): () => void {
  listeners.add(fn);
  // Accepting an "About you" suggestion, or Ask remembering something, changes it too.
  const off = onMemoryChange((topic) => {
    if (topic === "fact" || topic === "suggestion" || topic === "all") fn();
  });
  return () => {
    listeners.delete(fn);
    off();
  };
}
const changed = () => listeners.forEach((fn) => fn());

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getMeta(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const writeJson = (key: string, value: unknown) => setMeta(key, JSON.stringify(value)).catch(() => undefined);

/** True for "no connection" (fetch failed), false for an answer from the server. */
const isOffline = (error: unknown) => !(error instanceof ApiError);

// ---------- values ----------

type Outbox = Record<string, ProfileEdit>;

/** Lay edits still waiting in the outbox over what the server last said. */
function withPending(sections: ProfileSection[], box: Outbox): ProfileSectionView[] {
  const waiting = new Map(Object.values(box).map((e) => [e.key.toLowerCase(), e]));
  if (!waiting.size) return sections;
  const now = new Date().toISOString();
  const out: ProfileSectionView[] = sections.map((s) => ({
    ...s,
    fields: s.fields.map((f) => {
      const e = waiting.get(f.key.toLowerCase());
      if (!e) return f;
      waiting.delete(f.key.toLowerCase());
      const fact: Fact | null = e.value
        ? { ...(f.fact ?? { id: `local-${f.key}`, subject_kind: "me", subject_id: null, created_at: now }), key: f.key, value: e.value, source: "manual", source_quote: null, confidence: null, observed_at: now, superseded_at: null, updated_at: now }
        : null;
      return { ...f, fact, owner_typed: fact ? true : null, pending: true };
    }),
  }));
  // A new free-form key waiting to go: it shows under Other.
  const other = out.find((s) => s.id === "other");
  for (const e of waiting.values()) {
    if (!e.value || profileField(e.key) || !other) continue;
    other.fields.push({ key: e.key, label: e.key, input: "text", step: "other", fact: { id: `local-${e.key}`, subject_kind: "me", subject_id: null, key: e.key, value: e.value, source: "manual", confidence: null, observed_at: now, superseded_at: null, created_at: now, updated_at: now }, owner_typed: true, pending: true });
  }
  return out;
}

export async function loadProfile(): Promise<{ sections: ProfileSectionView[]; state: ConnectionState }> {
  if (isSampleMode()) return { sections: groupProfile(await sampleOwnerFacts()), state: "sample" };
  const box = await readJson<Outbox>(OUTBOX, {});
  try {
    const { sections } = await request<{ sections: ProfileSection[] }>("/profile");
    void writeJson(CACHE, sections);
    return { sections: withPending(sections, box), state: "online" };
  } catch (error) {
    const cached = await readJson<ProfileSection[] | null>(CACHE, null);
    if (!isOffline(error) && !cached) throw error;
    return { sections: withPending(cached ?? groupProfile([]), box), state: "offline" };
  }
}

async function sendEdits(edits: ProfileEdit[]): Promise<void> {
  if (isSampleMode()) {
    for (const e of edits) {
      if (e.value.trim()) await addFact({ subject_kind: "me", subject_id: null, key: profileField(e.key)?.key ?? e.key, value: e.value });
      else await sampleForgetOwner(e.key);
    }
    return;
  }
  const { sections } = await request<{ sections: ProfileSection[] }>("/profile", { method: "PUT", body: JSON.stringify({ values: edits }) });
  void writeJson(CACHE, sections);
}

/**
 * Save the owner's own answers (an empty value forgets). Resolves "saved",
 * or "queued" when there's no connection and they'll go later.
 */
export async function saveProfile(edits: ProfileEdit[]): Promise<"saved" | "queued"> {
  const list = edits.map((e) => ({ key: e.key.trim(), value: e.value.trim() })).filter((e) => e.key);
  if (!list.length) return "saved";
  try {
    if (!isSampleMode() && !navigator.onLine) throw new TypeError("offline");
    await sendEdits(list);
    changed();
    return "saved";
  } catch (error) {
    if (!isOffline(error) || isSampleMode()) throw error;
    const box = await readJson<Outbox>(OUTBOX, {});
    for (const e of list) box[e.key.toLowerCase()] = e;
    await writeJson(OUTBOX, box);
    changed();
    return "queued";
  }
}

// ---------- setup progress ----------

export async function loadSetup(): Promise<ProfileSetup> {
  if (isSampleMode()) return readJson<ProfileSetup>(SAMPLE_SETUP, { ...EMPTY_SETUP });
  const queued = await readJson<SetupChange[]>(SETUP_OUTBOX, []);
  const replay = (s: ProfileSetup) => queued.reduce((acc, c) => applySetupChange(acc, c), s);
  try {
    const setup = await request<ProfileSetup>("/profile/setup");
    void writeJson(SETUP_CACHE, setup);
    return replay(setup);
  } catch (error) {
    const cached = await readJson<ProfileSetup | null>(SETUP_CACHE, null);
    // Offline before Athena ever said: don't nag with a card it can't save.
    if (!cached) return isOffline(error) ? { ...EMPTY_SETUP, completed_at: new Date(0).toISOString() } : Promise.reject(error);
    return replay(cached);
  }
}

/** Move the wizard on (or finish, dismiss or restart it). Queued like values when offline. */
export async function changeSetup(change: SetupChange): Promise<"saved" | "queued"> {
  if (isSampleMode()) {
    await writeJson(SAMPLE_SETUP, applySetupChange(await loadSetup(), change));
    changed();
    return "saved";
  }
  try {
    if (!navigator.onLine) throw new TypeError("offline");
    const setup = await request<ProfileSetup>("/profile/setup", { method: "POST", body: JSON.stringify(change) });
    void writeJson(SETUP_CACHE, setup);
    changed();
    return "saved";
  } catch (error) {
    if (!isOffline(error)) throw error;
    const queued = await readJson<SetupChange[]>(SETUP_OUTBOX, []);
    await writeJson(SETUP_OUTBOX, [...queued, change]);
    changed();
    return "queued";
  }
}

// ---------- history ----------

/** Every value a key has had, newest first. */
export async function loadHistory(key: string): Promise<{ facts: Fact[]; state: ConnectionState }> {
  const k = key.trim().toLowerCase();
  const newest = (facts: Fact[]) => facts.filter((f) => f.key.trim().toLowerCase() === k).sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  if (isSampleMode()) return { facts: newest(await sampleOwnerFacts()), state: "sample" };
  const cacheKey = `profile-history:${k}`;
  try {
    const { facts } = await request<{ facts: Fact[] }>(`/profile/history?key=${encodeURIComponent(key)}`);
    void writeJson(cacheKey, facts);
    return { facts: newest(facts), state: "online" };
  } catch (error) {
    const cached = await readJson<Fact[] | null>(cacheKey, null);
    if (!cached) throw error;
    return { facts: newest(cached), state: "offline" };
  }
}

// ---------- the outbox ----------

/** Whether anything is waiting to go. */
export async function profileQueued(): Promise<boolean> {
  if (isSampleMode()) return false;
  const [box, setup] = await Promise.all([readJson<Outbox>(OUTBOX, {}), readJson<SetupChange[]>(SETUP_OUTBOX, [])]);
  return Object.keys(box).length > 0 || setup.length > 0;
}

let flushing = false;
/** Send what's waiting, values first. Called on load and on `online`. */
export async function flushProfileOutbox(): Promise<void> {
  if (flushing || isSampleMode()) return;
  flushing = true;
  try {
    const box = await readJson<Outbox>(OUTBOX, {});
    const edits = Object.values(box);
    if (edits.length) {
      try {
        await sendEdits(edits);
      } catch (error) {
        if (isOffline(error)) return;
        // Refused (a value too long): drop it rather than retry for ever.
        console.error("Athena profile outbox:", error);
      }
      await writeJson(OUTBOX, {});
    }
    const queued = await readJson<SetupChange[]>(SETUP_OUTBOX, []);
    while (queued.length) {
      try {
        const setup = await request<ProfileSetup>("/profile/setup", { method: "POST", body: JSON.stringify(queued[0]) });
        void writeJson(SETUP_CACHE, setup);
      } catch (error) {
        if (isOffline(error)) return;
        console.error("Athena profile outbox:", error);
      }
      queued.shift();
      await writeJson(SETUP_OUTBOX, queued);
    }
  } finally {
    flushing = false;
    changed();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flushProfileOutbox());
  void profileQueued().then((any) => any && navigator.onLine && void flushProfileOutbox());
}
