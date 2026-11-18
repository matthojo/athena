/**
 * The Days client: every Days call the app makes goes through here (shapes in
 * lib/day-types.ts, routes in netlify/lib/days/routes.ts). Shared with
 * days-design, which adds its sample mode beside it; keep these signatures.
 */
import type { Day, DayPatch, DaySearch, DaysRange } from "../../../lib/day-types";
import { request } from "./api";

export type { Day, DayEntry, DayPatch, DaySearch, DaySearchHit, DaysRange, DaySummary } from "../../../lib/day-types";

export const fetchDays = (from: string, to: string) => request<DaysRange>(`/days?${new URLSearchParams({ from, to })}`);

export const fetchDay = (date: string) => request<Day>(`/days/${encodeURIComponent(date)}`);

export const patchDay = (date: string, patch: DayPatch) => request<Day>(`/days/${encodeURIComponent(date)}`, { method: "PATCH", body: JSON.stringify(patch) });

export const setEntryHidden = (date: string, id: string, hidden: boolean) =>
  request<{ id: string; hidden: boolean; changed: boolean }>(`/days/${encodeURIComponent(date)}/entries/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ hidden }) });

/** What the day page's "Add to this day" sends (POST /api/days/:date/entries). */
export interface ManualEntryInput {
  kind: "watched" | "listened" | "read" | "played" | "other";
  title: string;
  subtitle?: string;
  note?: string;
  minutes?: number;
  rating?: number;
}

export const addEntry = (date: string, entry: ManualEntryInput) =>
  request<{ id: string | null; date: string }>(`/days/${encodeURIComponent(date)}/entries`, { method: "POST", body: JSON.stringify(entry) });

/** Delete an entry added by hand (anything else is hidden instead). */
export const removeEntry = (date: string, id: string) => request<{ ok: true }>(`/days/${encodeURIComponent(date)}/entries/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Filters: kind, from, to, source ("trakt"), place (a place's name), person (a person's name or id). */
export const searchDays = (q: string, opts: { kind?: string; from?: string; to?: string; source?: string; place?: string; person?: string } = {}) =>
  request<DaySearch>(`/days/search?${new URLSearchParams({ q, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)) })}`);

/** What moving the Life log's old notes into Days would do (nothing is written). */
export interface ConversionPlan {
  notes: number;
  days: number;
  entries: number;
  by_kind: Partial<Record<string, number>>;
  lines: number;
  unreadable: number;
  unread_lines: number;
  first?: string;
  last?: string;
}

export interface ConversionResult {
  converted: number;
  entries: number;
  lines: number;
  remaining: number;
  unreadable: number;
}

export const fetchConversionPlan = () => request<ConversionPlan>("/days/convert");

/** One batch (about eight seconds on the server). Call again while `remaining` goes down. */
export const convertBatch = () => request<ConversionResult>("/days/convert", { method: "POST" });
