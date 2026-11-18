/**
 * Rich links' rules, pure (no DOM, no storage, no network) so they can be
 * tested with tsx: when a link preview kept on this device is good enough,
 * when the server's copy replaces it, and how each kind of thing in Athena
 * becomes a live card. app/src/db/rich-links.ts does the reading and
 * keeping; docs/notes/rich-links-stage2s.md has the contract.
 */

import { markdownToText } from "../lib/markdown-text";
import { addDays, localWhen, upcomingOccurrences, zonedToday } from "../../../lib/dates";
import { athenaLinkRegex, parseAthenaLinks, parseLinkMode, unescapeLabel, webLinkRegex, type LinkKind, type LinkMode } from "../../../lib/links";
import { priceText } from "../../../lib/saved-kinds";
import { savedTitle } from "../../../lib/mentions";
import { kindWords, NEUTRAL_STATUS, progressFraction, progressWords, type ReadingKind, type ReadingProgress, type ReadingStatus } from "../../../lib/watch-read";
import type { LinkPreview } from "../../../lib/link-previews";
import type { SavedItem } from "../../../lib/saved-rules";
import type { AthenaEvent, Commitment, Note, Person, Place, ReadingItem } from "../types";

// ---------- links in text (Ask, the briefing) ----------

/** One link in a piece of text: where it is, what it points at and how it's shown. */
export type LinkPiece =
  | { at: number; end: number; target: "athena"; kind: LinkKind; id: string; label: string; mode: LinkMode }
  | { at: number; end: number; target: "web"; url: string; label: string; mode: LinkMode };

/**
 * Every link in the text, athena:// and web, in order, with its mode (the
 * default when it names none; an athena:// embed reads as a card). What
 * components/link-text.ts draws, so no link is left as Markdown.
 */
export function linkPieces(text: string): LinkPiece[] {
  const out: LinkPiece[] = [];
  for (const m of text.matchAll(athenaLinkRegex())) {
    const named = parseLinkMode(m[4] ?? m[5]);
    out.push({ at: m.index!, end: m.index! + m[0].length, target: "athena", kind: m[2] as LinkKind, id: m[3].toLowerCase(), label: unescapeLabel(m[1]), mode: named === "embed" ? "card" : (named ?? "mention") });
  }
  for (const m of text.matchAll(webLinkRegex())) {
    if (out.some((p) => m.index! < p.end && m.index! + m[0].length > p.at)) continue;
    out.push({ at: m.index!, end: m.index! + m[0].length, target: "web", url: m[2], label: unescapeLabel(m[1]), mode: parseLinkMode(m[3] ?? m[4]) ?? "link" });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- link previews kept on this device ----------

/** Ask the server again after a day: its own copy changes at most every 30 days, or on Try again. */
export const PREVIEW_CHECK_HOURS = 24;
/** A failed preview is asked again after an hour, as the server retries a failed page after an hour. */
export const PREVIEW_FAILED_CHECK_MINUTES = 60;

/** A preview as this device keeps it: the server's answer, and when this device last asked. */
export interface StoredPreview {
  preview: LinkPreview;
  /** When this device last had an answer from the server (ms). */
  checked_at: number;
}

/**
 * What loadPreview does with what's on this device:
 *  - "cached": use it as it is (fresh enough, or offline).
 *  - "check": ask the server, keep whichever is newer, and fall back to the copy here if the server can't be reached.
 *  - "fetch": nothing here; ask the server.
 *  - "none": nothing here and no connection.
 */
export type PreviewPlan = "cached" | "check" | "fetch" | "none";

export function previewPlan(stored: StoredPreview | null | undefined, opts: { online: boolean; now?: number; refresh?: boolean }): PreviewPlan {
  const now = opts.now ?? Date.now();
  if (!stored) return opts.online ? "fetch" : "none";
  if (!opts.online) return "cached";
  if (opts.refresh) return "check";
  const age = now - stored.checked_at;
  if (stored.preview.status === "failed") return age >= PREVIEW_FAILED_CHECK_MINUTES * 60_000 ? "check" : "cached";
  return age >= PREVIEW_CHECK_HOURS * 3_600_000 ? "check" : "cached";
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Whether the server's preview replaces the one here: a later good read, a
 * good read where this device only has a failure, or a different picture or
 * favicon (its ?v= changed). A server failure never replaces a good copy.
 */
export function serverIsNewer(here: LinkPreview | null | undefined, server: LinkPreview): boolean {
  if (!here) return true;
  if (server.status === "failed") return here.status === "failed" && server.id !== here.id;
  if (here.status === "failed") return true;
  if (ms(server.fetched_at) > ms(here.fetched_at)) return true;
  return server.image_url !== here.image_url || server.favicon_url !== here.favicon_url || server.id !== here.id;
}

/** The Cache Storage key for a preview's picture or favicon, versioned by its ?v= so a new picture is a new key. */
export function previewPictureKey(preview: Pick<LinkPreview, "id" | "image_url" | "favicon_url">, which: "image" | "favicon"): string | null {
  const src = which === "image" ? preview.image_url : preview.favicon_url;
  if (!src || !src.startsWith("/api/")) return null;
  const v = /[?&]v=([^&]+)/.exec(src)?.[1] ?? "0";
  return `/link-preview-cache/${preview.id}/${which}/${v}`;
}

// ---------- live cards ----------

/** A picture this device can show in an <img> (an object URL from its own cache, or a bundled sample file), with its shape and tint. */
export interface LivePicture {
  src: string;
  w: number | null;
  h: number | null;
  /** The picture's main colour, for the card's --tint. */
  tone: string | null;
}

interface LiveBase {
  kind: LinkKind;
  id: string;
  /** What the card is called. */
  title: string;
  /** Archived in Athena: the card keeps its name, struck through. */
  archived: boolean;
  /** True when this is the last copy on this device, not a fresh read (offline): the card's "Not updated" badge. */
  stale: boolean;
}

export interface PersonCard extends LiveBase {
  kind: "person";
  /** Athena keeps no photos of people today, so this is null and the card shows initials. */
  photo: LivePicture | null;
  relationship: string | null;
  /** When you last caught up (ISO), or null. */
  lastCatchUp: string | null;
  /** The next birthday from today: the date, how many days away, and the age they turn when the year is known. */
  nextBirthday: { date: string; inDays: number; turns: number | null } | null;
}

export interface PlaceCard extends LiveBase {
  kind: "place";
  name: string;
  /** The town or area from the address ("London" from "1 Granary Square, London N1C 4AA"), or null. */
  area: string | null;
  address: string | null;
  /** Athena's still of the spot (an object URL), or null: show the pin icon and address. */
  mapUrl: string | null;
  /** "Open map": the maps app picked for this device in Settings (lib/map-app.ts openMapUrl). Null with no address. */
  openMapUrl: string | null;
  /** The last day you were there ("YYYY-MM-DD"), from your days, or null. */
  lastVisit: string | null;
}

export interface TodoCard extends LiveBase {
  kind: "todo";
  /** "YYYY-MM-DD", or null. */
  due: string | null;
  done: boolean;
  /** Past due and not done. */
  overdue: boolean;
}

export interface WatchCard extends LiveBase {
  kind: "watch";
  cover: LivePicture | null;
  /** Book, film, show… */
  readingKind: ReadingKind;
  /** "Book", "Film", "TV show"… */
  kindLabel: string;
  status: ReadingStatus;
  /** "Reading", "Watching", "Finished"… in the kind's own words. */
  statusLabel: string;
  /** 0 to 1, or null when it's under way and how far isn't known. */
  progress: number | null;
  /** The kept position in words ("Page 120 of 300", "45%"), or null when Athena keeps none. */
  progressText: string | null;
}

export interface SavedCard extends LiveBase {
  kind: "saved";
  image: LivePicture | null;
  /** "£45", or null. */
  price: string | null;
  /** The shop (or brand, or site), or null. */
  shop: string | null;
  url: string | null;
}

export interface EventCard extends LiveBase {
  kind: "event";
  /** Its next day ("YYYY-MM-DD"): this year's for a yearly event, else its own. */
  date: string;
  /** "HH:MM" here, or null for an all-day event. */
  time: string | null;
  /** The first place its notes link to, or null. */
  place: { id: string; name: string } | null;
}

export interface NoteCard extends LiveBase {
  kind: "note";
  /** The opening lines as plain text (Markdown and links read as words), up to about 240 characters. */
  firstLines: string;
  /** When it was last edited (ISO). */
  updated: string;
}

export interface PlainCard extends LiveBase {
  kind: "record" | "organisation" | "project";
  /** "Wine", a website's host, a project's status. */
  subtitle: string;
}

export type LiveCard = PersonCard | PlaceCard | TodoCard | WatchCard | SavedCard | EventCard | NoteCard | PlainCard;

/** Where "today" and the time zone come from; tests pass their own. */
export interface Clock {
  today: string;
  tz: string;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim() || null;

export function personCard(p: Person, clock: Clock, extra: { photo?: LivePicture | null; stale?: boolean } = {}): PersonCard {
  return {
    kind: "person",
    id: p.id,
    title: p.name,
    archived: !!p.archived_at,
    stale: !!extra.stale,
    photo: extra.photo ?? null,
    relationship: clean(p.relationship),
    lastCatchUp: p.last_contacted_at ?? null,
    nextBirthday: nextBirthday(p.birthday, clock),
  };
}

/** A birthday ("YYYY-MM-DD", or "--MM-DD" without the year) as its next day from today. */
export function nextBirthday(birthday: string | null | undefined, clock: Clock): PersonCard["nextBirthday"] {
  if (!birthday) return null;
  const yearKnown = !birthday.startsWith("--");
  const date = yearKnown ? birthday : `2000-${birthday.slice(2)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [o] = upcomingOccurrences([{ date, time: null, starts_at: null, recurrence: "yearly" as const, year_known: yearKnown }], clock.today, 366, clock.tz);
  return o ? { date: o.occurs_on, inDays: o.days_until, turns: o.years } : null;
}

const POSTCODE = /\s*\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|\d{5}(?:-\d{4})?)\b\s*$/i;
const COUNTRY = /^(uk|united kingdom|england|scotland|wales|northern ireland|great britain|gb|usa|us|united states|france|germany|spain|italy|ireland)$/i;

/** The town or area in an address: its last part that isn't a postcode, a country, a US state or a street number. Null for a one-part address. */
export function areaOf(address: string | null | undefined): string | null {
  const parts = (address ?? "")
    .split(/[,\n]/)
    .map((x) => x.trim().replace(POSTCODE, "").replace(/^\d{4,5}\s+/, "").trim())
    .filter((x) => x && !COUNTRY.test(x));
  if (parts.length < 2) return null;
  const named = parts.slice(1).filter((x) => !/^\d/.test(x) && !/^[A-Z]{2}$/.test(x));
  return named.length ? named[named.length - 1] : null;
}

export function placeCard(p: Place, extra: { mapUrl?: string | null; openMapUrl?: string | null; lastVisit?: string | null; stale?: boolean } = {}): PlaceCard {
  return {
    kind: "place",
    id: p.id,
    title: p.name,
    name: p.name,
    archived: !!p.archived_at,
    stale: !!extra.stale,
    area: areaOf(p.address),
    address: clean(p.address),
    mapUrl: extra.mapUrl ?? null,
    openMapUrl: extra.openMapUrl ?? null,
    lastVisit: extra.lastVisit ?? null,
  };
}

export function todoCard(c: Commitment, clock: Clock, extra: { stale?: boolean } = {}): TodoCard {
  const done = c.status === "done";
  return {
    kind: "todo",
    id: c.id,
    title: c.title,
    archived: !!c.archived_at || c.status === "dropped",
    stale: !!extra.stale,
    due: c.due_on ?? null,
    done,
    overdue: !done && !!c.due_on && c.due_on < clock.today,
  };
}

/**
 * How far through something is: finished is 1; then its progress field
 * (0042) when that gives a share; then up next is 0; then any "45%" or
 * "120 of 300" in its notes.
 */
export function readingProgress(status: ReadingStatus, notes: string | null | undefined, kept?: ReadingProgress | null): number | null {
  if (status === "done") return 1;
  const field = kept ? progressFraction(kept, status) : null;
  if (field !== null) return field;
  if (status === "queued") return 0;
  const text = notes ?? "";
  const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
  if (pct) {
    const n = Number(pct[1]);
    if (n >= 0 && n <= 100) return n / 100;
  }
  const of = /\b(\d{1,5})\s*(?:of|\/)\s*(\d{1,5})\b/i.exec(text);
  if (of) {
    const [a, b] = [Number(of[1]), Number(of[2])];
    if (b > 0 && a <= b) return a / b;
  }
  return null;
}

export function watchCard(r: ReadingItem, extra: { cover?: LivePicture | null; stale?: boolean } = {}): WatchCard {
  const words = kindWords(r.kind);
  const status = (words.status ?? NEUTRAL_STATUS)[r.status] ?? NEUTRAL_STATUS[r.status];
  return {
    kind: "watch",
    id: r.id,
    title: r.title,
    archived: !!r.archived_at,
    stale: !!extra.stale,
    cover: extra.cover ?? null,
    readingKind: r.kind,
    kindLabel: words.label,
    status: r.status,
    statusLabel: status,
    progress: readingProgress(r.status, r.notes, r.progress),
    progressText: r.progress ? progressWords(r.progress) : null,
  };
}

export function savedCard(s: SavedItem, extra: { image?: LivePicture | null; stale?: boolean } = {}): SavedCard {
  const facts = s.facts ?? null;
  return {
    kind: "saved",
    id: s.id,
    title: savedTitle(s),
    archived: !!s.archived,
    stale: !!extra.stale,
    image: extra.image ?? null,
    price: facts ? (priceText(facts) ?? null) : null,
    shop: clean(facts?.shop) ?? clean(s.site),
    url: s.url,
  };
}

export function eventCard(e: AthenaEvent, clock: Clock, extra: { placeName?: (id: string) => string | null; stale?: boolean } = {}): EventCard {
  const when = localWhen(e, clock.tz);
  const next = e.recurrence === "yearly" ? upcomingOccurrences([e], clock.today, 366, clock.tz)[0] : undefined;
  const link = parseAthenaLinks(e.notes ?? "").find((l) => l.kind === "place");
  const name = link ? (extra.placeName?.(link.id) ?? link.label.replace(/^@/, "")) : null;
  return {
    kind: "event",
    id: e.id,
    title: e.title,
    archived: !!e.archived_at,
    stale: !!extra.stale,
    date: next?.occurs_on ?? when.date,
    time: next ? next.time : when.time,
    place: link && name ? { id: link.id, name } : null,
  };
}

/** A note's opening lines as plain text: its title left out when the body starts with it. */
export function firstLines(note: Pick<Note, "title" | "body">, max = 240): string {
  let text = markdownToText(note.body ?? "");
  const title = note.title.trim();
  if (title && text.startsWith(title)) text = text.slice(title.length);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (lines.length <= max) return lines;
  const cut = lines.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).trimEnd()}…`;
}

export function noteCard(n: Note, extra: { stale?: boolean } = {}): NoteCard {
  return {
    kind: "note",
    id: n.id,
    title: n.title.trim() || markdownToText(n.body ?? "").split("\n")[0].slice(0, 80) || "Untitled",
    archived: !!n.archived_at,
    stale: !!extra.stale,
    firstLines: firstLines(n),
    updated: n.updated_at,
  };
}

export function plainCard(kind: PlainCard["kind"], id: string, title: string, subtitle: string, extra: { archived?: boolean; stale?: boolean } = {}): PlainCard {
  return { kind, id, title, subtitle, archived: !!extra.archived, stale: !!extra.stale };
}

/** A website's host, for an organisation's subtitle: "netlify.com". */
export function hostOf(website: string | null | undefined): string {
  const w = (website ?? "").trim();
  if (!w) return "";
  try {
    return new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A copy marked as the last one on this device ("Not updated"). */
export const asStale = <T extends LiveCard>(card: T): T => ({ ...card, stale: true });

/** Today here, for a Clock. */
export const clockFor = (tz: string, at = new Date()): Clock => ({ today: zonedToday(at, tz), tz });

/** For tests and the sample data: a day `n` days from `today`. */
export const dayFrom = (today: string, n: number): string => addDays(today, n);
