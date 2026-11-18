/**
 * Failed runs you've dismissed from "Waiting for you" (views/team.ts),
 * remembered on this device only. The run itself stays in the assistant's
 * history; dismissing only says "I've seen it". A newer failure is a new
 * run, so it shows again.
 *
 *   dismissRun(id)       hide it from Waiting for you
 *   undismissRun(id)     put it back (Undo)
 *   isDismissed(id)      true once dismissed here
 *   onDismissChange(fn)  after any change, in this tab or another
 */
const KEY = "athena.team.dismissed";
/** Enough to cover every failure still in view; the oldest go first. */
const KEEP = 60;

const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-KEEP)));
  } catch {
    // Private mode or full storage: it shows again next time, which is safe.
  }
  for (const fn of listeners) fn();
}

export function isDismissed(id: string): boolean {
  return read().includes(id);
}

export function dismissRun(id: string): void {
  const ids = read().filter((x) => x !== id);
  write([...ids, id]);
}

export function undismissRun(id: string): void {
  write(read().filter((x) => x !== id));
}

export function onDismissChange(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
