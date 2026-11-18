/**
 * What a saved thing is (Saved actions, migration 0039): a typed reading of a
 * saved page from its JSON-LD (schema.org), Open Graph and a few known sites.
 * A Goodreads page is a book with an author and ISBN, an IMDb page a film or
 * a show, a shop's page a product with a price, a Maps link a place.
 *
 * Pure and shared with the app (the card's "Book · Ottessa Moshfegh" line):
 * no network, no DOM library. `detectFromHtml` takes the page's HTML, which
 * saveItem already has from the readable copy's fetch; `detectFromUrl`
 * works from the address alone (an item saved before 0039, a page that
 * couldn't be read, a Maps link).
 */

export const SAVED_THINGS = ["book", "film", "show", "product", "recipe", "place", "event", "article", "video", "image"] as const;
export type SavedThing = (typeof SAVED_THINGS)[number];

/** What's known about it. Every field is optional; text is short and plain. */
export interface SavedFacts {
  /** Its own name when that differs from the page's title ("Lapvona", not "Lapvona by Ottessa Moshfegh | Goodreads"). */
  name?: string;
  /** Author, director, creator, channel or the recipe's cook. */
  by?: string;
  isbn?: string;
  year?: string;
  /** "45.00" with its currency ("GBP"): a product's price. */
  price?: string;
  currency?: string;
  /** Who sells it: the shop, or the brand when there's no shop. */
  shop?: string;
  /** A place's or event's address, on one line. */
  address?: string;
  /** An event's start, as the page gives it (ISO). */
  starts?: string;
  /** A recipe's total time in minutes. */
  minutes?: number;
  /** IMDb's id, for a film or show ("tt1234567"). */
  imdb?: string;
}

export interface Detected {
  type: SavedThing;
  facts: SavedFacts;
}

const squash = (s: unknown): string | undefined => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() || undefined : undefined);
const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[k] ?? m;
  });

// ---------- from the address ----------

const host = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  } catch {
    return "";
  }
};
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

/** An ISBN-10 or -13 that checks out, or undefined. */
export function cleanIsbn(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.replace(/[\s-]/g, "").toUpperCase() : "";
  if (/^\d{13}$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 && /^97[89]/.test(s) ? s : undefined;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((a, c, i) => a + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? s : undefined;
  }
  return undefined;
}

/** What the address alone says. Null when it says nothing. */
export function detectFromUrl(url: string | null | undefined): Detected | null {
  if (!url) return null;
  const h = host(url);
  const p = pathOf(url);
  // Maps: Google (and its short links), Apple, OpenStreetMap.
  if ((/(^|\.)google\.[a-z.]+$/.test(h) && /^\/maps\b/.test(p)) || h === "maps.google.com" || h === "maps.app.goo.gl" || (h === "goo.gl" && p.startsWith("/maps")) || h === "maps.apple.com" || (h === "openstreetmap.org" && /\/(node|way)\//.test(p))) {
    const place = p.match(/\/maps\/place\/([^/@]+)/)?.[1];
    let name: string | undefined;
    try {
      name = place ? squash(decodeURIComponent(place.replace(/\+/g, " "))) : h === "maps.apple.com" ? squash(new URL(url).searchParams.get("q")) : undefined;
    } catch {
      name = undefined;
    }
    return { type: "place", facts: name ? { name } : {} };
  }
  if (h === "goodreads.com" && /^\/book\/show\//.test(p)) return { type: "book", facts: {} };
  if (h === "openlibrary.org" && /^\/(works|books)\//.test(p)) return { type: "book", facts: {} };
  if ((h === "bookshop.org" || h.endsWith(".bookshop.org")) && /^\/(p\/)?books?\//.test(p)) {
    const isbn = cleanIsbn(p.match(/\/(\d{13})(?:$|[/?])/)?.[1]);
    return { type: "book", facts: isbn ? { isbn } : {} };
  }
  if (/^amazon\.[a-z.]+$/.test(h)) {
    // A book's ASIN is its ISBN-10; other products have B0… ASINs.
    const asin = p.match(/\/(?:dp|gp\/product)\/([0-9A-Z]{10})/i)?.[1];
    const isbn = cleanIsbn(asin);
    if (isbn) return { type: "book", facts: { isbn } };
    if (asin) return { type: "product", facts: { shop: "Amazon" } };
  }
  const tt = p.match(/^\/title\/(tt\d{5,10})/)?.[1];
  if (h === "imdb.com" && tt) return { type: "film", facts: { imdb: tt } };
  if (h === "letterboxd.com" && /^\/film\//.test(p)) return { type: "film", facts: {} };
  if (h === "themoviedb.org" && /^\/movie\//.test(p)) return { type: "film", facts: {} };
  if (h === "themoviedb.org" && /^\/tv\//.test(p)) return { type: "show", facts: {} };
  if (h === "netflix.com" && /^\/(\w{2}(-\w{2})?\/)?title\//.test(p)) return { type: "show", facts: {} };
  if ((h === "youtube.com" && /^\/(watch|shorts\/)/.test(p)) || h === "youtu.be" || (h === "vimeo.com" && /^\/\d+/.test(p))) return { type: "video", facts: {} };
  return null;
}

// ---------- from the page ----------

type Node = Record<string, unknown>;

/**
 * Page metadata is read from the first part of the page only, and with
 * index scans rather than open-ended patterns: every scan below moves forward
 * and never rereads, so a page of unclosed `<script ` or `<meta ` tags costs
 * one pass (security review M18).
 */
export const META_SCAN_CHARS = 300_000;
/** A tag longer than this isn't metadata. */
const MAX_TAG_CHARS = 8_000;

/** Every `<name …>` opening tag in order, with where it ends. One forward pass. */
function* openTags(html: string, name: string): Generator<{ tag: string; end: number }> {
  const low = html.toLowerCase();
  const open = `<${name}`;
  let at = 0;
  for (;;) {
    const start = low.indexOf(open, at);
    if (start < 0) return;
    const after = low.charCodeAt(start + open.length);
    // "<meta" must end the tag name: not "<metadata".
    if ((after >= 97 && after <= 122) || (after >= 48 && after <= 57) || after === 45 || after === 95) {
      at = start + open.length;
      continue;
    }
    const end = low.indexOf(">", start);
    if (end < 0) return;
    if (end - start <= MAX_TAG_CHARS) yield { tag: html.slice(start, end + 1), end: end + 1 };
    at = end + 1;
  }
}

/** Drop every block comment, in one pass. An unclosed one is left as it is. */
function stripBlockComments(s: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = s.indexOf("/*", at);
    const end = start < 0 ? -1 : s.indexOf("*/", start + 2);
    if (end < 0) return out + s.slice(at);
    out += s.slice(at, start);
    at = end + 2;
  }
}

/** Every JSON-LD node on the page, @graph flattened. */
export function jsonLdNodes(html: string): Node[] {
  const out: Node[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      out.push(v as Node);
      const g = (v as Node)["@graph"];
      if (g) walk(g);
    }
  };
  const head = html.length > META_SCAN_CHARS ? html.slice(0, META_SCAN_CHARS) : html;
  const low = head.toLowerCase();
  let from = 0;
  for (const { tag, end } of openTags(head, "script")) {
    if (end < from) continue; // inside the last block's body
    if (!/\stype\s*=\s*["']?application\/ld\+json["']?[\s>]/i.test(tag)) continue;
    const close = low.indexOf("</script>", end);
    if (close < 0) break;
    from = close;
    try {
      // Some sites wrap it in an HTML or CDATA comment (Letterboxd: /* <![CDATA[ */ … /* ]]> */).
      walk(JSON.parse(stripBlockComments(head.slice(end, close)).replace(/<!\[CDATA\[|\]\]>/g, "").trim().replace(/^<!--|-->$/g, "")));
    } catch {
      /* a broken block: skip it */
    }
  }
  return out;
}

/** The page's <meta> tags, read once per page (the last page asked about is remembered). */
let metaOf: { html: string; tags: string[] } | null = null;
function metaTags(html: string): string[] {
  if (metaOf?.html === html) return metaOf.tags;
  const head = html.length > META_SCAN_CHARS ? html.slice(0, META_SCAN_CHARS) : html;
  const tags: string[] = [];
  for (const { tag } of openTags(head, "meta")) tags.push(tag);
  metaOf = { html, tags };
  return tags;
}

/** <meta property|name|itemprop="…" content="…">, first match, decoded. */
export function metaContent(html: string, ...names: string[]): string | undefined {
  const tags = metaTags(html);
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const key = new RegExp(`\\b(?:property|name|itemprop)\\s*=\\s*["']${esc}["']`, "i");
    let v: string | undefined;
    for (const tag of tags) {
      if (!key.test(tag)) continue;
      // The tag's last content="…", as before.
      const all = [...tag.matchAll(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)];
      const m = all[all.length - 1];
      if (!m) continue;
      v = squash(decode(m[1] ?? m[2] ?? ""));
      break;
    }
    if (v) return v;
  }
  return undefined;
}

const types = (n: Node) => ([] as unknown[]).concat(n["@type"] ?? []).map((t) => String(t).replace(/^.*[/#]/, ""));
const nameOf = (v: unknown): string | undefined => {
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first === "string") return squash(first);
  if (first && typeof first === "object") return squash((first as Node).name);
  return undefined;
};
const namesOf = (v: unknown): string | undefined => {
  const list = ([] as unknown[]).concat(v ?? []).map(nameOf).filter(Boolean) as string[];
  return list.length ? list.slice(0, 2).join(" and ") : undefined;
};
const yearOf = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1] : undefined);

/** "PT1H15M" → 75. */
export function isoMinutes(raw: unknown): number | undefined {
  const m = typeof raw === "string" ? raw.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i) : null;
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  const n = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return n > 0 && n < 10_000 ? n : undefined;
}

function addressOf(v: unknown): string | undefined {
  const a = Array.isArray(v) ? v[0] : v;
  if (typeof a === "string") return clip(squash(a), 160);
  if (!a || typeof a !== "object") return undefined;
  const n = a as Node;
  if (n.address) return addressOf(n.address);
  const parts = [n.streetAddress, n.addressLocality, n.postalCode].map(squash).filter(Boolean);
  return parts.length ? clip(parts.join(", "), 160) : undefined;
}

const PLACE_TYPES = /^(Place|LocalBusiness|Restaurant|CafeOrCoffeeShop|BarOrPub|Bakery|FoodEstablishment|Hotel|LodgingBusiness|Museum|TouristAttraction|Store|Park|Winery|Brewery|NightClub|ArtGallery|Library|MovieTheater|Landmarks.*|CivicStructure)$/;
const EVENT_TYPES = /Event$/;
const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|Report|TechArticle|ScholarlyArticle|OpinionNewsArticle|AnalysisNewsArticle|ReviewNewsArticle)$/;

function fromNode(n: Node): Detected | null {
  const t = types(n);
  const has = (re: RegExp) => t.some((x) => re.test(x));
  if (has(/^Book$/)) {
    const work = ([] as unknown[]).concat(n.workExample ?? [])[0] as Node | undefined;
    return { type: "book", facts: { name: nameOf(n.name), by: namesOf(n.author), isbn: cleanIsbn(n.isbn) ?? cleanIsbn(work?.isbn), year: yearOf(n.datePublished) ?? yearOf(work?.datePublished) } };
  }
  if (has(/^Movie$/)) return { type: "film", facts: { name: nameOf(n.name), by: namesOf(n.director), year: yearOf(n.datePublished ?? n.dateCreated) } };
  if (has(/^(TVSeries|TVSeason|TVEpisode|TVShow)$/)) return { type: "show", facts: { name: nameOf(n.name), by: namesOf(n.creator ?? n.director), year: yearOf(n.startDate ?? n.datePublished) } };
  if (has(/^(Product|ProductGroup|IndividualProduct)$/)) {
    const offers = ([] as unknown[]).concat(n.offers ?? []) as Node[];
    const offer = offers.flatMap((o) => (types(o).includes("AggregateOffer") ? [{ ...o, price: o.lowPrice ?? o.price }] : [o])).find((o) => o && (o.price !== undefined || o.priceSpecification)) as Node | undefined;
    const spec = offer?.priceSpecification as Node | undefined;
    const price = offer?.price ?? spec?.price;
    return {
      type: "product",
      facts: {
        name: nameOf(n.name),
        price: price !== undefined && price !== null && String(price).trim() && Number.isFinite(Number(String(price).replace(/,/g, ""))) ? Number(String(price).replace(/,/g, "")).toFixed(2).replace(/\.00$/, "") : undefined,
        currency: squash(offer?.priceCurrency ?? spec?.priceCurrency)?.toUpperCase(),
        shop: nameOf(offer?.seller) ?? nameOf(n.brand),
      },
    };
  }
  if (has(/^Recipe$/)) return { type: "recipe", facts: { name: nameOf(n.name), by: namesOf(n.author), minutes: isoMinutes(n.totalTime) ?? isoMinutes(n.cookTime) } };
  if (has(EVENT_TYPES)) {
    const loc = ([] as unknown[]).concat(n.location ?? [])[0] as Node | string | undefined;
    const venue = typeof loc === "string" ? squash(loc) : nameOf(loc);
    return { type: "event", facts: { name: nameOf(n.name), starts: squash(n.startDate), address: [venue, typeof loc === "object" ? addressOf(loc) : undefined].filter(Boolean).join(", ") || undefined } };
  }
  if (has(PLACE_TYPES)) return { type: "place", facts: { name: nameOf(n.name), address: addressOf(n.address) } };
  if (has(/^VideoObject$/)) return { type: "video", facts: { name: nameOf(n.name), by: namesOf(n.author ?? n.creator) } };
  if (has(ARTICLE_TYPES)) return { type: "article", facts: { by: namesOf(n.author) } };
  return null;
}

/** Strongest first: a page about a book that's also an article is a book. */
const RANK: Record<SavedThing, number> = { book: 9, film: 9, show: 9, recipe: 8, product: 7, event: 7, place: 6, video: 3, article: 2, image: 1 };

const tidy = (facts: SavedFacts): SavedFacts =>
  Object.fromEntries(
    Object.entries(facts)
      .map(([k, v]) => [k, typeof v === "string" ? clip(squash(v), 160) : v])
      .filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as SavedFacts;

/** "Lapvona by Ottessa Moshfegh | Goodreads" → { name: "Lapvona", by: "Ottessa Moshfegh" }. */
function bookTitle(title: string | undefined): { name?: string; by?: string } {
  const t = title?.replace(/\s*[|–—-]\s*(Goodreads|Open Library|Bookshop(\.org)?(\s+UK|\s+US)?)\s*$/i, "").trim();
  const m = t?.match(/^(.+?)\s+by\s+([^|:(]+?)(?:\s*[|:(].*)?$/i);
  return m ? { name: m[1].trim(), by: m[2].trim() } : t ? { name: t } : {};
}

/**
 * What the page is. Null when it's nothing in particular (a plain page with
 * no schema and no known site): the item then has no type, and only the
 * actions that fit anything (a list, a to-do, a link) are offered.
 */
export function detectFromHtml(html: string, url: string, hints: { title?: string | null; author?: string | null; hasText?: boolean } = {}): Detected | null {
  const fromUrl = detectFromUrl(url);
  const found = jsonLdNodes(html)
    .map(fromNode)
    .filter((d): d is Detected => !!d)
    .sort((a, b) => RANK[b.type] - RANK[a.type])[0];
  const og = metaContent(html, "og:type")?.toLowerCase();
  const ogType: SavedThing | null =
    og === "book" || og === "books.book" ? "book" : og === "video.movie" ? "film" : og === "video.tv_show" || og === "video.episode" ? "show" : og === "product" || og === "og:product" || og === "product.item" ? "product" : og === "restaurant.restaurant" || og === "place" || og === "business.business" ? "place" : og === "video.other" ? "video" : og === "article" ? "article" : null;
  // The page's own schema wins over its address (IMDb's TVSeries beats "film" from /title/), the address over a bare og:type.
  let type: SavedThing | null = found?.type ?? null;
  if (fromUrl && (!type || RANK[fromUrl.type] > RANK[type])) type = fromUrl.type;
  if (!type && ogType) type = ogType;
  if (fromUrl?.type === "film" && (found?.type === "show" || ogType === "show")) type = "show";
  if (!type && hints.hasText) type = "article";
  if (!type) return null;
  const facts: SavedFacts = { ...(fromUrl?.facts ?? {}), ...(found && found.type === type ? found.facts : {}) };
  if (type === "book") {
    const t = bookTitle(metaContent(html, "og:title") ?? hints.title ?? undefined);
    facts.name ??= t.name;
    facts.by ??= metaContent(html, "books:author", "book:author") && !/^https?:/.test(metaContent(html, "books:author", "book:author")!) ? metaContent(html, "books:author", "book:author") : (t.by ?? hints.author ?? undefined);
    facts.isbn ??= cleanIsbn(metaContent(html, "books:isbn", "book:isbn", "isbn"));
  }
  if (type === "product") {
    facts.price ??= metaContent(html, "product:price:amount", "og:price:amount")?.replace(/,/g, "").replace(/\.00$/, "");
    facts.currency ??= metaContent(html, "product:price:currency", "og:price:currency")?.toUpperCase();
    facts.shop ??= metaContent(html, "og:site_name");
    if (facts.price && !Number.isFinite(Number(facts.price))) delete facts.price;
  }
  if (type === "place") facts.address ??= metaContent(html, "place:location:address", "restaurant:contact_info:street_address", "business:contact_data:street_address");
  if ((type === "film" || type === "show") && !facts.year) facts.year = yearOf(metaContent(html, "og:title") ?? hints.title ?? undefined);
  if ((type === "article" || type === "video") && !facts.by && hints.author) facts.by = hints.author;
  return { type, facts: tidy(facts) };
}

// ---------- words ----------

export const THING_LABEL: Record<SavedThing, string> = {
  book: "Book",
  film: "Film",
  show: "TV show",
  product: "Product",
  recipe: "Recipe",
  place: "Place",
  event: "Event",
  article: "Article",
  video: "Video",
  image: "Image",
};

const SYMBOL: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", AUD: "A$", CAD: "C$" };

/** "£45", "45 SEK". */
export function priceText(facts: SavedFacts): string | undefined {
  if (!facts.price) return undefined;
  const sym = facts.currency ? SYMBOL[facts.currency] : undefined;
  return sym ? `${sym}${facts.price}` : facts.currency ? `${facts.price} ${facts.currency}` : facts.price;
}

/** The short detail after the type: "Ottessa Moshfegh", "£45 · COS", "45 min". */
export function thingDetail(type: SavedThing, facts: SavedFacts): string | undefined {
  switch (type) {
    case "book":
      return facts.by;
    case "film":
    case "show":
      return [facts.year, facts.by].filter(Boolean).join(" · ") || undefined;
    case "product":
      return [priceText(facts), facts.shop].filter(Boolean).join(" · ") || undefined;
    case "recipe":
      return facts.minutes ? `${facts.minutes} min` : facts.by;
    case "place":
      return facts.address;
    case "event": {
      const t = facts.starts ? Date.parse(facts.starts) : NaN;
      return Number.isNaN(t) ? facts.address : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(t);
    }
    default:
      return undefined;
  }
}

/** The card's line, "Book · Ottessa Moshfegh". Null for plain articles, videos and images: the card already says so. */
export function thingLine(type: SavedThing | null | undefined, facts: SavedFacts | null | undefined): string | null {
  if (!type || type === "article" || type === "video" || type === "image") return null;
  const detail = thingDetail(type, facts ?? {});
  return detail ? `${THING_LABEL[type]} · ${detail}` : THING_LABEL[type];
}
