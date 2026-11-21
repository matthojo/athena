/**
 * Sample mode's rich links (app/src/db/rich-links.ts): previews for a few
 * addresses, with pictures from /sample/saved/, a plain card for any other
 * address, a drawn map for places, a last visit and Watch & read covers.
 * Nothing here touches the network.
 */

import { embedFor } from "../../../lib/embeds";
import { siteOf } from "../../../lib/saved-rules";
import type { LinkPreview } from "../../../lib/link-previews";
import type { ReadingItem } from "../types";
import type { LivePicture } from "./rich-links-rules";
import { dayFrom } from "./rich-links-rules";

type Sample = Partial<LinkPreview> & Pick<LinkPreview, "title" | "summary" | "site_name">;

const pic = (file: string, w: number, h: number, tone: string) => ({
  image_url: `/sample/saved/${file}`,
  image_w: w,
  image_h: h,
  image_tone: tone,
  shape: w / h > 1.3 ? ("wide" as const) : w / h < 0.8 ? ("tall" as const) : ("square" as const),
});

/** Keyed by host and path start, so a sample address with any query still matches. */
const SAMPLES: Array<{ match: RegExp; preview: Sample }> = [
  {
    match: /^https:\/\/(www\.)?theguardian\.com\//,
    preview: { title: "Why sleep is the most productive thing you'll do this week", summary: "The hours we lose are the ones that keep what we learned during the day.", site_name: "The Guardian", author: "Hannah Fry", ...pic("night.webp", 1200, 675, "#28324a") },
  },
  {
    match: /^https:\/\/(www\.)?cos\.com\//,
    preview: { title: "Pleated midi dress", summary: "Fluid pleats in a recycled fabric, cut to sit below the knee.", site_name: "COS", kind: "product", facts: { price: "89", currency: "GBP", shop: "COS" }, ...pic("dress.webp", 800, 1000, "#6b4a3a") },
  },
  {
    match: /^https:\/\/(www\.)?bookshop\.org\//,
    preview: { title: "Four Thousand Weeks", summary: "Time management for mortals.", site_name: "Bookshop.org", author: "Oliver Burkeman", kind: "book", facts: { by: "Oliver Burkeman" }, ...pic("book.webp", 800, 1200, "#c9a24a") },
  },
  {
    match: /^https:\/\/(www\.)?letterboxd\.com\/film\//,
    preview: { title: "Guardians of the Galaxy", summary: "A thief, a raccoon and a talking tree end up with an orb half the galaxy wants.", site_name: "Letterboxd", kind: "film", facts: { by: "James Gunn", year: "2014" }, ...pic("film.webp", 800, 1200, "#3a2050") },
  },
  {
    match: /^https:\/\/(www\.)?youtube\.com\/|^https:\/\/youtu\.be\//,
    preview: { title: "A slow walk along Regent's Canal", summary: "Forty minutes from Little Venice to King's Cross, with no talking.", site_name: "YouTube", ...pic("hills.webp", 1280, 720, "#4a6a4a") },
  },
];

/** A sample preview for an address: one of the samples, else a plain card from the address alone. */
export function samplePreview(url: string): LinkPreview {
  const found = SAMPLES.find((s) => s.match.test(url))?.preview;
  const base: LinkPreview = {
    id: `sample-${Math.abs(hash(url)).toString(36)}`,
    url,
    status: "ok",
    title: null,
    summary: null,
    site_name: siteOf(url) || url,
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
    embed: embedFor(url),
  };
  return { ...base, ...(found ?? {}) };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** A sample place's last visit: a recent day, the same for the same place. */
export function sampleLastVisit(placeId: string, today: string): string {
  return dayFrom(today, -(2 + (Math.abs(hash(placeId)) % 19)));
}

/** A drawn map for sample mode: a few streets and a pin, as an SVG data URL. Never a real map. */
export function sampleMapStill(name: string): string {
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const [bg, street, pin] = dark ? ["#1d2126", "#2f353d", "#ff6b5a"] : ["#eef0ea", "#ffffff", "#e5483a"];
  const title = name.replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 320"><title>${title}</title><rect width="600" height="320" fill="${bg}"/><g fill="none" stroke="${street}" stroke-linecap="round"><path d="M-20 92 C 120 70, 220 120, 360 96 S 560 60, 640 84" stroke-width="12"/><path d="M-20 236 C 140 250, 260 206, 420 226 S 560 260, 640 238" stroke-width="9"/><path d="M168 -20 C 150 90, 196 190, 172 340" stroke-width="9"/><path d="M430 -20 C 446 80, 404 200, 438 340" stroke-width="12"/><path d="M-20 160 L 640 170" stroke-width="5"/></g><circle cx="300" cy="166" r="11" fill="${pin}" stroke="${bg}" stroke-width="4"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const COVERS: Record<string, string> = { book: "book.webp", paper: "book.webp", film: "night.webp", tv: "night.webp", video: "night.webp", music: "palette.webp", podcast: "palette.webp", game: "bike.webp", article: "shelf.webp" };

/** A sample cover for a Watch & read title, from /sample/saved/. */
export function sampleCover(r: Pick<ReadingItem, "kind">): LivePicture {
  const file = COVERS[r.kind] ?? "shelf.webp";
  return { src: `/sample/saved/${file}`, w: 2, h: 3, tone: null };
}
