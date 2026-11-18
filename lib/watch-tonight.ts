/**
 * Something to watch tonight: on an evening with nothing on the calendar
 * after 19:00, one to three picks from the owner's own lists (Watch & read's
 * films and shows still to watch or part-way through, Trakt's watchlist among
 * them), ranked against their taste (lib/taste.ts, and what they told About
 * you). No web search and no titles from anywhere else: every pick is an
 * item already on their list, and each one's "why" names the taste it
 * matches ("You rate slow-burn sci-fi highly").
 *
 * The ranking is pure (rankTonight); loadTonight reads the list and the
 * taste. Used by the watch_tonight nudge (lib/proactive/rules.ts, off by
 * default) and Ask's "Something to watch tonight" chip (GET /api/watch-tonight).
 */
import { upcomingOccurrences, zonedParts, zonedToday, zonedToInstant } from "./dates";
import { isEncryptedPlaceholder } from "./encrypted";

/** One film or show on the owner's list. */
export interface WatchCandidate {
  id: string;
  title: string;
  kind: "film" | "tv";
  /** Director (a film's "by"). */
  maker: string;
  /** queued: still to watch; reading: part-way through (a show). */
  status: "queued" | "reading";
  notes: string;
  /** Who recommended it, by name. */
  recommended_by: string | null;
  /** Where it came from: "trakt" for the Trakt watchlist. */
  source: string | null;
  /** How far through: "Episode 4 of 8". */
  progress?: string | null;
  added_at: string;
}

/** What the owner's taste says, from ratings and their own words. */
export interface TasteSignals {
  /** Finished films and shows with stars (out of 5). */
  rated: Array<{ title: string; by?: string; stars: number; kind: "film" | "tv" }>;
  /** Genres learned from their ratings ("Film genres", "TV genres"): "slow-burn sci-fi". */
  genres: string[];
  /** What they said they like ("Films I like", "TV I like"). */
  likes: string[];
  /** "Don't like": never picked. */
  dislikes: string[];
}

export interface WatchPick {
  id: string;
  title: string;
  kind: "film" | "tv";
  /** The taste it matches, as one sentence. */
  why: string;
  /** "Trakt watchlist" or "Watch & read". */
  from: string;
  score: number;
}

export const EVENING_FROM = "19:00";
export const MAX_PICKS = 3;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["the", "and", "a", "an", "of", "films", "film", "shows", "show", "tv", "movies", "movie", "anything", "with", "that", "good"]);
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** A phrase matches when all its words (stems, loosely) are in the text: "slow-burn sci-fi" in "a slow burn, very sci fi". */
export function phraseIn(phrase: string, text: string): boolean {
  const want = words(phrase);
  if (!want.length) return false;
  const have = new Set(words(text));
  const hay = norm(text);
  return want.every((w) => have.has(w) || have.has(w.replace(/s$/, "")) || hay.includes(w));
}

const stars = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} star${n === 1 ? "" : "s"}`;

/**
 * Rank the owner's own films and shows for tonight. Only items given are
 * ever returned; anything matching a dislike is left out. Each pick's why is
 * its strongest reason: a show part-way through, a taste it matches, the
 * maker of something they rated highly, who recommended it, then how long
 * it has waited.
 */
export function rankTonight(candidates: WatchCandidate[], taste: TasteSignals, opts: { limit?: number; now?: Date } = {}): WatchPick[] {
  const limit = Math.min(Math.max(opts.limit ?? MAX_PICKS, 1), MAX_PICKS);
  const now = (opts.now ?? new Date()).getTime();
  const avg = (k: "film" | "tv") => {
    const r = taste.rated.filter((x) => x.kind === k);
    return r.length >= 3 ? r.reduce((s, x) => s + x.stars, 0) / r.length : null;
  };
  const filmAvg = avg("film");
  const tvAvg = avg("tv");
  const prefers: "film" | "tv" | null = filmAvg !== null && tvAvg !== null && Math.abs(filmAvg - tvAvg) >= 0.5 ? (filmAvg > tvAvg ? "film" : "tv") : null;

  const picks: WatchPick[] = [];
  for (const c of candidates) {
    if (!c.title.trim() || isEncryptedPlaceholder(c.title)) continue;
    const text = `${c.title} ${c.notes} ${c.maker}`;
    if (taste.dislikes.some((d) => phraseIn(d, text))) continue;
    const reasons: Array<{ score: number; why: string }> = [];
    if (c.status === "reading") reasons.push({ score: 3, why: c.progress ? `You're part-way through: ${c.progress.charAt(0).toLowerCase()}${c.progress.slice(1)}.` : "You're part-way through it." });
    const genre = taste.genres.find((g) => phraseIn(g, text));
    if (genre) reasons.push({ score: 2.5, why: `You rate ${genre} highly.` });
    const liked = taste.likes.find((l) => phraseIn(l, text) && norm(l) !== norm(c.title));
    if (liked) reasons.push({ score: 2, why: `You said you like ${liked}.` });
    if (c.maker.trim()) {
      const same = taste.rated.filter((r) => r.by && norm(r.by) === norm(c.maker) && norm(r.title) !== norm(c.title) && r.stars >= 4).sort((a, b) => b.stars - a.stars)[0];
      if (same) reasons.push({ score: 1.5 + (same.stars - 4), why: `You gave ${same.title} ${stars(same.stars)}, and this is also ${c.maker}'s.` });
    }
    if (c.recommended_by?.trim()) reasons.push({ score: 1.2, why: `${c.recommended_by.trim()} recommended it.` });
    if (prefers === c.kind) reasons.push({ score: 0.6, why: c.kind === "tv" ? "You rate shows higher than films." : "You rate films higher than shows." });
    // How long it has waited breaks ties: older first, up to half a point over a year.
    const waited = Math.max(0, now - Date.parse(c.added_at)) / (365 * 86_400_000);
    const tie = Math.min(waited, 1) * 0.5;
    const best = reasons.sort((a, b) => b.score - a.score)[0];
    const since = new Date(c.added_at);
    const why = best?.why ?? `On your list since ${since.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}.`;
    picks.push({ id: c.id, title: c.title, kind: c.kind, why, from: c.source === "trakt" ? "Trakt watchlist" : "Watch & read", score: reasons.reduce((s, r) => s + r.score, 0) + tie });
  }
  return picks.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

/** The evening is free: no timed event today overlaps from 19:00 to midnight. All-day events don't count. */
export function eveningFree(events: Array<{ starts_at: string; ends_at: string | null }>, today: string, tz: string, from = EVENING_FROM): boolean {
  const start = zonedToInstant(today, from, tz).getTime();
  const end = start + (24 * 60 - (Number(from.slice(0, 2)) * 60 + Number(from.slice(3, 5)))) * 60_000;
  return !events.some((e) => {
    if (zonedParts(new Date(e.starts_at), tz).date !== today && Date.parse(e.starts_at) > end) return false;
    const s = Date.parse(e.starts_at);
    const f = e.ends_at ? Date.parse(e.ends_at) : s + 3_600_000;
    return s < end && f > start;
  });
}

// ---------- reading the list and the taste ----------

/** The owner's films and shows still to watch, and their taste, for rankTonight. */
export async function loadTonight(): Promise<{ candidates: WatchCandidate[]; taste: TasteSignals }> {
  const [{ listReading }, { tasteProfile }, { listFacts }, { progressWords }] = await Promise.all([import("./memory"), import("./taste"), import("./memory"), import("./watch-read")]);
  const [items, profile, facts] = await Promise.all([listReading({ limit: 2000 }), tasteProfile().catch(() => null), listFacts({ subjectKind: "me" }).catch(() => [])]);
  const candidates: WatchCandidate[] = items
    .filter((i) => (i.kind === "film" || i.kind === "tv") && (i.status === "queued" || i.status === "reading") && !i.archived_at && !isEncryptedPlaceholder(i.title))
    .map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind as "film" | "tv",
      maker: i.kind === "film" ? i.author : "",
      status: i.status as "queued" | "reading",
      notes: isEncryptedPlaceholder(i.notes) ? "" : i.notes,
      recommended_by: i.recommender?.name ?? (i.recommended_by && !isEncryptedPlaceholder(i.recommended_by) ? i.recommended_by : null),
      source: i.source,
      progress: i.progress ? progressWords(i.progress) : null,
      added_at: i.created_at,
    }));
  const current = facts.filter((f) => !f.superseded_at && !f.archived_at && !isEncryptedPlaceholder(f.value));
  const list = (...keys: string[]) => current.filter((f) => keys.includes(f.key.trim().toLowerCase())).flatMap((f) => listValues(f.value));
  const rated: TasteSignals["rated"] = [
    ...(profile?.films?.rated ?? []).map((r) => ({ title: r.title, by: r.by, stars: r.stars ?? 0, kind: "film" as const })),
    ...(profile?.tv?.rated ?? []).map((r) => ({ title: r.title, by: r.by, stars: r.stars ?? 0, kind: "tv" as const })),
  ].filter((r) => r.stars > 0);
  return {
    candidates,
    taste: { rated, genres: list("film genres", "tv genres"), likes: list("films i like", "tv i like"), dislikes: list("don't like", "dont like") },
  };
}

/**
 * Tonight's picks as the card shows them: whether the evening is clear, and up to three from the owner's own
 * list. One function for the chip (GET /api/watch-tonight) and Ask's watch_tonight tool, so both give the same card.
 */
export async function tonightCard(now: Date, tz: string): Promise<{ free: boolean; picks: WatchPick[] }> {
  const { listEvents, notDeclined } = await import("./db");
  const today = zonedToday(now, tz);
  const events = (await listEvents()).filter(notDeclined);
  const occ = upcomingOccurrences(events.filter((e) => e.kind !== "birthday" && e.kind !== "anniversary"), today, 1, tz).filter((x) => x.starts_at);
  const free = eveningFree(occ.map((x) => ({ starts_at: x.starts_at!, ends_at: null })), today, tz);
  const { candidates, taste } = await loadTonight();
  return { free, picks: rankTonight(candidates, taste, { now }) };
}

/** A list fact's items: a JSON list, or lines and commas. */
export function listValues(value: string): string[] {
  try {
    const v = JSON.parse(value);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  } catch {
    // plain text
  }
  return value.split(/\n|,|;/).map((x) => x.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
}
