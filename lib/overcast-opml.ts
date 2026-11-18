/**
 * Overcast's "All data" export (overcast.fm/account → Export OPML, extended:
 * overcast-data.opml), turned into days of podcast episodes. Shared by the
 * app and the server (no Node or DOM imports; Intl for the owner's day).
 *
 * Shows are `<outline type="rss" title=…>`; their episodes sit inside as
 * `<outline type="podcast-episode" title=… played="1" progress="1234"
 * userUpdatedDate="2024-03-14T21:40:37-04:00" overcastUrl=… enclosureUrl=…>`.
 * An episode counts when it's played, or has progress (seconds in). It goes
 * on the day of `userUpdatedDate` in the owner's time zone, which is when
 * Overcast last saw it change: for a finished episode, close to when it was
 * finished. Minutes come from progress when there is some. The file has no
 * durations, so a finished episode has none.
 */
import { ImportFileError } from "./loop-csv";

export interface Episode {
  show: string;
  title: string;
  /** Overcast's id, else the audio file's address: stable across exports. */
  id: string;
  /** overcast.fm/+…, else the episode's page. */
  url?: string;
  minutes?: number;
  /** Has progress but isn't marked played. */
  partial?: boolean;
}

export interface PodcastDay {
  day: string;
  episodes: Episode[];
}

export interface PodcastParse {
  days: PodcastDay[];
  episodes: number;
  shows: string[];
  minutes: number;
  skipped: { undated: number; future: number };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()],
  );
const clean = (s: string, max: number) => unescape(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, max);

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = m[3] ?? m[4] ?? "";
  return out;
}

/** The calendar day of an instant in a time zone (the owner's); the instant's own date without one. */
export function dayIn(iso: string, tz?: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  if (!tz) return /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  } catch {
    return /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? null;
  }
}

const https = (u: string | undefined) => (u && /^https?:\/\//i.test(u) && u.length <= 2000 ? unescape(u) : undefined);

export function parseOvercast(text: string, opts: { tz?: string; today?: string } = {}): PodcastParse {
  if (!/<opml[\s>]/i.test(text)) throw new ImportFileError("unreadable");
  const shows: string[] = [];
  const by = new Map<string, Map<string, Episode>>();
  const skipped = { undated: 0, future: 0 };
  let sawEpisode = false;
  // A stack of open outlines: the show is the nearest rss one.
  const stack: Array<string | null> = [];
  for (const m of text.matchAll(/<outline\b([^>]*?)(\/?)>|<\/outline\s*>/gi)) {
    if (m[0][1] === "/") {
      stack.pop();
      continue;
    }
    const a = attrs(m[1]);
    const self = m[2] === "/";
    const type = (a.type ?? "").toLowerCase();
    if (type === "rss") {
      const show = clean(a.title || a.text || "", 200) || "A podcast";
      if (!self) stack.push(show);
      continue;
    }
    if (type === "podcast-episode") {
      sawEpisode = true;
      const show = [...stack].reverse().find((s): s is string => !!s) ?? "A podcast";
      const progress = Number(a.progress ?? "");
      const played = a.played === "1";
      const has = Number.isFinite(progress) && progress > 0;
      if (played || has) {
        const day = a.userUpdatedDate ? dayIn(a.userUpdatedDate, opts.tz) : null;
        if (!day) skipped.undated++;
        else if (opts.today && day > opts.today) skipped.future++;
        else {
          const id = (a.overcastId && /^[\w-]{1,40}$/.test(a.overcastId) ? a.overcastId : "") || https(a.enclosureUrl) || https(a.url) || `${show}|${a.title ?? ""}`;
          const ep: Episode = {
            show,
            title: clean(a.title || "", 300) || "An episode",
            id: id.slice(0, 280),
            ...(https(a.overcastUrl) || https(a.url) ? { url: https(a.overcastUrl) ?? https(a.url) } : {}),
            ...(has ? { minutes: Math.max(1, Math.round(progress / 60)) } : {}),
            ...(has && !played ? { partial: true } : {}),
          };
          const d = by.get(day) ?? by.set(day, new Map()).get(day)!;
          d.set(ep.id, ep);
          if (!shows.includes(show)) shows.push(show);
        }
      }
      if (!self) stack.push(null);
      continue;
    }
    if (!self) stack.push(null);
  }
  if (!sawEpisode) throw new ImportFileError(/type\s*=\s*["']rss["']/i.test(text) ? "empty" : "unreadable");
  const days = [...by.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([day, m]) => ({ day, episodes: [...m.values()] }));
  const episodes = days.reduce((n, d) => n + d.episodes.length, 0);
  const minutes = days.reduce((n, d) => n + d.episodes.reduce((k, e) => k + (e.minutes ?? 0), 0), 0);
  return { days, episodes, shows: shows.sort((x, y) => x.localeCompare(y)), minutes, skipped };
}
