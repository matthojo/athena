/**
 * The live channel in the app: while Athena is open and visible, the server
 * says when notes, records, days, habits, recipes, check-ins, nudges or runs changed somewhere else (MCP,
 * another device, a collection), and the pulls the app already has run
 * straight away. Events carry kinds and ids, never content. With the channel
 * down nothing is lost: the pulls on opening, on coming back to the app and
 * on reconnecting still happen.
 */
import { getToken, hasToken, isSampleMode } from "../db/api";
import { createLiveClient } from "./client";

export type LiveKind = "note" | "record" | "memory" | "logistics" | "custom" | "saved" | "thread" | "nudge" | "run" | "backfill" | "day" | "habit" | "recipe" | "checkin";

const listeners = new Map<string, Set<(ids: string[]) => void>>();

/** Hear that a kind changed elsewhere (after the app's own stores were told). For views that load their own data, such as Home's nudges. */
export function onLive(kind: LiveKind, fn: (ids: string[]) => void): () => void {
  const set = listeners.get(kind) ?? new Set();
  listeners.set(kind, set.add(fn));
  return () => set.delete(fn);
}

export interface LiveHooks {
  /** Pull notes (db/data.ts refreshNotes). */
  notes: () => unknown;
  /** Reload the accounts' and collections' state. */
  sources: () => unknown;
}

let started = false;

/** Start the channel. Called once the shell is up; does nothing in sample mode or signed out. */
export function startLive(hooks: LiveHooks): void {
  if (started || isSampleMode() || !hasToken() || typeof fetch !== "function" || typeof ReadableStream === "undefined") return;
  started = true;

  // The stores' own "changed elsewhere" calls, as Ask makes after its changes. Loaded on use: most live in view chunks.
  const pulls: Record<LiveKind, (ids: string[]) => unknown> = {
    note: hooks.notes,
    record: () => import("../db/records").then((m) => m.recordsChanged()),
    memory: () => import("../db/memory").then((m) => m.memoryChanged()),
    logistics: () => import("../db/trips").then((m) => m.logisticsChanged()),
    custom: () => import("../db/custom-kinds").then((m) => m.customKindsChanged()),
    saved: () => import("../db/saved").then((m) => m.savedChanged()),
    thread: () => import("../db/ask-threads").then((m) => m.pullThreads()),
    checkin: () => import("../db/checkins").then((m) => m.checkinsChanged()),
    nudge: () => undefined,
    run: hooks.sources,
    backfill: hooks.sources,
    // Days are named by date; a habit tick is a day entry, so it arrives as both.
    day: (dates) => import("../db/days-app").then((m) => m.daysChanged(dates)),
    habit: () => import("../db/habits").then((m) => m.habitsChanged()),
    recipe: (ids) => import("../db/recipes").then((m) => m.recipesChanged(ids)),
  };

  // A burst (a collection writing twenty notes) becomes one pull per kind.
  const waiting = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const batch = [...waiting];
    waiting.clear();
    for (const [kind, ids] of batch) {
      try {
        void Promise.resolve(pulls[kind as LiveKind]?.([...ids])).catch(() => undefined);
        listeners.get(kind)?.forEach((fn) => fn([...ids]));
      } catch {
        // One reload failing never stops the others.
      }
    }
  };

  const client = createLiveClient({
    fetch: (input, init) => fetch(input, init),
    token: getToken,
    visible: () => document.visibilityState === "visible",
    online: () => navigator.onLine,
    onChange(kind, ids) {
      const set = waiting.get(kind) ?? new Set<string>();
      ids.forEach((id) => set.add(id));
      waiting.set(kind, set);
      timer ??= setTimeout(flush, 400);
    },
  });

  const sync = () => client.sync();
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  // A page going into the back/forward cache can't keep a connection.
  window.addEventListener("pagehide", () => client.stop());
  window.addEventListener("pageshow", sync);
  sync();
}
