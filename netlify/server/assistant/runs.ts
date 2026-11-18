/**
 * Ask runs that outlive the app. A run is one streamed reply (Ask's one loop,
 * lib/answer.ts runAsk) under the id the app chose for it. It runs to the end
 * whether or not anyone is listening, keeps its steps, its words so far and
 * its reply, and any number of requests can follow it: the first one, the
 * same one sent again after a dropped connection, or the app reopened.
 *
 * One id runs once. Sending a run's request again follows the run or replays
 * how it ended; it never starts the work a second time while the run is
 * known. The record is also kept in the store (store.ts: Netlify Blobs,
 * sealed), written before an instruction starts, as it goes and when it
 * ends, so a new instance can answer for a run an old one had.
 *
 * A run whose instance went away is only run again when that can't repeat a
 * change. The loop reads first and makes its one change last, and says so on
 * the record, waiting for the write, before it does (`beforeChange`): a run
 * whose record doesn't say so changed nothing, and is safe to run again.
 * One that did gets what it had changed by then and a word to check.
 */
import type { TextEvent, TextSink } from "../../../lib/ask-stream";
import type { Change } from "../../../lib/assistant";
import { streamError, type Step, type StepSink, type StepStreamEvent } from "../../../lib/steps";
import type { RunWork } from "./host";

/**
 * "ask": a run of Ask's one loop (lib/answer.ts runAsk), which reads and may change something. "act" and
 * "answer" are records written before the loops were merged: an instruction, and an answer that only read.
 */
export type RunKind = "ask" | "act" | "answer";

export interface RunRecord {
  id: string;
  kind: RunKind;
  /** interrupted: its instance shut down before it finished. */
  status: "running" | "done" | "error" | "interrupted";
  started: number;
  /** Last written. A running record that stops being written has lost its instance. */
  updated: number;
  steps: Step[];
  draft: string;
  /**
   * A change was about to be made. An "ask" run sets it, and waits for the record to be written, before its one
   * change (the loop's beforeChange); an older "act" run set it when a step that may change something started.
   */
  acted: boolean;
  reply?: unknown;
  /** `retry_after`: seconds, with a 429 whose wait the gateway gave. */
  error?: { status: number; message: string; retry_after?: number };
}

export interface RunStore {
  get(id: string): Promise<RunRecord | null>;
  put(record: RunRecord): Promise<void>;
}

/** A quiet connection gets a blank line this often, and a quiet run's record is touched this often. */
export const BEAT_MS = 10_000;
/** A running record not written for this long has lost its instance (it's touched every BEAT_MS). */
export const STALE_MS = 45_000;
const SAVE_EVERY_MS = 2_000;
const POLL_MS = 2_000;
/** A finished run stays in memory this long for the app to pick up; after that the store answers. */
const LINGER_MS = 10 * 60_000;

export const CUT_OFF_WITH_CHANGES = "I was cut off part-way. Here's what I'd changed by then, so check before you ask again.";
export const CUT_OFF_ACTING = "I was cut off while making a change. Check whether it went through before you ask again.";
export const CUT_OFF_ANSWER = "Athena restarted before this was answered.";

export const UNCHECKED = "Athena couldn't check whether this had already started, so nothing was done. Try again in a moment.";

/** The store couldn't be read, so a run that may change something wasn't started. */
export class RunUnchecked extends Error {
  constructor() {
    super(UNCHECKED);
  }
}

interface LiveRun {
  record: RunRecord;
  listeners: Set<(event: StepStreamEvent | "end") => void>;
  stopped: boolean;
  saving: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  finished: Promise<void>;
}

export interface Opened {
  stream: ReadableStream<Uint8Array>;
  /** The run itself, when this call started it: pass it to waitUntil. */
  background?: Promise<void>;
}

function failure(error: unknown): { status: number; message: string; retry_after?: number } {
  const known = streamError(error);
  if (known) return known;
  console.error("Athena assistant (run) failed:", error);
  return { status: 500, message: "Internal server error" };
}

const final = (r: RunRecord): StepStreamEvent | null =>
  r.status === "done" ? { type: "done", reply: r.reply } : r.status === "error" ? { type: "error", ...(r.error ?? { status: 500, message: "Internal server error" }) } : null;

/** Everything so far, as the events that rebuild it: each step as it stands, then the words from the start. */
function snapshot(r: RunRecord): StepStreamEvent[] {
  return [...r.steps.map((s): StepStreamEvent => ({ type: "step", ...s })), { type: "text", reset: true }, ...(r.draft ? [{ type: "text", delta: r.draft } as StepStreamEvent] : [])];
}

/** A reply in Ask's one shape (lib/answer.ts AskReply) that only says what happened to the run. */
const cutOffReply = (text: string, changes: Change[]) => ({ text, sources: [], related: [], searched: "", skipped: [], found: false, flagged: false, changes, choices: [] });

/** How a run that lost its instance ends for the app: one that had reached a change says what it had changed; one that hadn't just failed. */
export function cutOff(r: RunRecord): RunRecord {
  if (r.kind === "answer" || (r.kind === "ask" && !r.acted)) return { ...r, status: "error", error: { status: 500, message: CUT_OFF_ANSWER } };
  const changes = r.steps.flatMap((s) => s.changes ?? []) as Change[];
  return { ...r, status: "done", reply: cutOffReply(changes.length ? CUT_OFF_WITH_CHANGES : CUT_OFF_ACTING, changes) };
}

export function createRuns(deps: { store: RunStore | null; now?: () => number; beatMs?: number; pollMs?: number; saveEveryMs?: number }) {
  const now = deps.now ?? Date.now;
  const beatMs = deps.beatMs ?? BEAT_MS;
  const live = new Map<string, LiveRun>();
  const deciding = new Map<string, Promise<Opened | null>>();
  const encoder = new TextEncoder();
  const line = (event: StepStreamEvent | null) => encoder.encode(event ? `${JSON.stringify(event)}\n` : "\n");

  /** Writes go one after another, so an older one never lands on a newer one. */
  function save(run: LiveRun): Promise<void> {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    if (!deps.store) return Promise.resolve();
    run.record.updated = now();
    const copy = structuredClone(run.record);
    run.saving = run.saving
      .then(() => deps.store!.put(copy))
      .catch((error) => console.warn("Athena assistant (run): couldn't keep the run:", error instanceof Error ? error.message : error));
    return run.saving;
  }

  function saveSoon(run: LiveRun) {
    if (run.timer || !deps.store) return;
    run.timer = setTimeout(() => void save(run), deps.saveEveryMs ?? SAVE_EVERY_MS);
    run.timer.unref?.();
  }

  const tell = (run: LiveRun, event: StepStreamEvent | "end") => {
    for (const listener of [...run.listeners]) listener(event);
  };

  async function execute(run: LiveRun, work: RunWork, careful = false): Promise<void> {
    const r = run.record;
    /** Before an "ask" run's one change: the record says so, and is written, first. From here on this run is never started again. */
    const beforeChange = async () => {
      if (run.stopped) throw new Error("The run was stopped, so Athena stopped too");
      r.acted = true;
      await save(run);
    };
    const onStep: StepSink = (step) => {
      if (run.stopped && !step.done) throw new Error("The run was stopped, so Athena stopped too");
      const i = r.steps.findIndex((s) => s.id === step.id);
      if (i >= 0) r.steps[i] = step;
      else r.steps.push(step);
      tell(run, { type: "step", ...step });
      if (step.acts && !step.done && !r.acted) {
        // Before the change is made: from here on this run is never started again. (An "ask" run has already said so, and waited: beforeChange.)
        r.acted = true;
        void save(run);
      } else saveSoon(run);
    };
    const onText: TextSink = (text: TextEvent) => {
      if (run.stopped) throw new Error("The run was stopped, so Athena stopped too");
      r.draft = "reset" in text ? "" : r.draft + text.delta;
      tell(run, { type: "text", ...text });
      saveSoon(run);
    };
    const beat = setInterval(() => void save(run), beatMs);
    beat.unref?.();
    try {
      const reply = await work(onStep, onText, { beforeChange, careful });
      r.status = "done";
      r.reply = reply;
    } catch (error) {
      // Shut down part-way (interruptAll): the record already says so.
      if (r.status !== "interrupted") {
        r.status = "error";
        r.error = run.stopped ? { status: 499, message: "Stopped" } : failure(error);
      }
    } finally {
      clearInterval(beat);
      const ended = final(r);
      if (ended) tell(run, ended);
      tell(run, "end");
      await save(run);
      const drop = setTimeout(() => live.get(r.id) === run && live.delete(r.id), LINGER_MS);
      drop.unref?.();
    }
  }

  /** Follow a run in this instance: what's happened so far, then each event as it comes. Closing it leaves the run alone. */
  function follow(run: LiveRun): ReadableStream<Uint8Array> {
    let off = () => {};
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: StepStreamEvent | null) => {
          try {
            controller.enqueue(line(event));
          } catch {
            off();
          }
        };
        for (const event of snapshot(run.record)) send(event);
        const ended = final(run.record);
        if (ended || run.record.status === "interrupted") {
          if (ended) send(ended);
          return controller.close();
        }
        const beat = setInterval(() => send(null), beatMs);
        const listener = (event: StepStreamEvent | "end") => {
          if (event !== "end") return send(event);
          off();
          try {
            controller.close();
          } catch {
            // already gone
          }
        };
        off = () => {
          clearInterval(beat);
          run.listeners.delete(listener);
        };
        run.listeners.add(listener);
      },
      cancel() {
        off();
      },
    });
  }

  /** How a run that isn't in this instance stands, from its record: all of it, then how it ended. */
  function replay(r: RunRecord): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of snapshot(r)) controller.enqueue(line(event));
        const ended = final(r);
        if (ended) controller.enqueue(line(ended));
        controller.close();
      },
    });
  }

  /**
   * Follow a run another instance still has (a deploy, or the 8-hour
   * replacement), by its record. If the record stops being written, the
   * stream just ends: the app asks again and gets the answer for a lost run.
   */
  function followStored(first: RunRecord): ReadableStream<Uint8Array> {
    let timer: ReturnType<typeof setInterval> | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      if (beat) clearInterval(beat);
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        let seen = -1;
        const show = (r: RunRecord): boolean => {
          try {
            if (r.updated !== seen) for (const event of snapshot(r)) controller.enqueue(line(event));
            seen = r.updated;
            const ended = final(r);
            if (ended) controller.enqueue(line(ended));
            if (ended || r.status === "interrupted" || now() - r.updated >= STALE_MS) {
              stop();
              controller.close();
              return false;
            }
          } catch {
            stop();
            return false;
          }
          return true;
        };
        if (!show(first)) return;
        beat = setInterval(() => {
          try {
            controller.enqueue(line(null));
          } catch {
            stop();
          }
        }, beatMs);
        timer = setInterval(() => {
          void deps.store!.get(first.id).then(
            (r) => r && show(r),
            () => undefined,
          );
        }, deps.pollMs ?? POLL_MS);
      },
      cancel() {
        stop();
      },
    });
  }

  async function decide(id: string, kind: RunKind | null, work: RunWork | null): Promise<Opened | null> {
    let stored: RunRecord | null = null;
    /** Whether this id has already run can't be told: the run goes ahead, but may only plan a change, never make one. */
    let careful = false;
    try {
      stored = deps.store ? await deps.store.get(id) : null;
    } catch (error) {
      // An answer only reads, so it goes ahead. So does an "ask" run, told to change nothing (it plans instead). An older instruction doesn't start.
      console.warn("Athena assistant (run): couldn't read the run:", error instanceof Error ? error.message : error);
      if (kind === "act" || (kind === null && work)) throw new RunUnchecked();
      careful = kind === "ask";
    }
    if (live.has(id)) return { stream: follow(live.get(id)!) };
    if (stored) {
      if (stored.status === "running" && now() - stored.updated < STALE_MS) return { stream: followStored(stored) };
      if (stored.status === "done" || stored.status === "error") return { stream: replay(stored) };
      // Its instance went away part-way. Run it again only when that can't repeat a change: it only read, it never
      // reached its change (an "ask" run's record says so before the change, and waits for the write), or it was an
      // older instruction stopped cleanly before any step that could change something.
      const safe = stored.kind === "answer" || (stored.kind === "ask" && !stored.acted) || (stored.status === "interrupted" && !stored.acted);
      if (!work || !safe) return { stream: replay(cutOff(stored)) };
      kind = stored.kind;
    }
    if (!work || !kind) return null;
    const t = now();
    const run: LiveRun = {
      record: { id, kind, status: "running", started: t, updated: t, steps: [], draft: "", acted: false },
      listeners: new Set(),
      stopped: false,
      saving: Promise.resolve(),
      timer: null,
      finished: Promise.resolve(),
    };
    live.set(id, run);
    // An older instruction is on record before it can change anything. An "ask" run and an answer don't wait: reading
    // is safe to repeat, and an "ask" run writes its record, and waits, before the one change it makes.
    if (kind === "act") await save(run);
    else void save(run);
    run.finished = execute(run, work, careful);
    return { stream: follow(run), background: run.finished };
  }

  return {
    /**
     * Follow run `id`, starting it with `work` if nothing is known of it.
     * Without `work` (the app reopened, with only the id) it's follow or
     * nothing: null when the run isn't known.
     */
    async open(id: string, kind: RunKind | null, work: RunWork | null): Promise<Opened | null> {
      for (;;) {
        const run = live.get(id);
        if (run) return { stream: follow(run) };
        const busy = deciding.get(id);
        if (!busy) break;
        // The same id is being looked up or started right now: wait, then follow what that made.
        await busy.catch(() => undefined);
      }
      const decision = decide(id, kind, work);
      deciding.set(id, decision);
      try {
        return await decision;
      } finally {
        deciding.delete(id);
      }
    },

    /** Stop: the run ends before its next step starts (the step in hand finishes, so nothing is left half-made). */
    stop(id: string): boolean {
      const run = live.get(id);
      if (!run || run.record.status !== "running") return false;
      run.stopped = true;
      return true;
    },

    /** Shutdown, once work in progress has had its time: stop what's still going and say so on its record. */
    async interruptAll(): Promise<void> {
      await Promise.all(
        [...live.values()]
          .filter((run) => run.record.status === "running")
          .map((run) => {
            run.stopped = true;
            run.record.status = "interrupted";
            return save(run);
          }),
      );
    },

    /** How many runs are going. */
    running: () => [...live.values()].filter((run) => run.record.status === "running").length,
  };
}

export type Runs = ReturnType<typeof createRuns>;
