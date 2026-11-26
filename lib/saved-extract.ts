/**
 * A page's readable copy (Saved, migration 0038): the title, lead image,
 * author, date, site name and clean article text, from its HTML. Mozilla's
 * Readability (Firefox Reader View) over linkedom's DOM; the metadata from
 * Open Graph, Twitter cards and JSON-LD first. Pure: no network.
 *
 * The text is kept as plain paragraphs (blank lines between, "## " before a
 * heading, "> " before a quote, "• " before a list item), never HTML, so
 * nothing from the page is ever rendered as markup.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { MAX_READABLE_CHARS } from "./saved-rules";

export interface Extracted {
  title: string | null;
  site_name: string | null;
  author: string | null;
  published_at: string | null;
  excerpt: string | null;
  image: string | null;
  /** Clean article text, or null when the page has none (a video, a tweet, an app). */
  text: string | null;
  words: number;
}

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim() || null;

function isoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  return y < 1990 || y > 2100 ? null : d.toISOString().slice(0, 10);
}

function absolute(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** JSON-LD's Article/NewsArticle/BlogPosting fields, if the page has them. */
function jsonLd(doc: Document): { author?: string; published?: string; headline?: string; image?: string } {
  const out: { author?: string; published?: string; headline?: string; image?: string } = {};
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? "");
    } catch {
      continue;
    }
    const nodes: unknown[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        nodes.push(v);
        const g = (v as Record<string, unknown>)["@graph"];
        if (g) walk(g);
      }
    };
    walk(data);
    for (const n of nodes as Array<Record<string, unknown>>) {
      const type = ([] as unknown[]).concat(n["@type"] ?? []).map(String);
      if (!type.some((t) => /Article|BlogPosting|Report|Posting/i.test(t))) continue;
      const a = ([] as unknown[]).concat(n.author ?? [])[0];
      const name = typeof a === "string" ? a : a && typeof a === "object" ? (a as { name?: unknown }).name : undefined;
      if (!out.author && typeof name === "string") out.author = name;
      if (!out.published && typeof n.datePublished === "string") out.published = n.datePublished;
      if (!out.headline && typeof n.headline === "string") out.headline = n.headline;
      const img = ([] as unknown[]).concat(n.image ?? [])[0];
      const src = typeof img === "string" ? img : img && typeof img === "object" ? (img as { url?: unknown }).url : undefined;
      if (!out.image && typeof src === "string") out.image = src;
    }
  }
  return out;
}

/** Readability's article HTML as plain paragraphs. */
function plainText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const blocks: string[] = [];
  const BLOCK = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|FIGCAPTION|DT|DD|TD|TH)$/;
  const visit = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (BLOCK.test(child.tagName)) {
        const raw = child.tagName === "PRE" ? (child.textContent ?? "").replace(/\s+$/g, "") : squash(child.textContent);
        if (!raw) continue;
        if (/^H[1-6]$/.test(child.tagName)) blocks.push(`## ${raw}`);
        else if (child.tagName === "LI") blocks.push(`• ${raw}`);
        else if (child.tagName === "BLOCKQUOTE") blocks.push(`> ${raw}`);
        else if (child.tagName === "PRE") blocks.push("```\n" + raw + "\n```");
        else blocks.push(raw);
      } else if (/^(SCRIPT|STYLE|NOSCRIPT|IFRAME|SVG|FORM|BUTTON)$/.test(child.tagName)) continue;
      else visit(child);
    }
  };
  visit(document.body);
  if (!blocks.length) return squash(document.body.textContent) ?? "";
  // Merge consecutive list items into one block so they read as a list.
  const out: string[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && b.startsWith("• ") && prev.split("\n").pop()!.startsWith("• ")) out[out.length - 1] = `${prev}\n${b}`;
    else out.push(b);
  }
  return out.join("\n\n");
}

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

// ---------- hostile shapes ----------

/** A real page nests a few dozen levels. Past this, linkedom's parse and Readability both go quadratic, so the page isn't parsed at all. */
export const MAX_PAGE_DEPTH = 300;
/** Readability isn't run over more elements than this; the page keeps its preview (title, picture, summary) only. */
export const MAX_READABLE_ELEMS = 20_000;

const VOID = new Set("area base basefont br col command embed frame hr img input isindex keygen link meta param source track wbr".split(" "));
const P = ["p"];
/** The opening tags that close what's open, as linkedom's parser (htmlparser2) does: `<li>` after `<li>` is a sibling, not a child. */
const CLOSES: Record<string, string[]> = {
  tr: ["tr", "th", "td"], th: ["th"], td: ["thead", "th", "td"], li: ["li"], option: ["option"], optgroup: ["optgroup", "option"],
  dd: ["dd", "dt"], dt: ["dd", "dt"], rt: ["rt", "rp"], rp: ["rt", "rp"], tbody: ["thead", "tbody"], tfoot: ["thead", "tbody"],
  ...Object.fromEntries("p h1 h2 h3 h4 h5 h6 address article aside blockquote details div dl fieldset figcaption figure footer form header main nav ol pre section table ul".split(" ").map((t) => [t, P])),
};

/**
 * How deep the page nests and how many elements it has, from one forward
 * pass over the text (no DOM, no backtracking). Stops counting as soon as
 * the depth passes MAX_PAGE_DEPTH.
 */
export function pageShape(html: string): { depth: number; elements: number } {
  const low = html.toLowerCase();
  const stack: string[] = [];
  const open = new Map<string, number>();
  const pop = () => {
    const t = stack.pop()!;
    open.set(t, open.get(t)! - 1);
  };
  let depth = 0;
  let elements = 0;
  let at = 0;
  for (;;) {
    const lt = low.indexOf("<", at);
    if (lt < 0) break;
    if (low.startsWith("<!--", lt)) {
      const end = low.indexOf("-->", lt + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const closing = low.charCodeAt(lt + 1) === 47;
    let i = lt + (closing ? 2 : 1);
    const from = i;
    for (let c = low.charCodeAt(i); (c >= 97 && c <= 122) || (i > from && ((c >= 48 && c <= 57) || c === 45 || c === 58)); c = low.charCodeAt(++i));
    if (i === from) {
      at = lt + 1;
      continue;
    }
    const name = low.slice(from, i);
    const gt = low.indexOf(">", i);
    if (gt < 0) break;
    at = gt + 1;
    if (closing) {
      // Closes back to its nearest opener; a stray closer is ignored.
      if (open.get(name)) while (stack.length && stack[stack.length - 1] !== name) pop();
      if (open.get(name)) pop();
      continue;
    }
    elements++;
    if (VOID.has(name)) continue;
    const closes = CLOSES[name];
    if (closes) while (stack.length && closes.includes(stack[stack.length - 1])) pop();
    if (name === "script" || name === "style") {
      // Raw text: nothing inside is a tag.
      const end = low.indexOf(`</${name}`, at);
      if (end < 0) break;
      at = end;
    }
    stack.push(name);
    open.set(name, (open.get(name) ?? 0) + 1);
    if (stack.length > depth) depth = stack.length;
    if (depth > MAX_PAGE_DEPTH) break;
  }
  return { depth, elements };
}

/** True for a page nested too deep to parse safely. readLink and readPreview refuse it; extractPage returns nothing for it. */
export const tooDeep = (html: string): boolean => pageShape(html).depth > MAX_PAGE_DEPTH;

/** The readable copy of a page's HTML at `url`. */
export function extractPage(html: string, url: string): Extracted {
  const shape = pageShape(html);
  // Never parsed: the parse itself is quadratic in depth.
  if (shape.depth > MAX_PAGE_DEPTH) return { title: null, site_name: null, author: null, published_at: null, excerpt: null, image: null, text: null, words: 0 };
  const { document } = parseHTML(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      const v = squash(el?.getAttribute("content"));
      if (v) return v;
    }
    return null;
  };
  const ld = jsonLd(document as unknown as Document);
  const ogTitle = meta("og:title", "twitter:title");
  const docTitle = squash(document.querySelector("title")?.textContent);
  const site_name = meta("og:site_name", "application-name");
  const image = absolute(meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src") ?? ld.image, url);
  const author = squash(ld.author) ?? meta("author", "article:author", "parsely-author", "sailthru.author", "twitter:creator");
  const published_at = isoDate(meta("article:published_time", "og:published_time", "datePublished", "pubdate", "date", "parsely-pub-date") ?? ld.published ?? document.querySelector("time[datetime]")?.getAttribute("datetime"));
  let excerpt = meta("og:description", "description", "twitter:description");

  let text: string | null = null;
  let title = ogTitle ?? squash(ld.headline) ?? docTitle;
  let byline: string | null = null;
  try {
    // Readability's own maxElemsToParse counts with getElementsByTagName("*"), which linkedom answers with 0, so the count is made here.
    if (shape.elements > MAX_READABLE_ELEMS) throw new Error("too many elements");
    const reader = new Readability(document as unknown as Document, { charThreshold: 400, keepClasses: false, maxElemsToParse: MAX_READABLE_ELEMS });
    const article = reader.parse();
    if (article?.content) {
      // A byline left as the first paragraph ("By Dr Hannah Okafor") is shown from author instead.
      const plain = plainText(article.content).replace(/^(by|words by|written by)\s[^\n]{2,80}\n\n/i, "").slice(0, MAX_READABLE_CHARS);
      // Under ~120 words isn't an article: a video page's description or a tweet. Keep the preview only.
      if (wordCount(plain) >= 120) text = plain;
      title = title ?? squash(article.title);
      byline = squash(article.byline);
      excerpt = excerpt ?? squash(article.excerpt);
    }
  } catch {
    text = null;
  }
  // "Article title | Site" → "Article title" when the site is named.
  if (title && site_name && title.length > site_name.length + 3) {
    const cut = title.replace(new RegExp(`\\s*[|\\-–—·:]\\s*${site_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
    if (cut.length >= 8) title = cut;
  }
  const authorOut = author && !/^https?:\/\//.test(author) ? author : byline && byline.length < 80 ? byline.replace(/^by\s+/i, "") : null;
  return {
    title: title?.slice(0, 300) ?? null,
    site_name: site_name?.slice(0, 80) ?? null,
    author: authorOut?.slice(0, 120) ?? null,
    published_at,
    excerpt: excerpt?.slice(0, 600) ?? null,
    image,
    text,
    words: text ? wordCount(text) : 0,
  };
}
