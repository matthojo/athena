/**
 * What Watch & read knows about a title beyond its name: the year, how long
 * it runs, its genres, the playlists it's in, the owner's own tags, and the
 * seasons it suits (Christmas, Halloween). Kept as one sealed JSON value in
 * `reading_items.meta` (0063).
 *
 * Where it comes from (netlify/lib/watch-enrich.ts asks, once per item):
 *  - a YouTube video: the Data API's `videos` (length, topics, category),
 *    and the playlists it was saved to;
 *  - a film or a show: TMDB's details (genres, running time, year, keywords),
 *    when the owner added a TMDB key;
 *  - a book: Open Library's search (first published, pages, subjects).
 * Tags are the owner's alone: no source writes them.
 *
 * Pure: the app and the server both use it.
 */

export interface WatchMeta {
  /** First released, published or aired. */
  year?: number;
  /** Running time in minutes: a film, a video, one episode of a show. */
  minutes?: number;
  /** A book's pages. */
  pages?: number;
  /** From the source, most telling first: "Science Fiction", "Electronic". */
  genres?: string[];
  /** The playlists it's in, by name. */
  lists?: string[];
  /** Seasons a source says it suits (SEASONS ids), from its keywords. */
  themes?: string[];
  /** The owner's own tags. */
  tags?: string[];
  /** A video that is a song or a set: YouTube's Music category. */
  music?: boolean;
  /** When the sources were last asked (ISO). Absent: not yet. */
  checked?: string;
}

export const MAX_GENRES = 6;
export const MAX_LISTS = 12;
export const MAX_TAGS = 12;
export const TAG_LENGTH = 40;

const tidy = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Names tidied, empty ones dropped, the same name in another case kept once. */
export function nameList(raw: unknown, max: number, length: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const name = tidy(v, length);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

const whole = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/** Stored meta, read back: a sealed value arrives as JSON text. Anything unreadable is no meta. */
export function readMeta(raw: unknown): WatchMeta {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const m = v as Record<string, unknown>;
  const out: WatchMeta = {};
  const year = whole(m.year, 1800, 2200);
  const minutes = whole(m.minutes, 1, 100_000);
  const pages = whole(m.pages, 1, 100_000);
  const genres = nameList(m.genres, MAX_GENRES, 40);
  const lists = nameList(m.lists, MAX_LISTS, 120);
  const tags = nameList(m.tags, MAX_TAGS, TAG_LENGTH);
  const themes = nameList(m.themes, 6, 20).filter((t) => SEASONS.some((s) => s.id === t));
  if (year) out.year = year;
  if (minutes) out.minutes = minutes;
  if (pages) out.pages = pages;
  if (genres.length) out.genres = genres;
  if (lists.length) out.lists = lists;
  if (themes.length) out.themes = themes;
  if (tags.length) out.tags = tags;
  if (m.music === true) out.music = true;
  if (typeof m.checked === "string" && !Number.isNaN(Date.parse(m.checked))) out.checked = m.checked;
  return out;
}

/**
 * What a source learned, laid over what's kept. A source fills gaps and adds
 * playlists; it never touches tags, and never empties a value that's there.
 */
export function mergeMeta(kept: WatchMeta, learned: WatchMeta): WatchMeta {
  const next: WatchMeta = { ...kept };
  if (learned.year && !kept.year) next.year = learned.year;
  if (learned.minutes && !kept.minutes) next.minutes = learned.minutes;
  if (learned.pages && !kept.pages) next.pages = learned.pages;
  if (learned.genres?.length && !kept.genres?.length) next.genres = learned.genres;
  if (learned.lists?.length) next.lists = nameList([...(kept.lists ?? []), ...learned.lists], MAX_LISTS, 120);
  if (learned.themes?.length) next.themes = nameList([...(kept.themes ?? []), ...learned.themes], 6, 20);
  if (learned.music) next.music = true;
  if (learned.checked) next.checked = learned.checked;
  return readMeta(next);
}

export const sameMeta = (a: WatchMeta, b: WatchMeta): boolean => JSON.stringify(readMeta(a)) === JSON.stringify(readMeta(b));

// ---------- YouTube ----------

/** The video id in a YouTube link (watch, youtu.be, shorts, embed, music.youtube.com), or null. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") id = parts[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Minutes in an ISO 8601 duration ("PT1H2M30S" → 63), rounded, at least 1; undefined when it isn't one or is nothing. */
export function isoMinutes(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(raw.trim());
  if (!m) return undefined;
  const seconds = Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : undefined;
}

/** YouTube's video categories worth showing as a genre. "People & Blogs" and the like say nothing. */
const YT_CATEGORIES: Record<string, string> = {
  "1": "Film & animation",
  "2": "Cars",
  "10": "Music",
  "15": "Animals",
  "17": "Sport",
  "19": "Travel",
  "20": "Gaming",
  "23": "Comedy",
  "25": "News",
  "26": "How-to",
  "27": "Education",
  "28": "Science & tech",
};

/** A topic's own words read better as these. */
const YT_TOPIC_NAMES: Record<string, string> = {
  "television program": "TV",
  "video game culture": "Gaming",
  "physical fitness": "Fitness",
  "association football": "Football",
  "rhythm and blues": "R&B",
  "hip hop": "Hip-hop",
  humour: "Comedy",
  vehicle: "Cars",
  pet: "Animals",
  tourism: "Travel",
  independent: "Indie",
};
/** Topics that say too little to be a genre. */
const YT_VAGUE = new Set(["music", "entertainment", "knowledge", "society", "lifestyle", "hobby", "film"]);

/**
 * Genres from a video's topics (Wikipedia addresses: ".../wiki/Electronic_music")
 * and its category. Music genres lose their "music"; a vague topic is used
 * only when there's nothing better.
 */
export function youtubeGenres(topics: unknown, categoryId: unknown): { genres: string[]; music: boolean } {
  const names: string[] = [];
  const vague: string[] = [];
  let music = categoryId === "10";
  for (const t of Array.isArray(topics) ? topics : []) {
    if (typeof t !== "string") continue;
    let last = t.split("/").pop() ?? "";
    try {
      last = decodeURIComponent(last);
    } catch {
      // keep it as it came
    }
    // Wikipedia's own capitals are kept ("Latin America"); matching is on the lower-case words.
    let words = last.replace(/_/g, " ").replace(/\s*\(.*\)\s*$/, "").trim();
    if (!words) continue;
    if (/\bmusic\b/i.test(words)) music = true;
    if (words.toLowerCase() !== "music") words = words.replace(/^music of /i, "").replace(/ music$/i, "");
    const name = words.toLowerCase();
    const shown = YT_TOPIC_NAMES[name] ?? words.charAt(0).toUpperCase() + words.slice(1);
    (YT_VAGUE.has(name) ? vague : names).push(shown);
  }
  const category = typeof categoryId === "string" ? YT_CATEGORIES[categoryId] : undefined;
  const all = names.length ? names : category && category !== "Music" ? [category] : vague.filter((v) => v !== "Music");
  return { genres: nameList(all, MAX_GENRES, 40), music };
}

// ---------- Open Library ----------

/** Subjects that are genres. Open Library's subjects are anything a librarian typed; only these are kept. */
const BOOK_GENRES = [
  "Science fiction",
  "Fantasy",
  "Mystery",
  "Thriller",
  "Crime",
  "Horror",
  "Romance",
  "Historical fiction",
  "Literary fiction",
  "Biography",
  "Memoir",
  "History",
  "Science",
  "Philosophy",
  "Psychology",
  "Business",
  "Economics",
  "Politics",
  "Travel",
  "Cooking",
  "Poetry",
  "Humor",
  "Essays",
  "Self-help",
  "Technology",
  "Design",
  "Nature",
  "Art",
  "Music",
  "Sport",
  "Religion",
  "Young adult",
  "Graphic novels",
  "Short stories",
];

const BY_LENGTH = [...BOOK_GENRES].sort((a, b) => b.length - a.length);

/** A book's genres from its subjects, in the order BOOK_GENRES lists them being found; three at most. */
export function bookGenres(subjects: unknown): string[] {
  if (!Array.isArray(subjects)) return [];
  const found = new Map<string, number>();
  subjects.forEach((raw, i) => {
    if (typeof raw !== "string") return;
    const s = raw
      .toLowerCase()
      .replace(/humour/g, "humor")
      .replace(/autobiograph(y|ies)|biograph(y|ies)/g, "biography")
      .replace(/detective and mystery stories|mystery fiction/g, "mystery")
      .replace(/thrillers?/g, "thriller")
      .replace(/comics & graphic novels|graphic novel\b/g, "graphic novels")
      .replace(/sports/g, "sport");
    // Longest names first, each taken out once matched: "science fiction" isn't also "science".
    let rest = s;
    for (const g of BY_LENGTH) {
      const at = new RegExp(`(^|[^a-z])${g.toLowerCase().replace(/-/g, "[- ]")}(?=[^a-z]|$)`).exec(rest);
      if (!at) continue;
      rest = rest.slice(0, at.index) + " " + rest.slice(at.index + at[0].length);
      if (!found.has(g)) found.set(g, i);
    }
  });
  // "Fiction" alone is on nearly every novel; the named kinds above say more.
  return [...found.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([g]) => (g === "Humor" ? "Humour" : g));
}

// ---------- Seasons ----------

export interface Season {
  id: string;
  /** "Christmas": as a shelf, "For Christmas". */
  label: string;
  /** First and last day it's offered, [month, day], inclusive. */
  from: [number, number];
  to: [number, number];
  /** Words in a title, a playlist's name, a tag or a source's keyword that mean it. */
  words: RegExp;
  /** Film and show genres that suit it on their own. */
  genres?: string[];
}

export const SEASONS: readonly Season[] = [
  { id: "valentines", label: "Valentine's", from: [2, 1], to: [2, 14], words: /\b(valentines?|love songs?|rom[- ]?coms?|romantic)\b/i, genres: ["Romance"] },
  { id: "summer", label: "Summer", from: [6, 1], to: [8, 31], words: /\b(summer|beach|festival|sunshine|bbq|barbecue|road ?trip)\b/i },
  { id: "halloween", label: "Halloween", from: [10, 1], to: [10, 31], words: /\b(halloween|spooky|haunted|haunting|ghosts?|witch(es)?|zombies?|vampires?|slasher|monsters?)\b/i, genres: ["Horror"] },
  { id: "christmas", label: "Christmas", from: [11, 1], to: [12, 31], words: /\b(christmas|xmas|santa|festive|noel|carols?|advent|yuletide|nutcracker|holiday (film|movie|special|season)s?)\b/i },
];

const dayNumber = (month: number, day: number) => month * 100 + day;

/** The season on now (the owner's local date), or null. */
export function seasonOn(date: Date): Season | null {
  const today = dayNumber(date.getMonth() + 1, date.getDate());
  return SEASONS.find((s) => today >= dayNumber(...s.from) && today <= dayNumber(...s.to)) ?? null;
}

export interface Themed {
  title: string;
  kind: string;
  meta?: WatchMeta | null;
}

/** Why an item suits a season: its own words (title, playlist, tag, keyword) or only its genre. Null: it doesn't. */
export function seasonFit(item: Themed, season: Season): "named" | "genre" | null {
  const m = item.meta ?? {};
  if (m.themes?.includes(season.id)) return "named";
  const words = [item.title, ...(m.lists ?? []), ...(m.tags ?? [])];
  if (words.some((w) => season.words.test(w))) return "named";
  if (season.genres && (item.kind === "film" || item.kind === "tv") && m.genres?.some((g) => season.genres!.some((s) => s.toLowerCase() === g.toLowerCase()))) return "genre";
  return null;
}

/** The seasons a source's keywords name ("christmas", "halloween", "holiday"). */
export function themesFromKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  const text = keywords.filter((k): k is string => typeof k === "string");
  return SEASONS.filter((s) => text.some((k) => s.words.test(k))).map((s) => s.id);
}

// ---------- Words ----------

/** A running time: "48m", "2h", "2h 15m". */
export function minutesWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h ? (rest ? `${h}h ${rest}m` : `${h}h`) : `${rest}m`;
}

/** Tags as the owner typed them, in one field: split on commas. */
export const parseTags = (raw: string): string[] => nameList(raw.split(","), MAX_TAGS, TAG_LENGTH);

// ---------- Music, music videos and Shorts ----------

/**
 * A YouTube Short: its link says so, or it runs a minute or less. YouTube's
 * API has no flag for one, and a liked Short arrives with an ordinary watch
 * link, so the length is what's left to go on. A song is longer.
 */
export function isShort(item: { url?: string | null; meta?: WatchMeta | null }): boolean {
  if (/youtube\.com\/shorts\//i.test(item.url ?? "")) return true;
  const m = item.meta?.minutes;
  return typeof m === "number" && m <= 1;
}

/**
 * A music video: a video YouTube files under Music that isn't a Short. It
 * lives on the Music page (Music videos), never on Watch & read.
 */
export function isMusicVideo(item: { kind: string; url?: string | null; meta?: WatchMeta | null }): boolean {
  return item.kind === "video" && item.meta?.music === true && !isShort(item);
}

/** Everything the Music page holds and Watch & read doesn't: music saved as music, and music videos. */
export const isMusic = (item: { kind: string; url?: string | null; meta?: WatchMeta | null }): boolean => item.kind === "music" || isMusicVideo(item);
