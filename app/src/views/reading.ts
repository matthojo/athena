/**
 * Watch & read: books, films, TV shows, articles, videos, podcasts, music and
 * games: what you're in the middle of, what's next, and what you finished.
 *
 * The page (styles/watch.css) is covers first, in the order things matter:
 *  - the month so far, as one sentence beside the covers it's about;
 *  - In progress, a shelf with how far through each thing is under its cover;
 *  - Up next, on shelves by kind (a kind with a few things gets its own; the
 *    ones and twos share one) or by who made it; a cover's shape says its
 *    kind: a poster stands, an album sits square, a video lies wide;
 *  - Favourites, whatever was given four stars or more;
 *  - Finished, the latest on a shelf, and all of it by year behind "See all".
 * Start or Finish rides a cover's corner, with Undo. One bar does both jobs a
 * list needs: type to find what's on it, press Enter to add what isn't (a
 * pasted link gets a first title and kind). Chips narrow everything to one
 * kind, shown as a grid, and keep their choice on the device.
 *
 * The sheet opens on the cover, who made it and who it's from; the form is
 * folded below. Each item's words fit its kind ("To watch · Watching ·
 * Watched"), while the page's own sections stay neutral because it mixes
 * kinds. (The view id, route and table are still called "reading".)
 */

import { artImg } from "../components/art-img";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { openEditorSheet } from "../components/editor-sheet";
import { autoTextarea, choiceChips, field, input, select } from "../components/fields";
import { personPicker } from "../components/person-picker";
import { readingProgressRow } from "../components/reading-progress";
import { customFieldsSection, ratingStars } from "../components/custom-fields";
import { loadKindValues, onCustomFieldsChange } from "../db/custom-fields";
import { ratingFieldOf } from "../../../lib/custom-field-rules";
import { safeUrl } from "../components/record-profile";
import { showToast } from "../components/toast";
import { deleteMemoryForever, loadReading, onMemoryChange, saveReading, setMemoryArchived } from "../db/memory";
import { hueFor, initials, relativeTime } from "../lib/format";
import { madeFill } from "../lib/cover-ink";
import { READING_META, readingMeta } from "../lib/memory-meta";
import { NEUTRAL_STATUS, progressFraction, progressWords, READING_KINDS, READING_STATUSES } from "../../../lib/watch-read";
import { isMusic, isMusicVideo, isShort, minutesWords, parseTags, seasonFit, seasonOn, type Season } from "../../../lib/watch-meta";
import { isSampleMode } from "../db/api";
import { loadWatchStats } from "../db/days-app";
import { barChart, radarChart } from "../components/house-charts";
import { genreRadar } from "../../../lib/genre-mix";
import { openScreenTime } from "../components/screen-time";
import type { MonthStats } from "../../../lib/watch-stats";
import "../styles/house.css";
import type { PersonRef, ReadingItem, ReadingKind, ReadingStatus } from "../types";
import "../styles/life.css";
import "../styles/watch.css";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";

/** Hosts (and paths) that say what a link is. Checked in order; anything else is an article. */
const LINK_KINDS: [RegExp, ReadingKind][] = [
  [/(youtube\.com|youtu\.be|vimeo\.com)\//, "video"],
  [/(podcasts\.apple\.com|spotify\.com\/(episode|show)|overcast\.fm|pca\.st)\//, "podcast"],
  [/(spotify\.com\/(album|track|playlist|artist)|music\.apple\.com|bandcamp\.com|soundcloud\.com|tidal\.com)\//, "music"],
  [/(themoviedb\.org\/tv|tv\.apple\.com\/.*\/show|thetvdb\.com)\//, "tv"],
  [/(letterboxd\.com\/film|themoviedb\.org\/movie|imdb\.com\/title|tv\.apple\.com\/.*\/movie)\//, "film"],
  [/(store\.steampowered\.com\/app|itch\.io|gog\.com\/.*\/game|nintendo\.com\/.*\/store)\//, "game"],
  [/(goodreads\.com\/book|openlibrary\.org|bookshop\.org)\//, "book"],
  [/(arxiv\.org|doi\.org)\/|\.pdf\/$/i, "paper"],
];

/** Path parts that are ids or section names, not the thing's name ("tt0903747", "album", "gb"). */
const NOT_A_NAME = /^(\d+|(?=.*\d)[a-z0-9.]{8,}|[a-z]{2}(-[a-z]{2})?|title|film|movie|show|tv|album|track|song|app|book|episode|game|products?|store|watch|embed|abs)$/i;

/** A first title and kind from a pasted link; easy to correct in the sheet. */
export function guessFromUrl(raw: string): { title: string; url: string; kind: ReadingKind } | null {
  const s = raw.trim();
  if (!/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s)) return null;
  const url = safeUrl(s);
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  const where = `${host}${u.pathname}/`;
  const kind = LINK_KINDS.find(([re]) => re.test(where))?.[1] ?? "article";
  const slug = [...u.pathname.split("/").filter(Boolean)]
    .reverse()
    .map((part) =>
      decodeURIComponent(part)
        .replace(/\.(html?|php|aspx?)$/i, "")
        .replace(/^\d+[-_.](?=\D)/, "")
    )
    .find((part) => !NOT_A_NAME.test(part))
    ?.replace(/[-_]+/g, " ")
    .trim();
  const title = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : host;
  return { title, url, kind };
}

/** "Watched 3 days ago", "Read last week", "Finished yesterday". */
const doneLine = (r: Pick<ReadingItem, "kind" | "finished_at">) => (r.finished_at ? `${readingMeta(r.kind).status.done} ${relativeTime(r.finished_at)}` : "");

/** The shape a cover takes without art: square for music and podcasts, a screen for a video, a poster for the rest. */
const coverRatio = (kind: string) => (kind === "music" || kind === "podcast" ? 1 : kind === "video" ? 16 / 9 : 2 / 3);

/** An item's cover: its art, or one made from its title. */
function readingCover(r: Pick<ReadingItem, "title" | "author" | "kind" | "art">, opts: { size?: "sm" | "lg"; alt?: string; eager?: boolean } = {}): HTMLElement {
  const meta = readingMeta(r.kind);
  return artImg(r.art, { alt: opts.alt ?? "", size: opts.size ?? "sm", eager: opts.eager, fallback: meta.icon, ratio: coverRatio(r.kind), cover: { title: r.title, by: r.author || undefined } });
}

/** The art's own tone, or the made cover's fill: the sheet's glow behind the cover. */
const TONE = /^(#[0-9a-f]{6}|oklch\([0-9.%\s/]+\))$/i;
const glowOf = (r: Pick<ReadingItem, "title" | "art">) => (r.art?.tone && TONE.test(r.art.tone) ? r.art.tone : madeFill(r.title.trim() || "Watch & read"));

/** "From" and the person as a chip that opens them (after the sheet has closed). */
function fromChip(p: PersonRef, close: (then: () => void) => void): HTMLElement {
  const href = `#/people/${encodeURIComponent(p.id)}`;
  const chip = h("a", { class: "mention rs-person", href, title: p.name }, h("span", { class: "avatar avatar--xs", style: `--h:${hueFor(p.name)}`, "aria-hidden": "true" }, initials(p.name)), p.name.split(" ")[0]);
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    close(() => (location.hash = href));
  });
  return h("p", { class: "rs-from" }, "From ", chip);
}

export function openReadingSheet(initial: ReadingItem | null, seed: Partial<ReadingItem> = {}): void {
  let rec = initial;
  const start = { ...seed, ...(initial ?? {}) };
  const startKind: ReadingKind = start.kind && start.kind in READING_META ? start.kind : initial ? "other" : "book";
  const kind = select(
    "Kind",
    READING_KINDS.map((k) => ({ value: k, label: READING_META[k].label })),
    startKind
  );
  const link = input("url", start.url ?? "", { placeholder: "Add a link", autocomplete: "off", inputmode: "url" });
  const author = input("text", start.author ?? "", { placeholder: "Who made it", autocomplete: "off" });
  const status = choiceChips<ReadingStatus>(
    "Status",
    READING_STATUSES.map((s) => ({ value: s, label: READING_META[startKind].status[s] })),
    start.status ?? "queued",
    (s) => {
      progress.setStatus(s);
      if (rec) save({ status: s });
    }
  );
  // How far through it you are: shown while it's under way, or once a position is kept.
  const progress = readingProgressRow({
    kind: startKind,
    status: start.status ?? "queued",
    value: start.progress,
    onChange: (p) => rec && save({ progress: p }),
    onProblem: (message) => showToast(message, { icon: "bell", timeoutMs: 4000 }),
  });
  let recommender = start.recommender ?? null;
  const picker = personPicker({
    value: recommender,
    label: "Recommended by",
    placeholder: "Someone (optional)",
    onChange: (p) => {
      recommender = p;
      paintHero();
      if (rec) save({ recommended_by: p?.id ?? null });
    },
  });
  const tags = input("text", (start.meta?.tags ?? []).join(", "), { placeholder: "cosy, rewatch", autocomplete: "off", "aria-label": "Tags, separated by commas" });
  const notes = autoTextarea(start.notes ?? "", { name: "notes", placeholder: "Highlights, thoughts, where you're up to", "aria-label": "Notes" }, 72);

  let saving: Promise<void> = Promise.resolve();
  function save(patch: Partial<ReadingItem> & { tags?: string[] }) {
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await saveReading(patch, rec.id);
        editor.refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }
  link.addEventListener("change", () => rec && save({ url: link.value.trim() }));
  author.addEventListener("change", () => rec && save({ author: author.value.trim() }));
  author.addEventListener("input", () => paintHero());
  notes.addEventListener("change", () => rec && save({ notes: notes.value }));
  tags.addEventListener("change", () => {
    const list = parseTags(tags.value);
    tags.value = list.join(", ");
    if (rec) save({ tags: list });
  });

  const openLink = h("a", { class: "icon-btn icon-btn--sm icon-btn--ghost", target: "_blank", rel: "noopener noreferrer", "aria-label": "Open link" }, icons.link());
  const paintOpen = () => {
    const href = safeUrl(link.value);
    openLink.hidden = !href;
    if (href) openLink.setAttribute("href", href);
  };
  link.addEventListener("input", paintOpen);
  paintOpen();

  // ---------- The top: the cover, then who made it, who it's from and the stars ----------
  const cover = h("div", { class: "rs-cover" });
  const byLine = h("p", { class: "rs-by" });
  // What the sources know: the year, how long it runs, its genres, the playlists it's in.
  const factsLine = h("p", { class: "rs-facts" });
  const listsLine = h("p", { class: "rs-lists" });
  const fromSlot = h("div", { class: "rs-from-slot" });
  const starsSlot = h("div", { class: "rs-stars" });
  const hero = h("section", { class: "rs-hero" }, byLine, factsLine, listsLine, fromSlot, starsSlot);
  /** Stars from the owner's Rating field, if they have one and gave some. */
  let rated: number | undefined;

  const closeThen = (then: () => void) => {
    editor.sheet.dialog.addEventListener("close", then, { once: true });
    editor.sheet.close();
  };

  /** The cover follows the title, kind and maker while there's no art, so a new item gets its cover as it's typed. */
  function paintCover() {
    const now = { title: editor?.title.value.trim() || start.title?.trim() || "", author: author.value.trim(), kind: kind.value as ReadingKind, art: rec?.art ?? start.art };
    cover.style.setProperty("--rs-glow", glowOf(now));
    cover.replaceChildren(readingCover(now, { size: "lg", eager: true }));
  }

  function paintHero() {
    const who = author.value.trim();
    byLine.textContent = who;
    byLine.hidden = !who;
    const known = { kind: kind.value as ReadingKind, meta: rec?.meta ?? start.meta };
    const facts = factsOf(known, { genres: 3, long: true });
    factsLine.textContent = facts;
    factsLine.hidden = !facts;
    const lists = known.meta?.lists ?? [];
    listsLine.replaceChildren(...(lists.length ? [h("span", { class: "rs-lists__label" }, lists.length === 1 ? "Playlist" : "Playlists"), ...lists.map((name) => h("span", { class: "rs-lists__name" }, name))] : []));
    listsLine.hidden = !lists.length;
    fromSlot.replaceChildren(...(recommender ? [fromChip(recommender, closeThen)] : []));
    starsSlot.replaceChildren(...(rated ? [ratingStars(rated)] : []));
    hero.hidden = !who && !recommender && !rated && !facts && !lists.length;
    paintCover();
  }

  async function loadStars() {
    if (!rec) return;
    const id = rec.id;
    try {
      const kv = await loadKindValues("reading");
      const f = ratingFieldOf(kv.fields, "reading");
      const v = f ? kv.values[id]?.[f.id] : undefined;
      rated = typeof v === "number" && v > 0 ? v : undefined;
      paintHero();
    } catch {
      // No stars on the top: the Details card still has the field.
    }
  }

  // ---------- Below, folded: the form ----------
  const authorRow = field("By", author);
  const fields = h("div", { class: "card card--flush fields" }, field("Status", status.el), field("Kind", kind), field("Link", link, openLink), authorRow, field("From", picker.el), field("Tags", tags));
  // Progress keeps its own row, open, since it's the thing you change while you're in the middle of something.
  const progressCard = h("div", { class: "card card--flush fields rs-progress" }, progress.el);
  const paintProgressCard = () => (progressCard.hidden = progress.el.hidden);
  const details = h(
    "details",
    { class: "rs-details" },
    h("summary", { class: "rs-details__summary" }, h("span", { class: "group__label" }, "Details"), icons.chevronDown()),
    fields
  ) as HTMLDetailsElement;
  // A new item needs its kind and status, so it opens unfolded.
  details.open = !initial;

  /** The words that change with the kind: the status chips and what the maker is called. */
  function paintKind() {
    const meta = readingMeta(kind.value);
    status.el.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip, i) => (chip.textContent = meta.status[READING_STATUSES[i]]));
    authorRow.querySelector(".prop__label")!.textContent = meta.maker ?? "By";
    // A TV show has no one "by": the row goes unless something's already in it.
    authorRow.hidden = !meta.maker && !author.value.trim();
  }
  kind.addEventListener("change", () => {
    paintKind();
    progress.setKind(kind.value);
    paintCover();
    if (rec) save({ kind: kind.value as ReadingKind });
  });
  paintKind();

  const notesSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Notes"), notes);
  // The owner's own fields (a Rating, say) follow the built-in ones once the item exists.
  const custom = customFieldsSection("reading");
  custom.attach(fields);
  custom.show(initial?.id ?? null);

  const editor = openEditorSheet({
    newLabel: "Add to Watch & read",
    isNew: !initial,
    titleValue: start.title ?? "",
    placeholder: "Title",
    mark: cover,
    sections: [hero, progressCard, notesSection, details],
    onTitle: (title) => save({ title }),
    create: async () => {
      const created = await saveReading({
        title: editor.title.value.trim(),
        kind: kind.value as ReadingKind,
        url: link.value.trim(),
        author: author.value.trim(),
        status: status.value(),
        recommended_by: recommender?.id ?? null,
        notes: notes.value,
        progress: progress.value(),
        ...(parseTags(tags.value).length ? { tags: parseTags(tags.value) } : {}),
      });
      await custom.commit(created.id);
      // Music lives on the Music page, not here.
      showToast(isMusic(created) ? "Added to Music" : "Added to Watch & read", { icon: "bookmark" });
      return true;
    },
    status: () => (rec ? doneLine(rec) || `Added ${relativeTime(rec.created_at)}` : ""),
    // Start or Finish, one tap from the foot, as on the list.
    action: () => {
      if (!rec || rec.status === "done") return null;
      const next: ReadingStatus = rec.status === "queued" ? "reading" : "done";
      return {
        icon: next === "reading" ? "play" : "check",
        label: next === "reading" ? "Start" : "Finish",
        run: () => {
          status.set(next);
          progress.setStatus(next);
          paintProgressCard();
          save({ status: next });
        },
      };
    },
    archive: async () => {
      if (!rec) return;
      const { id } = rec;
      await setMemoryArchived("reading", id, true);
      showToast("Archived", { icon: "archive", action: { label: "Undo", run: () => void setMemoryArchived("reading", id, false) } });
    },
    remove: {
      what: initial ? `“${initial.title}”` : "It",
      run: async () => {
        if (rec) await deleteMemoryForever("reading", rec.id);
      },
    },
  });
  editor.title.closest(".loop-sheet")?.classList.add("rs");
  editor.title.addEventListener("input", () => !rec?.art && paintCover());
  status.el.addEventListener("click", () => queueMicrotask(paintProgressCard));
  paintHero();
  paintProgressCard();
  void loadStars();
  const unsubFields = onCustomFieldsChange((k) => (k === "reading" || k === null) && void loadStars());
  editor.sheet.dialog.addEventListener("close", () => {
    custom.destroy();
    unsubFields();
  });
}

/**
 * A thing to listen to, as the Music page shelves it: a square sleeve (a
 * song's video thumbnail is cropped to one), its length in the corner, the
 * name and who made it. A tap opens the same sheet as on Watch & read,
 * where it's started and finished.
 */
export function listenCard(r: ReadingItem): HTMLElement {
  const maker = r.author.replace(/\s+-\s+Topic$/i, "").trim();
  const length = r.status === "done" || !r.meta?.minutes ? "" : minutesWords(r.meta.minutes);
  const state = r.status === "reading" ? (r.progress ? progressWords(r.progress) : READING_META.music.status.reading) : r.status === "done" ? doneLine(r) : "";
  const pictured = Boolean(r.art);
  const open = h(
    "button",
    { class: "watch-card__open cover-lift", type: "button", "aria-label": `${r.title}${maker ? `, ${maker}` : ""}${length ? `, ${length}` : ""}${state ? `: ${state}` : ""}` },
    h("span", { class: "watch-card__cover" }, readingCover(r), length && pictured ? h("span", { class: "watch-card__len", "aria-hidden": "true" }, length) : null),
    pictured ? h("span", { class: "watch-card__title" }, r.title) : null,
    pictured && maker ? h("span", { class: "watch-card__sub" }, maker) : null,
    !pictured && length ? h("span", { class: "watch-card__sub" }, length) : null,
    state ? h("span", { class: "watch-card__sub" }, state) : null
  );
  open.addEventListener("click", () => openReadingSheet(r));
  return h("li", { class: "watch-card", "data-shape": "square", "data-status": r.status }, open);
}

/** A filter chip's word for a kind: what the list holds of it. */
/**
 * What the page shelves by: a kind, or "short". A YouTube Short is saved as
 * a video, but it's a different thing (seconds long, gone by tomorrow), so
 * it has a chip and a shelf of its own and keeps out of the long videos.
 */
type Shelf = ReadingKind | "short";
/** Where a shelf sorts among the kinds: Shorts last. */
const shelfOrder = (k: Shelf) => (k === "short" ? READING_KINDS.length : READING_KINDS.indexOf(k));

const KIND_PLURAL: Record<Shelf, string> = { book: "Books", film: "Films", tv: "TV", article: "Articles", video: "Videos", podcast: "Podcasts", music: "Music", game: "Games", paper: "Papers", other: "Other", short: "Shorts" };

/** One and many of a kind, for the month's line: "2 films", "a book". */
const KIND_COUNT: Record<Shelf, [string, string]> = {
  short: ["Short", "Shorts"],
  book: ["book", "books"],
  film: ["film", "films"],
  tv: ["show", "shows"],
  article: ["article", "articles"],
  video: ["video", "videos"],
  podcast: ["podcast", "podcasts"],
  music: ["listen", "listens"],
  game: ["game", "games"],
  paper: ["paper", "papers"],
  other: ["other", "others"],
};

/** Who made it, as the list shows it. YouTube files an artist's own uploads under "<Artist> - Topic". */
const makerOf = (r: Pick<ReadingItem, "author">) => r.author.replace(/\s+-\s+Topic$/i, "").trim();

/**
 * The kind an item is shelved under. A music video (a video YouTube files
 * under Music that isn't a Short) is music, whatever kind it was saved as.
 * Music isn't on this page at all: it's the Music page's (lib/watch-meta.ts).
 */
export const shelfKind = (r: Pick<ReadingItem, "kind" | "meta" | "url">): Shelf => (isMusicVideo(r) ? "music" : r.kind === "video" && isShort(r) ? "short" : r.kind);

/** How long it runs, as the cover's corner says it. A show's minutes are one episode's, and say less. */
const lengthOf = (r: Pick<ReadingItem, "kind" | "meta">): string => (r.meta?.minutes && r.kind !== "tv" ? minutesWords(r.meta.minutes) : "");

/** "2024 · 2h 47m · Science Fiction, Adventure": what's known, in the order it's asked about. */
function factsOf(r: Pick<ReadingItem, "kind" | "meta">, opts: { genres?: number; long?: boolean } = {}): string {
  const m = r.meta ?? {};
  const length = m.minutes ? (r.kind === "tv" ? (opts.long ? `${minutesWords(m.minutes)} an episode` : "") : minutesWords(m.minutes)) : m.pages ? `${m.pages} pages` : "";
  return [m.year ? String(m.year) : "", length, (m.genres ?? []).slice(0, opts.genres ?? 1).join(", ")].filter(Boolean).join(" · ");
}

/** Up next by length: the shelf an item's running time puts it on. */
const LENGTHS: Array<{ id: string; label: string; under: number }> = [
  { id: "a", label: "A few minutes", under: 15 },
  { id: "b", label: "Half an hour or so", under: 45 },
  { id: "c", label: "About an hour", under: 90 },
  { id: "d", label: "Feature length", under: Infinity },
];

type Shape = "wide" | "square" | "tall";

/** The cover's shape: its art's own, or the made cover's for its kind. */
function shapeOf(r: Pick<ReadingItem, "kind" | "art" | "meta" | "url">): Shape {
  // Music is square on a shelf, as a sleeve is: a song's video thumbnail is cropped to one.
  if (shelfKind(r) === "music") return "square";
  const ratio = r.art && r.art.w > 0 && r.art.h > 0 ? r.art.w / r.art.h : coverRatio(r.kind);
  return ratio > 1.2 ? "wide" : ratio > 0.9 ? "square" : "tall";
}

/** Small choices kept on this device, so the page opens the way it was left. */
function stored<T extends string>(key: string, ok: (v: string) => v is T): T | null {
  try {
    const v = localStorage.getItem(key);
    return v && ok(v) ? v : null;
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // not kept here (a private window): the choice still holds for this visit
  }
}
const FILTER_KEY = "athena.watch.kind";
const GROUP_KEY = "athena.watch.group";
/** The season shelf, put away for this year: "christmas-2026". */
const SEASON_OFF_KEY = "athena.watch.season.off";
const GROUPS = ["kind", "list", "genre", "length", "maker"] as const;
type GroupBy = (typeof GROUPS)[number];
const GROUP_WORDS: Record<GroupBy, string> = { kind: "Kind", list: "Playlist", genre: "Genre", length: "Length", maker: "Made by" };

/** How many finished things are drawn at a time: a history loaded from Trakt can run to hundreds. */
const DONE_PAGE = 48;
/** The Finished rail shows this many of the latest; the rest are under "See all". */
const DONE_RAIL = 14;
/** A kind needs this many things in Up next for a shelf of its own. */
const OWN_SHELF = 3;
/** Stars from here up make a favourite. */
const FAVOURITE = 4;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2 films, a book and 3 shows". */
function countWords(counts: Map<Shelf, number>): string {
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || shelfOrder(a[0]) - shelfOrder(b[0]))
    .map(([k, n]) => `${n === 1 ? (/^[aeio]/.test(KIND_COUNT[k][0]) ? "an" : "a") : n} ${KIND_COUNT[k][n === 1 ? 0 : 1]}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}

export function renderReading(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let items: ReadingItem[] = [];
  /** Each item's stars, from the owner's Rating field. */
  let stars = new Map<string, number>();
  let loaded = false;
  let kindFilter = stored(FILTER_KEY, (v): v is Shelf => v in KIND_PLURAL);
  let groupBy: GroupBy = stored(GROUP_KEY, (v): v is GroupBy => (GROUPS as readonly string[]).includes(v)) ?? "kind";
  /** Asked once more, a little after the first load, when the server is still learning about some titles. */
  let again: number | undefined;
  let askedAgain = false;
  let query = "";
  let doneAll = false;
  let doneShown = DONE_PAGE;
  /** The item that just changed state, so it arrives where it lands. */
  let arrived: string | null = null;

  // ---------- The bar: find what's on the list, or add what isn't ----------
  const bar = h("input", {
    class: "quick-add__input",
    type: "text",
    name: "watch-find",
    placeholder: "Find, or add a title or link",
    autocomplete: "off",
    enterkeyhint: "done",
    "aria-label": "Find on the list, or add a title or link",
  }) as HTMLInputElement;
  const addBtn = h("button", { class: "btn btn--primary btn--sm watch-bar__add", type: "submit" }, "Add");
  const clearBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost watch-bar__clear", type: "button", "aria-label": "Clear" }, icons.close());
  const newBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost watch-bar__new", type: "button", "aria-label": "Add with details", title: "Add with details" }, icons.plus());
  const barForm = h("form", { class: "quick-add watch-bar", role: "search" }, h("span", { class: "quick-add__icon", "aria-hidden": "true" }, icons.search()), bar, clearBtn, addBtn, newBtn);
  const paintBar = () => barForm.classList.toggle("has-text", Boolean(bar.value.trim()));
  const setQuery = (value: string) => {
    bar.value = value;
    query = value.trim().toLowerCase();
    paintBar();
    paint();
  };
  bar.addEventListener("input", () => {
    query = bar.value.trim().toLowerCase();
    paintBar();
    paint();
  });
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bar.value) {
      e.preventDefault();
      setQuery("");
    }
  });
  clearBtn.addEventListener("click", () => {
    setQuery("");
    bar.focus();
  });
  newBtn.addEventListener("click", () => openReadingSheet(null));
  const addTyped = () => {
    const raw = bar.value.trim();
    if (!raw) return;
    setQuery("");
    // A link's title and kind are only guesses, and a typed title says nothing
    // about whether it's a book, a film or a show: the sheet asks.
    openReadingSheet(null, guessFromUrl(raw) ?? { title: raw });
  };
  barForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addTyped();
  });

  const chips = h("div", { class: "chip-row watch-kinds", role: "group", "aria-label": "Show" });
  const list = h("div", { class: "notes__list watch__list" });
  const el = h(
    "div",
    { class: "view lists watch" },
    pageHead({
      segments: librarySegments("reading", ctx.go),
      title: "Watch & read",
      below: [barForm],
    }),
    // The chips scroll away with the page: the head that stays keeps to the title and the bar.
    chips,
    list
  );

  const setKind = (kind: Shelf | null) => {
    kindFilter = kind;
    store(FILTER_KEY, kind);
    doneShown = DONE_PAGE;
    paint();
  };

  const matches = (r: ReadingItem) => {
    if (kindFilter && shelfKind(r) !== kindFilter) return false;
    // A Short you've watched is gone by tomorrow: it shows under Shorts or a search, not among what you finished.
    if (!kindFilter && !query && r.status === "done" && shelfKind(r) === "short") return false;
    if (!query) return true;
    const m = r.meta ?? {};
    const hay = `${r.title} ${makerOf(r)} ${r.recommender?.name ?? ""} ${readingMeta(r.kind).label} ${m.year ?? ""} ${[...(m.genres ?? []), ...(m.lists ?? []), ...(m.tags ?? [])].join(" ")}`.toLowerCase();
    return query.split(/\s+/).every((word) => hay.includes(word));
  };

  /** Move an item on, say so, and offer the way back. */
  async function move(r: ReadingItem, to: ReadingStatus, said: string) {
    const from = r.status;
    arrived = r.id;
    try {
      await saveReading({ status: to }, r.id);
      showToast(said, { icon: to === "done" ? "check" : "play", action: { label: "Undo", run: () => void saveReading({ status: from }, r.id) } });
    } catch (error) {
      arrived = null;
      showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff" });
    }
  }

  /** A card folds away before the page repaints without it. */
  function leave(node: HTMLElement, then: () => void) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return then();
    node.classList.add("is-leaving");
    setTimeout(then, 200);
  }

  /**
   * One thing, cover first. Under it: how far through it is (in progress),
   * then its name and who made it. A made cover already prints both, so only
   * a picture gets them written underneath. Start or Finish rides the
   * cover's corner; a tap anywhere else opens the sheet.
   */
  function card(r: ReadingItem): HTMLElement {
    const meta = readingMeta(r.kind);
    const pictured = Boolean(r.art);
    const from = r.recommender ? `From ${r.recommender.name.split(" ")[0]}` : "";
    const rated = stars.get(r.id);
    const fraction = r.status === "reading" ? progressFraction(r.progress, r.status) : null;
    const where = r.status === "reading" && r.progress ? progressWords(r.progress) : "";
    const length = r.status === "done" ? "" : lengthOf(r);
    // A film's or a book's year tells two of the same name apart; a video's says little.
    const year = r.meta?.year && r.kind !== "video" && shelfKind(r) !== "music" ? String(r.meta.year) : "";
    // The year leads: it's short, and a long name can then run out of room without taking it along.
    // A made cover prints its own title and maker along the bottom, so its length is said under it, not on it.
    const sub = r.status === "done" ? doneLine(r) : [pictured ? "" : length, pictured || !makerOf(r) ? year : "", pictured ? makerOf(r) : "", from].filter(Boolean).join(" · ");
    const said = `${r.title}${makerOf(r) ? `, ${makerOf(r)}` : ""}${length ? `, ${length}` : ""}${where ? `: ${where}` : r.status === "done" && sub ? `: ${sub}` : ""}`;
    const open = h(
      "button",
      { class: "watch-card__open cover-lift", type: "button", "aria-label": said },
      h("span", { class: "watch-card__cover" }, readingCover(r), length && pictured ? h("span", { class: "watch-card__len", "aria-hidden": "true" }, length) : null),
      fraction === null
        ? null
        : h(
            "span",
            { class: "watch-card__track", role: "progressbar", "aria-label": `${r.title}: ${where}`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)) },
            h("span", { class: "watch-card__fill", style: `--p:${fraction.toFixed(3)}` })
          ),
      where ? h("span", { class: "watch-card__where" }, where) : null,
      pictured ? h("span", { class: "watch-card__title" }, r.title) : null,
      sub ? h("span", { class: "watch-card__sub" }, sub) : null,
      rated ? h("span", { class: "watch-card__stars" }, ratingStars(rated)) : null
    );
    open.addEventListener("click", () => openReadingSheet(r));
    const el = h("li", { class: `watch-card${arrived === r.id ? " is-arriving" : ""}`, "data-shape": shapeOf(r), "data-status": r.status }, open);
    if (r.status !== "done") {
      const next: ReadingStatus = r.status === "queued" ? "reading" : "done";
      const words = next === "reading" ? `Start ${meta.status.reading.toLowerCase()}` : "Finish";
      const act = h("button", { class: `icon-btn icon-btn--sm watch-card__act watch-card__act--${next === "reading" ? "start" : "finish"}`, type: "button", "aria-label": `${words}: ${r.title}`, title: words }, next === "reading" ? icons.play() : icons.check());
      act.addEventListener("click", () => leave(el, () => void move(r, next, `${meta.status[next]}: ${r.title}`)));
      el.append(act);
    }
    return el;
  }

  /** Every card the same shape: the rail or grid can size itself to it. */
  const oneShape = (rows: ReadingItem[]): Shape | "mixed" => {
    const first = rows.length ? shapeOf(rows[0]) : "tall";
    return rows.every((r) => shapeOf(r) === first) ? first : "mixed";
  };

  /** A run of covers sideways: a shelf you pull along. */
  /** Mixed shapes with no poster among them: the line they stand on can sit lower. */
  const low = (rows: ReadingItem[]) => (rows.some((r) => shapeOf(r) === "tall") ? {} : { "data-low": "" });
  const rail = (rows: ReadingItem[]) => h("ul", { class: "watch-rail", role: "list", "data-shape": oneShape(rows), ...low(rows) }, ...rows.map(card));
  /** Every cover of a set, wrapped: what "see all" and a chosen kind show. */
  const grid = (rows: ReadingItem[]) => h("ul", { class: "watch-grid", role: "list", "data-shape": oneShape(rows), ...low(rows) }, ...rows.map(card));

  /** A section's title: its name and count, then anything that belongs at its far end. */
  function heading(text: string, n: number, ...end: (Node | null)[]): HTMLElement {
    return h("div", { class: "watch-head" }, h("h2", { class: "watch-title" }, text, h("span", { class: "watch-title__count" }, String(n))), h("span", { class: "watch-head__end" }, ...end.filter(Boolean)));
  }

  /** A shelf's label inside a section: a kind, or who made them. */
  function shelfLabel(text: string, n: number, ...end: (Node | null)[]): HTMLElement {
    return h("div", { class: "watch-head watch-head--shelf" }, h("h3", { class: "group__label" }, text, h("span", { class: "group__count" }, String(n))), h("span", { class: "watch-head__end" }, ...end.filter(Boolean)));
  }

  /** A quiet text button at a heading's end ("See all"). */
  function textButton(text: string, run: () => void): HTMLElement {
    const b = h("button", { class: "watch-link", type: "button" }, text, icons.chevronRight());
    b.addEventListener("click", run);
    return b;
  }

  const section = (...children: (Node | null)[]) => h("section", { class: "group watch-group" }, ...children.filter(Boolean));

  // ---------- The month: what was finished, what was watched, and when ----------
  const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = () => monthKey(new Date());
  /** The month the card shows: this one, or one stepped back to. */
  let statsMonth = thisMonth();
  /** Each month's numbers, as they arrive. */
  const statsBy = new Map<string, MonthStats>();
  const statsAsked = new Set<string>();
  /** The month before one: the genre radar's comparison. */
  const monthBefore = (month: string) => {
    const [yy, mm] = month.split("-").map(Number);
    return monthKey(new Date(yy, mm - 2, 1));
  };
  function askStats(month: string) {
    if (statsAsked.has(month)) return;
    statsAsked.add(month);
    loadWatchStats(month, items)
      .then((st) => {
        statsBy.set(month, st);
        if (month === statsMonth || month === monthBefore(statsMonth)) paint();
      })
      .catch(() => statsAsked.delete(month));
  }

  /** One figure of the month: the number, then what it counts. */
  const figure = (value: string, label: string) => h("div", { class: "watch-stat" }, h("dd", { class: "watch-stat__value" }, value), h("dt", { class: "watch-stat__label" }, label));

  function recap(): HTMLElement | null {
    if (query || kindFilter) return null;
    askStats(statsMonth);
    const [y, m] = statsMonth.split("-").map(Number);
    const current = statsMonth === thisMonth();
    // Shorts aren't counted in what was finished, or shown among its covers.
    const done = items.filter((r) => r.status === "done" && r.finished_at && monthKey(new Date(r.finished_at)) === statsMonth && shelfKind(r) !== "short");
    const st = statsBy.get(statsMonth);
    // Nothing finished and nothing watched this month: the card waits until there is, unless you stepped back to look.
    if (current && !done.length && !st?.plays) return null;

    const counts = new Map<Shelf, number>();
    for (const r of done) counts.set(shelfKind(r), (counts.get(shelfKind(r)) ?? 0) + 1);
    const under = items.filter((r) => r.status === "reading").length;
    const line = done.length
      ? `${countWords(counts).replace(/^./, (c) => c.toUpperCase())} finished${under && current ? `, ${under} on the go` : ""}.`
      : st?.plays
        ? `${[st.films ? `${st.films} ${st.films === 1 ? "film" : "films"}` : "", st.episodes ? `${st.episodes} ${st.episodes === 1 ? "episode" : "episodes"}` : "", st.videos ? `${st.videos} ${st.videos === 1 ? "video" : "videos"}` : ""].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1")} watched.`
        : st
          ? "Nothing logged."
        : current
          ? "Nothing finished yet."
          : "Nothing finished.";

    const step = (by: number, label: string, icon: () => Node, off = false) => {
      const b = h("button", { class: `icon-btn icon-btn--sm icon-btn--ghost watch-recap__step${by < 0 ? " watch-recap__step--back" : ""}`, type: "button", "aria-label": label, title: label }, icon()) as HTMLButtonElement;
      b.disabled = off;
      b.addEventListener("click", () => {
        statsMonth = monthKey(new Date(y, m - 1 + by, 1));
        paint();
      });
      return b;
    };
    const head = h(
      "div",
      { class: "watch-recap__head" },
      h("p", { class: "watch-recap__month" }, `${MONTHS[m - 1]}${y === new Date().getFullYear() ? "" : ` ${y}`}`),
      h("span", { class: "watch-recap__steps" }, step(-1, "The month before", icons.chevronRight), step(1, "The month after", icons.chevronRight, current))
    );

    // The numbers: only the ones that aren't nothing.
    const figures: HTMLElement[] = [];
    // When the headline already counts what was watched, the figures keep to the time.
    const counted = !done.length;
    if (st?.plays) {
      if (st.minutes) figures.push(figure(minutesWords(st.minutes), st.timed < st.plays ? "watched, where the length is known" : "watched"));
      if (!counted && st.films) figures.push(figure(String(st.films), st.films === 1 ? "film" : "films"));
      if (!counted && st.episodes) figures.push(figure(String(st.episodes), `${st.episodes === 1 ? "episode" : "episodes"}${st.shows > 1 ? ` of ${st.shows} shows` : ""}`));
      if (counted && st.shows > 1) figures.push(figure(String(st.shows), "shows"));
      if (!counted && st.videos) figures.push(figure(String(st.videos), st.videos === 1 ? "video" : "videos"));
    }
    // A column a day: time when lengths are known, otherwise how many were watched.
    let chart: HTMLElement | null = null;
    if (st?.plays) {
      const byTime = st.minutes > 0;
      const today = new Date();
      const todayKey = `${thisMonth()}-${String(today.getDate()).padStart(2, "0")}`;
      chart = barChart({
        label: `${byTime ? "Time watched" : "Watched"} each day in ${MONTHS[m - 1]} ${y}`,
        series: [{ name: byTime ? "Watched" : "Plays", cls: "is-watch" }],
        points: st.days.map((d, i) => {
          const date = new Date(y, m - 1, i + 1);
          return {
            label: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
            tick: i === 0 || (i + 1) % 7 === 0 ? String(i + 1) : undefined,
            values: [d.date > todayKey ? null : byTime ? d.minutes : d.plays],
          };
        }),
        format: (v) => (byTime ? (v ? minutesWords(v) : "Nothing") : `${v} watched`),
        note: (i) => (byTime && st.days[i].plays ? `${st.days[i].plays} watched` : ""),
        height: 112,
      });
      chart.classList.add("watch-recap__chart");
    }
    // The genres as a shape, against the month before (asked for once this month has some).
    let genres: HTMLElement | null = null;
    if (st?.mix?.known) {
      const prev = monthBefore(statsMonth);
      askStats(prev);
      const [py, pm] = prev.split("-").map(Number);
      const shape = genreRadar(st.mix, statsBy.get(prev)?.mix);
      if (shape) {
        const titles = st.mix.known;
        genres = h(
          "div",
          { class: "watch-recap__genres" },
          h("p", { class: "watch-recap__genres-title" }, "Genres"),
          radarChart({
            label: `Genres of the films and episodes watched in ${MONTHS[m - 1]} ${y}${shape.before ? `, against ${MONTHS[pm - 1]}` : ""}`,
            axes: shape.axes,
            series: [{ name: MONTHS[m - 1], values: shape.now }, ...(shape.before ? [{ name: `${MONTHS[pm - 1]}${py === y ? "" : ` ${py}`}`, values: shape.before }] : [])],
            format: (v) => `${Math.round(v * 100)}%`,
            height: 240,
          }),
          h("p", { class: "watch-recap__genres-note" }, `Share of ${titles} ${titles === 1 ? "play" : "plays"} with a known genre. A title can count towards more than one.`)
        );
      }
    }
    const mostly = st?.genres.length ? h("p", { class: "watch-recap__mostly" }, `Mostly ${st.genres.length > 1 ? `${st.genres.slice(0, -1).join(", ")} and ${st.genres[st.genres.length - 1]}` : st.genres[0]}.`) : null;

    const card = h(
      "section",
      { class: `watch-recap${chart ? " watch-recap--stats" : ""}`, "aria-label": `${MONTHS[m - 1]} ${y}` },
      h(
        "div",
        { class: "watch-recap__top" },
        h("div", { class: "watch-recap__words" }, head, h("p", { class: "watch-recap__line" }, line), mostly),
        done.length ? h("div", { class: "watch-recap__covers", "aria-hidden": "true" }, ...done.slice(0, 5).map((r) => h("span", { class: "watch-recap__cover", "data-shape": shapeOf(r) }, readingCover(r)))) : null
      ),
      figures.length ? h("div", { class: "watch-stats-row" }, h("dl", { class: "watch-stats" }, ...figures), textButton("Screen time", () => openScreenTime(items))) : null,
      chart,
      genres
    );
    if (done.length) card.style.setProperty("--tone", glowOf(done[0]));
    return card;
  }

  // ---------- For the season: what's on your own lists that suits the time of year ----------
  function seasonShelf(season: Season | null): HTMLElement | null {
    if (!season || query || kindFilter) return null;
    const year = new Date().getFullYear();
    if (stored(SEASON_OFF_KEY, (v): v is string => v === `${season.id}-${year}`)) return null;
    // Still to get to, then the ones you loved before (four stars or more). A genre alone (a horror film in October) only counts while it's unwatched.
    const fits = items
      .map((r) => ({ r, fit: seasonFit(r, season) }))
      .filter(({ r, fit }) => fit === "named" || (fit === "genre" && r.status !== "done"))
      // Seen already: only when you rated it a favourite, so the shelf suggests and doesn't just list history.
      .filter(({ r, fit }) => r.status !== "done" || (fit === "named" && (stars.get(r.id) ?? 0) >= FAVOURITE))
      .sort((a, b) => Number(a.r.status === "done") - Number(b.r.status === "done") || Number(a.fit === "genre") - Number(b.fit === "genre") || (stars.get(b.r.id) ?? 0) - (stars.get(a.r.id) ?? 0))
      .map(({ r }) => r);
    if (!fits.length) return null;
    const hide = h("button", { class: "watch-link watch-link--plain", type: "button" }, "Not now");
    hide.addEventListener("click", () => {
      store(SEASON_OFF_KEY, `${season.id}-${year}`);
      paint();
      showToast(`Put away until next ${season.label}`, { icon: "check", action: { label: "Undo", run: () => (store(SEASON_OFF_KEY, null), paint()) } });
    });
    const again = fits.filter((r) => r.status === "done").length;
    const line = again === fits.length ? "Ones you've seen, for another go." : again ? "From your lists, and a few to go back to." : "Already on your lists.";
    return h("section", { class: "group watch-group watch-season", "data-season": season.id }, heading(`For ${season.label}`, fits.length, hide), h("p", { class: "watch-season__line" }, line), rail(fits));
  }

  // ---------- Up next: by kind, playlist, genre, length or who made it ----------
  /** The shelves one way of grouping makes: each named shelf, then the things that fit none. */
  function shelvesOf(next: ReadingItem[], by: GroupBy): { shelves: Array<{ label: string; rows: ReadingItem[]; all?: () => void }>; rest: ReadingItem[]; restLabel: string } {
    const groups = new Map<string, { label: string; rows: ReadingItem[] }>();
    const put = (key: string, label: string, r: ReadingItem) => {
      const g = groups.get(key) ?? { label, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    };
    const placed = new Set<string>();
    for (const r of next) {
      if (by === "kind") put(shelfKind(r), KIND_PLURAL[shelfKind(r)] ?? readingMeta(r.kind).label, r);
      // In two playlists: on both shelves.
      else if (by === "list") for (const name of r.meta?.lists ?? []) put(name.toLowerCase(), name, r);
      else if (by === "genre") {
        const g = r.meta?.genres?.[0];
        if (g) put(g.toLowerCase(), g, r);
      } else if (by === "length") {
        const m = r.kind !== "tv" ? r.meta?.minutes : undefined;
        const l = m ? LENGTHS.find((x) => m < x.under)! : null;
        if (l) put(l.id, l.label, r);
      } else if (makerOf(r)) put(makerOf(r).toLowerCase(), makerOf(r), r);
    }
    // How many a shelf needs to stand alone: a playlist or a length is one whatever it holds; a lone kind, genre or maker joins the rest.
    const least = by === "kind" || by === "genre" ? OWN_SHELF : by === "maker" ? 2 : 1;
    // Shorts always stand apart, however few: one among the long videos is what the shelf is there to stop.
    let own = [...groups.entries()].filter(([key, g]) => g.rows.length >= least || (by === "kind" && key === "short"));
    if (by === "length") own.sort((a, b) => a[0].localeCompare(b[0]));
    else own.sort((a, b) => b[1].rows.length - a[1].rows.length || (by === "kind" ? shelfOrder(a[0] as Shelf) - shelfOrder(b[0] as Shelf) : a[1].label.localeCompare(b[1].label)));
    // Shortest first on a length shelf: the quick ones are what it's for.
    if (by === "length") own = own.map(([k, g]) => [k, { ...g, rows: [...g.rows].sort((a, b) => (a.meta?.minutes ?? 0) - (b.meta?.minutes ?? 0)) }]);
    for (const [, g] of own) for (const r of g.rows) placed.add(r.id);
    return {
      shelves: own.map(([key, g]) => ({ label: g.label, rows: g.rows, ...(by === "kind" && g.rows.length > 4 ? { all: () => setKind(key as Shelf) } : {}) })),
      rest: next.filter((r) => !placed.has(r.id)),
      restLabel: by === "kind" ? "Everything else" : by === "list" ? "Not in a playlist" : by === "genre" ? "Everything else" : by === "length" ? "Length not known" : "One each",
    };
  }

  function nextSections(next: ReadingItem[]): HTMLElement[] {
    const total = next.length;
    // A search: everything that matches, wrapped.
    if (query) return [section(heading(NEUTRAL_STATUS.queued, total), grid(next))];

    // Only the ways of grouping this list has the data for.
    const has: Record<GroupBy, boolean> = {
      kind: !kindFilter,
      list: next.some((r) => r.meta?.lists?.length),
      genre: next.some((r) => r.meta?.genres?.length),
      length: next.some((r) => r.kind !== "tv" && r.meta?.minutes),
      maker: next.some((r) => makerOf(r)),
    };
    const offered = GROUPS.filter((g) => has[g]);
    const by = has[groupBy] ? groupBy : (offered[0] ?? "kind");
    const pick = (value: GroupBy) => {
      const b = h("button", { class: "watch-switch__item", type: "button", "aria-pressed": String(by === value) }, GROUP_WORDS[value]);
      b.addEventListener("click", () => {
        groupBy = value;
        store(GROUP_KEY, value === "kind" ? null : value);
        paint();
      });
      return b;
    };
    const switcher = offered.length > 1 ? h("span", { class: "watch-switch", role: "group", "aria-label": "Group by" }, ...offered.map(pick)) : null;
    const { shelves, rest, restLabel } = shelvesOf(next, by);
    const out: HTMLElement[] = [heading(NEUTRAL_STATUS.queued, total, switcher)];
    // A chosen kind with nothing to split it by: one wrapped set.
    if (kindFilter && !shelves.length) return [...out, section(grid(next))];
    for (const shelf of shelves) out.push(section(shelfLabel(shelf.label, shelf.rows.length, shelf.all ? textButton("See all", shelf.all) : null), rail(shelf.rows)));
    if (rest.length) out.push(section(shelves.length ? shelfLabel(restLabel, rest.length) : null, rail(rest)));
    return out;
  }

  function paintChips() {
    const active = items.filter((r) => r.status !== "done");
    const counts = new Map<Shelf, number>();
    for (const r of items) counts.set(shelfKind(r), (counts.get(shelfKind(r)) ?? 0) + (r.status === "done" ? 0 : 1));
    // A filter for a kind that's gone from the list would show nothing with no way to see why.
    if (kindFilter && !counts.has(kindFilter)) {
      kindFilter = null;
      store(FILTER_KEY, null);
    }
    const kinds = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || shelfOrder(a) - shelfOrder(b));
    chips.hidden = kinds.length < 2;
    const chip = (kind: Shelf | null, text: string, n: number) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(kindFilter === kind) }, text, n ? h("span", { class: "chip__count" }, String(n)) : null);
      b.addEventListener("click", () => setKind(kind));
      return b;
    };
    chips.replaceChildren(chip(null, "All", active.length), ...kinds.map((k) => chip(k, KIND_PLURAL[k] ?? readingMeta(k).label, counts.get(k)!)));
  }

  function paint() {
    if (!loaded) return;
    paintChips();
    if (!items.length) {
      list.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("span", { class: "tile" }, icons.film()),
          h("p", { class: "empty__title" }, "Nothing on the list"),
          h("p", { class: "empty__sub" }, "Paste a link or type a title above when a book, film, show or album is worth getting to, or when someone recommends one.")
        )
      );
      return;
    }
    const shown = items.filter(matches);
    // Add is the answer when nothing matches; while something does, it steps back so finding comes first.
    addBtn.classList.toggle("btn--primary", !shown.length);
    addBtn.classList.toggle("btn--soft", shown.length > 0);
    const by = (s: ReadingStatus) => shown.filter((r) => r.status === s);
    const now = by("reading");
    const next = by("queued");
    const done = by("done");

    if (!shown.length) {
      const typed = bar.value.trim();
      const what = kindFilter ? (KIND_PLURAL[kindFilter] ?? "").toLowerCase() : "";
      const add = typed ? h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.plus(), `Add “${typed.length > 40 ? `${typed.slice(0, 40)}…` : typed}”`) : null;
      add?.addEventListener("click", addTyped);
      // Back to All, named as the person sees it.
      const all = !typed && kindFilter ? h("button", { class: "btn btn--soft btn--sm", type: "button" }, "See everything") : null;
      all?.addEventListener("click", () => setKind(null));
      list.replaceChildren(
        h(
          "div",
          { class: "empty watch-empty" },
          h("span", { class: "tile" }, icons.search()),
          h("p", { class: "empty__title" }, typed ? "Not on the list yet" : `No ${what} on the list`),
          h("p", { class: "empty__sub" }, typed ? (kindFilter ? `Nothing in ${KIND_PLURAL[kindFilter]} matches. Press Enter to add it.` : "Press Enter to add it.") : "Type a title above to add one."),
          add,
          all
        )
      );
      return;
    }

    const sections: (HTMLElement | null)[] = [recap()];
    if (now.length) sections.push(section(heading(NEUTRAL_STATUS.reading, now.length), rail(now)));
    sections.push(seasonShelf(seasonOn(new Date())));
    if (next.length) sections.push(h("div", { class: "watch-block" }, ...nextSections(next)));
    // The ones given four stars or more, wherever they are on the list.
    const loved = query || kindFilter ? [] : items.filter((r) => (stars.get(r.id) ?? 0) >= FAVOURITE).sort((a, b) => stars.get(b.id)! - stars.get(a.id)!);
    if (loved.length) sections.push(section(heading("Favourites", loved.length), rail(loved)));
    if (done.length) {
      // A search or a chosen kind shows every finished match; otherwise the latest few, and the rest behind "See all".
      const all = doneAll || Boolean(query) || Boolean(kindFilter);
      if (!all) {
        sections.push(section(heading(NEUTRAL_STATUS.done, done.length, done.length > DONE_RAIL ? textButton("See all", () => ((doneAll = true), paint())) : null), rail(done.slice(0, DONE_RAIL))));
      } else {
        // By the year it was finished, newest first.
        const years = new Map<string, ReadingItem[]>();
        for (const r of done.slice(0, doneShown)) {
          const y = r.finished_at ? String(new Date(r.finished_at).getFullYear()) : "Undated";
          years.set(y, [...(years.get(y) ?? []), r]);
        }
        const fold = doneAll && !query && !kindFilter ? textButton("Show fewer", () => ((doneAll = false), (doneShown = DONE_PAGE), paint())) : null;
        const more = done.length > doneShown ? h("button", { class: "btn btn--soft btn--sm watch-more", type: "button" }, `Show ${Math.min(DONE_PAGE, done.length - doneShown)} more`) : null;
        more?.addEventListener("click", () => {
          doneShown += DONE_PAGE;
          paint();
        });
        sections.push(section(heading(NEUTRAL_STATUS.done, done.length, fold), ...[...years.entries()].flatMap(([y, rows]) => [years.size > 1 ? h("h3", { class: "group__label watch-year" }, y) : null, grid(rows)]), more));
      }
    }
    list.replaceChildren(...(sections.filter(Boolean) as HTMLElement[]));
    arrived = null;
  }

  async function load() {
    const [{ items: loadedItems }, kv] = await Promise.all([loadReading(), loadKindValues("reading").catch(() => ({ fields: [], values: {} }))]);
    const field = ratingFieldOf(kv.fields, "reading");
    stars = new Map();
    if (field) for (const [id, v] of Object.entries(kv.values)) if (typeof v[field.id] === "number") stars.set(id, v[field.id] as number);
    // Music has its own page, and none of it is here: albums and songs, heard or not, and music videos (views/music.ts).
    items = [...loadedItems].filter((r) => !isMusic(r)).sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
    loaded = true;
    paint();
    // The server looks up lengths, genres and playlists after it replies (netlify/lib/watch-enrich.ts): ask once more for what it found.
    if (!askedAgain && !isSampleMode() && items.some((r) => !r.meta?.checked)) {
      askedAgain = true;
      again = window.setTimeout(() => void load().catch(() => undefined), 9000);
    }
  }

  void load();
  const unsub = onMemoryChange((t) => (t === "reading" || t === "all") && void load());
  const unsubFields = onCustomFieldsChange((k) => (k === "reading" || k === null) && void load());
  return {
    el,
    destroy: () => {
      window.clearTimeout(again);
      unsub();
      unsubFields();
    },
  };
}
