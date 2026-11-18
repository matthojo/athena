/**
 * The words and arithmetic of Days, kept pure (no DOM) so they can be
 * tested: dates in words, mood names, the figures a card shows, health in
 * sentences compared with the owner's usual, how entries group, the
 * calendar's heat and month grids. Week and month reviews: lib/week-review.ts.
 */

import type { Day, DayArt, DayCounts, DayEntry, DayHealth, DaySummary, EntryKind, Mood } from "../db/days-app";
import { eveningLine, privatePlace, publicPlaces, type SeenToday } from "../../../lib/nudges";

// ---------- Dates ----------

const utc = (day: string) => new Date(`${day}T12:00:00Z`);
const fmt = (day: string, o: Intl.DateTimeFormatOptions) => utc(day).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });

export function addDays(date: string, n: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) => Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (date: string) => (utc(date).getUTCDay() + 6) % 7;

/** Monday of the date's week. */
export const weekStart = (date: string) => addDays(date, -weekdayIndex(date));

export const monthOf = (date: string) => date.slice(0, 7);

/** "Friday 6 November", with the year when it isn't this year's. */
export function longDate(date: string, today: string): string {
  const base = fmt(date, { weekday: "long", day: "numeric", month: "long" });
  return date.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${date.slice(0, 4)}`;
}

export const weekdayName = (date: string) => fmt(date, { weekday: "long" });
export const weekdayShort = (date: string) => fmt(date, { weekday: "short" });
export const dayNumber = (date: string) => String(Number(date.slice(8, 10)));
export const shortDate = (date: string) => fmt(date, { day: "numeric", month: "short" });
export const monthName = (month: string, withYear = true) =>
  utc(`${month}-15`).toLocaleDateString("en-GB", { month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });

/** "Today", "Yesterday", "Tuesday" this week, else null. */
export function relativeDay(date: string, today: string): string | null {
  const n = daysBetween(date, today);
  if (n === 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n > 1 && n < 7) return weekdayName(date);
  return null;
}

/** "A year ago", "3 years ago": for On this day. */
export function yearsAgo(date: string, today: string): string {
  const n = Number(today.slice(0, 4)) - Number(date.slice(0, 4));
  return n === 1 ? "A year ago" : `${n} years ago`;
}

/** "Week of 2 November" (and the year when it isn't this one). */
export function weekLabel(monday: string, today: string): string {
  const base = `Week of ${fmt(monday, { day: "numeric", month: "long" })}`;
  return monday.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${monday.slice(0, 4)}`;
}

// ---------- Numbers in words ----------

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Small counts as words ("two"), larger ones as figures ("14", "9,412"). */
export const count = (n: number) => (n <= 10 && n >= 0 && Number.isInteger(n) ? SMALL[n] : Math.round(n).toLocaleString("en-GB"));

export const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "a, b and c". */
export function list(parts: string[]): string {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] ?? "";
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

/** "one film", "three films". */
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** " (1h 25m deep)" after the hours slept, when the night has deep sleep (owner, 7 Nov): the same words as lib/health-line.ts, held together so a narrow row wraps before the bracket. */
export const deepNote = (s: { deep?: number } | undefined): string => (s?.deep ? ` (${hoursMinutes(s.deep)} deep)`.replace(/(?<=\S) (?=\S)/g, "\u00a0") : "");

export function hoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** 9412 → "9,400"; 812 → "812". */
export const roughSteps = (n: number) => (n >= 1000 ? (Math.round(n / 100) * 100).toLocaleString("en-GB") : String(Math.round(n)));

export const km = (m: number) => `${(Math.round(m / 100) / 10).toLocaleString("en-GB")} km`;

// ---------- Mood ----------

export const MOODS: { value: Mood; word: string }[] = [
  { value: 1, word: "Rough" },
  { value: 2, word: "Low" },
  { value: 3, word: "Okay" },
  { value: 4, word: "Good" },
  { value: 5, word: "Great" },
];

export const moodWord = (m: Mood | undefined | null) => (m ? MOODS[m - 1].word : null);

// ---------- Entries ----------

export const KIND_ORDER: EntryKind[] = ["watched", "listened", "read", "highlight", "played", "chess", "workout", "habit", "posted", "saved", "other"];

export const KIND_TITLE: Record<EntryKind, string> = {
  watched: "Watched",
  listened: "Listened",
  read: "Read",
  highlight: "Highlights",
  played: "Played",
  chess: "Chess",
  workout: "Moved",
  habit: "Habits",
  posted: "Posted",
  saved: "Saved",
  other: "Also",
};

/** Search's kind filter, in words. */
export const KIND_FILTER: Partial<Record<EntryKind, string>> = {
  watched: "Watched",
  listened: "Listened",
  read: "Read",
  highlight: "Highlights",
  played: "Played",
  chess: "Chess",
  posted: "Posted",
  saved: "Saved",
};

const SOURCE_NAMES: Record<string, string> = {
  home_connect: "Home Connect",
  netflix: "Netflix",
  trakt: "Trakt",
  letterboxd: "Letterboxd",
  plex: "Plex",
  jellyfin: "Jellyfin",
  youtube: "YouTube",
  spotify: "Spotify",
  lastfm: "Last.fm",
  listenbrainz: "ListenBrainz",
  goodreads: "Goodreads",
  readwise: "Readwise",
  kindle: "Kindle",
  steam: "Steam",
  lichess: "Lichess",
  chesscom: "Chess.com",
  "chess.com": "Chess.com",
  reddit: "Reddit",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  pocket: "Pocket",
  raindrop: "Raindrop.io",
  eventbrite: "Eventbrite",
  strava: "Strava",
  apple_health: "Apple Health",
  swarm: "Swarm",
  loop: "Loop",
  daylio: "Daylio",
  bearable: "Bearable",
  overcast: "Overcast",
  tfl: "TfL",
  uber: "Uber",
  bolt: "Bolt",
  ubereats: "Uber Eats",
  deliveroo: "Deliveroo",
  justeat: "Just Eat",
  manual: "Added by hand",
};

export const sourceName = (s: string) => SOURCE_NAMES[s.toLowerCase()] ?? capital(s.replace(/[-_]/g, " "));

/** What an "Also" entry is: a TfL journey, a ride (Uber, Bolt), a takeaway (Uber Eats, Deliveroo, Just Eat), or something else. */
export type AlsoSort = "journey" | "ride" | "takeaway" | "other";
const RIDES = new Set(["uber", "bolt"]);
const TAKEAWAYS = new Set(["ubereats", "deliveroo", "justeat"]);

export function alsoSort(e: Pick<DayEntry, "source" | "group">): AlsoSort {
  if (RIDES.has(e.source)) return "ride";
  if (TAKEAWAYS.has(e.source)) return "takeaway";
  if (e.source === "tfl" || e.group === "commute") return "journey";
  return "other";
}

/** "a ride", "two rides". */
const some = (n: number, one: string) => (n === 1 ? `a ${one}` : plural(n, one));

/** The Also entries in words: "Two journeys, a ride and a takeaway". */
export function alsoSummary(entries: Pick<DayEntry, "source" | "group" | "count">[]): string {
  const n: Record<AlsoSort, number> = { journey: 0, ride: 0, takeaway: 0, other: 0 };
  for (const e of entries) n[alsoSort(e)] += e.count ?? 1;
  return capital(list([n.journey ? some(n.journey, "journey") : "", n.ride ? some(n.ride, "ride") : "", n.takeaway ? some(n.takeaway, "takeaway") : "", n.other ? plural(n.other, n.journey || n.ride || n.takeaway ? "other thing" : "thing") : ""]));
}

/** An episode is a watched entry that belongs to a show (has a group). */
export const isEpisode = (e: DayEntry) => e.kind === "watched" && !!e.group;

export interface EntryGroup {
  key: string;
  /** The first entry, whose art and title stand for the group. */
  lead: DayEntry;
  entries: DayEntry[];
  /** Plays, episodes or highlights in the group. */
  total: number;
}

/** Entries of one kind, grouped (an album's tracks, a show's episodes), biggest first, then by time. */
export function groupEntries(entries: DayEntry[]): EntryGroup[] {
  const groups = new Map<string, EntryGroup>();
  for (const e of entries) {
    const key = e.group ? `g:${e.group}` : `e:${e.id}`;
    const g = groups.get(key);
    const n = e.count ?? 1;
    if (g) {
      g.entries.push(e);
      g.total += n;
    } else groups.set(key, { key, lead: e, entries: [e], total: n });
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || (a.lead.at ?? "").localeCompare(b.lead.at ?? ""));
}

export const byKind = (entries: DayEntry[]) => {
  const out = new Map<EntryKind, DayEntry[]>();
  for (const k of KIND_ORDER) {
    const of = entries.filter((e) => e.kind === k);
    if (of.length) out.set(k, of);
  }
  return out;
};

/** What a section's entries add up to, in words: "Two films and three episodes of Severance". */
export function kindSummary(kind: EntryKind, entries: DayEntry[]): string {
  const n = entries.reduce((a, e) => a + (e.count ?? 1), 0);
  switch (kind) {
    case "watched": {
      const eps = entries.filter(isEpisode);
      const films = entries.filter((e) => !isEpisode(e));
      const shows = [...new Set(eps.map((e) => e.group!))];
      const epCount = eps.reduce((a, e) => a + (e.count ?? 1), 0);
      const epPart = eps.length ? (shows.length === 1 ? `${plural(epCount, "episode")} of ${shows[0]}` : `${plural(epCount, "episode")} across ${count(shows.length)} shows`) : "";
      const filmPart = films.length ? plural(films.length, films.every((f) => f.source === "youtube") ? "video" : "film") : "";
      return capital(list([filmPart, epPart]));
    }
    case "listened": {
      const artists = new Set(entries.map((e) => e.subtitle).filter(Boolean));
      return capital(`${plural(n, "play")}${artists.size > 1 ? ` across ${count(artists.size)} artists` : artists.size === 1 ? `, all ${[...artists][0]}` : ""}`);
    }
    case "read": {
      return capital(plural(entries.length, "book"));
    }
    case "highlight":
      return capital(plural(n, "highlight"));
    case "played": {
      return capital(plural(entries.length, "game"));
    }
    case "chess": {
      return capital(plural(n, "game"));
    }
    case "posted":
      return capital(plural(n, "post"));
    case "saved":
      return capital(plural(n, "link") + " saved");
    case "workout":
      return capital(plural(n, "workout"));
    case "other":
      return alsoSummary(entries);
    default:
      return capital(plural(n, "thing"));
  }
}

// ---------- Figures in words ----------

/** The short figures a feed card shows, most telling first: "Slept 7h 40m", "9,400 steps", "two films". */
export function dayFigures(day: Day, max = 4): string[] {
  const out: string[] = [];
  const h = day.health;
  if (h?.sleep_minutes) out.push(`Slept ${hoursMinutes(h.sleep_minutes)}`);
  if (h?.workouts?.length) out.push(workoutPhrase(h.workouts[0]));
  else if (h?.steps) out.push(`${roughSteps(h.steps)} steps`);
  const kinds = byKind(day.entries);
  for (const [kind, entries] of kinds) {
    if (kind === "highlight" || kind === "other") continue;
    out.push(kindSummary(kind, entries).replace(/^./, (c) => c.toLowerCase()));
  }
  const takeaway = day.entries.find((e) => e.kind === "other" && alsoSort(e) === "takeaway");
  if (takeaway) out.push("a takeaway");
  if (day.photos.length) out.push(plural(day.photos.length, "photo"));
  return out.slice(0, max).map((s, i) => (i === 0 ? capital(s) : s.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())));
}

const WORKOUT_VERB: Array<[RegExp, string]> = [
  [/run|jog/i, "Ran"],
  [/walk|hik/i, "Walked"],
  [/swim/i, "Swam"],
  [/ride|cycl|bik/i, "Rode"],
  [/row/i, "Rowed"],
];

/** "Ran 8.2 km", "Yoga for 40 min". */
export function workoutPhrase(w: { type: string; minutes: number; distance_m?: number }): string {
  const verb = WORKOUT_VERB.find(([re]) => re.test(w.type))?.[1];
  if (verb && w.distance_m) return `${verb} ${km(w.distance_m)}`;
  if (verb) return `${verb} for ${hoursMinutes(w.minutes)}`;
  return `${capital(w.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase())} for ${hoursMinutes(w.minutes)}`;
}

// ---------- Totals from counts (summaries, weeks) ----------

/** "40 min", "2h 10m", or "9 hours" once it's long and rough. */
export const duration = (minutes: number, rough = false) => (rough && minutes >= 180 ? `${Math.round(minutes / 60)} hours` : hoursMinutes(minutes));

const TOTAL_ORDER: EntryKind[] = ["workout", "watched", "listened", "read", "highlight", "played", "chess", "posted", "saved"];

/** One kind's total in words: "2h 10m of watching", "41 plays", "one book". */
export function kindTotal(kind: EntryKind, n: number, minutes: number | undefined, rough = false): string | null {
  if (!n && !minutes) return null;
  switch (kind) {
    case "watched":
      return minutes ? `${duration(minutes, rough)} of watching` : `${count(n)} watched`;
    case "listened":
      return minutes && minutes >= 60 ? `${duration(minutes, rough)} of music` : plural(n, "play");
    case "read":
      return plural(n, "book");
    case "highlight":
      return plural(n, "highlight");
    case "played":
      return minutes ? `${duration(minutes, rough)} of games` : plural(n, "game");
    case "chess":
      return plural(n, "chess game");
    case "posted":
      return plural(n, "post");
    case "saved":
      return `${plural(n, "link")} saved`;
    case "workout":
      return plural(n, "workout");
    default:
      return null;
  }
}

/** A summary's key figures in words, most telling first: "9,400 steps", "2h of watching", "41 plays". */
export function summaryFigures(c: DayCounts, max = 4, rough = false): string[] {
  const out: string[] = [];
  if (c.steps) out.push(`${roughSteps(c.steps)} steps`);
  for (const k of TOTAL_ORDER) {
    const t = kindTotal(k, c.by_kind[k] ?? 0, c.minutes[k], rough);
    if (t) out.push(t);
  }
  if (c.photos) out.push(plural(c.photos, "photo"));
  return out.slice(0, max).map((s, i) => (i === 0 ? capital(s) : s));
}

/** Counts added up across days. */
export function addCounts(cs: DayCounts[]): DayCounts {
  const out: DayCounts = { entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0 };
  let steps = 0;
  for (const c of cs) {
    out.entries += c.entries;
    out.photos += c.photos;
    out.notes += c.notes;
    out.events += c.events;
    steps += c.steps ?? 0;
    for (const [k, n] of Object.entries(c.by_kind)) out.by_kind[k as EntryKind] = (out.by_kind[k as EntryKind] ?? 0) + (n ?? 0);
    for (const [k, n] of Object.entries(c.minutes)) out.minutes[k as EntryKind] = (out.minutes[k as EntryKind] ?? 0) + (n ?? 0);
  }
  if (steps) out.steps = steps;
  return out;
}

export interface WeekGlance {
  moods: (Mood | null)[];
  art: DayArt[];
  headline: string;
  days: number;
}

/** A week (or any stretch) from its summaries: moods, artwork and one line. For the feed's week cards. */
export function glance(summaries: DaySummary[], from: string, to: string): WeekGlance {
  const inRange = summaries.filter((d) => d.date >= from && d.date <= to);
  const byDate = new Map(inRange.map((d) => [d.date, d]));
  const moods = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => byDate.get(addDays(from, i))?.mood ?? null);
  const seen = new Set<string>();
  const art = inRange.flatMap((d) => d.art).filter((a) => !seen.has(a.id) && !!seen.add(a.id));
  const totals = addCounts(inRange.map((d) => d.counts));
  // A book read on four days is one book, not four: say the days instead.
  const readDays = inRange.filter((d) => d.counts.by_kind.read).length;
  const parts = TOTAL_ORDER.filter((k) => k !== "workout" && k !== "highlight")
    .map((k) => (k === "read" ? (readDays > 1 ? `reading on ${count(readDays)} days` : readDays ? "some reading" : null) : kindTotal(k, totals.by_kind[k] ?? 0, totals.minutes[k], true)))
    .filter((x): x is string => !!x)
    .slice(0, 3);
  const set = moods.filter((m): m is Mood => m !== null);
  const avg = set.length ? (Math.round(set.reduce((a, b) => a + b, 0) / set.length) as Mood) : null;
  const moodPart = avg ? MOOD_STRETCH[avg] : null;
  const body = list(parts);
  const headline = moodPart && body ? `${moodPart}: ${body}` : moodPart ?? (body ? capital(body) : "A quiet stretch");
  return { moods, art, headline, days: inRange.length };
}

const MOOD_STRETCH: Record<Mood, string> = { 1: "A hard stretch", 2: "A low stretch", 3: "An even stretch", 4: "Mostly good days", 5: "Great days" };

const SMALL_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const an = (n: number) => (/^(8|11|18|80|8\d)$/.test(String(n)) || /^8/.test(String(n)) ? "an" : "a");

/** "two hours of", "an hour of", "40 minutes of". */
function timeOf(minutes: number): string {
  if (minutes < 55) return `${Math.round(minutes / 5) * 5 || minutes} minutes of`;
  const h = Math.round(minutes / 60);
  return h === 1 ? "an hour of" : `${SMALL_WORDS[h] ?? h} hours of`;
}

/** What kind of day it was, for the opening: "A full Friday", "A slow Sunday". */
function opener(day: Day): string {
  const weekday = weekdayName(day.date);
  const weekend = weekdayIndex(day.date) >= 5;
  const n = day.entries.reduce((a, e) => a + (e.count ?? 1), 0) + day.events.length + day.photos.length;
  if (n >= 18) return `A full ${weekday}`;
  if (n <= 4) return weekend ? `A slow ${weekday}` : `A quiet ${weekday}`;
  return weekend ? `An easy ${weekday}` : weekday;
}

const WEEKDAY_LEAD = /^(?:(?:A|An) [a-z]+ )?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday): (.+)$/;

/**
 * A day's line where the date is already beside it (the feed, search, On
 * this day): "A steady Tuesday: yoga and …" reads "Yoga and …".
 */
export function listLine(line: string): string {
  const m = WEEKDAY_LEAD.exec(line);
  return m ? capital(m[1]) : line;
}

/**
 * A line for a day that has none of its own, as a sentence, people and
 * places first: "Lunch with Priya at Dishoom, then Hampstead Heath" when the
 * day has a person seen or a places line (lib/nudges.ts eveningLine), else
 * "A slow Saturday: an episode of The Glasshouse, reading Small Hours and two
 * hours of Hollow Peaks". `seen` is who the owner saw that day (Week in
 * review's rule). Null when the day has nothing to say.
 */
export function fallbackLine(day: Day, seen: SeenToday[] = []): string | null {
  const media = mediaParts(day);
  const lead = seen.length || publicPlaces(day.places_line).length ? eveningLine({ places_line: day.places_line }, seen) : null;
  if (lead) {
    // One thing from the day's media, only when the lead is a single phrase.
    const more = !/, then |, /.test(lead) ? media[0] : undefined;
    return more ? `${lead}, and ${more}` : lead;
  }
  const parts: string[] = [];
  // A named stop leads the media, never home or work.
  const place = day.places.find((p) => !/^(home|work)$/i.test(p.name) && !privatePlace(p.name));
  if (place) parts.push(place.name);
  parts.push(...media);
  if (!parts.length) {
    const h = day.health;
    const bits = [h?.sleep_minutes ? `${hoursMinutes(h.sleep_minutes)} of sleep` : null, h?.steps ? `${roughSteps(h.steps)} steps` : null].filter((x): x is string => !!x);
    return bits.length ? `${opener(day)}: ${list(bits)}` : null;
  }
  return `${opener(day)}: ${list(parts.slice(0, 3))}`;
}

/** The day's workout, then what was watched, read, played and played most: up to three, in that order. */
function mediaParts(day: Day): string[] {
  const parts: string[] = [];
  const w = day.health?.workouts?.[0];
  if (w) {
    const km = w.distance_m ? Math.round(w.distance_m / 1000) : 0;
    const what = workoutPhrase(w).split(" ")[0].toLowerCase();
    const noun = { ran: "run", walked: "walk", swam: "swim", rode: "ride", rowed: "row" }[what];
    parts.push(noun && km ? `${an(km)} ${km} km ${noun}` : w.type.toLowerCase());
  }
  const eps = day.entries.filter(isEpisode);
  if (eps.length) {
    const show = eps[0].group!;
    const n = eps.filter((e) => e.group === show).reduce((a, e) => a + (e.count ?? 1), 0);
    parts.push(n === 1 ? `an episode of ${show}` : `${SMALL_WORDS[n] ?? n} episodes of ${show}`);
  }
  const film = day.entries.find((e) => e.kind === "watched" && !isEpisode(e));
  if (film) parts.push(film.title);
  const book = day.entries.find((e) => e.kind === "read");
  if (book) parts.push(`reading ${book.title}`);
  const game = day.entries.find((e) => e.kind === "played");
  if (game) parts.push(game.minutes ? `${timeOf(game.minutes)} ${game.title}` : game.title);
  const plays = new Map<string, number>();
  for (const e of day.entries) if (e.kind === "listened") plays.set(e.subtitle ?? e.group ?? e.title, (plays.get(e.subtitle ?? e.group ?? e.title) ?? 0) + (e.count ?? 1));
  const top = [...plays].sort((a, b) => b[1] - a[1])[0];
  if (top) parts.push(top[1] >= 8 ? `a lot of ${top[0]}` : `music by ${top[0]}`);
  return parts.slice(0, 3);
}

/** Is there anything on this day besides health? */
export const hasStory = (day: Day) => day.entries.length > 0 || day.photos.length > 0 || day.places.length > 0 || day.events.length > 0 || day.notes.length > 0 || !!day.journal;

export const hasHealth = (h: DayHealth | undefined): h is DayHealth =>
  !!h && (h.sleep_minutes !== undefined || h.steps !== undefined || !!h.workouts?.length || h.resting_hr !== undefined || h.weight_kg !== undefined);

/** How much the day holds (for picking the fullest day). */
export function dayWeight(day: Pick<Day, "counts">): number {
  const c = day.counts;
  return c.entries + c.photos * 2 + c.notes + c.events;
}

/** 0 (nothing) to 4 (a full day), on fixed steps so a month reads the same each time. */
export function heatLevel(weight: number): 0 | 1 | 2 | 3 | 4 {
  if (weight <= 0) return 0;
  if (weight < 4) return 1;
  if (weight < 10) return 2;
  if (weight < 20) return 3;
  return 4;
}

// ---------- Health in sentences ----------

/** The figures a sentence compares: from a Day, or from the Health page's days. */
export type HealthFigures = Partial<Pick<DayHealth, "sleep_minutes" | "sleep_stages" | "steps" | "resting_hr" | "weight_kg">>;

export interface HealthSentence {
  id: "sleep" | "steps" | "heart" | "weight";
  text: string;
  /** Comparison with the owner's usual, when there's enough to say. */
  aside?: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Health as sentences, each compared with the two weeks before the day:
 * "Slept 7h 40m" / "40 min more than usual".
 */
export function healthSentences(h: HealthFigures, before: HealthFigures[]): HealthSentence[] {
  const out: HealthSentence[] = [];
  const usual = (f: (d: HealthFigures) => number | undefined) => {
    const xs = before.map(f).filter((v): v is number => typeof v === "number");
    return xs.length >= 4 ? mean(xs) : null;
  };
  if (h.sleep_minutes !== undefined) {
    const u = usual((d) => d.sleep_minutes);
    const diff = u === null ? null : h.sleep_minutes - u;
    out.push({
      id: "sleep",
      text: `Slept ${hoursMinutes(h.sleep_minutes)}${deepNote(h.sleep_stages)}`,
      aside: diff === null ? undefined : Math.abs(diff) < 15 ? "About your usual" : `${hoursMinutes(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than usual`,
    });
  }
  if (h.steps !== undefined) {
    const u = usual((d) => d.steps);
    const ratio = u ? h.steps / u : null;
    out.push({
      id: "steps",
      text: `Walked ${roughSteps(h.steps)} steps`,
      aside: ratio === null ? undefined : ratio > 1.6 ? "One of your busier days" : ratio > 1.15 ? "More than usual" : ratio < 0.5 ? "A still day" : ratio < 0.85 ? "Fewer than usual" : "About your usual",
    });
  }
  if (h.resting_hr !== undefined) {
    const u = usual((d) => d.resting_hr);
    const diff = u === null ? null : h.resting_hr - u;
    out.push({
      id: "heart",
      text: `Resting heart rate ${Math.round(h.resting_hr)}`,
      aside: diff === null ? undefined : Math.abs(diff) < 2 ? "Steady" : `${Math.round(Math.abs(diff))} ${diff > 0 ? "higher" : "lower"} than usual`,
    });
  }
  if (h.weight_kg !== undefined) out.push({ id: "weight", text: `Weighed ${(Math.round(h.weight_kg * 10) / 10).toLocaleString("en-GB")} kg` });
  return out;
}

// ---------- Calendar ----------

/** The weeks of a month, Monday first; days outside the month are null. */
export function monthGrid(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const lead = weekdayIndex(first);
  const length = daysBetween(first, nextMonth(first + "").slice(0, 7) + "-01");
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length }, (_, i) => addDays(first, i))];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "2026-11" → "2026-12" (accepts a date too). */
export function nextMonth(monthOrDate: string, n = 1): string {
  const [y, m] = monthOrDate.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  return d.toISOString().slice(0, 7);
}

// ---------- On this day ----------

/** The same date in earlier years (29 Feb falls back to 28 Feb). */
export function sameDayEarlier(today: string, years = 10): string[] {
  const out: string[] = [];
  const [y, m, d] = today.split("-");
  for (let i = 1; i <= years; i++) {
    const yy = String(Number(y) - i);
    let date = `${yy}-${m}-${d}`;
    if (m === "02" && d === "29" && !isLeap(Number(yy))) date = `${yy}-02-28`;
    out.push(date);
  }
  return out;
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// ---------- Recaps ----------
// The week and month in review moved to lib/week-review.ts (the model) and
// lib/week-headline.ts (the headline's rules), 2026-11-08.

// ---------- The old Life log notes ----------

/** A Life log day note ("life-log" source or tag): which day it was. Null for anything else. */
export function lifeLogDate(note: { source: string | null; tags: string[]; created_at: string; title: string }, zoneDate: (iso: string) => string): string | null {
  if (note.source !== "life-log" && !note.tags.includes("life-log")) return null;
  return zoneDate(note.created_at);
}

// ---------- Today's phase ----------

export type Phase = "morning" | "day" | "evening";

/** Before 11:00 is morning; from 18:00 it's evening (in this device's zone). */
export const phaseAt = (d: Date): Phase => (d.getHours() < 11 ? "morning" : d.getHours() >= 18 ? "evening" : "day");

// ---------- The day's highlight ----------

export interface Highlight {
  entry: DayEntry;
  /** "The day's film", "Three episodes", "Played 14 times". */
  why: string;
  title: string;
}

const stars = (r: number) => `${Math.floor(r)}${r % 1 ? "½" : ""}`;

/**
 * The one thing that earns large art on a day page: a film you rated well,
 * a show you binged, a long game, an album on repeat, or the book you were
 * reading. Null when nothing stands out.
 */
export function dayHighlight(day: Pick<Day, "entries">): Highlight | null {
  const es = day.entries.filter((e) => e.art && e.source !== "places");
  const films = es.filter((e) => e.kind === "watched" && !isEpisode(e)).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const rated = films.find((f) => (f.rating ?? 0) >= 4);
  if (rated) return { entry: rated, title: rated.title, why: `The day's film, rated ${stars(rated.rating!)}` };
  const shows = groupEntries(es.filter(isEpisode));
  if (shows[0] && shows[0].total >= 3) return { entry: shows[0].lead, title: shows[0].lead.group!, why: `${capital(count(shows[0].total))} episodes` };
  if (films[0]) return { entry: films[0], title: films[0].title, why: "The day's film" };
  const game = es.filter((e) => e.kind === "played").sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0];
  if (game && (game.minutes ?? 0) >= 90) return { entry: game, title: game.title, why: `${capital(duration(game.minutes!, true))} of play` };
  const album = groupEntries(es.filter((e) => e.kind === "listened"))[0];
  if (album && album.total >= 8) return { entry: album.lead, title: album.lead.group ?? album.lead.title, why: `On repeat: ${count(album.total)} plays` };
  return null;
}

/** A smooth line through the points (monotone, so it never overshoots a day's figure). */
export function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const n = pts.length;
  const dx = (i: number) => pts[i + 1][0] - pts[i][0];
  const slope = (i: number) => (pts[i + 1][1] - pts[i][1]) / (dx(i) || 1);
  const m: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) m.push(slope(0));
    else if (i === n - 1) m.push(slope(n - 2));
    else {
      const a = slope(i - 1);
      const b = slope(i);
      m.push(a * b <= 0 ? 0 : (2 * a * b) / (a + b));
    }
  }
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx(i) / 3;
    d += ` C${f(pts[i][0] + h3)},${f(pts[i][1] + m[i] * h3)} ${f(pts[i + 1][0] - h3)},${f(pts[i + 1][1] - m[i + 1] * h3)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}
