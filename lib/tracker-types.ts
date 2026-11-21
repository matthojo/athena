/**
 * Tracking: anything the owner wants followed over time (docs/team.md,
 * "Tracking"). Owner, 16 Nov 2026: generalise the price trend so "a user can
 * track anything numeric over time", with a label and a prefix or suffix
 * (label "price", prefix "£"); then: numbers AND states ("in stock"), on a
 * saved item OR on its own, several per thing, called "Tracking" in the app.
 *
 * A price is one preset of a tracker: label "price", a currency, lower is
 * better, a target of "at or under". Stock is another: a state, with a target
 * of "is in stock".
 *
 * The contract between the server (lib/trackers*.ts, the routes and the
 * tools) and the app (app/src/db/trackers.ts and the tracking panel). Types
 * only: no logic here.
 */

/** A number written with a prefix or suffix, or one of a short list of states. */
export type TrackerKind = "number" | "state";

/** What counts as news for a number: a new low, a new high, or any change. A state is always "change". */
export type TrackerDirection = "lower" | "higher" | "change";

/** Ready-made trackers. `null`: one the owner described themselves. */
export type TrackerPreset = "price" | "stock" | null;

/** "Tell me when…": at or under, at or over, exactly this (a state, or a number), or whenever it changes. */
export interface TrackerTarget {
  op: "lte" | "gte" | "eq" | "change";
  /** A number as written ("30", "29.99"), or a state ("in stock"). Empty for "change". */
  value: string;
  set_by: "owner" | "ask" | "assistant";
  assistant_id: string | null;
  set_at: string;
}

export interface Tracker {
  id: string;
  /** The saved item it follows, or null for one that stands on its own. */
  saved_id: string | null;
  /** What's being followed when it stands on its own ("Octopus tariff", "Followers on my channel"). For a saved item's tracker this is the item's name, filled in by the server. */
  name: string;
  /** The page to check, when there is one. A saved item's tracker defaults to the item's link. */
  url: string | null;
  /** What the value is, in the owner's word: "price", "stock", "followers". Lower case, at most 24 characters. */
  label: string;
  kind: TrackerKind;
  /** Written before a number ("£"). Empty for none. */
  prefix: string;
  /** Written after a number ("%", " kWh"). Empty for none. */
  suffix: string;
  /** ISO 4217 for a price ("GBP"), so two prices in different currencies are never compared. Null otherwise. */
  currency: string | null;
  /** The states a state tracker can be in, the good one first ("in stock", "sold out"). Empty for a number. */
  states: string[];
  direction: TrackerDirection;
  preset: TrackerPreset;
  target: TrackerTarget | null;
  /** The assistant that checks it, when one does. */
  assistant_id: string | null;
  /**
   * Added (additive, 0074): who chose the checker. Null: nobody yet, so the first assistant to keep a check on it
   * takes it on. "owner": the owner chose, an assistant or "Just me" (assistant_id null), and it's never overwritten.
   * "ask" / "assistant": Ask gave it to one, or an assistant started it or took it on. Missing on older servers.
   */
  assistant_set_by?: "owner" | "ask" | "assistant" | null;
  created_at: string;
}

export type TrackerChecker = "save" | "owner" | "ask" | "assistant";

/** One check. Every check is kept, the same value too. */
export interface TrackerPoint {
  id: string;
  tracker_id: string;
  /** A number as written on the page ("34", "159.99"), never rounded or converted; or the state. */
  value: string;
  /** Where it was read: the shop or site ("Smyths"). */
  source: string | null;
  /** The page it was read on. Required for anything an assistant or Ask records; the owner may add one by hand without. */
  url: string | null;
  checked_at: string;
  checked_by: TrackerChecker;
  assistant_id: string | null;
  /** The assistant's name when it checked, for "Checked by Penny". */
  who?: string | null;
}

/** What the points add up to, worked out by the server so every screen agrees. */
export interface TrackerSummary {
  first: TrackerPoint;
  latest: TrackerPoint;
  /** A number's best so far by its direction (the lowest, or the highest). Null for a state and for direction "change". */
  best: TrackerPoint | null;
  /** When the value last differed from the check before it. */
  changed_at: string | null;
  /** The latest check meets the target. */
  target_reached: boolean;
  /** The latest check is recent enough to call "now" (14 days, owner 16 Nov 2026). */
  fresh: boolean;
  checks: number;
  sources: number;
  /**
   * Added by the server session (additive): the check that counts as "now". For a number with a direction, the best
   * of each source's latest check within 14 days of the newest ("best price now", owner 16 Nov 2026); otherwise the
   * latest. `target_reached` is judged on it. Always present in the server's answers.
   */
  now?: TrackerPoint;
  /**
   * Added (additive; owner, 16 Nov 2026): the check that meets the target. A target on a number is reached while
   * any source's current value meets it (each source's latest check within 14 days of the newest), so a dearer check
   * at another shop doesn't clear it. Null when it isn't reached.
   */
  reached_by?: TrackerPoint | null;
}

/** A tracker as the app shows it: its points oldest first, and their summary (null with no checks yet). */
export interface TrackerView extends Tracker {
  points: TrackerPoint[];
  summary: TrackerSummary | null;
}

/** What a kept check says was new about it, for the run that kept it and for What Ask did. */
export interface TrackerNews {
  /** A number's new best by its direction. */
  best: boolean;
  /** The value differs from the check before. */
  changed: boolean;
  target_reached: boolean;
}

// ---------- routes ----------

/** GET /api/trackers?saved_id=<id> (one item's), ?standalone=1 (those on their own), or neither (all). */
export interface TrackersResponse {
  trackers: TrackerView[];
}

/** POST /api/trackers. With `preset`, the rest is filled in; otherwise `label` and `kind` are required. */
export interface TrackerInput {
  saved_id?: string | null;
  name?: string;
  url?: string | null;
  preset?: TrackerPreset;
  label?: string;
  kind?: TrackerKind;
  prefix?: string;
  suffix?: string;
  currency?: string | null;
  states?: string[];
  direction?: TrackerDirection;
  /** null clears it. */
  target?: Pick<TrackerTarget, "op" | "value"> | null;
  assistant_id?: string | null;
}

/** POST /api/trackers and PATCH /api/trackers/<id> answer the tracker; DELETE answers { ok: true }. */
export interface TrackerResponse {
  tracker: TrackerView;
}

/** Added (additive): PATCH /api/trackers/<id> also answers the tracker as it was, for Undo. */
export interface TrackerPatchResponse extends TrackerResponse {
  was: TrackerView;
}

/** Added (additive): POST /api/trackers/<id>/restore brings a stopped tracker back (Undo of DELETE) → TrackerResponse. */
export type TrackerRestoreResponse = TrackerResponse;

/** Added (additive): POST /api/trackers/<id>/points answers the check, what was new about it, and the tracker after. */
export interface TrackerPointResponse {
  point: TrackerPoint;
  news: TrackerNews;
  tracker: TrackerView;
}

/** POST /api/trackers/<id>/points: the owner adds a check by hand. DELETE /api/trackers/<id>/points/<pointId> removes one (never the first, kept at save). */
export interface TrackerPointInput {
  value: string;
  source?: string | null;
  url?: string | null;
  checked_at?: string;
  /** Added (additive): a price's currency as the page gave it; refused (400) when it isn't the tracker's. */
  currency?: string | null;
}

// Added (additive): POST /api/trackers/<id>/points/<pointId>/restore brings a removed check back → { ok: true }. DELETE of the save point is 409.

// ---------- limits ----------

export const TRACKER_LIMITS = {
  /** Trackers on one saved item. */
  perItem: 6,
  /** Trackers standing on their own. */
  standalone: 40,
  label: 24,
  affix: 8,
  states: 6,
  state: 24,
  /** Days a check counts as "now". */
  freshDays: 14,
} as const;
