/**
 * Saved (migration 0038): the pure rules, shared by the server and the app.
 * Which kind a save is, whether text is a link, what a site is called, and
 * the size caps. No database, no network.
 */

import type { SavedFacts, SavedThing } from "./saved-kinds";

export const SAVED_KINDS = ["link", "image", "quote", "snippet", "note"] as const;
export type SavedKind = (typeof SAVED_KINDS)[number];

/** The ways in that Athena ships itself. */
export const SAVED_SOURCES = ["shortcut", "extension", "share-target", "app", "email"] as const;
/**
 * How an item arrived: one of Athena's own ways in, or the short name another client gives itself ("raycast").
 * It's kept readable and nothing branches on it, so a new client needs no change here.
 */
export type SavedSource = (typeof SAVED_SOURCES)[number] | (string & {});

/** A letter, then letters, digits or hyphens, 40 at most. The same rule as the column's CHECK (migration 0092). */
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The source a save names, lower-cased; "app" when it names none or one that isn't a short plain name. */
export function cleanSource(raw: unknown): SavedSource {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SOURCE_NAME.test(name) ? name : "app";
}

/** Caps: text, selection and note each; a title; an image; the whole request; the readable copy. */
export const MAX_SAVED_TEXT = 20_000;
export const MAX_SAVED_TITLE = 300;
export const MAX_SAVED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SAVED_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_READABLE_CHARS = 200_000;
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_TAGS = 12;

export interface SavedItem {
  id: string;
  kind: SavedKind;
  url: string | null;
  title: string | null;
  site: string | null;
  author: string | null;
  published_at: string | null;
  excerpt: string | null;
  quote: string | null;
  note: string | null;
  tags: string[];
  source: SavedSource;
  source_url: string | null;
  image_url: string | null;
  image_w: number | null;
  image_h: number | null;
  image_tone: string | null;
  saved_at: string;
  saved_on: string;
  archived: boolean;
  has_readable: boolean;
  fetch_status: "ok" | "preview" | "failed" | null;
  /** Only on GET /api/saved/:id: the clean article text, paragraphs split by blank lines. */
  readable?: string | null;
  /** Words in the readable copy, for "6 min read". */
  words?: number | null;
  /** What it is, read from the page (lib/saved-kinds.ts): book, film, product, place… Null when it's nothing in particular. */
  thing?: SavedThing | null;
  /** What's known about it: author, ISBN, price, address… */
  facts?: SavedFacts | null;
  /** Where an action filed it (lib/saved-actions.ts). Filed items leave the main list and show under Filed. */
  filed?: SavedFiled | null;
  /** Lists only (GET /api/saved): the best price now, when the item has checks since it was saved (lib/trackers-store.ts pricesNow: the item's price tracker). Its own page keeps the saved price. */
  price_now?: { amount: string; currency: string; shop: string | null } | null;
}

/** Where an item went: "Rowan · Gift ideas", opening #/notes/<id>. */
export interface SavedFiled {
  at: string;
  /** The action that filed it, e.g. "gift_idea". */
  action: string;
  label: string;
  /** An app route ("#/notes/<id>"), or null when there's nowhere to open. */
  href: string | null;
}

const URL_AT_START = /^(https?:\/\/[^\s<>"']+)/i;

/** A web address as typed or shared: http(s), a host with a dot, no credentials. Null otherwise. */
export function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/[)\].,;:!?'"»”]+$/, "");
  if (!s) return null;
  if (/^www\.[^\s]+\.[a-z]{2,}/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
  if (!u.hostname.includes(".") || u.hostname.endsWith(".")) return null;
  u.hash = u.hash && /^#:~:text=/.test(u.hash) ? "" : u.hash;
  return u.toString();
}

/**
 * Text that is a link, or starts with one: the link and whatever follows
 * (a Share sheet often sends "Title https://…" or "https://… note"). A
 * link anywhere else in longer text stays text.
 */
export function leadingUrl(text: string): { url: string; rest: string } | null {
  const t = text.trim();
  const m = t.match(URL_AT_START) ?? t.match(/^(www\.[^\s<>"']+)/i);
  if (m) {
    const url = cleanUrl(m[1]);
    if (url) return { url, rest: t.slice(m[1].length).trim() };
  }
  // "Some title\nhttps://…" or "Some title https://…" with the link last: Safari's share text.
  const last = t.match(/^([^\n]{0,300}?)\s+(https?:\/\/[^\s<>"']+)$/i);
  if (last && !/https?:\/\//i.test(last[1])) {
    const url = cleanUrl(last[2]);
    if (url) return { url, rest: last[1].trim() };
  }
  return null;
}

/** Looks like code: several lines with code punctuation, or one line that's clearly a command or expression. */
export function looksLikeCode(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^```/.test(t)) return true;
  const lines = t.split("\n");
  const codeLine = (l: string) =>
    /[;{}]\s*$/.test(l) ||
    /^\s*(const|let|var|function|def|class|import|export|return|if|for|while|SELECT|INSERT|UPDATE|CREATE|#include|package|fn|pub|func)\b/.test(l) ||
    /^\s*(\$|>|npm|npx|git|curl|brew|pip|sudo|cd|ls)\s/.test(l) ||
    /=>|::|\(\)\s*[{:]/.test(l);
  const hits = lines.filter(codeLine).length;
  if (lines.length >= 2) return hits / lines.length >= 0.4 || /^\s{2,}\S/m.test(t) && hits >= 1;
  return hits === 1 && t.length < 400 && (/[(){};=$]/.test(t) || /^\s*(\$|npm|npx|git|curl|brew|pip|sudo)\s/.test(t));
}

export interface SaveInput {
  url?: unknown;
  text?: unknown;
  selection?: unknown;
  title?: unknown;
  note?: unknown;
  source_url?: unknown;
  hasImage?: boolean;
}

export interface SavePlan {
  kind: SavedKind;
  url: string | null;
  title: string | null;
  quote: string | null;
  note: string | null;
  source_url: string | null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return t ? t.slice(0, max) : null;
};

export class SaveTooBig extends Error {}

/**
 * What a save is, in the contract's order: an image; a selection (a quote
 * from the page); a URL, or text that is or starts with one (a link); code
 * (a snippet); other text (a note). Null when there's nothing to keep.
 */
export function planSave(input: SaveInput): SavePlan | null {
  for (const k of ["text", "selection", "note"] as const) {
    const v = input[k];
    if (typeof v === "string" && v.length > MAX_SAVED_TEXT) throw new SaveTooBig(k);
  }
  let url = cleanUrl(input.url);
  let text = str(input.text, MAX_SAVED_TEXT);
  let note = str(input.note, MAX_SAVED_TEXT);
  const selection = str(input.selection, MAX_SAVED_TEXT);
  let title = str(input.title, MAX_SAVED_TITLE)?.replace(/\s+/g, " ") ?? null;
  const source_url = cleanUrl(input.source_url);
  if (!url && text) {
    const lead = leadingUrl(text);
    if (lead) {
      url = lead.url;
      // "Title https://…" from a Share sheet: the words are the page's title; after the link, they're the owner's note.
      const before = text.trim().indexOf(lead.url.replace(/\/$/, "")) > 0 || !/^(https?:\/\/|www\.)/i.test(text.trim());
      if (lead.rest) {
        if (before && !title) title = lead.rest.slice(0, MAX_SAVED_TITLE);
        else note = note ? `${lead.rest}\n\n${note}` : lead.rest;
      }
      text = null;
    }
  }
  if (input.hasImage) return { kind: "image", url: null, title, quote: selection ?? text, note, source_url: source_url ?? url };
  if (selection) return { kind: "quote", url: null, title, quote: selection, note: note ?? text, source_url: source_url ?? url };
  if (url) return { kind: "link", url, title, quote: null, note: note ?? text, source_url: null };
  if (text) return { kind: looksLikeCode(text) ? "snippet" : text.length <= 600 && /^[“"«].+[”"»]/s.test(text) ? "quote" : "note", url: null, title, quote: text, note, source_url };
  if (note) return { kind: "note", url: null, title, quote: note, note: null, source_url };
  return null;
}

/** "nytimes.com" from "https://www.nytimes.com/…". */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^(www|m|mobile|amp)\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Tags as the owner typed them: trimmed, no "#", unique in any case, a few. */
export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== "string") continue;
    const tag = t.replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (tag && !out.some((o) => o.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** "6 min read" from a word count (230 words a minute), null under a minute. */
export function readingTime(words: number | null | undefined): string | null {
  if (!words || words < 150) return null;
  return `${Math.max(1, Math.ceil(words / 230))} min read`;
}

/** What makes two saved links the same page: no fragment, no trailing slash, any case. */
export const savedUrlKey = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();

/** Siri or the Share sheet sent a link (the text is, or starts with, one): it goes to Saved, not the assistant. */
export const captureIsLink = (text: string): boolean => !!leadingUrl(text);
