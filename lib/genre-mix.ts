/**
 * Genres as a mix, for the radar charts on Watch & read and Music: what
 * share of what was played was each genre, this period and the one before.
 *
 * Films and shows carry TMDB's or Trakt's genres (lib/watch-meta.ts);
 * `filmGenres` makes the two agree ("Sci-Fi & Fantasy" is two genres,
 * "science-fiction" is "Science fiction"). Artists carry Spotify's or
 * MusicBrainz's genres (netlify/lib/music-genres.ts), which are fine
 * grained ("uk alternative hip hop"): `musicFamilies` folds them into a
 * dozen broad ones, so forty artists don't make forty spokes. The raw
 * genres are kept as stored, so the folding can change without asking again.
 *
 * A title or artist counts towards each of its genres (two at most for an
 * artist), so the shares are "of what was played, how much was X" and can
 * add up to more than all of it. Pure.
 */

export interface GenreCount {
  genre: string;
  plays: number;
}

/** A period's mix: each genre's plays, and how many plays had any genre at all. */
export interface GenreMix {
  genres: GenreCount[];
  /** Plays with a known genre: the shares are of these. */
  known: number;
}

export interface GenreRadar {
  axes: string[];
  /** Shares (0–1) of `known`, one per axis. */
  now: number[];
  /** The period before on the same axes, when it had any. */
  before: number[] | null;
}

/** Spokes on a radar: past eight it stops reading as a shape. */
export const RADAR_MOST = 8;
/** Fewer than this and a radar is a line or a triangle: say it in words instead. */
export const RADAR_LEAST = 3;

/** Count `plays` towards each genre, once each. */
export function addPlays(into: Map<string, number>, genres: readonly string[], plays: number): void {
  for (const g of new Set(genres)) into.set(g, (into.get(g) ?? 0) + plays);
}

/** A tally as a mix, most played first. */
export function mixOf(tally: Map<string, number>, known: number): GenreMix {
  return {
    genres: [...tally.entries()].map(([genre, plays]) => ({ genre, plays })).sort((a, b) => b.plays - a.plays || a.genre.localeCompare(b.genre)),
    known,
  };
}

/**
 * The radar for a period: its top genres as spokes (in the order they rank,
 * so the biggest is at the top), and the period before on those same
 * spokes. Null when there's too little to draw.
 */
export function genreRadar(now: GenreMix | null | undefined, before?: GenreMix | null, most = RADAR_MOST): GenreRadar | null {
  if (!now || now.known <= 0) return null;
  const top = now.genres.filter((g) => g.plays > 0).slice(0, most);
  if (top.length < RADAR_LEAST) return null;
  const share = (m: GenreMix, genre: string) => (m.known > 0 ? (m.genres.find((g) => g.genre === genre)?.plays ?? 0) / m.known : 0);
  const axes = top.map((g) => g.genre);
  return {
    axes,
    now: axes.map((a) => share(now, a)),
    before: before && before.known > 0 ? axes.map((a) => share(before, a)) : null,
  };
}

// ---------- Films and shows ----------

const FILM_NAMES: Record<string, string> = {
  "science fiction": "Science fiction",
  "sci fi": "Science fiction",
  scifi: "Science fiction",
  "tv movie": "TV film",
  kids: "Children",
  children: "Children",
  "superhero": "Superhero",
  "anime": "Anime",
};

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** One film genre, named the same whichever source said it. */
function filmName(raw: string): string | null {
  const key = raw
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!key) return null;
  return FILM_NAMES[key] ?? sentence(key);
}

/** TMDB's and Trakt's genres for a title, as one list: TV's paired genres ("Action & Adventure") split in two. */
export function filmGenres(genres: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const g of genres ?? []) {
    for (const part of g.split(/\s*&\s*/)) {
      const name = filmName(part === "Sci-Fi" ? "science fiction" : part);
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

// ---------- Music ----------

/**
 * The broad families, most particular first: "indie rock" is Indie before
 * it's Rock, "trip hop" is Electronic, "pop punk" is Punk, "dance pop" is Pop.
 */
const FAMILIES: Array<[string, RegExp]> = [
  ["Metal", /\bmetal|metalcore|grindcore|djent|doom\b/],
  ["Hip hop", /\bhip hop\b|\brap\b|\btrap\b|\bgrime\b|\bdrill\b|boom bap/],
  ["Jazz", /\bjazz|\bbebop|(?<!jack )\bswing\b|big band/],
  ["Classical", /\bclassical|orchestra|\bbaroque(?! pop)|\bopera\b|chamber music|chamber orchestra|symphon|\bcomposer|minimalism/],
  ["Soundtrack", /soundtrack|\bscore\b|video game|musical|show tunes/],
  ["Reggae", /reggae|\bdub\b|dancehall|\bska\b|rocksteady/],
  ["Soul & R&B", /\bsoul\b|\br ?(&|and|n) ?b\b|\bfunk|motown|disco|gospel|new jack/],
  ["Blues", /\bblues/],
  ["Folk & country", /\bfolk|country|americana|bluegrass|celtic/],
  ["Punk", /\bpunk|hardcore|\bemo\b|screamo/],
  ["Electronic", /electro|\bhouse\b|techno|trance|\bedm\b|dubstep|drum (and|&|n) bass|\bdnb\b|jungle|\bgarage\b(?! rock)|ambient|\bidm\b|breakbeat|downtempo|trip hop|chillwave|synthwave|\bbass music|footwork|\brave\b|hardstyle|club\b|future bass/],
  ["Indie", /\bindie|art pop|chamber pop|baroque pop|shoegaze|dream pop|lo fi|\blo-fi|bedroom pop|post punk|\bpost-punk|britpop|\bmath rock|slowcore|noise pop/],
  ["World", /latin|reggaeton|salsa|bachata|cumbia|samba|bossa|afro|highlife|\bk pop|\bk-pop|\bj pop|\bj-pop|bollywood|flamenco|world|\bfado\b|desi|amapiano/],
  ["Rock", /\brock|grunge|\bpsych|progressive|\bprog\b|garage rock|stoner/],
  ["Pop", /\bpop\b|\bpop$|^pop|synthpop|synth pop|boy band|girl group|\bteen\b|adult contemporary|\bdance\b/],
];

/** A raw genre's family, or null for one that says nothing about the sound ("seen live", "british"). */
export function musicFamily(raw: string): string | null {
  const g = ` ${raw.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim()} `;
  for (const [name, re] of FAMILIES) if (re.test(g)) return name;
  return null;
}

/**
 * An artist's families from their raw genres. Both sources list the
 * strongest first, so each genre weighs by its place (the first 1, the
 * second ½, the third ⅓…): a long tail of "country pop", "country" under a
 * leading "pop" doesn't outvote it. Two at most, so an artist tagged with
 * eight sub-genres doesn't count eight times.
 */
export function musicFamilies(genres: readonly string[] | undefined, most = 2): string[] {
  const tally = new Map<string, { w: number; first: number }>();
  (genres ?? []).forEach((g, i) => {
    const f = musicFamily(g);
    if (!f) return;
    const t = tally.get(f);
    if (t) t.w += 1 / (i + 1);
    else tally.set(f, { w: 1 / (i + 1), first: i });
  });
  return [...tally.entries()]
    .sort((a, b) => b[1].w - a[1].w || a[1].first - b[1].first)
    .slice(0, most)
    .map(([f]) => f);
}

/** How artist names are matched between plays and the genre store: case, accents, "The" and punctuation aside. */
export function artistKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}
