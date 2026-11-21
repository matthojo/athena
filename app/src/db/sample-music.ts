/**
 * Sample Music: two years of made-up listening across about forty invented
 * artists, the same every time for a given date (seeded per day). A few
 * favourites carry most of the plays, tastes drift through the seasons,
 * some artists only turn up partway through (so each period has new ones),
 * weekends run longer and some days have nothing. Rows go through the same
 * rules as the server's (lib/music.ts). Covers are drawn by sample-days.
 */

import { addSampleArt } from "./sample-days";
import { artistDetail, buildMusic, type ArtistDetail, type MusicData, type MusicRow } from "../../../lib/music";
import { musicFamilies } from "../../../lib/genre-mix";
import { playlistsView, topArtistsOf, type PlaylistsView, type StoredPlaylist } from "../../../lib/playlists";

const pad = (n: number) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
let fixedToday: string | null = null;
/** For the screenshot mocks: pretend today is this date. */
export function setSampleMusicToday(date: string | null): void {
  fixedToday = date;
}
const today = () => fixedToday ?? localToday();
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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

// ---------- The catalogue (all invented) ----------

interface Artist {
  name: string;
  albums: string[];
  /** How much they're played, relative. */
  weight: number;
  /** Days before today they first turn up (0: from the start of the two years). */
  from: number;
  /** Months they peak in (0-11), if any. */
  season?: number[];
  hue: number;
}

const A = (name: string, weight: number, albums: string[], hue: number, from = 0, season?: number[]): Artist => ({ name, albums, weight, from, hue, season });

const ARTISTS: Artist[] = [
  A("Mara Vell", 30, ["Tidal Hours", "Saltwater Hymns", "Lowlight"], 220),
  A("The Low Arcs", 22, ["Concrete Garden", "Signal Fires"], 20),
  A("Ostra", 20, ["Amber Signals", "Field Notes", "Northern Glass"], 55),
  A("Juniper & Gale", 16, ["Fieldwork", "Hedgerow"], 140, 0, [3, 4, 5]),
  A("Kaito Rhee", 15, ["Soft Neon", "Night Market"], 330),
  A("Halden", 14, ["Winter Index", "Frostline"], 250, 0, [10, 11, 0, 1]),
  A("Paloma Strand", 12, ["Glass Coast", "Weather Room"], 190),
  A("Ferro", 11, ["Iron Bloom", "Rust & Rain"], 35),
  A("Wren Okafor", 11, ["Harbour Lights", "Small Revolutions"], 280, 420),
  A("The Quiet Hours", 10, ["Late Trains", "Dawn Chorus"], 240),
  A("Severin", 9, ["Monochrome Summer"], 0, 0, [5, 6, 7]),
  A("Lumen Choir", 9, ["Cathedral Static", "Echo Valley"], 200),
  A("Astrid Kalm", 8, ["Paper Boats", "Northbound"], 160),
  A("Velvet Engines", 8, ["Overdrive Lullabies"], 300, 300),
  A("Cass Moreno", 8, ["Desert Radio", "Sunset Strip"], 30, 0, [6, 7]),
  A("Delta Fold", 7, ["Origami Bass"], 100),
  A("Iris & the Pines", 7, ["Woodsmoke", "Clearing"], 120, 0, [9, 10]),
  A("Noor Haddad", 7, ["Silk Road Sessions"], 45, 200),
  A("Big Sky Collective", 6, ["Open Country", "Prairie Static"], 210),
  A("Theo Lindqvist", 6, ["Minor Keys"], 230),
  A("Saffron Tapes", 6, ["Cassette Gardens"], 70, 520),
  A("Moth Parade", 6, ["Porch Light", "Night Moths"], 270),
  A("Elodie Brun", 5, ["Rue des Fleurs"], 350),
  A("Grey Meridian", 5, ["Longitude"], 215),
  A("Hollow Pines", 5, ["Cabin Fever"], 130, 0, [11, 0]),
  A("Ivo Marsh", 5, ["Tideline", "Brackish"], 180, 90),
  A("Kestrel", 5, ["High Wire"], 15),
  A("Lowland Choir", 4, ["Fen Songs"], 95),
  A("Mira Solano", 4, ["Calle Luna"], 340, 25),
  A("Neon Fathoms", 4, ["Deep Blue Hours"], 235, 160),
  A("Orla Finch", 4, ["Wildflower Year"], 110),
  A("Pale Harbour", 4, ["Fog Signals"], 205),
  A("Quill", 4, ["Ink & Static"], 260, 610),
  A("Rosa Varga", 3, ["Budapest Nights"], 10),
  A("Second Spring", 3, ["Thaw"], 150, 0, [2, 3]),
  A("Tamsin Wolde", 3, ["Moorland"], 85),
  A("Umber", 3, ["Earth Tones"], 40, 350),
  A("Vessel & Vine", 3, ["Harvest Moon"], 60, 0, [8, 9]),
  A("Yuki Arden", 3, ["Snow Country"], 225, 40),
  A("Zephyr Lane", 2, ["Tailwind"], 175, 12),
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const tone = (hue: number, l: number, c: number) => `oklch(${l} ${c} ${hue})`;

/** Each album's cover, registered with sample-days so artUrl draws it. */
function cover(a: Artist, album: string, i: number) {
  const id = `album-m-${slug(a.name)}-${slug(album)}`;
  const tone1 = tone((a.hue + i * 24) % 360, 0.34 + (i % 2) * 0.12, 0.08);
  addSampleArt({ id, title: album, by: a.name, tone: tone1, tone2: tone((a.hue + 160 + i * 30) % 360, 0.82, 0.1), w: 1, h: 1 });
  return { id, w: 600, h: 600, tone: tone1 };
}

// ---------- When ----------

/** Start hours a session tends to begin at, with weights: the commute and evenings on weekdays, a long afternoon at weekends. */
const WEEKDAY_STARTS: Array<[number, number]> = [[7, 5], [8, 6], [12, 2], [13, 1], [17, 4], [18, 3], [20, 6], [21, 5], [22, 2]];
const WEEKEND_STARTS: Array<[number, number]> = [[9, 1], [10, 2], [11, 2], [13, 4], [14, 5], [15, 4], [16, 2], [19, 2], [20, 3], [21, 3], [22, 1]];

/** A session's plays spread over the hour it starts in and the next one or two. */
function sessionHours(r: () => number, weekend: boolean, plays: number): number[] {
  const starts = weekend ? WEEKEND_STARTS : WEEKDAY_STARTS;
  const total = starts.reduce((s, [, w]) => s + w, 0);
  let pick = r() * total;
  const start = (starts.find(([, w]) => (pick -= w) <= 0) ?? starts[0])[0];
  const span = 1 + Math.floor(r() * 3);
  const hours = new Array<number>(24).fill(0);
  for (let p = 0; p < plays; p++) hours[(start + Math.floor((p / plays) * span)) % 24]++;
  return hours;
}

// ---------- The days ----------

const DAYS = 730;
let cache: { today: string; rows: MusicRow[] } | null = null;

function weightOn(a: Artist, date: string, ago: number): number {
  if (a.from > 0 && ago > a.from) return 0;
  let w = a.weight;
  const month = Number(date.slice(5, 7)) - 1;
  if (a.season) w *= a.season.includes(month) ? 3 : 0.4;
  // A new arrival gets played a lot at first.
  if (a.from > 0 && a.from - ago < 45) w *= 2.5;
  return w;
}

function rows(): MusicRow[] {
  const t = today();
  if (cache?.today === t) return cache.rows;
  const out: MusicRow[] = [];
  for (let ago = DAYS - 1; ago >= 0; ago--) {
    const date = addDays(t, -ago);
    const r = seeded(`music:${date}`);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    // Some quiet days; fewer of them at weekends.
    if (r() < (weekend ? 0.12 : 0.22)) continue;
    const pool = ARTISTS.map((a) => ({ a, w: weightOn(a, date, ago) })).filter((x) => x.w > 0);
    const total = pool.reduce((s, x) => s + x.w, 0);
    const sessions = 2 + Math.floor(r() * (weekend ? 5 : 3));
    const used = new Set<string>();
    for (let s = 0; s < sessions; s++) {
      let pick = r() * total;
      const hit = pool.find((x) => (pick -= x.w) <= 0) ?? pool[0];
      const a = hit.a;
      // Mostly the newest album, sometimes an older one.
      const i = r() < 0.6 ? a.albums.length - 1 : Math.floor(r() * a.albums.length);
      const album = a.albums[i];
      const key = `${a.name}\u0000${album}`;
      if (used.has(key)) continue;
      used.add(key);
      const plays = 6 + Math.floor(r() * (weekend ? 20 : 14));
      out.push({ date, artist: a.name, title: album, plays, art: cover(a, album, i), hours: sessionHours(r, weekend, plays) });
    }
  }
  cache = { today: t, rows: out };
  return out;
}

// ---------- Genres (as MusicBrainz would tag them, strongest first) ----------

/** Two are left out: still being looked up, so the page says so. */
const GENRES: Record<string, string[]> = {
  "Mara Vell": ["indie folk", "dream pop", "singer-songwriter"],
  "The Low Arcs": ["indie rock", "post-punk", "alternative rock"],
  Ostra: ["ambient", "electronic", "downtempo"],
  "Juniper & Gale": ["folk", "americana"],
  "Kaito Rhee": ["synthpop", "city pop", "electronic"],
  Halden: ["post-rock", "ambient"],
  "Paloma Strand": ["dream pop", "shoegaze"],
  Ferro: ["garage rock", "blues rock"],
  "Wren Okafor": ["neo soul", "r&b"],
  "The Quiet Hours": ["slowcore", "indie rock"],
  Severin: ["house", "deep house"],
  "Lumen Choir": ["contemporary classical", "choral"],
  "Astrid Kalm": ["indie pop", "folk"],
  "Velvet Engines": ["alternative rock", "psychedelic rock"],
  "Cass Moreno": ["country", "americana"],
  "Delta Fold": ["drum and bass", "electronic"],
  "Iris & the Pines": ["folk", "indie folk"],
  "Noor Haddad": ["world", "jazz fusion"],
  "Big Sky Collective": ["country", "bluegrass"],
  "Theo Lindqvist": ["modern classical", "piano", "ambient"],
  "Saffron Tapes": ["lo-fi", "hip hop", "jazz"],
  "Moth Parade": ["indie rock", "emo"],
  "Elodie Brun": ["chanson", "pop"],
  "Grey Meridian": ["techno", "electronic"],
  "Hollow Pines": ["folk", "indie folk"],
  "Ivo Marsh": ["jazz", "soul jazz"],
  Kestrel: ["punk", "post-punk"],
  "Lowland Choir": ["choral", "classical"],
  "Mira Solano": ["latin pop", "reggaeton"],
  "Neon Fathoms": ["synthwave", "electronic"],
  "Orla Finch": ["singer-songwriter", "folk pop"],
  "Pale Harbour": ["shoegaze", "dream pop"],
  "Rosa Varga": ["jazz", "vocal jazz"],
  "Second Spring": ["indie pop"],
  "Tamsin Wolde": ["folk"],
  Umber: ["hip hop", "boom bap"],
  "Vessel & Vine": ["folk", "country"],
  "Yuki Arden": ["ambient", "j-pop"],
};
const families = (artist: string) => (artist in GENRES ? musicFamilies(GENRES[artist]) : undefined);

export async function sampleMusic(period: string): Promise<MusicData> {
  return buildMusic(rows(), period, today(), { families });
}

export async function sampleArtist(name: string): Promise<ArtistDetail | null> {
  return artistDetail(rows(), name);
}

// ---------- Playlists ----------


const PLAYLISTS: Array<{ id: string; name: string; owner?: string; artists: string[]; n: number }> = [
  { id: "pl1sundaykitchen", name: "Sunday kitchen", artists: ["Juniper & Gale", "Orla Finch", "Astrid Kalm", "Iris & the Pines"], n: 42 },
  { id: "pl2deepwork", name: "Deep work", artists: ["Lumen Choir", "Theo Lindqvist", "Grey Meridian", "Halden"], n: 68 },
  { id: "pl3morningrun", name: "Evening run", artists: ["Velvet Engines", "Kestrel", "Ferro", "Kaito Rhee"], n: 35 },
  { id: "pl4roadtrip", name: "Road trip 2025", artists: ["Cass Moreno", "Big Sky Collective", "The Low Arcs", "Paloma Strand"], n: 57 },
  { id: "pl5latenight", name: "Late night drive", artists: ["Neon Fathoms", "Kaito Rhee", "Mara Vell", "Delta Fold"], n: 29 },
  { id: "pl9christmas", name: "Christmas at home", artists: ["Juniper & Gale", "Halden", "Orla Finch", "Lumen Choir"], n: 38 },
  { id: "pl6winter", name: "Winter, slowly", artists: ["Halden", "Hollow Pines", "Pale Harbour", "Yuki Arden"], n: 24 },
  { id: "pl7dinner", name: "Dinner with friends", owner: "Priya", artists: ["Elodie Brun", "Rosa Varga", "Mira Solano", "Noor Haddad"], n: 51 },
  { id: "pl8discover", name: "New finds", owner: "Sam", artists: ["Quill", "Saffron Tapes", "Umber", "Wren Okafor"], n: 30 },
];
const TRACK_FIRST = ["Low", "Glass", "North", "Small", "After", "Second", "Paper", "Under", "Slow", "Harbour", "Lantern", "Field"];
const TRACK_SECOND = ["Tide", "Hours", "Wind", "Rooms", "Light", "Coast", "Planes", "Song", "Return", "Lights", "Weather", "Lines"];

/** A playlist's track names: every one different, in a seeded order. */
function trackNames(r: () => number, n: number): string[] {
  const pool = TRACK_FIRST.flatMap((a) => TRACK_SECOND.map((b) => `${a} ${b.toLowerCase()}`.replace(/^(\w)/, (c) => c.toUpperCase())));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function samplePlaylistsAll(): StoredPlaylist[] {
  return PLAYLISTS.map((p) => {
    const r = seeded(p.id);
    const names = trackNames(r, Math.min(p.n, 100));
    const items = names.map((track) => {
      const artist = p.artists[Math.floor(r() ** 1.4 * p.artists.length)];
      return { track, artist, album: ARTISTS.find((a) => a.name === artist)?.albums[0] };
    });
    return { id: p.id, name: p.name, ...(p.owner ? { owner: p.owner } : {}), mine: !p.owner, tracks: p.n, link: "https://open.spotify.com/", ...(p.owner ? {} : { items, top_artists: topArtistsOf(items) }) };
  });
}

const sampleUpdated = () => `${addDays(today(), 0)}T06:12:00Z`;

export async function samplePlaylists(): Promise<PlaylistsView> {
  return playlistsView([{ source: "spotify", updated: sampleUpdated(), playlists: samplePlaylistsAll() }]);
}

export async function samplePlaylist(id: string) {
  const p = samplePlaylistsAll().find((x) => x.id === id);
  return p ? { ...p, source: "spotify", updated: sampleUpdated() } : null;
}
