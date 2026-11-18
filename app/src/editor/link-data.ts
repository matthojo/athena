/**
 * Where the editor's rich links get their data: one small interface, so the
 * nodes, peeks and menus never reach into the database themselves.
 *
 * The source is app/src/db/rich-links.ts, adapted in link-data-real.ts and
 * plugged in once at start-up (main.ts) with `setLinkData(realLinkData)`.
 * Sample mode keeps the player and page previews below (local pictures,
 * nothing fetched); its live cards come from the sample data through 2S.
 *
 * Dates are ISO strings; the renderer words them.
 */

import type { LinkKind } from "../../../lib/links";
import type { Embed } from "../../../lib/embeds";

/** GET /api/link-preview's answer (lib/link-previews.ts LinkPreview), as far as the editor reads it. */
export interface LinkPreview {
  id: string;
  url: string;
  status: "ok" | "failed";
  title: string | null;
  summary: string | null;
  site_name: string;
  author: string | null;
  kind: string | null;
  facts: unknown;
  image_url: string | null;
  image_w: number | null;
  image_h: number | null;
  image_tone: string | null;
  shape: "wide" | "square" | "tall" | null;
  favicon_url: string | null;
  fetched_at: string | null;
  embed: Embed | null;
}

/** What a thing in Athena shows on its live card, per kind. `archived` draws the struck-through card; `stale` is a copy kept on this device ("Not updated"). */
export type LiveCard = { archived?: boolean; stale?: boolean; title: string } & (
  | { kind: "person"; photo: string | null; relation: string | null; lastCatchUp: string | null; birthday: string | null }
  | { kind: "place"; area: string | null; lastVisit: string | null; map: string | null; mapDark?: string | null; openMap?: string | null }
  | { kind: "todo"; due: string | null; done: boolean }
  | { kind: "watch"; type: string; status: string; progress: number | null; progressText?: string | null; cover: string | null }
  | { kind: "saved"; price: string | null; shop: string | null; image: string | null }
  | { kind: "event"; startsAt: string; where: string | null }
  | { kind: "note"; lines: string[]; editedAt: string }
  | { kind: "organisation" | "project" | "record"; subtitle: string | null }
);

export interface LinkData {
  /** A web page's preview, or null when there's none (offline, no key). `refresh` is the failed card's Try again. */
  loadPreview(url: string, opts?: { refresh?: boolean }): Promise<LinkPreview | null>;
  /** A thing's live card, or null when it can't be found here. */
  liveCard(kind: LinkKind, id: string): Promise<LiveCard | null>;
  /** Called when a thing's card should be drawn again. Returns an unsubscribe. */
  onLiveChange(fn: (kind: LinkKind, id: string) => void): () => void;
  /** Tick or untick a to-do; resolves to whether it's now done. */
  toggleTodo(id: string): Promise<boolean>;
  /** Both resolve to the toast's Undo, when the source can undo it. */
  logCatchUp(personId: string): Promise<{ undo?: () => Promise<void> }>;
  markWatched(id: string): Promise<{ undo?: () => Promise<void> }>;
  /** Optional. A Saved item's collections, with the one it's in marked, for the menu's "Move to…"; null when not known yet. */
  savedCollections?(id: string): { id: string; name: string; current: boolean }[] | null;
  /** Resolves to the toast's words when the source has its own. */
  moveSaved?(id: string, collectionId: string): Promise<string | void>;
  /** Optional. A reminder the day before an event, for the menu's "Add a reminder". */
  remindEvent?(id: string): Promise<void>;
}

let chosen: LinkData | null = null;

/** Use this source from now on (the integrator passes db/rich-links.ts). */
export function setLinkData(data: LinkData): void {
  chosen = data;
  previews.clear();
  known.clear();
}

/** The source in use. */
export function linkData(): LinkData {
  return chosen ?? unplugged;
}

const previews = new Map<string, Promise<LinkPreview | null>>();

/** One request per address while the page is open; Try again asks afresh. */
const known = new Map<string, LinkPreview | null>();

/** The preview already here for an address (undefined when it hasn't arrived), for menus that open at once. */
export const previewKnown = (url: string): LinkPreview | null | undefined => known.get(url);

export function previewFor(url: string, refresh = false): Promise<LinkPreview | null> {
  if (!refresh) {
    const had = previews.get(url);
    if (had) return had;
  }
  const p = linkData()
    .loadPreview(url, refresh ? { refresh } : undefined)
    .catch(() => null);
  previews.set(url, p);
  // Don't keep a miss (offline): the next look asks again.
  void p.then((r) => {
    if (previews.get(url) !== p) return;
    known.set(url, r);
    if (!r) previews.delete(url);
  });
  return p;
}

// ---------- Before setLinkData: nothing to show yet ----------

const unsupported = () => Promise.reject(new Error("Not available yet"));

const unplugged: LinkData = {
  loadPreview: async () => null,
  liveCard: async () => null,
  onLiveChange: () => () => undefined,
  toggleTodo: unsupported,
  logCatchUp: unsupported,
  markWatched: unsupported,
};

// ---------- Sample mode: local pictures, nothing fetched ----------

const img = (name: string) => `/sample/links/${name}.webp`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SamplePage = Partial<LinkPreview> & { match: RegExp };

/** Sample pages by address: the nine players and a few ordinary pages. Anything else gets a card with no picture. */
const SAMPLE_PAGES: SamplePage[] = [
  { match: /youtube\.com|youtu\.be/, title: "How a canal lock works", site_name: "YouTube", image_url: img("youtube"), shape: "wide", image_tone: "#7a6a52" },
  { match: /vimeo\.com/, title: "Morning on the Thames, in one take", site_name: "Vimeo", image_url: img("vimeo"), shape: "wide", image_tone: "#5f7f9a" },
  { match: /loom\.com/, title: "Kitchen plans, walked through", site_name: "Loom", image_url: img("loom"), shape: "wide", image_tone: "#6c64d8" },
  { match: /spotify\.com/, title: "Sunday Slow", summary: "Playlist", site_name: "Spotify", image_url: img("spotify"), shape: "square", image_tone: "#c4643a" },
  { match: /music\.apple\.com/, title: "Blue Lines", summary: "Album", site_name: "Apple Music", image_url: img("apple-music"), shape: "square", image_tone: "#3a5fc4" },
  { match: /google\.[a-z.]+\/maps|maps\.app\.goo\.gl/, title: "Regent's Park", site_name: "Google Maps", image_url: img("google-maps"), shape: "wide", image_tone: "#4f9a6a" },
  { match: /maps\.apple\.com/, title: "Columbia Road Flower Market", site_name: "Apple Maps", image_url: img("apple-maps"), shape: "wide", image_tone: "#3a8bf5" },
  { match: /figma\.com/, title: "Flat floor plan", site_name: "Figma", image_url: img("figma"), shape: "wide", image_tone: "#a259ff" },
  { match: /framer\.(website|app)/, title: "Supper club", site_name: "Framer", image_url: img("framer"), shape: "wide", image_tone: "#0055ff" },
  {
    match: /walk/,
    title: "A slow walk along Regent's Canal",
    summary: "Nine miles from Little Venice to Limehouse, with locks, narrowboats and three good cafés on the way.",
    site_name: "The Long Way Round",
    image_url: img("article-walk"),
    shape: "wide",
    image_tone: "#6f8a5c",
  },
  {
    match: /coffee/,
    title: "The case for a better cup at home",
    summary: "Grind fresh, weigh it, and don't boil the water.",
    site_name: "Brew Notes",
    image_url: img("article-coffee"),
    shape: "square",
    image_tone: "#8a5a3c",
  },
  { match: /gone|404/, status: "failed" },
];

function samplePreview(url: string): LinkPreview {
  const page = SAMPLE_PAGES.find((p) => p.match.test(url));
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep the address */
  }
  return {
    id: `sample-${host}`,
    url,
    status: "ok",
    title: null,
    summary: null,
    site_name: host,
    author: null,
    kind: null,
    facts: null,
    image_url: null,
    image_w: null,
    image_h: null,
    image_tone: null,
    shape: null,
    favicon_url: null,
    fetched_at: new Date().toISOString(),
    embed: null,
    ...(page ? { ...page, match: undefined } : {}),
  } as LinkPreview;
}

/** Sample mode's previews: the players and pages above, after a short wait like a real fetch. */
export async function samplePreviewFor(url: string): Promise<LinkPreview> {
  await wait(450);
  return samplePreview(url);
}
