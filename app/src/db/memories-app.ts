/**
 * Home's memory, as the app reads it: the server's context for a date
 * (GET /api/days/firsts?around=, lib/day-firsts.ts) and the owner's choices
 * (GET/PATCH /api/days/memories, lib/day-prefs.ts), with sample mode routed
 * to db/sample-days.ts. This device keeps a copy of the choices so the first
 * paint doesn't wait, and a "Not this one" made offline is sent next time.
 */

import { isSampleMode, request } from "./api";
import type { DayFirst, MemoryContext, MemoryDay, MemoryPrefs } from "../../../lib/memory-types";

export type { DayFirst, MemoryContext, MemoryDay, MemoryPrefs };

const KEY = "athena.days.memories";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Local extends MemoryPrefs {
  /** Hides not yet saved on the server. */
  unsent?: string[];
}

function readLocal(): Local {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Local> | null;
    const dates = (xs: unknown) => (Array.isArray(xs) ? xs.filter((d): d is string => typeof d === "string" && DATE.test(d)) : []);
    return { on: raw?.on !== false, hidden: dates(raw?.hidden), unsent: dates(raw?.unsent) };
  } catch {
    return { on: true, hidden: [], unsent: [] };
  }
}

function writeLocal(l: Local): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* private mode: this visit only */
  }
}

/** This device's copy: memories on or off, and the hidden days. */
export function memoryPrefs(): MemoryPrefs {
  const { on, hidden } = readLocal();
  return { on, hidden };
}

/** The server's choices, with this device's unsent hides added (and sent). Offline, this device's copy. */
export async function syncMemoryPrefs(): Promise<MemoryPrefs> {
  const local = readLocal();
  if (isSampleMode()) return { on: local.on, hidden: local.hidden };
  try {
    let server = await request<MemoryPrefs>("/days/memories");
    for (const hide of local.unsent ?? []) if (!server.hidden.includes(hide)) server = await request<MemoryPrefs>("/days/memories", { method: "PATCH", body: JSON.stringify({ hide }) });
    writeLocal({ on: server.on, hidden: server.hidden, unsent: [] });
    return server;
  } catch {
    return { on: local.on, hidden: local.hidden };
  }
}

/** Settings → Days, "Memories on Home". */
export async function setMemoriesOn(on: boolean): Promise<void> {
  writeLocal({ ...readLocal(), on });
  if (!isSampleMode()) await request("/days/memories", { method: "PATCH", body: JSON.stringify({ on }) });
}

/** "Not this one": the day never comes back as a memory, on any device. */
export async function hideMemory(date: string): Promise<void> {
  const l = readLocal();
  const hidden = l.hidden.includes(date) ? l.hidden : [...l.hidden, date].sort();
  writeLocal({ ...l, hidden, unsent: [...new Set([...(l.unsent ?? []), date])] });
  if (isSampleMode()) return writeLocal({ ...readLocal(), unsent: [] });
  await request("/days/memories", { method: "PATCH", body: JSON.stringify({ hide: date }) });
  const now = readLocal();
  writeLocal({ ...now, unsent: (now.unsent ?? []).filter((d) => d !== date) });
}

/** Undo a "Not this one". */
export async function showMemory(date: string): Promise<void> {
  const l = readLocal();
  writeLocal({ ...l, hidden: l.hidden.filter((d) => d !== date), unsent: (l.unsent ?? []).filter((d) => d !== date) });
  if (!isSampleMode()) await request("/days/memories", { method: "PATCH", body: JSON.stringify({ show: date }) });
}

/** Firsts near `around`, who and where on the candidate days, and the never-nudge topics. */
export async function loadMemoryContext(around: string): Promise<MemoryContext> {
  if (isSampleMode()) return (await import("./sample-days")).sampleMemoryContext(around);
  return request<MemoryContext>(`/days/firsts?${new URLSearchParams({ around })}`);
}
