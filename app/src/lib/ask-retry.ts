/**
 * Ask keeps trying for a written answer before it shows a keyword search. A
 * 429 waits and asks again, up to two more times, with a visible step
 * saying it's busy. A broken stream, a 502 or 504, or a network error is
 * asked again once. Anything else, Stop, or no connection at all, ends it
 * at once: the caller falls back, and says why. When a 429 says how long to
 * wait (the `Retry-After` header, or `retry_after` on a streamed error,
 * both in seconds) that's the wait, up to 30 s, in place of the guess.
 *
 * Pure: errors are read by their shape, so nothing here imports the network.
 */

export type RetryKind = "busy" | "dropped";

/** How long to wait before each further try. */
export const BUSY_WAITS_MS = [4_000, 10_000];
export const DROPPED_WAIT_MS = 1_500;
/** The longest a server's Retry-After is followed for. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** A Retry-After header given in seconds, as seconds; undefined for a date, a blank or anything else. */
export function retryAfterSeconds(header: string | null | undefined): number | undefined {
  return header && /^\s*\d+\s*$/.test(header) ? Number(header) : undefined;
}

/**
 * A streamed error's `retry_after` (lib/steps.ts): seconds as a number, since a stream has no header to carry
 * the wait. Undefined for anything that isn't a whole, positive number of seconds.
 */
export function retryAfterEvent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/** How long a busy reply asked for, capped; undefined when it didn't say. */
function toldWait(error: unknown): number | undefined {
  const s = error && typeof error === "object" ? (error as { retryAfter?: unknown }).retryAfter : undefined;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, RETRY_AFTER_CAP_MS) : undefined;
}

const statusOf = (error: unknown): number | undefined => (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined);
const nameOf = (error: unknown): string => (error && typeof error === "object" ? String((error as { name?: unknown }).name ?? "") : "");

/** Is this failure worth another go, and which kind? Null: it isn't (a refusal, a time-out, Stop). */
export function retryKind(error: unknown): RetryKind | null {
  const status = statusOf(error);
  if (status === 429) return "busy";
  if (status === 502 || status === 504) return "dropped";
  if (status !== undefined) return null;
  const name = nameOf(error);
  if (name === "AbortError" || name === "TimeoutError") return null;
  // fetch's own failure (no route, DNS, a reset) is a TypeError.
  if (name === "StreamBroken" || error instanceof TypeError) return "dropped";
  return null;
}

export interface RetryWait {
  kind: RetryKind;
  /** Which further try this wait comes before: 1, then 2. */
  attempt: number;
  ms: number;
  /** The server said how long (Retry-After). */
  told?: boolean;
}

export interface RetryOptions {
  signal?: AbortSignal;
  /** False: there's no connection, so nothing is tried again. */
  online?: () => boolean;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A wait begins (the busy step shows) … */
  onWait?: (w: RetryWait) => void;
  /** … and ends: the next try starts now. */
  onRetry?: (w: RetryWait) => void;
}

/**
 * Run `attempt` until it answers or it's time to fall back. `tryNo` counts
 * from 0; `last` is the failure the try follows. Throws the last failure.
 */
export async function withRetry<T>(attempt: (tryNo: number, last: unknown) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const wait = o.wait ?? sleep;
  let busy = 0;
  let dropped = 0;
  let last: unknown = null;
  for (let tryNo = 0; ; tryNo++) {
    try {
      return await attempt(tryNo, last);
    } catch (error) {
      last = error;
      if (o.signal?.aborted) throw error;
      const kind = retryKind(error);
      if (!kind || (o.online && !o.online())) throw error;
      if (kind === "busy" ? busy >= BUSY_WAITS_MS.length : dropped >= 1) throw error;
      const told = kind === "busy" ? toldWait(error) : undefined;
      const w: RetryWait = kind === "busy" ? { kind, attempt: busy + 1, ms: told ?? BUSY_WAITS_MS[busy], ...(told !== undefined ? { told: true } : {}) } : { kind, attempt: 1, ms: DROPPED_WAIT_MS };
      if (kind === "busy") busy++;
      else dropped++;
      o.onWait?.(w);
      await wait(w.ms, o.signal);
      if (o.signal?.aborted) throw error;
      // The connection went while it waited: fall back now, and let the reconnect bring it back.
      if (o.online && !o.online()) throw error;
      o.onRetry?.(w);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The step shown while Ask waits to try again. */
import { BUSY_STEP_FIRST } from "../../../lib/ask-busy";
export { BUSY_STEP_ID } from "../../../lib/ask-busy";
export function busyStepText(w: RetryWait): string {
  if (w.kind === "dropped") return "The connection dropped. Asking again";
  // A wait the server set can be long: say how long, so the step doesn't look stuck.
  const secs = Math.round(w.ms / 1000);
  if (w.told && secs >= 5) return `${w.attempt === 1 ? "Athena's AI is busy" : "Still busy"}. Trying again in ${secs} seconds`;
  return w.attempt === 1 ? BUSY_STEP_FIRST : "Still busy. Trying once more";
}
