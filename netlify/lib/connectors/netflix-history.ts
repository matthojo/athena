/**
 * Netflix viewing activity (NetflixViewingHistory.csv, one per profile), into
 * Days and Watch & read. lib/netflix-csv.ts has the parser; the app parses
 * the file on the device and sends days of title parts in batches.
 *
 * Each episode and film is one Day entry (lib/day-imports.ts). A Life log
 * run's Trakt or Letterboxd entry for the same thing that day folds into it
 * (lib/days.ts), adding its episode numbers, rating and link. Each show and
 * film also becomes one Watch & read item with no rating: a film as watched,
 * a show as watching until the owner marks it watched (lib/watch-read-sync.ts
 * never moves it back), so the owner's own edits there stand.
 *
 * The account itself holds nothing and Athena never calls Netflix: the
 * adapter below only stops the account being treated as an MCP server.
 */
import { AthenaInputError } from "../../../lib/db";
import { isValidDate } from "../../../lib/dates";
import type { Connector } from "../../../lib/connectors";
import { titleKey, type DayWatch, type NetflixDay } from "../../../lib/netflix-csv";
import { netflixEntries } from "../../../lib/day-imports";
import { syncWatchRead, type WatchReadInput } from "../../../lib/watch-read-sync";
import { historyTarget, importToDays, type FoldResult, type HistoryTarget } from "./youtube-history";
import type { DirectAdapter } from "./direct";

export const MAX_DAYS = 120;
export const MAX_ITEMS = 3000;

/** An import-only account: no tools, nothing to open but itself. */
export const netflixAdapter: DirectAdapter = {
  id: "netflix",
  handles: (c) => c.provider === "netflix",
  tools: () => [],
  serverInfo: () => ({ website_url: "https://www.netflix.com" }),
  open: async () => ({
    tools: [],
    call: async () => ({ text: "Netflix has nothing to read here: its history comes from the owner's import.", isError: true }),
  }),
  accountProblem: () => false,
  failure: () => null,
};

/** The same Life log as the other imports. No metric: the Life log run owns episodes and films per day. */
export async function viewingTarget(account: Connector): Promise<HistoryTarget> {
  return historyTarget(account);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The request's days, checked: real dates, titles, sensible sizes. */
export function readViewingDays(raw: unknown): NetflixDay[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("days: send at least one day");
  if (raw.length > MAX_DAYS) throw new AthenaInputError(`days: at most ${MAX_DAYS} per request`);
  const seen = new Set<string>();
  let total = 0;
  return raw.map((d) => {
    const day = (d as { day?: unknown })?.day;
    const watched = (d as { watched?: unknown })?.watched;
    if (typeof day !== "string" || !isValidDate(day)) throw new AthenaInputError("days: each needs a day (YYYY-MM-DD)");
    if (seen.has(day)) throw new AthenaInputError(`days: ${day} is in this request twice`);
    seen.add(day);
    if (!Array.isArray(watched) || !watched.length) throw new AthenaInputError(`days: ${day} has nothing watched`);
    return {
      day,
      watched: watched.map((w): DayWatch => {
        const o = (w ?? {}) as Record<string, unknown>;
        const title = str(o.title, 300);
        if (!title || !titleKey(title)) throw new AthenaInputError(`days: ${day} has something without a title`);
        if (o.episodes === undefined) {
          total++;
          if (total > MAX_ITEMS) throw new AthenaInputError(`days: at most ${MAX_ITEMS} episodes and films per request`);
          return { title };
        }
        if (!Array.isArray(o.episodes) || !o.episodes.length || o.episodes.length > 200) throw new AthenaInputError(`days: ${day} has a show without episodes`);
        total += o.episodes.length;
        if (total > MAX_ITEMS) throw new AthenaInputError(`days: at most ${MAX_ITEMS} episodes and films per request`);
        return { title, season: str(o.season, 40), episodes: o.episodes.map((e) => str(e, 300)) };
      }),
    };
  });
}

export interface ViewingResult extends FoldResult {
  /** Episodes and films Days didn't have before. */
  added: number;
  /** Of those, films. */
  added_films: number;
  /** Shows and films put in Watch & read, and ones there already that were filled in. */
  watch_read: { created: number; updated: number };
}

/** Write a batch of days as Day entries, and the shows and films into Watch & read. Safe to repeat. */
export async function importViewing(target: HistoryTarget, days: NetflixDay[], opts: { now?: Date } = {}): Promise<ViewingResult> {
  const { outcomes, ...r } = await importToDays(target, days, netflixEntries, { metric: null, from: "netflix-viewing", now: opts.now });
  const created = outcomes.filter((o) => o.action === "created");
  const added = created.length;
  const addedFilms = created.filter((o) => !o.entry.group).length;
  // One Watch & read item per show and film in this batch, on the first day it was watched.
  // A show stays Watching until the owner says it's done (owner decision 7 Nov); a film is Watched.
  const items = new Map<string, WatchReadInput>();
  for (const d of days)
    for (const w of d.watched) {
      const kind = w.episodes ? ("tv" as const) : ("film" as const);
      const k = `${kind}:${titleKey(w.title)}`;
      if (!items.has(k)) items.set(k, { kind, title: w.title, status: kind === "tv" ? "reading" : "done", at: d.day, external_id: `${kind === "tv" ? "show" : "film"}:${titleKey(w.title)}`, source: "netflix" });
    }
  const synced = await syncWatchRead([...items.values()], { collection: target.source, now: opts.now });
  const watch_read = { created: synced.filter((x) => x.action === "created").length, updated: synced.filter((x) => x.action === "updated").length };
  return { ...r, added, added_films: addedFilms, watch_read };
}
