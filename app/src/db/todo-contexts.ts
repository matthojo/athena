/**
 * To-do contexts on the device (lib/todo-contexts.ts on the server): the
 * owner's areas and where/how, for To do's chips and filters, the to-do
 * sheet's pickers and Settings → To do. The live API, then what this device
 * cached; sample mode keeps the starter set and its edits on this device.
 *
 * The rows read them synchronously (contextsSnapshot): primeContexts() fills
 * it at start-up and every load keeps it current. Changes need a connection.
 */

import { ApiError, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { OfflineError } from "./records";
import { CONTEXT_LIMITS, STARTER_CONTEXTS, cleanContextName, contextsOf, type ContextKind, type TodoContext } from "../../../lib/todo-context";
import type { ConnectionState } from "../types";

export type { ContextKind, TodoContext };

const subs = new Set<() => void>();
export function onContextsChange(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
const emit = () => subs.forEach((fn) => fn());

let snapshot: TodoContext[] = [];
let counts: Record<string, number> = {};

/** Every context this device knows, archived ones too. */
export const contextsSnapshot = (): TodoContext[] => snapshot;
/** Live contexts of one kind, in the owner's order. */
export const liveContexts = (kind: ContextKind): TodoContext[] => contextsOf(snapshot, kind);
export const contextById = (id: string | null | undefined): TodoContext | null => (id ? (snapshot.find((c) => c.id === id && !c.archived_at) ?? null) : null);
/** Open to-dos on each context, as last loaded. */
export const contextCount = (id: string): number => counts[id] ?? 0;

function set(all: TodoContext[], n: Record<string, number> = counts) {
  const changed = JSON.stringify(all) !== JSON.stringify(snapshot) || JSON.stringify(n) !== JSON.stringify(counts);
  snapshot = all;
  counts = n;
  if (changed) emit();
}

// ---------- sample mode ----------

const SAMPLE_KEY = "athena.sample.todoContexts";
const sampleId = (n: number) => `5a3e0000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`;

/** The starter set as sample mode's contexts, with stable ids (sample-memory.ts tags its to-dos with them). */
export function sampleStarterContexts(): TodoContext[] {
  const at = "2026-01-01T00:00:00.000Z";
  const pos: Record<string, number> = {};
  return STARTER_CONTEXTS.map((s, i) => ({ id: sampleId(i), kind: s.kind, key: s.key, name: s.name, icon: s.icon, colour: s.colour, position: (pos[s.kind] = (pos[s.kind] ?? -1) + 1), archived_at: null, created_at: at, updated_at: at }));
}
/** A starter context's sample id, by kind and key. */
export const sampleContextId = (kind: ContextKind, key: string): string => sampleId(STARTER_CONTEXTS.findIndex((s) => s.kind === kind && s.key === key));

function readSample(): TodoContext[] {
  try {
    const raw = localStorage.getItem(SAMPLE_KEY);
    if (raw) return JSON.parse(raw) as TodoContext[];
  } catch {
    // fall through to the starter set
  }
  return sampleStarterContexts();
}
function writeSample(all: TodoContext[]) {
  try {
    localStorage.setItem(SAMPLE_KEY, JSON.stringify(all));
  } catch {
    // private mode: the change lasts until reload
  }
}
async function sampleCounts(all: TodoContext[]): Promise<Record<string, number>> {
  const { loadCommitments } = await import("./memory");
  const { items } = await loadCommitments();
  const n: Record<string, number> = {};
  for (const c of items) {
    if (c.status !== "open" || c.kind === "decision") continue;
    for (const id of [c.area_id, c.where_id]) if (id && all.some((x) => x.id === id && !x.archived_at)) n[id] = (n[id] ?? 0) + 1;
  }
  return n;
}

// ---------- load ----------

export async function primeContexts(): Promise<void> {
  try {
    if (isSampleMode()) set(readSample());
    else {
      const raw = await getMeta("todoContexts");
      if (raw) set(JSON.parse(raw) as TodoContext[]);
    }
  } catch {
    // nothing cached yet
  }
  void loadContexts();
}

export async function loadContexts(): Promise<{ contexts: TodoContext[]; state: ConnectionState }> {
  if (isSampleMode()) {
    const all = readSample();
    set(all, await sampleCounts(all));
    return { contexts: all, state: "sample" };
  }
  try {
    const r = await request<{ contexts: TodoContext[]; counts: Record<string, number> }>("/todo-contexts");
    set(r.contexts, r.counts);
    void setMeta("todoContexts", JSON.stringify(r.contexts));
    return { contexts: r.contexts, state: "online" };
  } catch {
    return { contexts: snapshot, state: "offline" };
  }
}

// ---------- changes ----------

export interface ContextPatch {
  name?: string;
  icon?: string;
  colour?: string;
  archived?: boolean;
}

async function online<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.onLine) throw new OfflineError();
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new OfflineError();
  }
}

function sampleCheck(all: TodoContext[], kind: ContextKind, name: string, exceptId?: string) {
  const clash = all.find((c) => c.kind === kind && !c.archived_at && c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`You already have ${kind === "area" ? "an area" : "a where/how"} called “${clash.name}”.`);
}

export async function createContext(input: { kind: ContextKind; name: string; icon: string; colour: string }): Promise<TodoContext> {
  if (isSampleMode()) {
    const r = cleanContextName(input.name);
    if ("error" in r) throw new Error(r.error);
    const all = readSample();
    sampleCheck(all, input.kind, r.name);
    if (contextsOf(all, input.kind).length >= CONTEXT_LIMITS.perKind) throw new Error(`That's ${CONTEXT_LIMITS.perKind} already. Remove one first.`);
    const now = new Date().toISOString();
    const made: TodoContext = { id: crypto.randomUUID(), kind: input.kind, key: null, name: r.name, icon: input.icon, colour: input.colour as TodoContext["colour"], position: contextsOf(all, input.kind).length, archived_at: null, created_at: now, updated_at: now };
    writeSample([...all, made]);
    await loadContexts();
    return made;
  }
  const made = await online(() => request<TodoContext>("/todo-contexts", { method: "POST", body: JSON.stringify(input) }));
  await loadContexts();
  return made;
}

export async function updateContext(id: string, patch: ContextPatch): Promise<TodoContext> {
  if (isSampleMode()) {
    const all = readSample();
    const cur = all.find((c) => c.id === id);
    if (!cur) throw new Error("Not found");
    let name = cur.name;
    if (patch.name !== undefined) {
      const r = cleanContextName(patch.name);
      if ("error" in r) throw new Error(r.error);
      name = r.name;
    }
    if (patch.name !== undefined || patch.archived === false) sampleCheck(all, cur.kind, name, id);
    const next: TodoContext = {
      ...cur,
      name,
      icon: patch.icon ?? cur.icon,
      colour: (patch.colour as TodoContext["colour"]) ?? cur.colour,
      archived_at: patch.archived === undefined ? cur.archived_at : patch.archived ? (cur.archived_at ?? new Date().toISOString()) : null,
      updated_at: new Date().toISOString(),
    };
    writeSample(all.map((c) => (c.id === id ? next : c)));
    await loadContexts();
    notifyTodos();
    return next;
  }
  const saved = await online(() => request<TodoContext>(`/todo-contexts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }));
  await loadContexts();
  if (patch.archived !== undefined) notifyTodos();
  return saved;
}

export async function reorderContexts(kind: ContextKind, ids: string[]): Promise<void> {
  if (isSampleMode()) {
    writeSample(readSample().map((c) => (c.kind === kind && ids.includes(c.id) ? { ...c, position: ids.indexOf(c.id) } : c)));
    await loadContexts();
    return;
  }
  await online(() => request("/todo-contexts/order", { method: "POST", body: JSON.stringify({ kind, ids }) }));
  await loadContexts();
}

/** Removing or restoring a context changes what to-dos show: To do repaints. */
function notifyTodos() {
  void import("./memory").then((m) => m.memoryChanged());
}
