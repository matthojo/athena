/**
 * Sample Days, for sample mode and for the screenshot mocks: about fourteen
 * months of made-up days, the same every time for a given date (seeded),
 * with a few days shaped on purpose relative to today: today so far,
 * yesterday busy, a quiet day, a health-only day and a day with nothing.
 * Titles are invented; artwork is drawn here as SVG from each item's tone.
 * Pure apart from an in-memory store for the owner's own edits.
 */

import { deepNote, fallbackLine } from "../components/day-words";
import { SAMPLE_FOOD_DAY, sampleFood } from "./health";
import type { Day, DayArt, DayCounts, DayEntry, DayEvent, DayHealth, DayPatch, DayPlace, DaySearchFilters, DaySearchHit, DaySearchResult, DaySummary, DaysRange, EntryKind, ManualEntryInput, Mood } from "./days-app";
import { withSampleLife } from "./sample-life";
import { withManualVisits } from "./sample-place-visits";
import { coverTitleSvg } from "../lib/cover-ink";
import type { DayFirst, MemoryContext, MemoryDay } from "../../../lib/memory-types";

type Art = DayArt;
/** A stop as the generator thinks of it; the API sends name and minutes only. */
type Stop = DayPlace & { kind?: string; at?: string };

// ---------- Dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

let fixedToday: string | null = null;
/** For the screenshot mocks: pretend today is this date. */
export function setSampleToday(date: string | null): void {
  fixedToday = date;
}
const today = () => fixedToday ?? todayLocal();

// ---------- A seeded random per day ----------

function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

// ---------- The catalogue (all invented) ----------

interface Work {
  id: string;
  title: string;
  by?: string;
  tone: string;
  tone2: string;
  w: number;
  h: number;
}

const poster = (id: string, title: string, by: string, tone: string, tone2: string): Work => ({ id, title, by, tone, tone2, w: 2, h: 3 });
const square = (id: string, title: string, by: string, tone: string, tone2: string): Work => ({ id, title, by, tone, tone2, w: 1, h: 1 });
const cover = (id: string, title: string, by: string, tone: string, tone2: string): Work => ({ id, title, by, tone, tone2, w: 2, h: 3 });
const wide = (id: string, title: string, by: string, tone: string, tone2: string): Work => ({ id, title, by, tone, tone2, w: 16, h: 9 });

const SHOWS: Work[] = [
  poster("show-northern", "Northern Lines", "Season 2", "#1f3b57", "#e0b25c"),
  poster("show-glasshouse", "The Glasshouse", "Season 1", "#2f4a3a", "#d8e2c8"),
  poster("show-dispatch", "Night Dispatch", "Season 3", "#3a1f2b", "#f06b4f"),
  poster("show-harbour", "Harbour Street", "Season 1", "#26324a", "#9ab8e8"),
];
const FILMS: Work[] = [
  poster("film-quiet-coast", "The Quiet Coast", "2024", "#20403f", "#f2c38b"),
  poster("film-northbound", "Northbound", "2019", "#3b2f54", "#f4a6a0"),
  poster("film-paper-moon", "Paper Lanterns", "2022", "#5a2a1f", "#f7d9a4"),
  poster("film-last-ferry", "The Last Ferry", "2021", "#0f2a3d", "#7ec4cf"),
  poster("film-salt", "Salt and Iron", "2017", "#3d3a32", "#d9a441"),
  poster("film-orchard", "An Orchard in June", "2023", "#2e4a2a", "#f0e6a8"),
  poster("film-static", "Static Bloom", "2025", "#1d1d38", "#c08cf0"),
];
/** What Watch & read would know about the shows and films above (TMDB's genres), so the month's genre radar has something to draw. */
export const SAMPLE_WATCH_GENRES: Array<{ kind: "tv" | "film"; title: string; genres: string[] }> = [
  { kind: "tv", title: "Northern Lines", genres: ["Drama", "Crime"] },
  { kind: "tv", title: "The Glasshouse", genres: ["Comedy", "Drama"] },
  { kind: "tv", title: "Night Dispatch", genres: ["Crime", "Mystery", "Drama"] },
  { kind: "tv", title: "Harbour Street", genres: ["Sci-Fi & Fantasy", "Mystery"] },
  { kind: "film", title: "The Quiet Coast", genres: ["Drama", "Romance"] },
  { kind: "film", title: "Northbound", genres: ["Adventure", "Drama"] },
  { kind: "film", title: "Paper Lanterns", genres: ["Animation", "Family", "Fantasy"] },
  { kind: "film", title: "The Last Ferry", genres: ["Thriller", "Mystery"] },
  { kind: "film", title: "Salt and Iron", genres: ["Western", "Drama"] },
  { kind: "film", title: "An Orchard in June", genres: ["Comedy", "Romance"] },
  { kind: "film", title: "Static Bloom", genres: ["Science Fiction", "Thriller"] },
];
const ALBUMS: Work[] = [
  square("album-tidal", "Tidal Hours", "Mara Vell", "#1e4f6b", "#f3c677"),
  square("album-concrete", "Concrete Garden", "The Low Arcs", "#4a4a4a", "#e86f4f"),
  square("album-amber", "Amber Signals", "Ostra", "#6b3a12", "#f6d36b"),
  square("album-fieldwork", "Fieldwork", "Juniper & Gale", "#2d4f3c", "#cfe3b4"),
  square("album-neon", "Soft Neon", "Kaito Rhee", "#2a1a4a", "#ff7fb0"),
  square("album-winter", "Winter Index", "Halden", "#33415c", "#dfe7f2"),
];
const TRACKS = ["Opening", "Low Tide", "Glass Hours", "Northwind", "Small Rooms", "Afterlight", "Second Coast", "Paper Planes", "Undertow", "Slow Return"];
const BOOKS: Work[] = [
  cover("book-cartographer", "The Cartographer's Daughter", "Ines Morrow", "#264653", "#e9c46a"),
  cover("book-small-hours", "Small Hours", "Tomás Reid", "#5c2a3e", "#f4d1ae"),
  cover("book-making", "On Making Things Slowly", "Ada Lindqvist", "#e8e1d3", "#2b2b2b"),
];
const HIGHLIGHTS = [
  "Nothing is lost by going slowly, if you go somewhere.",
  "Every map is a decision about what to leave out.",
  "She kept the light on long after the ferry had gone.",
  "The best tools disappear in the hand.",
  "A day is long enough to change your mind twice.",
];
const GAMES: Work[] = [
  wide("game-lumen", "Lumen Drift", "", "#13243b", "#5ec8e0"),
  wide("game-hollow", "Hollow Peaks", "", "#3a2b1d", "#e3a75b"),
  wide("game-stack", "Stackyard", "", "#2f3b2a", "#b8e05e"),
];
const POSTS = [
  "Finally got the bike serviced. It's like a new bike.",
  "Small joy: the café remembered my order.",
  "Reading on the train beats scrolling on the train. Every time.",
  "Anyone else find autumn light makes everything look like a film still?",
];
const SAVED = [
  { title: "How to keep a notebook you'll actually reread", site: "slowwork.blog" },
  { title: "The case for boring software", site: "craft.dev" },
  { title: "A field guide to London's lidos", site: "citywalks.co.uk" },
];
const PLACES: (Stop & { lat: number; lng: number; town: string; weight: number })[] = [
  { id: "pl-dishoom", name: "Dishoom", kind: "food", lat: 51.5246, lng: -0.1266, town: "London", weight: 2 },
  { id: "pl-heath", name: "Hampstead Heath", kind: "park", lat: 51.5608, lng: -0.1636, town: "London", weight: 3 },
  { id: "pl-monmouth", name: "Monmouth Coffee", kind: "coffee", lat: 51.5145, lng: -0.1263, town: "London", weight: 3 },
  { id: "pl-barbican", name: "Barbican Centre", kind: "culture", lat: 51.5202, lng: -0.0938, town: "London", weight: 1 },
  { id: "pl-kings", name: "King's Cross", kind: "station", lat: 51.5308, lng: -0.1238, town: "London", weight: 2 },
  { id: "pl-broadway", name: "Broadway Market", kind: "shop", lat: 51.5363, lng: -0.0617, town: "London", weight: 1 },
  { id: "pl-gym", name: "Third Space", kind: "gym", lat: 51.5175, lng: -0.1404, town: "London", weight: 2 },
];
const HOME: Stop & { lat: number; lng: number; town: string } = { id: "pl-home", name: "Home", kind: "home", lat: 51.5465, lng: -0.1058, town: "London" };
const WORK: Stop & { lat: number; lng: number; town: string } = { id: "pl-work", name: "Work", kind: "work", lat: 51.5226, lng: -0.1085, town: "London" };
const MEETINGS = [
  { title: "Design review", people: ["Priya Shah", "Tom Ellis"] },
  { title: "1:1 with Sam", people: ["Sam Okafor"] },
  { title: "Planning", people: ["Priya Shah", "Leo Grant", "Ana Ruiz"] },
  { title: "Coffee with Ana", people: ["Ana Ruiz"] },
  { title: "Roadmap check-in", people: ["Leo Grant"] },
];
const WEATHER = [
  { text: "rain", code: 61 },
  { text: "sun", code: 0 },
  { text: "cloud", code: 3 },
  { text: "sunny spells", code: 2 },
  { text: "drizzle", code: 51 },
];
const JOURNALS = [
  "Long walk on the Heath after work. The light was unreal around four.",
  "Tired but good. The design review went better than I expected.",
  "Slow morning, then a proper lunch with Ana. Need more days like this.",
  "Couldn't focus today. Went to bed early.",
];

const MEMORY_JOURNAL = "First proper sunny day in ages. Priya talked me into the long way back over the Heath, and I'm glad she did.";

const ART = new Map<string, Work>();
for (const w of [...SHOWS, ...FILMS, ...ALBUMS, ...BOOKS, ...GAMES]) ART.set(w.id, w);
/** Another sample cover drawn the same way: Music's invented albums (db/sample-music.ts). */
export function addSampleArt(w: Work): void {
  if (!ART.has(w.id)) ART.set(w.id, w);
}
const art = (w: Work): Art => ({ id: w.id, w: w.w, h: w.h, tone: w.tone });

// ---------- A day ----------

type Shape = "today" | "busy" | "quiet" | "health" | "empty" | "memory" | "normal";

/** The same date a year before `date` (29 February → the 28th). */
function yearBefore(date: string, years = 1): string {
  const y = Number(date.slice(0, 4)) - years;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return date.slice(5) === "02-29" && !leap ? `${y}-02-28` : `${y}${date.slice(4)}`;
}

function shapeOf(date: string): Shape {
  // A year ago today: lunch with Priya at Dishoom, and a line from the journal, so Home has a memory.
  if (date === yearBefore(today())) return "memory";
  const n = daysBetween(date, today());
  if (n === 0) return "today";
  if (n === 1) return "busy";
  if (n === 2) return "quiet";
  if (n === 3) return "health";
  if (n === 5 || n === 19 || n === 33) return "empty";
  return "normal";
}

const at = (date: string, hh: number, mm = 0) => `${date}T${pad(hh)}:${pad(mm)}:00`;

function health(r: () => number, date: string, opts: { workout?: boolean; partial?: boolean } = {}): DayHealth {
  const h: DayHealth = {
    line: null,
    sleep_minutes: Math.round(370 + r() * 140),
    steps: opts.partial ? Math.round(2400 + r() * 2500) : Math.round(3500 + r() * 12500),
    resting_hr: Math.round(54 + r() * 8),
  };
  if (opts.workout) {
    const run = r() > 0.4;
    h.workouts = [run ? { type: "Running", minutes: Math.round(32 + r() * 30), distance_m: Math.round(5200 + r() * 6000), start: "07:10" } : { type: "Yoga", minutes: 40, start: "18:30" }];
  }
  if (weekday(date) === 6) h.weight_kg = 74 + Math.round(r() * 20) / 10;
  // The night by stage, as a watch gives it.
  const deep = Math.round(h.sleep_minutes! * (0.15 + r() * 0.07));
  const rem = Math.round(h.sleep_minutes! * (0.2 + r() * 0.07));
  h.sleep_stages = { deep, rem, core: h.sleep_minutes! - deep - rem, awake: Math.round(12 + r() * 20) };
  return h;
}

// A small loop around a park, encoded (Google polyline).
const ROUTE = encodeRoute([
  [51.5608, -0.1636],
  [51.5632, -0.1601],
  [51.5655, -0.1622],
  [51.5671, -0.1588],
  [51.5652, -0.1541],
  [51.5618, -0.1559],
  [51.5596, -0.1598],
  [51.5608, -0.1636],
]);

function encodeRoute(points: [number, number][]): string {
  let out = "";
  let pl = 0;
  let pg = 0;
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let r = "";
    while (s >= 0x20) {
      r += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    return r + String.fromCharCode(s + 63);
  };
  for (const [lat, lng] of points) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lng * 1e5);
    out += enc(a - pl) + enc(b - pg);
    pl = a;
    pg = b;
  }
  return out;
}

function makeDay(date: string): Day | null {
  const shape = shapeOf(date);
  const start = addDays(today(), -430);
  if (date > today() || date < start || shape === "empty") return null;
  const r = seeded(date);
  const dow = weekday(date);
  const weekend = dow >= 5;
  const day: Day = { date, photos: [], places: [], entries: [], notes: [], events: [], calendar_labels: ["work", "personal"], counts: emptyCounts() };
  const stops: Stop[] = [];

  if (shape === "health") {
    day.health = health(r, date);
    day.health.sleep_minutes = 512;
    day.health.sleep_stages = { deep: 92, rem: 121, core: 299, awake: 18 };
    day.health.steps = 3120;
    return finish(day);
  }

  const busy = shape === "busy";
  const quiet = shape === "quiet";
  day.health = health(r, date, { workout: busy || (!quiet && r() > 0.6), partial: shape === "today" });
  if (busy) day.health.steps = 14_210;
  if (shape === "today") delete day.health.resting_hr;
  // Food, drink and mind (Apple Health): yesterday is the brief's day; today has nothing yet.
  if (shape !== "today") Object.assign(day.health, busy ? SAMPLE_FOOD_DAY : sampleFood(date));

  // Watched
  if (!quiet && (busy || r() > 0.35)) {
    const show = busy ? SHOWS[0] : pick(r, SHOWS);
    const n = busy ? 3 : 1 + Math.floor(r() * 2);
    const ep = 1 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++)
      day.entries.push({ id: `${date}-ep-${i}`, kind: "watched", source: "netflix", title: `Episode ${ep + i}`, subtitle: `${show.by} · Episode ${ep + i}`, group: show.title, at: at(date, 20 + i), art: art(show), minutes: 52 });
  }
  if (busy || (!quiet && r() > 0.75)) {
    const film = pick(r, FILMS);
    day.entries.push({ id: `${date}-film`, kind: "watched", source: "letterboxd", title: film.title, subtitle: film.by, at: at(date, 22, 15), art: art(film), minutes: 112, rating: busy ? 4.5 : 3 + Math.round(r() * 4) / 2 });
  }
  // Listened
  if (shape === "today" || busy || r() > 0.25) {
    const albums = busy ? 3 : quiet ? 1 : 1 + Math.floor(r() * 3);
    const used = new Set<string>();
    for (let a = 0; a < albums; a++) {
      const album = pick(r, ALBUMS);
      if (used.has(album.id)) continue;
      used.add(album.id);
      const tracks = 2 + Math.floor(r() * 6);
      for (let t = 0; t < tracks; t++)
        day.entries.push({ id: `${date}-tr-${a}-${t}`, kind: "listened", source: "spotify", title: pick(r, TRACKS), subtitle: album.by, group: album.title, at: at(date, 8 + a * 3, t * 4), art: art(album), count: 1, minutes: 4 });
    }
  }
  // Read
  if (!quiet && (busy || r() > 0.55)) {
    const book = pick(r, BOOKS);
    const page = 40 + Math.floor(r() * 250);
    day.entries.push({ id: `${date}-book`, kind: "read", source: "goodreads", title: book.title, subtitle: `${book.by} · page ${page} of 340`, art: art(book), ...(busy ? { at: at(date, 7, 15), minutes: 25 } : {}) });
    if (busy || r() > 0.5) {
      const n = busy ? 2 : 1;
      for (let i = 0; i < n; i++) day.entries.push({ id: `${date}-hl-${i}`, kind: "highlight", source: "readwise", title: HIGHLIGHTS[(i + Math.floor(r() * 5)) % 5], subtitle: book.title, group: book.title });
    }
  }
  // Played
  if (!quiet && (busy || (weekend && r() > 0.3) || r() > 0.85)) {
    const game = pick(r, GAMES);
    const mins = 60 + Math.floor(r() * 150);
    day.entries.push({ id: `${date}-game`, kind: "played", source: "steam", title: game.title, minutes: mins, art: art(game), ...(busy ? { at: at(date, 18, 10), minutes: 70 } : {}) });
  }
  if (busy || (!quiet && r() > 0.8)) {
    day.entries.push({ id: `${date}-chess-1`, kind: "chess", source: "lichess", title: "Won with black", subtitle: "Rapid 10+0 · rated 1,642", url: "https://lichess.org", count: 1, group: "chess" });
    day.entries.push({ id: `${date}-chess-2`, kind: "chess", source: "lichess", title: "Lost on time", subtitle: "Blitz 3+2 · rated 1,618", url: "https://lichess.org", count: 1, group: "chess" });
  }
  // Posted and saved
  if (busy || (!quiet && r() > 0.7)) day.entries.push({ id: `${date}-post`, kind: "posted", source: "mastodon", title: pick(r, POSTS), at: at(date, 13, 5), url: "https://example.social" });
  if (busy || r() > 0.75) {
    const s = pick(r, SAVED);
    day.entries.push({ id: `${date}-saved`, kind: "saved", source: "pocket", title: s.title, subtitle: s.site, url: `https://${s.site}` });
  }
  // From the backfill imports (components/backfill-import.ts): Overcast episodes, TfL journeys. Habits come from db/sample-life.ts.
  if (r() > 0.6) {
    const show = pick(r, ["The Rest Is History", "Desert Island Discs", "In Our Time"]);
    day.entries.push({ id: `${date}-pod`, kind: "listened", source: "overcast", title: pick(r, ["The fall of Rome", "A life in eight records", "The printing press"]), subtitle: show, group: show, minutes: 25 + Math.floor(r() * 30), url: "https://overcast.fm" });
  }
  // Tuesdays and Thursdays at the client in Canary Wharf: the long commute behind the sample's commute pattern (db/sample-patterns.ts).
  if (!quiet && (dow === 1 || dow === 3)) {
    day.entries.push({ id: `${date}-tfl-am`, kind: "other", source: "tfl", title: "Highbury & Islington → Canary Wharf", subtitle: "07:58–08:42", group: "commute", minutes: 44 });
    day.entries.push({ id: `${date}-tfl-pm`, kind: "other", source: "tfl", title: "Canary Wharf → Highbury & Islington", subtitle: "18:10–18:57", group: "commute", minutes: 47 });
  } else if (weekday(date) < 5 && !quiet) {
    day.entries.push({ id: `${date}-tfl-am`, kind: "other", source: "tfl", title: "Highbury & Islington → Old Street", subtitle: "08:12–08:31", group: "commute", minutes: 19 });
    day.entries.push({ id: `${date}-tfl-pm`, kind: "other", source: "tfl", title: "Old Street → Highbury & Islington", subtitle: "18:05–18:27", group: "commute", minutes: 22 });
  }
  // From receipt emails (lib/receipts.ts): a Friday night ride home and a takeaway, the odd weekend Bolt and midweek Just Eat.
  // Fixed by the date, not drawn from r(), so the rest of the sample stays as it was.
  const dom = Number(date.slice(8, 10));
  if (dow === 4 || shape === "busy") {
    day.entries.push({ id: `${date}-uber`, kind: "other", source: "uber", title: "Covent Garden → Home", subtitle: "21:40 · 22 min", at: at(date, 21, 40), minutes: 22, group: "Rides" });
    day.entries.push({ id: `${date}-deliveroo`, kind: "other", source: "deliveroo", title: "Takeaway from Rosa's Thai", subtitle: "22:10 · Pad Thai and 2 more", at: at(date, 22, 10), group: "Takeaway" });
  } else if (dow === 5 && dom % 2 === 0) {
    day.entries.push({ id: `${date}-bolt`, kind: "other", source: "bolt", title: "Ride to Highbury Corner", subtitle: "23:39 · 19 min", at: at(date, 23, 39), minutes: 19, group: "Rides" });
  } else if (dow === 2 && dom % 2 === 1) {
    day.entries.push({ id: `${date}-justeat`, kind: "other", source: "justeat", title: "Takeaway from Mamma Mia Pizzeria", subtitle: "20:02 · Margherita and 2 more", at: at(date, 20, 2), group: "Takeaway" });
  }
  // From the connectors audit's sources (docs/notes/connectors-audit.md): a saved link most weekdays, a Sunday album on
  // ListenBrainz and an evening out booked on Eventbrite now and then. Also fixed by the date.
  if (weekday(date) < 5 && dom % 3 === 0) day.entries.push({ id: `${date}-raindrop`, kind: "saved", source: "raindrop", title: "How to make sourdough at home", subtitle: "seriouseats.com", url: "https://www.seriouseats.com", note: "Recipes" });
  if (dow === 6) day.entries.push({ id: `${date}-lb`, kind: "listened", source: "listenbrainz", title: "Profound Mysteries II", subtitle: "Röyksopp", group: "Röyksopp", count: 9, at: at(date, 11, 5), url: "https://listenbrainz.org" });
  if (dom === 12 || dom === 26) day.entries.push({ id: `${date}-eventbrite`, kind: "other", source: "eventbrite", title: dom === 12 ? "Late night at the museum" : "Talk: a short history of maps", subtitle: dom === 12 ? "19:00 · Natural History Museum, London" : "18:30 · Conway Hall, London", at: at(date, dom === 12 ? 19 : 18, dom === 12 ? 0 : 30), minutes: dom === 12 ? 180 : 90, group: "Events", url: "https://www.eventbrite.co.uk" });

  // Places and weather
  if (!quiet || r() > 0.5) {
    if (!weekend && shape !== "today") stops.push({ id: WORK.id, name: WORK.name, kind: "work", at: "09:20" });
    const n = busy ? 3 : quiet ? 1 : 1 + Math.floor(r() * 2);
    const used = new Set<string>();
    if (shape === "memory") {
      stops.push({ ...PLACES[0], at: "12:40" }, { ...PLACES[1], at: "16:10" });
      used.add(PLACES[0].id!).add(PLACES[1].id!);
    }
    for (let i = 0; i < n && shape !== "memory"; i++) {
      const p = pick(r, PLACES);
      if (used.has(p.id!)) continue;
      used.add(p.id!);
      stops.push({ id: p.id, name: p.name, kind: p.kind, at: `${pad(12 + i * 2)}:${pad(Math.floor(r() * 50))}` });
    }
    stops.push({ id: HOME.id, name: HOME.name, kind: "home", at: "19:10" });
    day.places = stops.map((s, i) => ({ id: s.id, name: s.name, minutes: s.kind === "work" ? 200 : i === stops.length - 1 ? undefined : 30 + Math.floor(r() * 120) }));
    const w = pick(r, WEATHER);
    const high = Math.round(8 + r() * 12 + (Number(date.slice(5, 7)) > 4 && Number(date.slice(5, 7)) < 10 ? 8 : 0));
    day.weather = `${high}° and ${w.text} in London`;
    const named = stops.filter((x) => x.kind !== "home").map((x) => (x.kind === "food" ? `lunch at ${x.name}` : x.name));
    if (named.length) day.places_line = (named.length > 1 ? `${named.slice(0, -1).join(", ")}, then ${named[named.length - 1]}` : named[0]).replace(/^./, (c) => c.toUpperCase());
  }

  // Meetings and notes
  if (!weekend && shape !== "today" && !quiet) {
    const n = busy ? 3 : 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const m = MEETINGS[(i + Math.floor(r() * MEETINGS.length)) % MEETINGS.length];
      const ev: DayEvent = { id: `${date}-ev-${i}`, title: m.title, kind: "meeting", starts_at: `${date}T${pad(10 + i * 2)}:00:00Z`, ends_at: `${date}T${pad(10 + i * 2)}:${i % 2 ? "30" : "59"}:00Z`, label: "work" };
      day.events.push(ev);
    }
    if (busy) day.events.push({ id: `${date}-ev-p`, title: "Dentist", kind: "appointment", starts_at: `${date}T16:30:00Z`, ends_at: `${date}T17:00:00Z`, label: "personal" });
    if (busy || r() > 0.6) day.notes.push({ id: `${date}-note-0`, title: busy ? "Design review: decisions on the new onboarding" : "Notes from planning", type: "meeting", source: "calendar-meetings", created_at: `${date}T11:00:00Z` });
  }
  // A weekend's own plans, on the personal calendar
  if (weekend && !quiet && shape !== "today") {
    day.events.push({ id: `${date}-ev-w0`, title: "Climbing with Leo", kind: "other", starts_at: `${date}T10:00:00Z`, ends_at: `${date}T12:00:00Z`, label: "personal" });
    day.events.push({ id: `${date}-ev-w1`, title: "Dinner at Ana's", kind: "other", starts_at: `${date}T19:00:00Z`, ends_at: `${date}T21:30:00Z`, label: "personal" });
  }

  // Photos
  if (busy) day.photos = [photo(date, 0, 4, 3, "#7a8fa6"), photo(date, 1, 3, 4, "#a77b52"), photo(date, 2, 4, 3, "#5d7d5a")];
  else if (!quiet && r() > 0.8) day.photos = [photo(date, 0, r() > 0.5 ? 4 : 3, r() > 0.5 ? 3 : 4, pick(r, ["#7a8fa6", "#a77b52", "#5d7d5a", "#8a6f8f"]))];

  // The owner's words
  if (shape === "busy") {
    day.mood = 4;
    day.journal = JOURNALS[0];
    day.line = `A full ${DAY_NAMES[weekday(date)]}: a long run, lunch at Dishoom and the Northern Lines finale`;
    day.line_by = "run";
  } else if (shape === "quiet") {
    day.mood = 3;
  } else if (shape === "memory") {
    day.mood = 5;
    day.journal = MEMORY_JOURNAL;
    day.line = fallbackLine(day) ?? undefined;
  } else if (shape !== "today") {
    if (r() > 0.35) day.mood = (1 + Math.min(4, Math.floor(r() * 3 + r() * 2.6))) as Mood;
    if (r() > 0.8) day.journal = pick(r, JOURNALS);
    if (r() > 0.25) day.line = fallbackLine(day) ?? undefined;
  }
  return finish(day);
}

function photo(date: string, i: number, w: number, h: number, tone: string) {
  const id = `photo-${date}-${i}`;
  ART.set(id, { id, title: "", tone, tone2: "#e9e4da", w, h });
  return { id, w: w * 400, h: h * 400, thumb: true, added_at: at(date, 11 + i * 3) };
}


const emptyCounts = (): DayCounts => ({ entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0 });

function finish(day: Day): Day {
  const c = emptyCounts();
  for (const e of day.entries) {
    c.by_kind[e.kind] = (c.by_kind[e.kind] ?? 0) + (e.count ?? 1);
    c.entries += e.count ?? 1;
    if (e.minutes) c.minutes[e.kind] = (c.minutes[e.kind] ?? 0) + e.minutes;
  }
  if (day.health?.workouts?.length) c.by_kind.workout = day.health.workouts.length;
  if (day.health?.steps) c.steps = day.health.steps;
  c.photos = day.photos.length;
  c.notes = day.notes.length;
  c.events = day.events.length;
  const weight = c.entries + c.photos * 2 + c.notes + c.events + (day.journal ? 3 : 0) + (day.health ? 1 : 0);
  c.heat = weight <= 0 ? 0 : weight < 4 ? 1 : weight < 10 ? 2 : weight < 20 ? 3 : 4;
  if (day.health) {
    const h = day.health;
    const bits = [h.sleep_minutes ? `${Math.floor(h.sleep_minutes / 60)}h ${h.sleep_minutes % 60}m sleep${deepNote(h.sleep_stages)}` : null, h.steps ? `${h.steps.toLocaleString("en-GB")} steps` : null, h.resting_hr ? `${h.resting_hr} bpm resting` : null].filter(Boolean);
    h.line = bits.length ? bits.join(" · ") : null;
  }
  day.counts = c;
  return day;
}

export function summaryOf(d: Day): DaySummary {
  const seen = new Set<string>();
  const art: DayArt[] = [];
  for (const e of d.entries) {
    if (!e.art || seen.has(e.group ?? e.art.id)) continue;
    seen.add(e.group ?? e.art.id);
    art.push(e.art);
    if (art.length === 4) break;
  }
  const habits = d.entries.filter((e) => e.kind === "habit");
  return { date: d.date, line: d.line, mood: d.mood, counts: d.counts, art, photo: d.photos[0]?.id, journal: !!d.journal, ...(habits.length ? { habits: { done: habits.filter((e) => (e.count ?? 1) > 0).length, of: habits.length } } : {}) };
}

// ---------- The owner's edits, kept in memory ----------

interface Edit {
  line?: string | null;
  mood?: Mood | null;
  journal?: string | null;
  photos?: Day["photos"];
  removed?: string[];
  hidden?: string[];
  /** Entries added by hand. */
  added?: DayEntry[];
}
const edits = new Map<string, Edit>();

function withEdits(date: string): Day {
  // Habits, and money and home when turned on (db/sample-life.ts); place visits added by hand (db/sample-place-visits.ts).
  const base = withManualVisits(withSampleLife(makeDay(date) ?? { date, photos: [], places: [], entries: [], notes: [], events: [], counts: emptyCounts() }));
  const e = edits.get(date);
  if (!e) return base;
  const d: Day = { ...base };
  if (e.line !== undefined) e.line ? ((d.line = e.line), (d.line_by = "owner")) : delete d.line;
  if (e.mood !== undefined) e.mood ? (d.mood = e.mood) : delete d.mood;
  if (e.journal !== undefined) e.journal ? (d.journal = e.journal) : delete d.journal;
  if (e.photos) d.photos = e.photos;
  if (e.removed) d.photos = d.photos.filter((p) => !e.removed!.includes(p.id));
  if (e.added) d.entries = [...d.entries, ...e.added];
  if (e.hidden) d.entries = d.entries.filter((x) => !e.hidden!.includes(x.id));
  return finish(d);
}

const isBlank = (d: Day) => !d.entries.length && !d.photos.length && !d.places.length && !d.events.length && !d.notes.length && !d.health && !d.journal && !d.mood && !d.line;

// ---------- The API, in sample mode ----------

const later = <T>(v: T, ms = 120): Promise<T> => new Promise((res) => setTimeout(() => res(structuredClone(v)), ms));

export function sampleRangeNow(from: string, to: string): DaysRange {
  const days: DaySummary[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = withEdits(d);
    if (!isBlank(day)) days.push(summaryOf(day));
  }
  return { from, to, days };
}

// ---------- Memories (GET /api/days/firsts) ----------

/**
 * What the server would say about memories near `around`: a few firsts
 * placed relative to it (a first run over 5 km two years ago today, the
 * first visit to the Barbican a year ago this week, the first catch-up with
 * Ana two years ago this week) and who and where on the same week a year ago.
 */
export function sampleMemoryContextNow(around: string): MemoryContext {
  const lastYear = yearBefore(around);
  const twoYears = yearBefore(around, 2);
  const firsts: DayFirst[] = [
    { kind: "run", date: twoYears, name: "run", km: 5.4 },
    { kind: "place", date: addDays(lastYear, -2), name: "Barbican Centre", since: 4 },
    { kind: "person", date: addDays(twoYears, 3), name: "Ana Ruiz", since: 11 },
  ];
  const days: MemoryDay[] = [];
  for (let d = addDays(lastYear, -3); d <= addDays(lastYear, 3); d = addDays(d, 1)) {
    const day = withEdits(d);
    const places = day.places.filter((p) => p.id !== HOME.id && p.id !== WORK.id).map((p) => p.name);
    const people = d === yearBefore(today()) ? ["Priya Shah"] : d === addDays(lastYear, -2) ? ["Tom Ellis"] : day.events.some((e) => e.title === "Coffee with Ana") ? ["Ana Ruiz"] : [];
    if (!places.length && !people.length) continue;
    days.push({ date: d, people: people.map((name) => ({ name, archived: false })), places, ...(day.places_line ? { line: day.places_line } : {}) });
  }
  return { around, firsts, days, never: ["weight", "money"] };
}

export const sampleMemoryContext = (around: string): Promise<MemoryContext> => later(sampleMemoryContextNow(around));

export const sampleRange = (from: string, to: string): Promise<DaysRange> => later(sampleRangeNow(from, to));
export const sampleDayNow = (date: string): Day => withEdits(date);
export const sampleDay = (date: string): Promise<Day> => later(withEdits(date));

export function patchSampleDay(date: string, patch: DayPatch): Promise<Day> {
  const e: Edit = { ...edits.get(date) };
  if (patch.line !== undefined) e.line = patch.line;
  if (patch.mood !== undefined) e.mood = patch.mood;
  if (patch.journal !== undefined) e.journal = patch.journal;
  if (patch.photos?.remove) e.removed = [...(e.removed ?? []), ...patch.photos.remove];
  edits.set(date, e);
  return later(withEdits(date), 60);
}

export function addSampleEntry(date: string, entry: ManualEntryInput): Promise<void> {
  const e: Edit = { ...edits.get(date) };
  const made: DayEntry = { id: `manual-${Date.now().toString(36)}`, source: "manual", kind: entry.kind, title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), ...(entry.note ? { note: entry.note } : {}), ...(entry.minutes ? { minutes: entry.minutes } : {}), ...(entry.rating ? { rating: entry.rating } : {}) };
  e.added = [...(e.added ?? []), made];
  edits.set(date, e);
  return later(undefined, 60);
}

export function removeSampleEntry(date: string, id: string): Promise<void> {
  const e: Edit = { ...edits.get(date) };
  e.added = (e.added ?? []).filter((x) => x.id !== id);
  edits.set(date, e);
  return later(undefined, 60);
}

export function hideSampleEntry(date: string, id: string, hidden: boolean): Promise<void> {
  const e: Edit = { ...edits.get(date) };
  const set = new Set(e.hidden ?? []);
  if (hidden) set.add(id);
  else set.delete(id);
  e.hidden = [...set];
  edits.set(date, e);
  return later(undefined, 60);
}

export function addSamplePhoto(date: string, input: { id: string; blob: Blob; width?: number; height?: number }): Promise<Day> {
  const current = withEdits(date);
  uploaded.set(input.id, URL.createObjectURL(input.blob));
  const p = { id: input.id, w: input.width, h: input.height, thumb: false, added_at: new Date().toISOString() };
  edits.set(date, { ...edits.get(date), photos: [...current.photos, p] });
  return later(withEdits(date), 200);
}
const uploaded = new Map<string, string>();

const snippetAround = (text: string, q: string) => {
  const k = text.toLowerCase().indexOf(q);
  return k < 0 ? text.slice(0, 120) : text.slice(Math.max(0, k - 40), k + q.length + 60);
};

/** "…the «Northern» Lines…": the match marked as the server marks it. */
const marked = (text: string, q: string) => {
  if (!q) return text;
  const k = text.toLowerCase().indexOf(q);
  if (k < 0) return text.slice(0, 120);
  const from = Math.max(0, k - 40);
  return `${from ? "…" : ""}${text.slice(from, k)}«${text.slice(k, k + q.length)}»${text.slice(k + q.length, k + q.length + 60)}`;
};

export function searchSampleDaysNow(f: DaySearchFilters): DaySearchResult {
  const q = (f.q ?? "").trim().toLowerCase();
  const results: DaySearchHit[] = [];
  const sources = new Map<string, number>();
  const places = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const empty = !q && !f.kind && !f.source && !f.place && !f.person;
  if (!empty)
    for (let d = today(), i = 0; i < 430 && results.length < 120; i++, d = addDays(d, -1)) {
      const day = withEdits(d);
      if (f.place && !day.places.some((p) => p.name === f.place)) continue;
      if (f.person) continue; // the sample days have no people
      let hit = false;
      for (const e of day.entries) {
        if (f.kind && e.kind !== f.kind) continue;
        if (f.source && e.source !== f.source) continue;
        const text = `${e.title} ${e.subtitle ?? ""} ${e.group ?? ""}`;
        if (q && !text.toLowerCase().includes(q)) continue;
        results.push({ date: d, match: "entry", entry: e, line: day.line, snippet: marked(text, q), rank: 1 });
        hit = true;
      }
      if (q && !f.kind && !f.source) {
        if (day.line?.toLowerCase().includes(q)) (results.push({ date: d, match: "line", line: day.line, snippet: marked(day.line, q), rank: 2 }), (hit = true));
        if (day.journal?.toLowerCase().includes(q)) (results.push({ date: d, match: "journal", line: day.line, snippet: marked(day.journal, q), rank: 1 }), (hit = true));
      }
      if (!q && !f.kind && !f.source && f.place) (results.push({ date: d, match: "line", line: day.line, snippet: day.line ?? "", rank: 1 }), (hit = true));
      if (!hit) continue;
      for (const e of day.entries) bump(sources, e.source);
      for (const p of day.places) if (!/^(home|work)$/i.test(p.name)) bump(places, p.name);
    }
  const byCount = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { q, results, facets: { sources: byCount(sources), places: byCount(places), people: [] } };
}

export const searchSampleDays = (f: DaySearchFilters): Promise<DaySearchResult> => later(searchSampleDaysNow(f), 160);

export type { DayEntry, EntryKind, DayEvent };

// ---------- Artwork, drawn ----------

export function sampleArt(id: string): Promise<string | null> {
  if (uploaded.has(id)) return Promise.resolve(uploaded.get(id)!);
  const svg = sampleArtSvg(id);
  return Promise.resolve(svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null);
}

/** An invented poster, cover, album or photo as SVG text. */
export function sampleArtSvg(id: string): string | null {
  if (!ART.has(id) && id.startsWith("photo-")) {
    const tone = "#7a8fa6";
    ART.set(id, { id, title: "", tone, tone2: "#e9e4da", w: 4, h: 3 });
  }
  const w = ART.get(id);
  if (!w) return null;
  const W = w.w * 120;
  const H = w.h * 120;
  const r = seeded(id);
  const kind = id.split("-")[0];
  const c1 = w.tone;
  const c2 = w.tone2;
  const shapes: string[] = [];
  if (kind === "photo") {
    // A soft landscape: sky, hills, a sun.
    shapes.push(`<rect width="${W}" height="${H}" fill="url(#g)"/>`);
    shapes.push(`<circle cx="${W * (0.25 + r() * 0.5)}" cy="${H * 0.32}" r="${H * 0.1}" fill="#fff4d6" opacity=".8"/>`);
    for (let i = 0; i < 3; i++) {
      const y = H * (0.55 + i * 0.12);
      shapes.push(`<path d="M0 ${y} Q ${W * 0.3} ${y - H * (0.12 + r() * 0.1)} ${W * 0.6} ${y} T ${W} ${y - H * 0.05} V ${H} H 0Z" fill="${c1}" opacity="${0.45 + i * 0.2}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs>${shapes.join("")}</svg>`;
  }
  shapes.push(`<rect width="${W}" height="${H}" fill="${c1}"/>`);
  const motif = Math.floor(r() * 3);
  if (motif === 0) {
    shapes.push(`<circle cx="${W * 0.5}" cy="${H * 0.42}" r="${Math.min(W, H) * 0.3}" fill="${c2}" opacity=".9"/>`);
    shapes.push(`<rect y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="${c1}" opacity=".85"/>`);
  } else if (motif === 1) {
    for (let i = 0; i < 5; i++) shapes.push(`<rect x="0" y="${H * (0.18 + i * 0.1)}" width="${W}" height="${H * 0.04}" fill="${c2}" opacity="${0.25 + i * 0.15}"/>`);
  } else {
    shapes.push(`<path d="M0 ${H * 0.75} L${W * 0.4} ${H * 0.35} L${W * 0.65} ${H * 0.58} L${W} ${H * 0.3} V${H} H0Z" fill="${c2}" opacity=".8"/>`);
  }
  // The title sits on a band of the fill, in --ink or --on-ink by contrast, and goes when the cover is small (lib/cover-ink.ts).
  const title = coverTitleSvg({ W, H, title: w.title, by: kind !== "show" ? w.by : undefined, fill: c1 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${shapes.join("")}${title}</svg>`;
}

