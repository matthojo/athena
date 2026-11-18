// The outbox. Every save is written here before it's sent, and it leaves
// only once Athena says it has it, or the owner removes it themselves.
// Pure logic with injected storage, clock and fetch, so it runs under node:test.

import { buildNoteRequest, buildSaveRequest, itemLink, send } from "./api.js";
import { isConfigured } from "./settings.js";

export const BACKOFF = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const RECENT = 20;

export function nextDelay(attempts) {
  return BACKOFF[Math.min(Math.max(attempts, 1), BACKOFF.length) - 1];
}

const SETUP = { kind: "setup", message: "Add your Athena address and key in the extension's settings." };

/**
 * store: { load(): Promise<{queue, recent}>, save({queue, recent}) }
 * getSettings(): Promise<{origin, key} | null>
 */
export function createQueue({ store, fetch, getSettings, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  async function load() {
    const state = (await store.load()) || {};
    return { queue: state.queue || [], recent: state.recent || [] };
  }

  // Sends one job in place. Returns what happened, for the caller to show.
  async function attempt(state, job, settings) {
    if (!isConfigured(settings)) {
      Object.assign(job, { status: "held", error: SETUP });
      return outcome(job);
    }
    const request =
      job.kind === "note" ? buildNoteRequest(settings, job) : buildSaveRequest(settings, job);
    const res = await send(fetch, request);
    job.lastTriedAt = now();
    if (res.kind === "ok") {
      state.queue = state.queue.filter((j) => j.id !== job.id);
      if (job.kind === "note") return { status: "saved", id: job.id, link: itemLink(settings.origin, res.body) };
      const entry = {
        id: job.id,
        savedId: res.body?.id != null ? String(res.body.id) : null,
        link: itemLink(settings.origin, res.body),
        kind: job.kind,
        title: job.title || "",
        payload: job.payload,
        at: now(),
      };
      state.recent = [entry, ...state.recent.filter((r) => r.id !== job.id)].slice(0, RECENT);
      return { status: "saved", id: job.id, link: entry.link, savedId: entry.savedId };
    }
    if (res.kind === "transient") {
      job.attempts = (job.attempts || 0) + 1;
      Object.assign(job, { status: "pending", nextAt: now() + nextDelay(job.attempts), error: res });
    } else {
      Object.assign(job, { status: "held", error: { kind: res.kind, message: res.message } });
    }
    return outcome(job);
  }

  function outcome(job) {
    return {
      status: job.status === "held" ? "held" : "queued",
      id: job.id,
      reason: job.error?.kind,
      message: job.error?.message,
    };
  }

  async function sendWhere(pick) {
    const settings = await getSettings();
    const state = await load();
    const results = [];
    for (const job of [...state.queue]) {
      if (!pick(job)) continue;
      results.push(await attempt(state, job, settings));
      await store.save(state);
    }
    return results;
  }

  return {
    /** Writes the job to the outbox, then tries to send it straight away. */
    add(input) {
      return exclusive(async () => {
        const job = {
          id: input.id || uuid(),
          kind: input.kind,
          title: input.title || input.payload?.title || "",
          payload: input.payload || {},
          image: input.image || null,
          warning: input.warning || null,
          createdAt: now(),
          attempts: 0,
          status: "pending",
          nextAt: now(),
        };
        const state = await load();
        state.queue.push(job);
        await store.save(state);
        const result = await attempt(state, job, await getSettings());
        await store.save(state);
        return { ...result, warning: job.warning };
      });
    },

    /** Sends every pending job that's due (or every job, with force). */
    flush({ force = false } = {}) {
      return exclusive(() =>
        sendWhere((job) => force || (job.status === "pending" && (job.nextAt ?? 0) <= now())),
      );
    },

    /** After new settings: wake jobs held for setup or a refused key. */
    settingsChanged() {
      return exclusive(async () => {
        const state = await load();
        for (const job of state.queue) {
          if (job.status === "held" && (job.error?.kind === "auth" || job.error?.kind === "setup")) {
            Object.assign(job, { status: "pending", nextAt: now() });
          }
        }
        await store.save(state);
        return sendWhere((job) => job.status === "pending" && job.nextAt <= now());
      });
    },

    retry(id) {
      return exclusive(async () => (await sendWhere((job) => job.id === id))[0] || null);
    },

    /** The owner removes a save they no longer want sent. */
    dismiss(id) {
      return exclusive(async () => {
        const state = await load();
        state.queue = state.queue.filter((j) => j.id !== id);
        await store.save(state);
      });
    },

    /**
     * A note for a save. If the save hasn't gone yet the note rides along with
     * it; otherwise it goes as its own request.
     */
    addNote(id, note) {
      return exclusive(async () => {
        const text = String(note || "").trim();
        if (!text) return { status: "saved", id };
        const state = await load();
        const waiting = state.queue.find((j) => j.id === id && j.kind !== "note");
        if (waiting) {
          waiting.payload = { ...waiting.payload, note: text };
          await store.save(state);
          const result = await attempt(state, waiting, await getSettings());
          await store.save(state);
          return result;
        }
        const done = state.recent.find((r) => r.id === id);
        if (!done?.payload) return { status: "held", id, message: "Couldn't find that save to add the note to." };
        // Same id as the save: it's the client_id Athena matches on.
        const job = {
          id: done.id,
          kind: "note",
          title: done.title,
          payload: { ...done.payload, kind: done.kind, note: text },
          createdAt: now(),
          attempts: 0,
          status: "pending",
          nextAt: now(),
        };
        state.queue.push(job);
        await store.save(state);
        const result = await attempt(state, job, await getSettings());
        await store.save(state);
        return result;
      });
    },

    state: () => exclusive(load),

    /** When the next pending job is due, or null. */
    async nextWake() {
      const { queue } = await exclusive(load);
      const due = queue.filter((j) => j.status === "pending").map((j) => j.nextAt ?? 0);
      return due.length ? Math.min(...due) : null;
    },
  };
}
