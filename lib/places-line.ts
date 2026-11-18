/**
 * The Places section of a Life log day, in words: shared by the server
 * (lib/places-visits.ts), the Life log keepers (lib/youtube-takeout.ts) and
 * the app. Pure: no database, no network.
 *
 *   ## Places
 *   Lunch at Dishoom, then Hampstead Heath
 *   14° and rain in London
 */
import { zonedParts } from "./dates";

// ---------- Shapes ----------

export type VisitKind = "home" | "work";
/** What kind of stop, for "Lunch at …": only these three change the words. */
export type StopCategory = "food" | "coffee" | "drinks";

/** One Swarm check-in, as the Swarm adapter returns it. */
export interface Checkin {
  id: string;
  at: string;
  lat: number;
  lng: number;
  venue: string;
  venue_id?: string;
  category?: string;
  town?: string;
}

/** One stop in a day, merged from both sources. */
export interface Visit {
  start: string;
  end: string;
  lat: number;
  lng: number;
  gid?: string;
  fsq?: string;
  kind?: VisitKind;
  /** Swarm's venue name, or the name given with a visit added by hand. */
  venue?: string;
  /** The name in an older Takeout file. */
  takeout?: string;
  category?: StopCategory;
  town?: string;
  timeline?: boolean;
  swarm?: boolean;
  /** Added by hand (lib/places-visits.ts addManualVisit), alone or merged into a Timeline visit or a check-in. */
  manual?: boolean;
  /** The ids of the visits added by hand that are this stop. */
  manual_ids?: string[];
  /** The address typed in with a visit added by hand: a Place made from it keeps it. */
  address?: string;
  /** Filled in by naming (a visit added by hand to a saved Place comes with it). */
  name?: string;
  place?: string;
}

/** "Indian Restaurant", "Coffee Shop", "pub" (Foursquare category or OSM type) → the three that change the words. */
export function categoryOf(raw: string | undefined | null): StopCategory | undefined {
  if (!raw) return undefined;
  if (/coffee|caf[eé]|tea ?room|bakery|patisserie|espresso/i.test(raw)) return "coffee";
  if (/\b(pub|bar|brewery|brewpub|wine|cocktail|biergarten|beer|nightclub|taproom|speakeasy)\b/i.test(raw)) return "drinks";
  if (/restaurant|diner|bistro|brasserie|steakhouse|pizz|sushi|ramen|noodle|burger|food|eatery|kitchen|taqueria|dining|gastropub|canteen|deli|dumpling|bbq|grill/i.test(raw)) return "food";
  return undefined;
}

// ---------- The line ----------

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function localHour(iso: string, tz: string): number {
  const p = zonedParts(new Date(iso), tz);
  return p.hour + p.minute / 60;
}

/** "lunch at Dishoom", "coffee at Gail's", or just the name. */
function phrase(v: Visit, tz: string): string {
  const h = localHour(v.start, tz);
  const n = v.name!;
  if (v.category === "food") {
    if (h >= 6 && h < 11) return `breakfast at ${n}`;
    if (h >= 11.5 && h < 15.5) return `lunch at ${n}`;
    if (h >= 17.5 && h < 23) return `dinner at ${n}`;
  }
  if (v.category === "coffee" && h >= 6 && h < 18) return `coffee at ${n}`;
  if (v.category === "drinks" && h >= 16) return `drinks at ${n}`;
  return n;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const MAX_STOPS = 6;

/**
 * The day in a line: "Lunch at Dishoom, then Hampstead Heath". Home is left
 * out unless it's the whole day ("Home all day"); the same place twice in a
 * row is said once. Unnamed stops are skipped. Null when there's nothing to say.
 */
export function placesLine(visits: Visit[], tz: string): string | null {
  if (!visits.length) return null;
  if (visits.every((v) => v.kind === "home")) return "Home all day";
  const said: string[] = [];
  let last = "";
  for (const v of visits) {
    if (!v.name || v.kind === "home") continue;
    if (fold(v.name) === last) continue;
    last = fold(v.name);
    said.push(phrase(v, tz));
  }
  if (!said.length) return null;
  const shown = said.slice(0, MAX_STOPS);
  const more = said.length - shown.length;
  const joined = more ? `${shown.join(", ")} and ${more} more` : shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")}, then ${shown[shown.length - 1]}`;
  return upperFirst(joined);
}

// ---------- In the day note ----------

export const PLACES_HEADING = "## Places";
/** lib/health.ts puts its section first; Places goes under it. */
const HEALTH_HEADING = "## Health";
const HEADING = /^#{1,6}\s/;

function strip(body: string): string {
  const out: string[] = [];
  let inside = false;
  for (const l of body.split("\n")) {
    if (l.trim() === PLACES_HEADING) {
      inside = true;
      continue;
    }
    if (inside && HEADING.test(l)) inside = false;
    if (!inside) out.push(l);
  }
  return out.join("\n").replace(/^\s*\n/, "").replace(/\n{3,}/g, "\n\n");
}

/** The lines in a body's Places section, or null when it has none. */
export function placesSectionIn(body: string): string[] | null {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim() === PLACES_HEADING);
  if (at < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (HEADING.test(l)) break;
    if (l.trim()) out.push(l.trim());
  }
  return out;
}

/** The body with these lines as its Places section: under Health when the note starts with it, else at the top. Empty or null takes the section out. */
export function withPlacesSection(body: string, lines: string[] | null): string {
  const rest = strip(body).trim();
  if (!lines?.length) return rest === body.trim() ? body : rest;
  const section = `${PLACES_HEADING}\n${lines.join("\n")}`;
  let next: string;
  if (rest.startsWith(HEALTH_HEADING)) {
    const ls = rest.split("\n");
    const end = ls.findIndex((l, i) => i > 0 && HEADING.test(l));
    const health = (end < 0 ? ls : ls.slice(0, end)).join("\n").trim();
    const after = end < 0 ? "" : ls.slice(end).join("\n").trim();
    next = `${health}\n\n${section}${after ? `\n\n${after}` : ""}`;
  } else next = `${section}${rest ? `\n\n${rest}` : ""}`;
  return next.trim() === body.trim() ? body : next;
}

/**
 * The Places import's part of keepImported (lib/youtube-takeout.ts): when a
 * Life log run rewrites a day, the Places section from the note it replaces
 * goes back in, in place of any the run wrote.
 */
export function keepPlaces(previous: string, next: string): string {
  const lines = placesSectionIn(previous);
  return lines ? withPlacesSection(next, lines) : next;
}

/** Text for Ask or a collection's search: the Places section goes. */
export function withoutPlaces(text: string): string {
  if (!text || !text.includes(PLACES_HEADING)) return text;
  return strip(text);
}

/** A question about where the owner went: Ask may then read the Places lines. */
export function isPlacesQuestion(text: string): boolean {
  return /\b(where|places?|went|go(ne)?|been|visit(ed|s|ing)?|trips?|travel(l?ed|l?ing)?|holidays?|vacation|abroad|weather|rain(ed|y|ing)?|sunny|snow(ed)?|restaurants?|caf[eé]s?|pubs?|bars?|lunch|dinner|breakfast|brunch|coffee|drinks|swarm|foursquare|check(ed)?[- ]?ins?|timeline|city|town|park)\b/i.test(text);
}

