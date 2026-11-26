/**
 * Covers for what an answer cites: a film's poster, a show's, a video's
 * thumbnail, a book's cover, a game's header, an album's or a track's
 * sleeve, and a Watch & read title's own. The app shows such a source as a
 * card (app/src/components/ask-answer.ts).
 *
 * Only sources a tool really returned get here (answer.ts drops the rest),
 * and nothing is fetched from the source's own address. The art comes the
 * way Days' and Watch & read's does (lib/art.ts, docs: security/outside-services): from the
 * id in a Spotify, YouTube, Letterboxd or Steam link, or by title from TMDB
 * and Open Library, off the fixed list of hosts, kept sealed and served by
 * GET /api/art/:id. An artist gets none: that would be a person's photo.
 *
 * Within a second and a half; a cover not found in time is fetched after
 * the reply and is there the next time the same thing is cited.
 */
import { attachArt, letterboxdFilm, readingArt, spotifyPath, type ArtHint, type ArtRef } from "./art";
import type { AnswerSource } from "./answer-text";
import { q } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { kindWords, NEUTRAL_STATUS, progressWords, type ReadingProgress, type ReadingStatus } from "./watch-read";
import { youtubeId } from "./watch-meta";

const BUDGET_MS = 1_500;

/** "Severance · S2E3" or "Severance: Season 2" as the show's own name, for the poster lookup. */
const showName = (title: string) =>
  title
    .replace(/\s*[·:,–-]\s*(S\d+\s*·?\s*E\d+|season\s+\d+|episode\s+\d+).*$/i, "")
    .replace(/\s+S\d+\s*·?\s*E\d+.*$/i, "")
    .trim();

/** Where a cited source's cover might come from, best first. Empty: it has none to look for. */
export function sourceHints(s: Pick<AnswerSource, "kind" | "url" | "title">): ArtHint[] {
  const url = s.url ?? "";
  const title = s.title.trim();
  const hints: ArtHint[] = [];
  switch (s.kind) {
    case "video": {
      const id = youtubeId(url);
      if (id) hints.push({ youtube: id });
      break;
    }
    case "track":
    case "album":
      if (spotifyPath(url)) hints.push({ spotify: url });
      break;
    case "film":
      if (letterboxdFilm(url)) hints.push({ letterboxd: url });
      if (title) hints.push({ film: { title } });
      break;
    case "show":
    case "episode":
      if (showName(title)) hints.push({ show: { title: showName(title) } });
      break;
    case "book":
      if (title) hints.push({ book: { title } });
      break;
    case "game": {
      const steam = Number(/store\.steampowered\.com\/app\/(\d+)/.exec(url)?.[1]);
      if (Number.isInteger(steam) && steam > 0) hints.push({ steam });
      break;
    }
    // An artist is a person; everything else isn't a thing with a cover.
    default:
      break;
  }
  return hints;
}

interface WatchRow {
  id: string;
  title: string;
  kind: string;
  author: string;
  url: string;
  source: string | null;
  status: ReadingStatus;
  progress: ReadingProgress | null;
}

/** "Film · To watch", "Book · Page 84 of 136": a Watch & read title's kind and where it's up to. */
export function watchDetail(r: Pick<WatchRow, "kind" | "status" | "progress">): string {
  const words = kindWords(r.kind);
  const status = (words.status ?? NEUTRAL_STATUS)[r.status] ?? NEUTRAL_STATUS[r.status];
  return [words.label, r.status === "reading" && r.progress ? progressWords(r.progress) : status].join(" · ");
}

/** The sources with covers (and a Watch & read title's detail) added where there are any. Never throws. */
export async function sourceCovers(sources: AnswerSource[], opts: { budgetMs?: number } = {}): Promise<AnswerSource[]> {
  try {
    const out = [...sources];
    const budgetMs = opts.budgetMs ?? BUDGET_MS;

    // Watch & read titles: their own cover and state, by id.
    const watch = out.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "watch" && x.s.id);
    if (watch.length) {
      const rows = await q<WatchRow>(
        `SELECT id, title, kind, author, url, source, status,
                CASE WHEN progress_unit IS NULL THEN NULL ELSE json_build_object('unit', progress_unit, 'done', progress_done, 'total', progress_total) END AS progress
         FROM reading_items WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [watch.map((x) => x.s.id)],
      );
      const readable = rows.filter((r) => !isEncryptedPlaceholder(r.title));
      const withArt = await readingArt(readable as Array<WatchRow & { art?: ArtRef }>, { budgetMs });
      for (const { s, i } of watch) {
        const row = withArt.find((r) => r.id === s.id);
        if (row) out[i] = { ...s, detail: watchDetail(row), ...(row.art ? { art: row.art } : {}) };
      }
    }

    // Everything else that has a cover to look for.
    const media = out.map((s, i) => ({ i, entry: { id: String(i), art: undefined as ArtRef | undefined }, hints: s.kind === "watch" ? [] : sourceHints(s) })).filter((x) => x.hints.length);
    if (media.length) {
      const done = await attachArt(media, { budgetMs });
      media.forEach((x, k) => {
        if (done[k].art) out[x.i] = { ...out[x.i], art: done[k].art };
      });
    }
    return out;
  } catch (error) {
    console.error("Athena answer: covers failed", (error as Error)?.message);
    return sources;
  }
}
