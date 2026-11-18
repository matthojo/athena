/**
 * Sample mode's history loads (components/history-load.ts): Trakt loaded
 * back to March 2019, YouTube part-way, with a Takeout import in, and
 * Octopus's meters two years back (a day of readings an item). Nothing
 * leaves the device.
 */
import type { HistoryStatus } from "../lib/history-words";

/** The sample accounts' ids, as sample Sources names them. */
export const SAMPLE_TRAKT = "00000000-0000-4000-8000-00000000e001";
export const SAMPLE_YOUTUBE = "00000000-0000-4000-8000-00000000e002";
export const SAMPLE_OCTOPUS = "00000000-0000-4000-8000-00000000e003";

let youtubeItems = 1240;

export function sampleHistory(id: string, opts: { again?: boolean } = {}): HistoryStatus | null {
  if (id === SAMPLE_TRAKT) {
    if (opts.again) return { supported: true, progress: { state: "running", items: 0, added: 0, oldest: "2019-03-02" }, takeout: null };
    return { supported: true, progress: { state: "done", items: 2318, added: 2318, oldest: "2019-03-02", finished_at: new Date().toISOString() }, takeout: null };
  }
  if (id === SAMPLE_YOUTUBE) {
    youtubeItems += 50;
    return { supported: true, progress: { state: "running", items: youtubeItems, added: youtubeItems, oldest: "2016-07-01" }, takeout: { at: new Date(Date.now() - 2 * 86_400_000).toISOString(), items: 39251 } };
  }
  if (id === SAMPLE_OCTOPUS) {
    if (opts.again) return { supported: true, progress: { state: "running", items: 120, added: 120, oldest: "2026-07-08", unit: "day" }, takeout: null };
    return { supported: true, progress: { state: "done", items: 731, added: 731, oldest: "2024-11-10", unit: "day", finished_at: new Date().toISOString() }, takeout: null };
  }
  return { supported: false, progress: null, takeout: null };
}
