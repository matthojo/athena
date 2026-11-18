/**
 * Where a day's map goes: the art session's map (components/day-map.ts),
 * which Athena draws on the server from the day's sealed places, with its
 * own loading, no-key, offline and no-places states. A day with no places
 * hides it; the stops list beside it always carries the words.
 */
import { dayMap } from "./day-map";

export function dayMapSlot(date: string, places: string[]): { el: HTMLElement; destroy: () => void } | null {
  if (!places.length) return null;
  const m = dayMap({ date, places });
  return { el: m.el, destroy: m.destroy };
}
