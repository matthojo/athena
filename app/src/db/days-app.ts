/**
 * Days as the views use them: the shared API client (db/days.ts, owned by
 * days-data, kept byte for byte) with sample mode routed to
 * db/sample-days.ts, search's extra filters, photo upload, and images
 * (artwork and the owner's photos) fetched through the token.
 */

import { daysBetween, monthDays, monthStats, screenTime, shiftDay, type MonthStats, type ScreenTime, type StatItem } from "../../../lib/watch-stats";
import { request } from "./api";
import { getToken, isSampleMode } from "./api";
import { addEntry, fetchDay, fetchDays, patchDay, removeEntry, searchDays as searchOnServer, setEntryHidden as hideOnServer, type ManualEntryInput } from "./days";

export type { ManualEntryInput };
import type { Day, DayEntryKind, DayPatch, DaySearch, DaysRange } from "../../../lib/day-types";

export type { Day, DayArt, DayCounts, DayEntry, DayEntryKind, DayEvent, DayHealth, DayNote, DayPatch, DayPhoto, DayPlace, DaySearch, DaySearchHit, DaySummary, DaysRange, Mood } from "../../../lib/day-types";

export type EntryKind = DayEntryKind;

export interface DaySearchFilters {
  q?: string;
  kind?: EntryKind | null;
  source?: string | null;
  place?: string | null;
  person?: string | null;
}

/** A search's hits and the filter options it offers (sources, places, people). */
export type DaySearchResult = DaySearch;

type SampleModule = typeof import("./sample-days");
let sample: Promise<SampleModule> | null = null;
const samples = () => (sample ??= import("./sample-days"));

// ---------- Changed somewhere else ----------

type DaysListener = (dates: string[]) => void;
const listeners = new Set<DaysListener>();
/** Hear that days changed somewhere else (MCP, another device, a collection). `dates` are the days named; empty means any of them may have. */
export function onDaysChange(fn: DaysListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Called by the live channel (app/src/live). Each open view loads again in its own way; nothing is cached here. */
export function daysChanged(dates: string[] = []): void {
  listeners.forEach((fn) => fn(dates));
}

/** Saves of the owner's words on their way to the server, and the reloads waiting for them to land. */
let saving = 0;
const settlers = new Set<() => void>();

/** What tells one load of a day from a later one: when it last changed and how much is on it. A day this device just saved has the same mark as the server's. */
export const dayMark = (d: Day): string => `${d.updated_at ?? ""}|${d.entries.filter((e) => e.source !== "places").length}|${d.photos.length}`;

/** How much was on each day when it was last loaded or saved here, and the mark of the last save that changed only the owner's words. */
const sizes = new Map<string, string>();
const own = new Map<string, string>();
const sizeOf = (d: Day) => dayMark({ ...d, updated_at: "" });
function loaded(d: Day): Day {
  sizes.set(d.date, sizeOf(d));
  return d;
}
/** A save's answer is the whole day: if nothing but the words moved, a later load with its mark is this save's echo. */
function saved(d: Day): Day {
  if (sizes.get(d.date) === sizeOf(d)) own.set(d.date, dayMark(d));
  else own.delete(d.date);
  return loaded(d);
}
/** Whether a fresh load holds nothing a view hasn't shown: the day it painted (`mark`, a dayMark), or the echo of a save made on this device. */
export const nothingNew = (fresh: Day, mark: string): boolean => dayMark(fresh) === mark || own.get(fresh.date) === dayMark(fresh);

/**
 * A reload that never happens under the owner's hands. `ask()` loads and
 * applies, unless `busy()`; then it waits, and `settle()` tries again. If the
 * owner starts while it loads, the result is dropped and it waits again.
 */
export function idleReload<T>(busy: () => boolean, load: () => Promise<T>, apply: (value: T) => void): { ask: () => Promise<void>; settle: () => void } {
  let waiting = false;
  const ask = async () => {
    if (busy()) return void (waiting = true);
    waiting = false;
    let value: T;
    try {
      value = await load();
    } catch {
      return;
    }
    if (busy()) return void (waiting = true);
    apply(value);
  };
  return { ask, settle: () => void (waiting && void ask()) };
}

/**
 * idleReload for a view with the day's editors in `root`: busy while the caret
 * is in one of its boxes, a save is on its way, or words there haven't saved;
 * tried again when the focus leaves and when a save lands.
 */
export function reloadWhenIdle<T>(root: HTMLElement, load: () => Promise<T>, apply: (value: T) => void): () => void {
  const typing = () => {
    const a = document.activeElement;
    return a instanceof HTMLElement && root.contains(a) && (a.matches("input, textarea, select") || a.isContentEditable);
  };
  // The journal's status says when its words are still on their way, or didn't save and wait for a retry (components/day-journal.ts).
  const unsaved = () => !!root.querySelector('.journal [data-state="saving"], .journal [data-state="failed"]');
  const r = idleReload(() => saving > 0 || typing() || unsaved(), load, apply);
  root.addEventListener("focusout", () => setTimeout(r.settle, 0));
  // Also once a save lands; forgotten when the view has gone.
  const settle = () => (root.isConnected ? r.settle() : void settlers.delete(settle));
  settlers.add(settle);
  return () => void r.ask();
}

// ---------- Reading and writing ----------

/** A summary of each day with something on it between two dates, inclusive, oldest first. */
export async function loadDays(from: string, to: string): Promise<DaysRange> {
  return isSampleMode() ? (await samples()).sampleRange(from, to) : fetchDays(from, to);
}

export async function loadDay(date: string): Promise<Day> {
  return loaded(await (isSampleMode() ? (await samples()).sampleDay(date) : fetchDay(date)));
}

export async function saveDay(date: string, patch: DayPatch): Promise<Day> {
  saving++;
  try {
    return saved(await (isSampleMode() ? (await samples()).patchSampleDay(date, patch) : patchDay(date, patch)));
  } finally {
    if (!--saving) setTimeout(() => settlers.forEach((fn) => fn()), 0);
  }
}

/** Hide one thing from a day (or bring it back). */
export async function setEntryHidden(date: string, id: string, hidden: boolean): Promise<void> {
  if (isSampleMode()) return (await samples()).hideSampleEntry(date, id, hidden);
  await hideOnServer(date, id, hidden);
}

/** Add something to a day by hand: a film, an album, a book, a game, a workout. */
export async function addDayEntry(date: string, entry: ManualEntryInput): Promise<void> {
  if (isSampleMode()) return (await samples()).addSampleEntry(date, entry);
  await addEntry(date, entry);
}

/** Delete an entry that was added by hand. */
export async function removeDayEntry(date: string, id: string): Promise<void> {
  if (isSampleMode()) return (await samples()).removeSampleEntry(date, id);
  await removeEntry(date, id);
}

/** Search with every filter the server takes (kind, source, place, person). */
export async function searchDays(f: DaySearchFilters): Promise<DaySearchResult> {
  if (isSampleMode()) return (await samples()).searchSampleDays(f);
  return searchOnServer(f.q ?? "", { kind: f.kind ?? undefined, source: f.source ?? undefined, place: f.place ?? undefined, person: f.person ?? undefined });
}

/**
 * Add a photo to a day: the file goes up like any other (POST /api/files
 * with day=, already shrunk on the device by attachments.prepareFile), then
 * the day takes it (PATCH photos.add).
 */
export async function addDayPhoto(date: string, input: { id: string; blob: Blob; name: string; thumb?: Blob | null; width?: number; height?: number }): Promise<Day> {
  if (isSampleMode()) return (await samples()).addSamplePhoto(date, input);
  const form = new FormData();
  form.set("id", input.id);
  form.set("file", input.blob, input.name);
  if (input.thumb) form.set("thumb", input.thumb, "thumb.jpg");
  if (input.width) form.set("width", String(input.width));
  if (input.height) form.set("height", String(input.height));
  form.set("day", date);
  const token = getToken();
  const res = await fetch("/api/files", { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`${res.status}`);
  return saveDay(date, { photos: { add: [input.id] } });
}

// ---------- Images: artwork and the owner's photos ----------

const urls = new Map<string, Promise<string | null>>();

function cachedUrl(key: string, get: () => Promise<Blob | string | null>): Promise<string | null> {
  let p = urls.get(key);
  if (!p) {
    p = get().then(
      (b) => (b === null ? null : typeof b === "string" ? b : URL.createObjectURL(b)),
      () => null
    );
    p.then((u) => u === null && urls.delete(key));
    urls.set(key, p);
  }
  return p;
}

async function authedBlob(path: string): Promise<Blob | null> {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return res.ok ? res.blob() : null;
}

/** A poster, cover or album (GET /api/art/:id: 800px, or 240px with ?size=sm). Null when it can't be had. */
export function artUrl(id: string, size: "sm" | "lg" = "sm"): Promise<string | null> {
  return cachedUrl(`a:${id}:${size}`, async () => (isSampleMode() ? (await samples()).sampleArt(id) : authedBlob(`/api/art/${encodeURIComponent(id)}${size === "sm" ? "?size=sm" : ""}`)));
}

/** One of the owner's day photos (GET /api/files/:id, or its preview). */
export function photoUrl(id: string, thumb = true): Promise<string | null> {
  return cachedUrl(`p:${id}:${thumb}`, async () => (isSampleMode() ? (await samples()).sampleArt(id) : authedBlob(`/api/files/${encodeURIComponent(id)}${thumb ? "/thumb" : ""}`)));
}

// ---------- Watch & read's month in numbers (lib/watch-stats.ts) ----------

/** What was watched each day of a month (YYYY-MM), and for how long. Sample mode works it out here from the sample days. */
export async function loadWatchStats(month: string, items: StatItem[]): Promise<MonthStats> {
  if (!isSampleMode()) return request<MonthStats>(`/watch-stats?${new URLSearchParams({ month })}`);
  const { sampleDayNow, SAMPLE_WATCH_GENRES } = await samples();
  const today = new Date();
  const now = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const entries = monthDays(month)
    .filter((date) => date <= now)
    .flatMap((date) => sampleDayNow(date).entries.map((e) => ({ ...e, date })));
  // The sample days' shows and films aren't on the sample list: what's known about them comes with them.
  const known: StatItem[] = SAMPLE_WATCH_GENRES.map((w) => ({ kind: w.kind, title: w.title, meta: { genres: w.genres } }));
  return monthStats(entries, [...items, ...known], month);
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Screen time over the last `days` days, today included, against the same number before (lib/watch-stats.ts). */
export async function loadScreenTime(days: number, items: StatItem[]): Promise<ScreenTime> {
  const to = localDay(new Date());
  const from = shiftDay(to, -(days - 1));
  if (!isSampleMode()) return request<ScreenTime>(`/watch-stats?${new URLSearchParams({ from, to })}`);
  const { sampleDayNow, SAMPLE_WATCH_GENRES } = await samples();
  const entries = daysBetween(shiftDay(from, -days), to).flatMap((date) => sampleDayNow(date).entries.map((e) => ({ ...e, date })));
  return screenTime(entries, items, from, to, { today: to });
}
