/**
 * Public RSS feeds (Letterboxd's diary), read safely:
 * only https, only the service's own hosts, redirects followed by hand and
 * only to those hosts, at most 2 MB. No account and no token: these feeds
 * are what the owner's public profile already shows.
 */
import { decodeEntities, htmlToText, tidyText } from "./google-api";
import { getText, ServiceError, type LifeService } from "./feeds-shared";

const MAX_REDIRECTS = 3;

/** GET a feed on one of `hosts`. Throws ServiceError with the owner's next step when it isn't there. */
export async function fetchFeed(service: LifeService, url: string, hosts: string[], words: { name: string; missing: string }): Promise<string> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(at);
    if (u.protocol !== "https:" || !hosts.includes(u.hostname)) throw new ServiceError(service, 400, `${words.name} sent Athena somewhere other than ${words.name}. Check the address under Edit.`, true);
    const res = await getText(service, u.toString(), { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5", "User-Agent": "Athena (personal notes)" }, {
      unreachable: `Couldn't reach ${words.name} right now. Athena will try again next run.`,
      busy: `${words.name} is limiting how often Athena can ask right now. Try again in a few minutes.`,
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) break;
      at = new URL(next, u).toString();
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new ServiceError(service, 404, words.missing, true);
    if (res.status === 401 || res.status === 403) throw new ServiceError(service, 403, words.missing, true);
    if (res.status !== 200) throw new ServiceError(service, res.status, `${words.name} refused that (${res.status}).`);
    if (!/<rss\b|<feed\b/i.test(res.text.slice(0, 2000))) throw new ServiceError(service, 422, words.missing, true);
    return res.text;
  }
  throw new ServiceError(service, 310, `${words.name} kept redirecting. Check the address under Edit.`, true);
}

/** Each <item> of an RSS feed as { tag: text }, CDATA unwrapped, entities decoded. Namespaced tags keep their prefix ("letterboxd:filmTitle"). */
export function rssItems(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    // The item's own XML too, for fields nested a level down (Goodreads' <book><num_pages>).
    const fields: Record<string, string> = { __xml: m[1] };
    for (const f of m[1].matchAll(/<([a-zA-Z][\w.-]*(?::[\w.-]+)?)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g)) {
      const key = f[1];
      if (key in fields) continue;
      fields[key] = text(f[2] ?? "");
    }
    items.push(fields);
  }
  return items;
}

function text(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? cdata[1].trim() : decodeEntities(raw).trim();
}

/** A feed's HTML description (a review) as short plain text, images and links dropped. */
export function reviewText(html: string, max = 280): string {
  const t = tidyText(htmlToText(html.replace(/<img\b[^>]*>/gi, ""))).replace(/\s*\(https?:\/\/[^)]+\)/g, "");
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}
