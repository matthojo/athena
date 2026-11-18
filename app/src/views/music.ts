/**
 * Music (#/music), in the Library's Notes and collections after Watch &
 * read: what the owner played, from Days' listened entries
 * (GET /api/life/music, lib/music-data.ts; the rules are lib/music.ts).
 *
 * One period at a time (This month, This year, earlier years, All time),
 * kept per device. In order: the plays with a chip against the same span
 * before and one line of words; the timeline (weeks for a month, months
 * for a year) with its takeaway; top artists as ranked bars; top albums as
 * a cover grid; artists new this period; the last days with music, each
 * linking to its Day. Tapping an artist opens a sheet: plays over time,
 * top albums, first and last played, and Ask about them.
 *
 * Charts are house-charts' barChart (charts.css mark spec, tooltip, hidden
 * table); the headline and card are House's (house.css). Nothing new is
 * sent anywhere.
 */

import "../styles/life.css";
import "../styles/house.css";
import "../styles/music.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { pageHead } from "../components/page-head";
import { barChart, heatmap, radarChart } from "../components/house-charts";
import { genreRadar } from "../../../lib/genre-mix";
import { artTile, initialsOf } from "../components/day-art";
import { openSheet } from "../components/sheet";
import { openAsk } from "../lib/open-ask";
import { dayHref } from "../lib/day-link";
import { inkFor, INK, madeFill } from "../lib/cover-ink";
import { loadArtist, loadMusic, loadPlaylist, loadPlaylists, type PlaylistDetail, type PlaylistsView, type PlaylistSummary, type ArtistDetail, type MusicAlbum, type MusicArtist, type MusicData, type MusicDay, type MusicPoint } from "../db/music";
import { bucketLabel, monthWord, WEEKDAY_NAMES } from "../../../lib/music";
import type { ViewId } from "../components/nav";
import { loadReading, onMemoryChange } from "../db/memory";
import { listenCard, openReadingSheet } from "./reading";
import type { ReadingItem } from "../types";
import { isMusic, isMusicVideo, seasonFit, seasonOn, type Season } from "../../../lib/watch-meta";
import { showToast } from "../components/toast";

const PERIOD_KEY = "athena.music.period";
const read = () => {
  try {
    return localStorage.getItem(PERIOD_KEY);
  } catch {
    return null;
  }
};
const keep = (v: string) => {
  try {
    localStorage.setItem(PERIOD_KEY, v);
  } catch {
    // Private mode: kept until the page reloads.
  }
};

const num = (n: number) => n.toLocaleString("en-GB");
const plays = (n: number) => `${num(n)} ${n === 1 ? "play" : "plays"}`;
const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const dayMonth = (d: string, year = false) => noon(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const weekdayShort = (d: string) => noon(d).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Mon 9 Nov", or "Today" / "Yesterday". */
function when(date: string, today: string): string {
  const diff = Math.round((noon(today).getTime() - noon(date).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${weekdayShort(date)} ${dayMonth(date, date.slice(0, 4) !== today.slice(0, 4))}`;
}

const ico = (make: () => SVGSVGElement, cls = "mu-ico") => {
  const s = make();
  s.classList.add(...cls.split(" "));
  s.setAttribute("aria-hidden", "true");
  return s;
};

function cover(art: MusicArtist["art"], title: string, cls: string, height?: number): HTMLElement {
  return artTile(art, { frame: [1, 1], initials: initialsOf(title), className: cls, ...(height ? { height } : {}) });
}

// ---------- The headline ----------

function eyebrow(m: MusicData): string {
  const p = m.period;
  if (p.kind === "month") return `${monthWord(m.today)} so far`;
  if (p.kind === "year") return `${p.label} so far`;
  if (p.kind === "past") return `In ${p.label}`;
  const firstMonth = m.timeline.points.find((x) => x.plays > 0)?.from;
  return firstMonth ? `Since ${m.timeline.unit === "year" ? firstMonth.slice(0, 4) : `${monthWord(firstMonth)} ${firstMonth.slice(0, 4)}`}` : "All time";
}

/** "↑ 18% on October": a rise or fall in plays, neither good nor bad. */
function changeChip(m: MusicData): HTMLElement | null {
  const prev = m.previous;
  if (!prev || prev.change === null) return null;
  const pct = Math.round(Math.abs(prev.change) * 100);
  const same = pct < 3;
  const up = prev.change > 0;
  const words = same ? `About the same as ${prev.label}` : `${pct}% ${up ? "more" : "fewer"} than ${prev.label}`;
  return h("span", { class: `mu-chip${same ? " is-same" : ""}`, "aria-label": words, title: words }, h("span", { "aria-hidden": "true" }, same ? "≈" : up ? "↑" : "↓"), h("span", { "aria-hidden": "true" }, same ? `${prev.label}` : `${pct}% on ${prev.label}`));
}

function heroLine(m: MusicData): string {
  if (!m.plays) {
    if (m.period.kind === "month") return "Nothing played this month yet.";
    if (m.period.kind === "year") return "Nothing played this year yet.";
    return `Nothing played in ${m.period.label}.`;
  }
  const top = m.top_artists[0];
  const span = `${num(m.artists)} ${m.artists === 1 ? "artist" : "artists"} across ${num(m.days)} ${m.days === 1 ? "day" : "days"}`;
  const parts = [top && m.artists > 1 ? `${span}, ${top.name} most of all.` : `${span}.`];
  if (m.new_count) parts.push(`${m.new_count === 1 ? "One was" : `${num(m.new_count)} were`} new to you.`);
  return parts.join(" ");
}

function hero(m: MusicData): HTMLElement {
  return h(
    "section",
    { class: "mu-hero", "aria-label": "Plays" },
    h(
      "div",
      { class: "tc-headline" },
      h("p", { class: "tc-headline__eyebrow" }, eyebrow(m)),
      h("p", { class: "tc-headline__row" }, h("span", { class: "tc-headline__big" }, num(m.plays)), h("span", { class: "tc-headline__unit" }, m.plays === 1 ? "play" : "plays"), changeChip(m))
    ),
    h("p", { class: "mu-hero__line" }, heroLine(m)),
    m.capped ? h("p", { class: "mu-hero__note" }, "Your earliest listening isn't counted: there's more history than this page reads at once.") : null
  );
}

// ---------- The timeline ----------

const UNIT_TITLE = { day: "Plays each day", week: "Plays each week", month: "Plays each month", year: "Plays each year" } as const;

function timelineChart(unit: "day" | "week" | "month" | "year", points: MusicPoint[], label: string, running: boolean, height = 156): HTMLElement {
  // Up to twelve labels; past that one every few, counted from the start so the last never crowds the edge.
  // Past a year of months: ticks at quarter starts (half years past two years), the year only on the first and in January.
  const long = unit === "month" && points.length > 12;
  const step = points.length > 24 ? 6 : 3;
  let firstTick = true;
  const tickFor = (from: string): string | undefined => {
    // A month of days: the 1st, 8th, 15th, 22nd and 29th.
    if (unit === "day") return (Number(from.slice(8, 10)) - 1) % 7 === 0 ? bucketLabel("day", from) : undefined;
    if (!long) return bucketLabel(unit, from);
    const month = Number(from.slice(5, 7));
    if ((month - 1) % step !== 0) return undefined;
    const withYear = firstTick || month === 1;
    firstTick = false;
    return withYear ? `${bucketLabel("month", from)} ${from.slice(0, 4)}` : bucketLabel("month", from);
  };
  // The latest stretch that has happened; the days after it are empty slots.
  const now = points.reduce((last, p, i) => (p.ahead ? last : i), 0);
  return barChart({
    label,
    series: [{ name: "Plays", cls: "is-electric" }],
    points: points.map((p, i) => ({
      label: unit === "week" ? `Week of ${bucketLabel("week", p.from)}` : bucketLabel(unit, p.from, true).replace(/^./, (c) => c.toUpperCase()),
      tick: tickFor(p.from),
      values: [p.ahead ? null : p.plays],
      // The stretch still running is drawn fainter: it isn't finished.
      faint: running && i === now,
    })),
    format: (v) => plays(v),
    note: running ? (i) => (i === now ? "So far" : i > now ? "Still to come" : "") : undefined,
    height,
  });
}

function timelineCard(m: MusicData): HTMLElement | null {
  const t = m.timeline;
  if (!m.plays || t.points.length < 2) return null;
  const running = m.period.kind !== "past";
  const chart = timelineChart(t.unit, t.points, `${UNIT_TITLE[t.unit]}, ${m.period.label}`, running);
  return h("section", { class: "house-card mu-card mu-timeline" }, h("h2", { class: "house-card__title" }, UNIT_TITLE[t.unit]), t.takeaway ? h("p", { class: "house-card__take" }, t.takeaway) : null, chart);
}

// ---------- When you listen ----------

function whenCard(m: MusicData): HTMLElement | null {
  if (!m.plays) return null;
  const w = m.when;
  const head = h("h2", { class: "house-card__title" }, "When you listen");
  if (!w.timed)
    return h("section", { class: "house-card mu-card mu-when" }, head, h("p", { class: "house-card__take" }, "Times show once your history is loaded again. Open the music account in Sources and choose Load history again."));
  const part = w.timed < m.plays * 0.9 ? h("p", { class: "house-card__aside" }, `From the ${num(w.timed)} of ${num(m.plays)} plays that have a time.`) : null;
  const map = heatmap({ label: `Plays by day of the week and hour, ${m.period.label}`, rows: WEEKDAY_NAMES, cells: w.cells, max: w.max, format: (v) => plays(v), slots: 24 });
  return h("section", { class: "house-card mu-card mu-when" }, head, w.takeaway ? h("p", { class: "house-card__take" }, w.takeaway) : null, map, part);
}

// ---------- Top artists ----------

// ---------- Genres ----------

/** The genre mix as a radar against the same span before, from the artists' genres (Spotify's or MusicBrainz's). */
function genresCard(m: MusicData): HTMLElement | null {
  const g = m.genres;
  if (!g || !m.plays) return null;
  const head = h("h2", { class: "house-card__title" }, "Genres");
  const shape = genreRadar(g.now, g.before);
  const learning = g.learning ? `Still finding genres for ${num(g.learning)} ${g.learning === 1 ? "artist" : "artists"}.` : "";
  if (!shape) {
    // Nothing to draw yet: say why, if there's a reason.
    if (!learning) return null;
    return h("section", { class: "house-card mu-card mu-genres" }, head, h("p", { class: "house-card__take" }, `${learning} They're looked up a few at a time, so check back shortly.`));
  }
  const nowName = m.period.kind === "month" ? monthWord(m.today) : m.period.label;
  const beforeName = m.period.kind === "year" ? "Last year" : (m.previous?.label ?? "Before");
  // The takeaway: the top two, then whichever moved most against before (when it moved enough to notice).
  const top = shape.axes.slice(0, 2);
  const words = [`Mostly ${andList(top)}.`];
  if (shape.before) {
    const moves = shape.axes.map((a, i) => ({ a, d: shape.now[i] - shape.before![i] })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const big = moves[0];
    if (big && Math.abs(big.d) >= 0.08) words.push(`${big.d > 0 ? "More" : "Less"} ${big.a} than ${m.period.kind === "year" ? "this point last year" : (m.previous?.label ?? "before")}.`);
  }
  const chart = radarChart({
    label: `Genres of the plays in ${nowName}${shape.before ? `, against ${beforeName}` : ""}`,
    axes: shape.axes,
    series: [{ name: nowName, values: shape.now }, ...(shape.before ? [{ name: beforeName, values: shape.before }] : [])],
    format: (v) => `${Math.round(v * 100)}% of plays`,
    height: 260,
  });
  const note = [g.covered < 0.995 ? `From the ${Math.round(g.covered * 100)}% of plays whose artist's genre is known.` : "", "An artist can count towards two genres.", learning].filter(Boolean).join(" ");
  return h("section", { class: "house-card mu-card mu-genres" }, head, h("p", { class: "house-card__take" }, words.join(" ")), chart, h("p", { class: "mu-genres__note" }, note));
}

function artistsCard(m: MusicData, open: (name: string) => void): HTMLElement | null {
  if (!m.top_artists.length) return null;
  const max = m.top_artists[0].plays || 1;
  return h(
    "section",
    { class: "house-card mu-card mu-card--artists", "aria-labelledby": "mu-artists" },
    h("h2", { class: "house-card__title", id: "mu-artists" }, "Top artists"),
    h(
      "ol",
      { class: "mu-ranks", role: "list" },
      ...m.top_artists.map((a, i) => {
        const b = h(
          "button",
          { class: "mu-rank", type: "button", "aria-label": `${i + 1}. ${a.name}, ${plays(a.plays)}` },
          h("span", { class: "mu-rank__n", "aria-hidden": "true" }, String(i + 1)),
          cover(a.art, a.name, "mu-rank__art"),
          h(
            "span",
            { class: "mu-rank__body", "aria-hidden": "true" },
            h("span", { class: "mu-rank__top" }, h("span", { class: "mu-rank__name" }, a.name), h("span", { class: "mu-rank__plays" }, num(a.plays))),
            h("span", { class: "mu-rank__track" }, h("span", { class: "mu-rank__fill", style: `width:${Math.max(2, (a.plays / max) * 100).toFixed(1)}%` }))
          )
        );
        b.addEventListener("click", () => open(a.name));
        return h("li", {}, b);
      })
    )
  );
}

// ---------- A list that starts short ----------

/** The first `n` items, and a button for the rest; the page stays short until it's asked for more. */
function shortList(list: HTMLElement, items: HTMLElement[], n: number, more: string): HTMLElement[] {
  list.append(...items.slice(0, n));
  if (items.length <= n) return [list];
  const b = h("button", { class: "btn btn--ghost btn--sm mu-more", type: "button" }, more, icons.chevronDown());
  b.addEventListener("click", () => {
    const first = items[n];
    list.append(...items.slice(n));
    b.remove();
    // Focus lands on the first new item, so a keyboard user carries on from there.
    first.querySelector<HTMLElement>("button, a, [tabindex]")?.focus({ preventScroll: true });
  });
  return [list, b];
}

const SHORT_ALBUMS = 6;
const SHORT_DAYS = 7;

// ---------- Top albums ----------

function albumTile(a: MusicAlbum, open: (name: string) => void): HTMLElement {
  const b = h("button", { class: "mu-album", type: "button", "aria-label": `${a.title} by ${a.artist}, ${plays(a.plays)}` }, cover(a.art, a.title, "mu-album__art"), h("span", { class: "mu-album__title", "aria-hidden": "true" }, a.title), h("span", { class: "mu-album__sub", "aria-hidden": "true" }, a.artist), h("span", { class: "mu-album__plays", "aria-hidden": "true" }, plays(a.plays)));
  b.addEventListener("click", () => open(a.artist));
  return h("li", {}, b);
}

function albumsCard(m: MusicData, open: (name: string) => void): HTMLElement | null {
  if (!m.top_albums.length) return null;
  const list = h("ul", { class: "mu-albums", role: "list" });
  return h("section", { class: "house-card mu-card mu-card--albums", "aria-labelledby": "mu-albums" }, h("h2", { class: "house-card__title", id: "mu-albums" }, m.albums_are === "tracks" ? "Top tracks" : "Top albums"), ...shortList(list, m.top_albums.map((a) => albumTile(a, open)), SHORT_ALBUMS, m.albums_are === "tracks" ? "All tracks" : "All albums"));
}

// ---------- New this period ----------

const NEW_TITLE = { month: "New this month", year: "New this year", past: "New that year", all: "" } as const;

function newCard(m: MusicData, open: (name: string) => void): HTMLElement | null {
  if (m.period.kind === "all" || !m.new_artists.length) return null;
  const more = m.new_count - m.new_artists.length;
  const take = `${m.new_count === 1 ? "One artist" : `${num(m.new_count)} artists`} you hadn't played before${more > 0 ? `; the ${m.new_artists.length} you played most` : ""}.`;
  return h(
    "section",
    { class: "house-card mu-card mu-card--new", "aria-labelledby": "mu-new" },
    h("h2", { class: "house-card__title", id: "mu-new" }, NEW_TITLE[m.period.kind]),
    h("p", { class: "house-card__take" }, take),
    h(
      "ul",
      { class: "mu-new", role: "list" },
      ...m.new_artists.map((a) => {
        const b = h("button", { class: "mu-new__item", type: "button" }, cover(a.art, a.name, "mu-new__art"), h("span", { class: "mu-new__body" }, h("span", { class: "mu-new__name" }, a.name), h("span", { class: "mu-new__meta" }, `First played ${dayMonth(a.first)} · ${plays(a.plays)}`)));
        b.addEventListener("click", () => open(a.name));
        return h("li", {}, b);
      })
    )
  );
}

// ---------- Recently played ----------

function recentRow(d: MusicDay, today: string): HTMLElement {
  return h(
    "li",
    {},
    h(
      "a",
      { class: "mu-day", href: dayHref(d.date) },
      cover(d.art, d.artists[0] ?? "", "mu-day__art"),
      h("span", { class: "mu-day__body" }, h("span", { class: "mu-day__when" }, when(d.date, today)), h("span", { class: "mu-day__who" }, andList(d.artists))),
      h("span", { class: "mu-day__plays" }, plays(d.plays)),
      ico(icons.chevronRight, "mu-ico mu-day__go")
    )
  );
}

function recentCard(m: MusicData): HTMLElement | null {
  if (!m.recent.length) return null;
  return h("section", { class: "house-card mu-card mu-card--recent", "aria-labelledby": "mu-recent" }, h("h2", { class: "house-card__title", id: "mu-recent" }, m.period.kind === "past" ? `The last days with music in ${m.period.label}` : "Recently played"), ...shortList(h("ul", { class: "mu-days", role: "list" }), m.recent.map((d) => recentRow(d, m.today)), SHORT_DAYS, "Show more"));
}

// ---------- Playlists (not tied to the period) ----------

const SHORT_PLAYLISTS = 6;
const SHORT_TRACKS = 20;
const tracksWord = (n: number) => `${num(n)} ${n === 1 ? "track" : "tracks"}`;

/** A made cover: the playlist's own colour and its initials, so nothing is fetched from Spotify. */
function playlistCover(name: string, cls: string): HTMLElement {
  const fill = madeFill(name);
  const tile = h("span", { class: `mu-pl-cover ${cls}`, "aria-hidden": "true" }, initialsOf(name) || "♪");
  tile.style.background = fill;
  tile.style.color = inkFor(fill).tone === "dark" ? INK.light.ink : INK.light.onInk;
  return tile;
}

function playlistTile(p: PlaylistSummary): HTMLElement {
  const sub = [tracksWord(p.tracks), p.owner ? `by ${p.owner}` : null].filter(Boolean).join(" · ");
  const b = h("button", { class: "mu-album", type: "button", "aria-label": `${p.name}, ${sub}` }, playlistCover(p.name, "mu-album__art"), h("span", { class: "mu-album__title", "aria-hidden": "true" }, p.name), h("span", { class: "mu-album__sub", "aria-hidden": "true" }, sub));
  b.addEventListener("click", () => openPlaylistSheet(p));
  return h("li", {}, b);
}

const SIGN_IN = "Sign in again to let Athena read your playlists.";

/**
 * To listen: albums and songs saved as music and not yet heard. Under way
 * first, then still to play. Music videos aren't here (they have their own
 * card, further down), and nothing that's been heard is. Null when nothing's
 * waiting.
 */
export function listenShelf(items: ReadingItem[]): HTMLElement | null {
  const music = items.filter((r) => r.kind === "music" && r.status !== "done");
  const rows = [...music.filter((r) => r.status === "reading"), ...music.filter((r) => r.status === "queued")];
  if (!rows.length) return null;
  const waiting = rows.length;
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add");
  add.addEventListener("click", () => openReadingSheet(null, { kind: "music" }));
  return h(
    "section",
    { class: "house-card mu-card mu-listen", "aria-labelledby": "mu-listen" },
    h("div", { class: "mu-card__head" }, h("h2", { class: "house-card__title", id: "mu-listen" }, "To listen", waiting ? h("span", { class: "mu-listen__count" }, String(waiting)) : null), add),
    h("ul", { class: "watch-rail mu-listen__rail", role: "list", "data-shape": "square" }, ...rows.map(listenCard))
  );
}

/** The season shelf, put away for this year: "christmas-2026". */
const SEASON_OFF_KEY = "athena.music.season.off";
const seasonOff = (key: string) => {
  try {
    return localStorage.getItem(SEASON_OFF_KEY) === key;
  } catch {
    return false;
  }
};
const setSeasonOff = (key: string | null) => {
  try {
    if (key) localStorage.setItem(SEASON_OFF_KEY, key);
    else localStorage.removeItem(SEASON_OFF_KEY);
  } catch {
    // not kept here (a private window): it still holds for this visit
  }
};

/**
 * For the season: your own playlists named for it ("Christmas at home"),
 * and the music saved and not yet heard that suits it by its title,
 * playlist or tag. Nothing from outside your own lists. Null out of season, when
 * nothing fits, or once it's put away for the year.
 */
export function seasonShelf(season: Season | null, items: ReadingItem[], playlists: PlaylistSummary[], repaint: () => void): HTMLElement | null {
  if (!season) return null;
  const key = `${season.id}-${new Date().getFullYear()}`;
  if (seasonOff(key)) return null;
  const lists = playlists.filter((p) => season.words.test(p.name));
  // Saved music that names the season and hasn't been heard yet.
  const music = items.filter((r) => isMusic(r) && r.status !== "done" && seasonFit(r, season) === "named");
  if (!lists.length && !music.length) return null;
  const hide = h("button", { class: "watch-link watch-link--plain", type: "button" }, "Not now");
  hide.addEventListener("click", () => {
    setSeasonOff(key);
    repaint();
    showToast(`Put away until next ${season.label}`, { icon: "check", action: { label: "Undo", run: () => (setSeasonOff(null), repaint()) } });
  });
  const line = lists.length && music.length ? "Your playlists, and what you saved to listen to." : lists.length ? (lists.length === 1 ? "A playlist of yours." : "Playlists of yours.") : "From what you saved to listen to.";
  return h(
    "section",
    { class: "house-card mu-card mu-season watch-season", "data-season": season.id, "aria-labelledby": "mu-season" },
    h("div", { class: "mu-card__head" }, h("h2", { class: "house-card__title watch-title", id: "mu-season" }, `For ${season.label}`), hide),
    h("p", { class: "watch-season__line" }, line),
    // One shelf: the playlists first, then the saved music, all the size of a sleeve.
    h("ul", { class: "watch-rail mu-listen__rail mu-season__rail", role: "list", "data-shape": "square" }, ...lists.map(playlistTile), ...music.map(listenCard))
  );
}

const SHORT_SLEEVES = 6;

/** A quiet card of sleeves at the foot of the page: a few shown, the rest behind a button. */
function sleevesCard(id: string, title: string, aside: string, rows: ReadingItem[], more: string): HTMLElement {
  const list = h("ul", { class: "watch-grid mu-sleeves", role: "list", "data-shape": "square" });
  return h(
    "section",
    { class: `house-card mu-card mu-card--${id}`, "aria-labelledby": `mu-${id}` },
    h("div", { class: "mu-card__head" }, h("h2", { class: "house-card__title", id: `mu-${id}` }, title), aside ? h("span", { class: "house-card__aside" }, aside) : null),
    ...shortList(list, rows.map(listenCard), SHORT_SLEEVES, more)
  );
}

/**
 * Music videos: videos YouTube files under Music (not Shorts), kept apart
 * from the music itself and at the foot of the page. Ones still to watch
 * first; the liked and watched after them, most recent first.
 */
export function musicVideosCard(items: ReadingItem[]): HTMLElement | null {
  const videos = items.filter(isMusicVideo);
  if (!videos.length) return null;
  const waiting = videos.filter((r) => r.status !== "done");
  return sleevesCard("videos", "Music videos", waiting.length ? `${waiting.length} to watch` : String(videos.length), [...waiting, ...videos.filter((r) => r.status === "done")], "All music videos");
}

/** Listened: albums and songs saved as music and since heard. Null when there are none. */
export function listenedCard(items: ReadingItem[]): HTMLElement | null {
  const heard = items.filter((r) => r.kind === "music" && r.status === "done");
  return heard.length ? sleevesCard("listened", "Listened", String(heard.length), heard, "Everything listened to") : null;
}

export function playlistsCard(v: PlaylistsView): HTMLElement | null {
  if (!v.playlists.length && !v.needs_sign_in) return null;
  const head = h("div", { class: "mu-card__head" }, h("h2", { class: "house-card__title", id: "mu-playlists" }, "Playlists"), v.updated ? h("span", { class: "house-card__aside" }, `Updated ${dayMonth(v.updated.slice(0, 10))}`) : null);
  const signIn = v.needs_sign_in
    ? h("div", { class: "mu-signin" }, h("p", { class: "house-card__take" }, SIGN_IN), h("a", { class: "btn btn--soft btn--sm", href: "#/settings/sources" }, icons.plug(), "Open Sources"))
    : null;
  const list = h("ul", { class: "mu-albums", role: "list" });
  return h(
    "section",
    { class: "house-card mu-card mu-card--playlists", "aria-labelledby": "mu-playlists" },
    head,
    signIn,
    ...(v.playlists.length ? shortList(list, v.playlists.map(playlistTile), SHORT_PLAYLISTS, "All playlists") : [])
  );
}

function playlistBody(p: PlaylistDetail): HTMLElement {
  const meta = [p.owner && !p.mine ? `By ${p.owner}` : "Yours", `updated ${dayMonth(p.updated.slice(0, 10))}`].join(" · ");
  const open = p.link ? h("a", { class: "btn btn--soft mu-sheet__ask", href: p.link, target: "_blank", rel: "noopener noreferrer" }, icons.external(), "Open in Spotify") : null;
  const items = p.items ?? [];
  const artists = p.top_artists ?? [];
  return h(
    "div",
    { class: "mu-sheet" },
    h("div", { class: "mu-sheet__head" }, playlistCover(p.name, "mu-sheet__art"), h("div", { class: "mu-sheet__words" }, h("p", { class: "mu-sheet__big" }, tracksWord(p.tracks)), h("p", { class: "mu-sheet__meta" }, meta))),
    open,
    artists.length ? h("h3", { class: "mu-sheet__sub" }, "Top artists in it") : null,
    artists.length ? h("ul", { class: "mu-pl-artists", role: "list" }, ...artists.map((a) => h("li", { class: "mu-pl-artist" }, h("span", {}, a.name), h("span", { class: "mu-pl-artist__n" }, String(a.tracks))))) : null,
    items.length ? h("h3", { class: "mu-sheet__sub" }, "Tracks") : null,
    ...(items.length
      ? shortList(
          h("ol", { class: "mu-pl-tracks", role: "list" }),
          items.map((t, i) => h("li", { class: "mu-pl-track" }, h("span", { class: "mu-pl-track__n", "aria-hidden": "true" }, String(i + 1)), h("span", { class: "mu-pl-track__body" }, h("span", { class: "mu-pl-track__name", tabindex: "-1" }, t.track), t.artist ? h("span", { class: "mu-pl-track__by" }, t.artist) : null))),
          SHORT_TRACKS,
          "All tracks"
        )
      : [h("p", { class: "life-empty__text" }, "Spotify only shares the tracks of playlists you made or collaborate on.")]),
    items.length && p.tracks > items.length ? h("p", { class: "house-card__aside" }, `The first ${num(items.length)} of ${tracksWord(p.tracks)}.`) : null
  );
}

function openPlaylistSheet(s: PlaylistSummary): void {
  const body = h("div", { class: "mu-sheet", "aria-busy": "true" }, h("span", { class: "skeleton mu-sk mu-sk--sheet" }));
  openSheet({ label: s.name, title: s.name, body });
  loadPlaylist(s.id).then(
    (p) => {
      body.removeAttribute("aria-busy");
      body.replaceChildren(p ? playlistBody(p) : h("p", { class: "life-empty__text" }, "This playlist isn't in Athena any more."));
    },
    () => {
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("p", { class: "life-empty__text" }, "This didn't load. Check you're online, then try again."));
    }
  );
}

// ---------- The artist sheet ----------

function artistBody(a: ArtistDetail, today: string): HTMLElement {
  const lastWord = when(a.last, today);
  const ask = h("button", { class: "btn btn--soft mu-sheet__ask", type: "button" }, icons.chat(), "Ask about this artist");
  ask.addEventListener("click", () => openAsk({ prompt: `What have I been listening to by ${a.name}? When did I play them most, and which albums?` }));
  const albums = a.albums.length
    ? h(
        "ul",
        { class: "mu-sheet__albums", role: "list" },
        ...a.albums.map((x) => h("li", { class: "mu-sheet__album" }, cover(x.art, x.title, "mu-sheet__album-art"), h("span", { class: "mu-album__title" }, x.title), h("span", { class: "mu-album__sub" }, plays(x.plays))))
      )
    : null;
  const unitWord = a.unit === "year" ? "Plays each year" : "Plays each month";
  return h(
    "div",
    { class: "mu-sheet" },
    h(
      "div",
      { class: "mu-sheet__head" },
      cover(a.art, a.name, "mu-sheet__art"),
      h("div", { class: "mu-sheet__words" }, h("p", { class: "mu-sheet__big" }, plays(a.plays)), h("p", { class: "mu-sheet__meta" }, `On ${num(a.days)} ${a.days === 1 ? "day" : "days"}`))
    ),
    h(
      "dl",
      { class: "mu-sheet__facts" },
      h("div", {}, h("dt", {}, "First played"), h("dd", {}, dayMonth(a.first, true))),
      h("div", {}, h("dt", {}, "Last played"), h("dd", {}, lastWord === "Today" || lastWord === "Yesterday" ? lastWord : dayMonth(a.last, true)))
    ),
    a.points.length > 1 ? h("div", { class: "mu-sheet__chart" }, h("h3", { class: "mu-sheet__sub" }, unitWord), timelineChart(a.unit, a.points, `${unitWord} for ${a.name}`, false, 128)) : null,
    albums ? h("h3", { class: "mu-sheet__sub" }, a.albums_are === "tracks" ? "Top tracks" : "Top albums") : null,
    albums,
    ask
  );
}

function openArtistSheet(name: string, today: string): void {
  const body = h("div", { class: "mu-sheet", "aria-busy": "true" }, h("span", { class: "skeleton mu-sk mu-sk--sheet" }));
  openSheet({ label: name, title: name, body });
  loadArtist(name).then(
    (a) => {
      body.removeAttribute("aria-busy");
      body.replaceChildren(a ? artistBody(a, today) : h("p", { class: "life-empty__text" }, `No plays of ${name} yet.`));
    },
    () => {
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("p", { class: "life-empty__text" }, "This didn't load. Check you're online, then try again."));
    }
  );
}

// ---------- The page ----------

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "life-empty mu-empty" },
    h("span", { class: "mu-empty__icon" }, ico(icons.music, "mu-ico mu-ico--lg")),
    h("p", { class: "life-empty__title" }, "No music yet"),
    h("p", { class: "life-empty__text" }, "Connect a music service or load a scrobble history to see your top artists and albums here."),
    h("a", { class: "btn btn--soft btn--sm", href: "#/settings/sources?add=entertainment" }, icons.plug(), "Open Sources")
  );
}

function skeleton(): HTMLElement {
  return h("div", { class: "mu-skeleton", "aria-hidden": "true" }, h("span", { class: "skeleton mu-sk mu-sk--hero" }), h("span", { class: "skeleton mu-sk mu-sk--card" }), h("span", { class: "skeleton mu-sk mu-sk--card" }));
}

export function renderMusic(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let dead = false;
  let period = read() ?? "month";
  let seq = 0;
  const switcher = h("div", { class: "segmented segmented--sub mu-periods", role: "radiogroup", "aria-label": "Period" });
  const body = h("div", { class: "mu-page", "aria-busy": "true" }, skeleton());
  const el = h("div", { class: "view lists music-view" }, pageHead({ segments: librarySegments("music", ctx.go), title: "Music" }), switcher, body);
  const open = (name: string, today: string) => openArtistSheet(name, today);

  const paintSwitch = (m: MusicData) => {
    const choices = m.periods;
    switcher.hidden = !m.has_music;
    switcher.replaceChildren(
      ...choices.map((c, i) => {
        const on = c.id === m.period.id;
        const b = h("button", { class: "segmented__item", type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1" }, c.label) as HTMLButtonElement;
        b.addEventListener("click", () => choose(c.id));
        b.addEventListener("keydown", (ev) => {
          const to = ev.key === "ArrowRight" ? choices[(i + 1) % choices.length] : ev.key === "ArrowLeft" ? choices[(i + choices.length - 1) % choices.length] : null;
          if (!to) return;
          ev.preventDefault();
          choose(to.id, true);
        });
        return b;
      })
    );
    switcher.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  /** The To listen shelf sits first on the page, whatever the period, and with or without any listening history. */
  const listenSlot = h("div", { class: "mu-listen-slot" });
  /** Music videos and what's been listened to: history, kept at the foot of the page. */
  const footSlot = h("div", { class: "mu-listen-slot mu-foot-slot" });
  const paintListen = () =>
    // Playlists are only for the season shelf here: without them it still shows saved music.
    void Promise.all([loadReading(), loadPlaylists().catch(() => null)]).then(
      ([{ items }, lists]) => {
        if (dead) return;
        const sorted = [...items].sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
        const shelf = listenShelf(sorted);
        const season = seasonShelf(seasonOn(new Date()), sorted, lists?.playlists ?? [], paintListen);
        listenSlot.replaceChildren(...[shelf, season].filter((x): x is HTMLElement => !!x));
        footSlot.replaceChildren(...[musicVideosCard(sorted), listenedCard(sorted)].filter((x): x is HTMLElement => !!x));
      },
      () => undefined
    );
  const unsub = onMemoryChange((t) => (t === "reading" || t === "all") && paintListen());
  paintListen();

  const paint = (m: MusicData, animate: boolean) => {
    body.removeAttribute("aria-busy");
    paintSwitch(m);
    if (!m.has_music) {
      body.replaceChildren(listenSlot, emptyState(), footSlot);
      return;
    }
    const go = (name: string) => open(name, m.today);
    const some = (xs: Array<HTMLElement | null>) => xs.filter((x): x is HTMLElement => !!x);
    // Two stacks on a wide screen (artists and new on the left, albums and days on the right); one column on a phone, in reading order.
    const left = h("div", { class: "mu-col" }, ...some([artistsCard(m, go), newCard(m, go)]));
    body.replaceChildren(listenSlot, h("div", { class: "mu-grid" }, ...some([hero(m), timelineCard(m), whenCard(m), genresCard(m)]), left, h("div", { class: "mu-col" }, ...some([albumsCard(m, go), recentCard(m)]))), footSlot);
    // Playlists aren't tied to the period: they arrive on their own, and a failure leaves the page as it is.
    void loadPlaylists().then(
      (v) => {
        const card = dead ? null : playlistsCard(v);
        if (card && left.isConnected) left.append(card);
      },
      () => undefined
    );
    if (animate) {
      body.classList.remove("is-entering");
      void body.offsetWidth;
      body.classList.add("is-entering");
    }
  };

  const load = (animate = false, focus = false) => {
    const mine = ++seq;
    body.setAttribute("aria-busy", "true");
    loadMusic(period).then(
      (m) => {
        if (dead || mine !== seq) return;
        // A kept year that has no music now falls back to this month on the server; keep what it answered.
        if (m.period.id !== period) {
          period = m.period.id;
          keep(period);
        }
        paint(m, animate);
        if (focus) switcher.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
      },
      () => {
        if (dead || mine !== seq) return;
        body.removeAttribute("aria-busy");
        body.replaceChildren(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "Music didn't load"), h("p", { class: "life-empty__text" }, "Check you're online, then come back to this page.")));
      }
    );
  };
  const choose = (id: string, focus = false) => {
    if (id === period) return;
    period = id;
    keep(id);
    load(true, focus);
  };
  load();
  return {
    el,
    destroy: () => {
      dead = true;
      unsub();
    },
  };
}
