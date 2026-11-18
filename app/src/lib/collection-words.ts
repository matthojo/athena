/**
 * The words for collections, kept apart from the screens so the form, the
 * detail and (later) Sources say the same thing the same way.
 *
 *  - scheduleSentence(): "Every morning at 07:15, reads Personal Gmail."
 *  - whatItSaves(recipe): the ✓ lines and the one "Never" line.
 *  - runHeadline(run): "4 things saved", "Nothing new", "Didn't run", in words.
 *  - runDay(run): "Today", "Yesterday", "Wednesday", "3 Nov".
 *
 * Times come from the device's locale (hour and minute) everywhere: rows,
 * sentences and pickers. Relative times only for the past.
 *
 * `current_run` and `last_run` arrive with slice D. Until then they're
 * missing, which reads as "not running" and "no history yet".
 */

import { plural } from "./format";
import { CONNECTOR_PRESETS, RECIPES, presetFor } from "../../../lib/connector-presets";
import { activityLineFromStats, activityTotal } from "../../../lib/activity-words";
import type { Collection, CollectionRun, Connector, RecipeId } from "../types";

// ---------- Server fields that land with slice D (read as optional) ----------

export interface CurrentRun {
  id: string;
  status: "queued" | "running";
  started_at: string | null;
}

export interface LastRun {
  status: CollectionRun["status"];
  finished_at: string | null;
  error: string;
  /** Records written. */
  saved: number;
  /** Ids of the accounts that stopped it. */
  blocked_by: string[];
}

export type CollectionLive = Collection & {
  current_run?: CurrentRun | null;
  last_run?: LastRun | null;
};

/** A run as GET /collections/:id/runs sends it, with D's `blocked_by` and `saved` when present. */
export type RunLike = CollectionRun & {
  stats: CollectionRun["stats"] & { blocked_by?: string[]; saved?: number };
};

/** One thing a run saved (GET /collections/:id/runs/:run/items). */
export interface RunItem {
  kind: string;
  record_id: string;
  title: string;
  item_date: string | null;
  archived: boolean;
}

// ---------- Recipes ----------

export const recipeOf = (id: RecipeId) => RECIPES.find((r) => r.id === id) ?? RECIPES[RECIPES.length - 1];

/** One line per recipe card. */
const RECIPE_LINE: Record<RecipeId, string> = {
  "calendar-meetings": "Decisions and to-dos from your meetings",
  "email-digest": "Things to act on, trips and orders, from email",
  "work-activity": "What shipped, what was decided and what's stuck",
  "life-log": "What you watched, played, listened to, read and posted",
  "plays-watches": "Plays, books, games, posts, habits and health, every hour",
  "work-sync": "Your issues and pull requests, counted every hour",
  home: "Energy, bank accounts and appliances, every hour",
  custom: "Your own instructions, on the accounts you choose",
};
export const recipeLine = (id: RecipeId): string => RECIPE_LINE[id];

/** What Your activity reads from a service, as the offer says it: "the games you played". */
const ACTIVITY_NOUN: Record<string, string> = {
  goodreads: "the books on your shelves",
  readwise: "how many highlights you made",
  steam: "the games you played",
  lichess: "your chess games",
  chesscom: "your chess games",
  raindrop: "what you bookmarked",
  eventbrite: "the events you went to",
  habitify: "your habits",
  todoist: "your routines",
  reddit: "what you posted and saved",
  bluesky: "what you posted",
  mastodon: "what you posted",
  strava: "your workouts",
  oura: "your sleep and workouts",
  withings: "your sleep, weight and steps",
  whoop: "your sleep and workouts",
  polar: "your sleep and workouts",
};
export const activityNoun = (provider: string): string => ACTIVITY_NOUN[provider] ?? "what you played and watched";

/** Whether an account's service feeds this recipe. Custom reads anything. */
export function fits(c: Pick<Connector, "provider"> & { auth_type?: Connector["auth_type"] }, recipe: RecipeId): boolean {
  // A custom server could feed anything, so it's never assumed to fit a named recipe; it stays under "Show other accounts".
  if (recipe === "custom") return true;
  // Todoist's habits are read by Athena itself only with an API token; signed in, they're Todoist's own server's.
  if (recipe === "plays-watches" && c.provider === "todoist" && c.auth_type && c.auth_type !== "token") return false;
  return c.provider !== "custom" && presetFor(c.provider).recipes.includes(recipe);
}

/** Connected and fitting: the accounts a recipe can use today. */
export function readyAccounts(connectors: Connector[], recipe: RecipeId): Connector[] {
  return connectors.filter((c) => c.status === "connected" && fits(c, recipe));
}

/** Services that feed a recipe, from the presets (so new services fill in by themselves). */
export function servicesFor(recipe: RecipeId): string[] {
  return CONNECTOR_PRESETS.filter((p) => p.id !== "custom" && p.recipes.includes(recipe)).map((p) => p.label);
}

/** "Trakt and YouTube"; "Trakt, YouTube and Letterboxd". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Needs an account like Trakt or YouTube", or null when no service feeds it yet. */
export function needsAccountLine(recipe: RecipeId): string | null {
  const names = servicesFor(recipe).slice(0, 2);
  if (!names.length) return null;
  return `Needs an account like ${names.join(" or ")}`;
}

// ---------- Times ----------

/** "07:15" → the device's way of writing it ("07:15", or "7:15 AM"). */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** An instant's time of day on this device. */
export function clockAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export function dayPart(hhmm: string): DayPart {
  const h = Number(hhmm.slice(0, 2));
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

/** A time that fits a part of the day: keep `current` if it does, else the recipe's time, else a sensible one. */
export function timeFor(part: DayPart, current: string, recipeTime: string): string {
  if (dayPart(current) === part) return current;
  if (dayPart(recipeTime) === part) return recipeTime;
  return {
    morning: "07:00",
    afternoon: "13:00",
    evening: "18:30",
    night: "22:30",
  }[part];
}

/** "Every morning at 07:15" · "Every 6 hours" · "Only when you run it". */
export function whenPhrase(c: Pick<Collection, "schedule" | "run_at" | "every_hours">): string {
  if (c.schedule === "manual") return "Only when you run it";
  if (c.schedule === "hourly") {
    const n = c.every_hours ?? 1;
    return n === 1 ? "Every hour" : n === 24 ? "Once a day" : `Every ${n} hours`;
  }
  const t = c.run_at?.slice(0, 5) ?? "07:00";
  return `Every ${dayPart(t)} at ${clock(t)}`;
}

/** Names of the accounts, as "Work Gmail and Personal Gmail". Gone accounts are left out. */
export function accountNames(ids: string[], connectors: Connector[]): string {
  return andList(ids.map((id) => connectors.find((c) => c.id === id)?.name).filter((n): n is string => !!n));
}

/** The detail's subtitle: "Every morning at 07:15, reads Personal Gmail." */
export function scheduleSentence(c: Pick<Collection, "schedule" | "run_at" | "every_hours" | "connector_ids">, connectors: Connector[]): string {
  const names = accountNames(c.connector_ids, connectors);
  const when = whenPhrase(c);
  if (!names) return `${when}.`;
  return c.schedule === "manual" ? `Reads ${names}, only when you run it.` : `${when}, reads ${names}.`;
}

/** "Email digest · personal"; a custom collection keeps its own name. */
export function collectionTitle(c: Pick<Collection, "recipe" | "name" | "label">): string {
  if (c.recipe === "custom") return c.name;
  const base = recipeOf(c.recipe).label;
  return c.label ? `${base} · ${c.label}` : base;
}

// ---------- What it saves ----------

export interface SavesLine {
  title: string;
  sub: string;
}

export interface Saves {
  saves: SavesLine[];
  never: SavesLine;
}

/** What a recipe saves and never saves. `aheadDays` is the calendar's look-ahead (0 hides that line). */
export function whatItSaves(recipe: RecipeId, aheadDays = 14): Saves {
  switch (recipe) {
    case "calendar-meetings":
      return {
        saves: [
          {
            title: "Meetings worth keeping",
            sub: "A note each, with decisions and to-dos",
          },
          { title: "Who was there", sub: "Linked to People" },
          ...(aheadDays > 0
            ? [
                {
                  title: `Your next ${aheadDays} days`,
                  sub: "Events in Coming up",
                },
              ]
            : []),
        ],
        never: {
          title: "Never whole transcripts",
          sub: "Or money and health details",
        },
      };
    case "email-digest":
      return {
        saves: [
          { title: "Things to act on", sub: "A note each, with who it's from" },
          {
            title: "Trips and bookings",
            sub: "Flights, trains and hotels, in Trips",
          },
          { title: "Orders", sub: "Tracked to your door, in Purchases" },
        ],
        never: {
          title: "Never money or health details",
          sub: "A bank email is noted, its figures are not",
        },
      };
    case "work-activity":
      return {
        saves: [
          {
            title: "What shipped, what was decided, what's stuck",
            sub: "Linked to its project",
          },
          { title: "Open blockers", sub: "Until they're cleared" },
        ],
        never: {
          title: "Never a sweep of your chat",
          sub: "It looks for decisions and blockers only",
        },
      };
    case "life-log":
      return {
        saves: [
          {
            title: "One line a day, from what's in your days",
            sub: "And entries from accounts Athena can't read by itself",
          },
        ],
        never: {
          title: "Never your feeds or other people's profiles",
          sub: "Only your own activity",
        },
      };
    case "plays-watches":
      return {
        saves: [
          { title: "What you played, watched, read and posted", sub: "On the day it happened" },
          { title: "Habits, workouts and sleep", sub: "Your health days stay sealed" },
          { title: "Films, shows and books in Watch & read", sub: "Marked watched or read" },
        ],
        never: {
          title: "Never your feeds or other people's posts",
          sub: "Only your own activity",
        },
      };
    case "work-sync":
      return {
        saves: [
          { title: "Issues assigned to you", sub: "When each started and closed" },
          { title: "Pull requests you opened or reviewed", sub: "When each opened and merged" },
        ],
        never: {
          title: "Never anyone else's work",
          sub: "A teammate's issues are left out",
        },
      };
    case "home":
      return {
        saves: [
          { title: "Energy, half hour by half hour", sub: "For House, with your tariff's costs" },
          { title: "What you spent and where", sub: "For Money, and your regular payments" },
          { title: "Each finished programme", sub: "From your appliances, on your days" },
        ],
        never: {
          title: "Never shown to the AI",
          sub: "Kept sealed, and only read",
        },
      };
    default:
      return {
        saves: [
          {
            title: "What your instructions ask for",
            sub: "As notes filed under this collection",
          },
        ],
        never: {
          title: "Never sends, edits or deletes",
          sub: "It only reads your accounts",
        },
      };
  }
}

// ---------- Runs ----------

export type RunTone = "saved" | "nothing" | "didnt" | "running";

export interface RunWords {
  tone: RunTone;
  title: string;
  /** What it saved, or why it didn't run. */
  sub: string;
  /** Records written, for "See all 4 in Notes". */
  saved: number;
}

/** Records a run wrote: notes, events, people, to-dos, bookings and orders (counts and metrics aren't things). */
export function savedCount(r: RunLike): number {
  const s = r.stats ?? {};
  if (typeof s.saved === "number") return s.saved;
  return (
    (s.notes_created ?? 0) +
    (s.notes_updated ?? 0) +
    (s.events_created ?? 0) +
    (s.people ?? 0) +
    (s.todos ?? 0) +
    (s.catch_ups ?? 0) +
    (s.bookings_created ?? 0) +
    (s.purchases_created ?? 0) +
    (s.renewals_created ?? 0) +
    (s.entries_created ?? 0) +
    activityTotal(s) +
    (s.issues_new ?? 0) +
    (s.prs_new ?? 0)
  );
}

/** A Your activity run: "6 plays, 1 watch, 2 books, 1 workout", or "Nothing new" (media-sync.ts says it the same way). */
export function playsWatchesLine(s: Record<string, unknown>): string {
  return activityLineFromStats(s);
}

/** A Your work, counted run: "3 issues, 2 pull requests", or "Nothing new" (work-sync.ts says it the same way). */
export function workSyncLine(s: { issues_new?: number; prs_new?: number }): string {
  const n = (count: number | undefined, one: string, many: string) => (count ? `${count.toLocaleString("en-GB")} ${plural(count, one, many)}` : "");
  const parts = [n(s.issues_new, "issue", "issues"), n(s.prs_new, "pull request", "pull requests")].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing new";
}

/** A Home run: "3 days updated, 1 programme finished", or "Up to date" (home-run.ts keeps the per-account detail in its summary). */
export function homeLine(s: { days_updated?: number; programmes_finished?: number }): string {
  const n = (count: number | undefined, one: string, many: string) => (count ? `${count.toLocaleString("en-GB")} ${plural(count, one, many)}` : "");
  const parts = [n(s.days_updated, "day updated", "days updated"), n(s.programmes_finished, "programme finished", "programmes finished")].filter(Boolean);
  return parts.length ? parts.join(", ") : "Up to date";
}

/** "2 notes, 1 trip and 1 order". Nothing truncates; it wraps. */
function savedParts(r: RunLike): string {
  const s = r.stats ?? {};
  const n = (count: number | undefined, one: string, many: string) => (count ? `${count} ${plural(count, one, many)}` : "");
  const notes = (s.notes_created ?? 0) + (s.notes_updated ?? 0);
  return andList(
    [
      n(notes, "note", "notes"),
      n(s.events_created, "event", "events"),
      n(s.people, "new person", "new people"),
      n((s.todos ?? 0) + (s.catch_ups ?? 0), "to-do", "to-dos"),
      n(s.bookings_created, "trip", "trips"),
      n(s.purchases_created, "order", "orders"),
      n(s.renewals_created, "renewal", "renewals"),
      n(s.entries_created, "entry in Days", "entries in Days"),
    ].filter(Boolean),
  );
}

/** The accounts that stopped a run: D's `blocked_by`, or the names in today's error text. */
export function blockedBy(r: RunLike, connectors: Connector[]): Connector[] {
  const ids = r.stats?.blocked_by;
  if (ids?.length) return ids.map((id) => connectors.find((c) => c.id === id)).filter((c): c is Connector => !!c);
  if (r.status !== "failed") return [];
  return connectors.filter((c) => r.error.includes(`${c.name} (needs signing in)`) || r.error.includes(`${c.name} needs signing in`));
}

/** "Personal Gmail is signed out", "GitHub's key stopped working". */
export function accountProblem(c: Connector): string {
  if (c.status === "pending") return `${c.name} isn't connected yet`;
  if (c.status === "error") {
    if (/admin|consent/i.test(c.status_detail)) return `${c.name} needs your IT admin`;
    if (/secret|key|expired/i.test(c.status_detail)) return `${c.name}'s key expired`;
    return `${c.name} isn't answering`;
  }
  if (c.auth_type === "token") return `${c.name}'s key stopped working`;
  if (c.oauth?.grant === "client_credentials") return `${c.name} can't get access`;
  return `${c.name} is signed out`;
}

/** A failed run's reason, in words. The raw text goes to the console, not the screen. */
export function failReason(r: RunLike, connectors: Connector[]): string {
  const blocked = blockedBy(r, connectors);
  if (blocked.length) return blocked.length === 1 ? accountProblem(blocked[0]) : `${andList(blocked.map((c) => c.name))} are signed out`;
  const e = r.error || "";
  if (/needs signing in|invalid_grant|unauthori[sz]ed|\b401\b/i.test(e)) return "An account it reads is signed out";
  if (/No account could be reached/i.test(e)) return "None of its accounts answered";
  if (/allowed tools/i.test(e)) return "Its accounts don't allow any reading yet";
  if (/No way to reach Claude|ANTHROPIC_API_KEY|AI Gateway/i.test(e)) return "Athena's AI isn't set up on the server";
  if (/overloaded|rate.?limit|\b429\b|\b529\b/i.test(e)) return "The AI was busy. It tries again next time";
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed|\b50[234]\b/i.test(e)) return "A service didn't answer. It tries again next time";
  if (/cut off|token limit/i.test(e)) return "It found too much in one go. It tries again next time";
  if (/deleted/i.test(e)) return "The collection was deleted";
  if (e) console.info("Athena collection run failed:", e);
  return "Something went wrong on Athena's side. It tries again next time";
}

export function runHeadline(r: RunLike, connectors: Connector[] = []): RunWords {
  if (r.status === "queued")
    return {
      tone: "running",
      title: "Starting",
      sub: "It usually takes a minute or two",
      saved: 0,
    };
  if (r.status === "running")
    return {
      tone: "running",
      title: "Running now",
      sub: "It usually takes a minute or two",
      saved: 0,
    };
  if (r.status === "failed")
    return {
      tone: "didnt",
      title: "Didn't run",
      sub: failReason(r, connectors),
      saved: 0,
    };
  // Your activity: plain counts, and any account that asked it to wait (the summary's later sentences).
  if (typeof r.stats?.plays_new === "number") {
    const s = r.stats;
    const total = activityTotal(s);
    return { tone: total ? "saved" : "nothing", title: playsWatchesLine(s), sub: (r.summary ?? "").split(". ").slice(1).join(". "), saved: total };
  }
  // Your work, counted: the same, for issues and pull requests.
  if (typeof r.stats?.issues_new === "number") {
    const s = r.stats;
    const total = (s.issues_new ?? 0) + (s.prs_new ?? 0);
    return { tone: total ? "saved" : "nothing", title: workSyncLine(s), sub: (r.summary ?? "").split(". ").slice(1).join(". "), saved: total };
  }
  // Home: days updated and programmes finished; the summary says which account did what (counts only).
  if (typeof r.stats?.days_updated === "number") {
    const s = r.stats;
    const total = (s.days_updated ?? 0) + (s.programmes_finished ?? 0);
    return { tone: total ? "saved" : "nothing", title: homeLine(s), sub: r.summary ?? "", saved: 0 };
  }
  const saved = savedCount(r);
  const skipped = r.stats?.triaged_out ?? 0;
  const skippedText = skipped ? `${skipped} ${plural(skipped, "email", "emails")} skipped` : "";
  if (!saved)
    return {
      tone: "nothing",
      title: "Nothing new",
      sub: skippedText,
      saved: 0,
    };
  return {
    tone: "saved",
    title: `${saved} ${plural(saved, "thing", "things")} saved`,
    sub: [savedParts(r), skippedText].filter(Boolean).join(". "),
    saved,
  };
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** When a run happened: finished, else started, else queued. */
export const runAt = (r: CollectionRun): string => r.finished_at ?? r.started_at ?? r.created_at;

/** The diary's day heading: "Today", "Yesterday", "Wednesday", "3 Nov". */
export function runDay(r: CollectionRun, now = new Date()): string {
  const t = Date.parse(runAt(r));
  const today = startOfDay(now);
  const day = 86_400_000;
  if (t >= today) return "Today";
  if (t >= today - day) return "Yesterday";
  if (t >= today - 6 * day) return new Date(t).toLocaleDateString([], { weekday: "long" });
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}

/** "Missed 2 runs": failed runs in a row, newest first. */
export function missedInARow(runs: CollectionRun[]): number {
  let n = 0;
  for (const r of runs) {
    if (r.status === "queued" || r.status === "running") continue;
    if (r.status !== "failed") break;
    n++;
  }
  return n;
}

/** Days since a run last saved something, when every run in that span found nothing (Readwise's "gone quiet"). */
export function quietDays(runs: RunLike[], now = Date.now()): number {
  const done = runs.filter((r) => r.status === "succeeded");
  if (done.length < 3) return 0;
  const lastSaved = done.find((r) => savedCount(r) > 0);
  const since = lastSaved ? Date.parse(runAt(lastSaved)) : Date.parse(runAt(done[done.length - 1]));
  return Math.floor((now - since) / 86_400_000);
}
