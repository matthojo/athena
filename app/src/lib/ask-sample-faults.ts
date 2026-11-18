/**
 * Sample mode has no server to be busy or out of reach, so the retry, the
 * busy step and the keyword-search fallback can't be seen there by asking.
 * This lets a screenshot or a manual check stage them: put a list in
 * sessionStorage and the next sample answers fail that way, one per try.
 *
 *   sessionStorage.setItem("athena.ask.sampleFaults", "busy")            // busy once, then the answer
 *   sessionStorage.setItem("athena.ask.sampleFaults", "busy,busy,busy")  // busy until it falls back
 *   sessionStorage.setItem("athena.ask.sampleFaults", "offline")         // as if offline, until the next "online" event
 *   sessionStorage.setItem("athena.ask.sampleFaults", "down,down")       // out of reach, and again on the automatic retry
 *
 * Nothing sets it in the app itself, and outside sample mode it's never read.
 */
const KEY = "athena.ask.sampleFaults";

export type SampleFault = "busy" | "offline" | "down";

let offline = false;

/** The next staged fault, taken off the list; null when there's none. */
export function takeSampleFault(): SampleFault | null {
  let list: string[];
  try {
    list = (sessionStorage.getItem(KEY) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.length) return null;
    const rest = list.slice(1);
    if (rest.length) sessionStorage.setItem(KEY, rest.join(","));
    else sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  const next = list[0];
  if (next === "offline") {
    offline = true;
    return "offline";
  }
  return next === "busy" || next === "down" ? next : null;
}

/** Sample mode is staged as offline (until the next "online" event). */
export const sampleOffline = (): boolean => offline;

/** An "online" event came: the staging is over. */
export const sampleBackOnline = (): void => void (offline = false);
