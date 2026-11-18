/**
 * The owner's own habits for the app (lib/own-habits.ts on the server):
 * GET /api/habits?date for a day's list, POST and PATCH to make and change
 * one, PUT /api/habits/:id/days/:date to tick.
 *
 * Ticks are optimistic: the change shows at once (every listener repaints
 * from the local state), then it's sent. Offline, it waits in IndexedDB and
 * goes on the next `online` (last count wins for a habit and day, like the
 * notes outbox in db/sync.ts). The last list seen for a day is kept too, so
 * Today still has its ticks with no signal. Sample mode answers from
 * db/sample-life.ts and never touches the network.
 */

import { ApiError, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { isDone, type OwnHabit } from "../../../lib/habit-rules";

export type { OwnHabit };

export interface OwnHabitDay {
  id: string;
  progress: number;
  done: boolean;
  shows: boolean;
  week_done?: number;
  streak: number;
  streak_unit: "day" | "week";
}

export interface HabitsOn {
  today: string;
  date: string;
  /** Every habit, archived ones last. */
  habits: OwnHabit[];
  /** Each live habit on `date`. */
  on: OwnHabitDay[];
}

export interface HabitInput {
  name?: string;
  days?: number;
  per_week?: number | null;
  target?: number | null;
  unit?: string | null;
  icon?: string;
  archived?: boolean;
}

const sample = () => import("./sample-life");
const OUTBOX = "habit-outbox";
const cacheKey = (date: string) => `habits-on:${date}`;

type Listener = () => void;
const listeners = new Set<Listener>();
export function onHabitsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());
/** Habits or ticks changed somewhere else (the live channel): every listener loads again, with ticks still on their way kept on top. */
export const habitsChanged = (): void => changed();

/** Counts set here and not yet confirmed: "id|date" → count. */
const pending = new Map<string, number>();

/** Bring a loaded day in line with ticks still on their way. */
function withPending(data: HabitsOn): HabitsOn {
  const habits = new Map(data.habits.map((x) => [x.id, x]));
  return {
    ...data,
    on: data.on.map((d) => {
      const p = pending.get(`${d.id}|${data.date}`);
      if (p === undefined || p === d.progress) return d;
      const done = isDone(p, habits.get(d.id)?.target ?? null);
      const step = d.streak_unit === "day" && done !== d.done ? (done ? 1 : -1) : 0;
      return { ...d, progress: p, done, streak: Math.max(0, d.streak + step), shows: d.shows || p > 0 };
    }),
  };
}

export async function loadHabitsOn(date?: string): Promise<HabitsOn> {
  if (isSampleMode()) return (await sample()).sampleHabitsOn(date);
  const key = cacheKey(date ?? "today");
  try {
    const data = await request<HabitsOn>(`/habits${date ? `?date=${date}` : ""}`);
    void setMeta(key, JSON.stringify(data)).catch(() => undefined);
    return withPending(data);
  } catch (error) {
    const cached = await getMeta(key).catch(() => undefined);
    if (cached && !(error instanceof ApiError && error.status !== 0)) return withPending(JSON.parse(cached) as HabitsOn);
    throw error;
  }
}

export async function saveHabit(patch: HabitInput, id?: string): Promise<OwnHabit> {
  const out = isSampleMode()
    ? await (await sample()).saveSampleHabit(patch, id)
    : await request<OwnHabit>(id ? `/habits/${id}` : "/habits", { method: id ? "PATCH" : "POST", body: JSON.stringify(patch) });
  changed();
  return out;
}

async function readOutbox(): Promise<Record<string, number>> {
  try {
    return JSON.parse((await getMeta(OUTBOX)) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

async function send(id: string, date: string, progress: number): Promise<void> {
  if (isSampleMode()) return (await sample()).setSampleHabitDay(id, date, progress);
  await request(`/habits/${id}/days/${date}`, { method: "PUT", body: JSON.stringify({ progress }) });
}

/**
 * Set a day's count. Shows at once; resolves when it's saved, or queued
 * because there's no connection (`queued`). Throws only when the server
 * refused it, after putting the old count back.
 */
export async function setHabitDay(id: string, date: string, progress: number, was: number): Promise<"saved" | "queued"> {
  const k = `${id}|${date}`;
  pending.set(k, progress);
  changed();
  try {
    await send(id, date, progress);
    if (pending.get(k) === progress) pending.delete(k);
    changed();
    return "saved";
  } catch (error) {
    if (error instanceof ApiError) {
      if (pending.get(k) === progress) pending.set(k, was);
      changed();
      pending.delete(k);
      throw error;
    }
    // No connection: keep it, send it when there is one.
    const box = await readOutbox();
    box[k] = progress;
    await setMeta(OUTBOX, JSON.stringify(box)).catch(() => undefined);
    return "queued";
  }
}

let flushing = false;
/** Send queued ticks, oldest first. Called on load and on `online`. */
export async function flushHabitOutbox(): Promise<void> {
  if (flushing || isSampleMode()) return;
  flushing = true;
  try {
    const box = await readOutbox();
    for (const [k, progress] of Object.entries(box)) {
      const [id, date] = k.split("|");
      try {
        await send(id, date, progress);
      } catch (error) {
        if (!(error instanceof ApiError)) return; // still offline
      }
      delete box[k];
      if (pending.get(k) === progress) pending.delete(k);
      await setMeta(OUTBOX, JSON.stringify(box)).catch(() => undefined);
    }
    // Queued ticks stay visible until they're sent.
    for (const [k, v] of Object.entries(await readOutbox())) pending.set(k, v);
    changed();
  } finally {
    flushing = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flushHabitOutbox());
  void readOutbox().then((box) => {
    for (const [k, v] of Object.entries(box)) pending.set(k, v);
    if (Object.keys(box).length) void flushHabitOutbox();
  });
}
