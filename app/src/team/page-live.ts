/**
 * The Team page keeps up while it's open (views/team.ts): it looks again
 * every few seconds while someone is working, every half minute when
 * nobody is, and not at all while the tab is hidden. Coming back to the tab
 * looks straight away.
 */
export interface LiveOptions {
  /** Fetch and draw. Resolves true while anything is queued or working. */
  look: () => Promise<boolean>;
  /** How long to wait while busy, and while quiet (ms). */
  busyMs?: number;
  quietMs?: number;
}

export function keepLooking(o: LiveOptions): { now: () => void; stop: () => void } {
  const busyMs = o.busyMs ?? 4000;
  const quietMs = o.quietMs ?? 30_000;
  let timer = 0;
  let stopped = false;
  let running = false;
  let again = false;

  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

  async function tick() {
    window.clearTimeout(timer);
    if (stopped) return;
    if (running) return void (again = true);
    running = true;
    let busy = false;
    try {
      busy = await o.look();
    } catch {
      // Offline or the server hiccupped: try again at the quiet pace.
    } finally {
      running = false;
    }
    if (stopped) return;
    if (again) {
      again = false;
      return void tick();
    }
    if (!hidden()) timer = window.setTimeout(tick, busy ? busyMs : quietMs);
  }

  const onVisible = () => {
    if (!hidden()) void tick();
    else window.clearTimeout(timer);
  };
  document.addEventListener("visibilitychange", onVisible);
  void tick();

  return {
    now: () => void tick(),
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
