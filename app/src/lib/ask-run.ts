/**
 * Following an Ask run (netlify/server/assistant/runs.ts). On the Netlify
 * Server a reply runs under an id the app chose and carries on without the
 * app, so a connection that drops (the phone locked, a tunnel, the app in the
 * background) is no failure: the same request is sent again under the same
 * id, and the server follows the run or replays how it ended. It never runs
 * the work twice, so sending again is always safe.
 */

export interface FollowOptions {
  /** Stop, or leaving: ends the following at once. */
  signal?: AbortSignal;
  /** Was this failure a lost connection (worth another go), not an answer from the server? */
  dropped: (error: unknown) => boolean;
  /** Resolves when it's worth trying: online and on screen. */
  ready?: (signal?: AbortSignal) => Promise<void>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Tries in a row that hear nothing from the server before giving up (about half a minute of them). */
  tries?: number;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * Run `attempt` until it gives an outcome. An attempt that drops is tried
 * again after a short wait, once there's a connection and the app is on
 * screen. `heard` is for the attempt to say the server answered at all: only
 * tries in a row that hear nothing count towards giving up, when the last
 * failure is thrown.
 */
export async function followRun<T>(attempt: (heard: () => void) => Promise<T>, o: FollowOptions): Promise<T> {
  const tries = o.tries ?? 6;
  const wait = o.wait ?? sleep;
  for (let silent = 0; ; ) {
    let heard = false;
    try {
      return await attempt(() => (heard = true));
    } catch (error) {
      if (o.signal?.aborted || !o.dropped(error)) throw error;
      silent = heard ? 0 : silent + 1;
      if (silent >= tries) throw error;
      await wait(BACKOFF_MS[Math.min(silent, BACKOFF_MS.length - 1)], o.signal);
      await (o.ready ?? onScreenAndOnline)(o.signal);
      if (o.signal?.aborted) throw error;
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

/** Back in the foreground with a connection (straight away if that's how things are). */
function onScreenAndOnline(signal?: AbortSignal): Promise<void> {
  const ok = () => navigator.onLine && document.visibilityState !== "hidden";
  if (ok() || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!ok() && !signal?.aborted) return;
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
      signal?.removeEventListener("abort", check);
      resolve();
    };
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    signal?.addEventListener("abort", check, { once: true });
  });
}
