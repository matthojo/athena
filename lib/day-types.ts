/**
 * Days: the contract between the data layer (lib/days.ts, the /api/days
 * routes, the runner's athena_day_entry and athena_day_line) and the app.
 *
 * A Day is everything Athena knows about one calendar date in the owner's
 * time zone: the one line written about it, the owner's mood, journal and
 * photos, the weather, health and places (opened from their sealed tables
 * when asked), the structured entries every source writes (what was
 * watched, listened to, read, played, posted, saved), and the notes and
 * events from that day, linked by date.
 *
 * Shared by the server and the PWA, so it imports nothing.
 *
 * API (all behind the bearer token):
 *   GET   /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD   → DaysRange (at most 400 days)
 *   GET   /api/days/:date                          → Day
 *   PATCH /api/days/:date   DayPatch               → Day
 *   GET   /api/days/search?q=&kind=&from=&to=      → DaySearch
 *   GET   /api/art/:id                             → the cover image (days-art's lib/art.ts)
 */

export const DAY_ENTRY_KINDS = ["watched", "listened", "read", "highlight", "played", "posted", "saved", "chess", "workout", "habit", "other"] as const;
export type DayEntryKind = (typeof DAY_ENTRY_KINDS)[number];
export const isDayEntryKind = (k: unknown): k is DayEntryKind => typeof k === "string" && (DAY_ENTRY_KINDS as readonly string[]).includes(k);

/** Cover art for an entry (a poster, album cover, book jacket, thumbnail), served by GET /api/art/:id. */
export interface DayArt {
  id: string;
  /** Pixel size, so the app can reserve the space before it loads. */
  w: number;
  h: number;
  /** The image's main colour as a CSS colour ("oklch(0.62 0.09 40)"), for a placeholder and a tint. */
  tone?: string;
}

/** One thing that happened on the day, from one source. */
export interface DayEntry {
  id: string;
  kind: DayEntryKind;
  /** The service it came from: "trakt", "letterboxd", "netflix", "youtube", "youtube_music", "goodreads", "readwise", "spotify", "lastfm", "listenbrainz", "steam", "lichess", "chesscom", "reddit", "bluesky", "mastodon", "raindrop", "eventbrite", "plex", "jellyfin", "health" (workouts), "places" (the day's stops, as "other"), "life_log" (converted from an old note). */
  source: string;
  /** "Severance", "Blackstar", "The Wager". */
  title: string;
  /** Who made it, or which part: "S2E3 · Who Is Alive?", "David Bowie", "David Grann", a channel. */
  subtitle?: string;
  /** When it happened, ISO 8601 with offset, when the source says. */
  at?: string;
  url?: string;
  art?: DayArt;
  /** The owner's rating in stars, 0.5–5 in halves. */
  rating?: number;
  /** Plays, episodes, highlights, games: 1 when absent. A habit: 1 done, 0 not done (skipped or missed). */
  count?: number;
  /** Time spent, when the source gives it (listening, playing, a workout). */
  minutes?: number;
  /** Entries that belong together on the day: a show's episodes, an album's tracks, a book's highlights. Same group, same card. */
  group?: string;
  /** A short extra the source gives: a review quote, "rewatch", "paused at 40%", "3 wins"; a habit's "skipped" or "3 of 5 glasses". */
  note?: string;
}

/** A photo the owner added to the day (a file in Athena's files; bytes at GET /api/files/:id). */
export interface DayPhoto {
  id: string;
  w?: number;
  h?: number;
  /** GET /api/files/:id?thumb=1 exists. */
  thumb: boolean;
  added_at: string;
}

/** A note written or collected that day (meetings, captures, email notes), linked by date. Life log notes aren't here: they became entries. */
export interface DayNote {
  id: string;
  title: string;
  type: string;
  source: string;
  created_at: string;
}

/** An event on that day (a meeting, an appointment, a birthday). */
export interface DayEvent {
  id: string;
  title: string;
  kind: string;
  /** A timed event's instant (UTC). */
  starts_at?: string;
  /** When a timed event ends (UTC), where Athena knows it. */
  ends_at?: string;
  /** Its calendar's label ("work", "personal", "family"): the collection's label, else the calendar account's. */
  label?: string;
  /** An all-day event, birthday or deadline. */
  date?: string;
}

/** Health for the day, merged across sources by the owner's choices (lib/health.ts). Never stored outside its sealed rows. */
export interface DayHealth {
  /** "7h 40m sleep · 9,200 steps · 5k run · 52 bpm resting". */
  line: string | null;
  sleep_minutes?: number;
  /** The night by stage, in minutes (lib/health-line.ts SleepStages). */
  sleep_stages?: { deep?: number; core?: number; rem?: number; awake?: number; in_bed?: number; asleep_unspecified?: number };
  steps?: number;
  active_minutes?: number;
  resting_hr?: number;
  recovery?: number;
  recharge?: number;
  weight_kg?: number;
  workouts?: Array<{ type: string; minutes: number; distance_m?: number; kcal?: number; start?: string; name?: string }>;
}

/**
 * The day's spending (lib/money.ts), merged across bank accounts. Sealed, and
 * only in a Day when the owner turned Money on (Settings → Days) or Ask has a
 * money question. Amounts are in minor units (pence) of `currency`.
 */
export interface DayMoney {
  /** "£42 spent · eating out £18 · groceries £24". */
  line: string;
  currency: string;
  spent: number;
  count: number;
  /** Spend per category, largest first. */
  categories: Array<{ category: MoneyCategory; amount: number }>;
}

export const MONEY_CATEGORIES = ["eating_out", "takeaway", "groceries", "transport", "shopping", "bills", "entertainment", "holidays", "personal_care", "general"] as const;
export type MoneyCategory = (typeof MONEY_CATEGORIES)[number];

/** The day's electricity (lib/money.ts, Octopus). Sealed: half-hourly use shows when someone's home. Only when Home is on. */
/** A day at home: electricity and gas, each only when the account has that meter. */
export interface DayHome {
  /** "8.4 kWh, mostly 18:00–22:00 · gas 21.3 kWh", or "Gas 21.3 kWh". */
  line: string;
  /** Electricity. */
  kwh?: number;
  gas_kwh?: number;
  /** Electricity kWh per local hour, 0–23. */
  by_hour?: number[];
  /** Share of the day's electricity used 18:00–23:00, 0–1: the "home evening" figure. */
  evening_share?: number;
}

/** A place the owner went that day (lib/places-visits.ts), in the order of the day. */
export interface DayPlace {
  /** The Place in the Library, when it is one. */
  id?: string;
  name: string;
  /** Minutes spent there that day. */
  minutes?: number;
}

/** What the calendar's heat and a day's header read. */
export interface DayCounts {
  /** Every entry, with counts folded in (6 episodes count 6). */
  entries: number;
  by_kind: Partial<Record<DayEntryKind, number>>;
  /** Minutes by kind, where sources gave durations. */
  minutes: Partial<Record<DayEntryKind, number>>;
  steps?: number;
  photos: number;
  notes: number;
  events: number;
  /** 0 (nothing) to 4 (a very full day): one scale for the whole calendar. */
  heat: 0 | 1 | 2 | 3 | 4;
}

export type Mood = 1 | 2 | 3 | 4 | 5;

export interface Day {
  date: string;
  /** The one written line about the day. */
  line?: string;
  /** Who wrote the line: a run writes it until the owner edits it, then it's theirs. */
  line_by?: "run" | "owner";
  mood?: Mood;
  journal?: string;
  photos: DayPhoto[];
  /** "14° and rain in London". */
  weather?: string;
  /** Where the day went, as one sentence: "Work, lunch at Dishoom, then Hampstead Heath". */
  places_line?: string;
  health?: DayHealth;
  /** Only when Money is on (Settings → Days). */
  money?: DayMoney;
  /** Only when Home is on (Settings → Days). */
  home?: DayHome;
  places: DayPlace[];
  entries: DayEntry[];
  notes: DayNote[];
  events: DayEvent[];
  /** Every calendar label the owner uses, in colour order (calendarLabelOrder), so a label keeps its colour whatever else is on the day. */
  calendar_labels?: string[];
  counts: DayCounts;
  /** Newest change to anything stored for the day (line, mood, journal, photos, entries). */
  updated_at?: string;
}

/** One day in a range: enough for a calendar cell or a list row. */
export interface DaySummary {
  date: string;
  line?: string;
  mood?: Mood;
  counts: DayCounts;
  /** Art for the cell: the day's most prominent entries with art, at most 4. */
  art: DayArt[];
  /** The first photo's id, if any. */
  photo?: string;
  /** Has a journal entry (the text itself is only in GET /api/days/:date). */
  journal: boolean;
  /** Habits logged that day and how many were done, when any were. */
  habits?: { done: number; of: number };
}

export interface DaysRange {
  from: string;
  to: string;
  /** Only days with something on them, oldest first. */
  days: DaySummary[];
}

/** PATCH /api/days/:date. Leave a field out to keep it; null clears it. */
export interface DayPatch {
  line?: string | null;
  mood?: Mood | null;
  journal?: string | null;
  /** File ids from POST /api/files: added to the day, or taken off (and deleted once nothing else uses them). */
  photos?: { add?: string[]; remove?: string[] };
}

export const MAX_LINE_CHARS = 280;
export const MAX_JOURNAL_CHARS = 4000;
export const MAX_DAY_PHOTOS = 12;
export const MAX_RANGE_DAYS = 400;

/** One search hit: an entry, or a day's line or journal. */
export interface DaySearchHit {
  date: string;
  /** What matched. */
  match: "entry" | "line" | "journal";
  entry?: DayEntry;
  /** The day's line, for context. */
  line?: string;
  /** Plain text around the match, with the matching words in « ». */
  snippet: string;
  rank: number;
}

export interface DaySearch {
  q: string;
  results: DaySearchHit[];
  /** What the results span, for filter chips: services, places and people, most frequent first. */
  facets: { sources: string[]; places: string[]; people: string[] };
}

/** GET /api/days/search filters beside q: kind, from, to, source ("trakt"), place (a place's name), person (a name or id). */
export interface DaySearchFilters {
  kind?: DayEntryKind;
  from?: string;
  to?: string;
  source?: string;
  place?: string;
  person?: string;
}

/** Calendar labels in their fixed colour order: work, personal, then the rest alphabetically. Lowercased, each once. */
export function calendarLabelOrder(labels: Iterable<string | null | undefined>): string[] {
  const set = new Set([...labels].map((l) => (l ?? "").trim().toLowerCase()).filter(Boolean));
  const rest = [...set].filter((l) => l !== "work" && l !== "personal").sort((a, b) => a.localeCompare(b));
  return [...(set.has("work") ? ["work"] : []), ...(set.has("personal") ? ["personal"] : []), ...rest];
}
