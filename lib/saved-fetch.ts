/**
 * Reading a saved link's page, once (Saved, migration 0038). The same
 * guarded fetch as artwork and icons (netlify/lib/connectors/icons.ts):
 * https only, every hop's address checked before and while connecting,
 * redirects followed by hand, one deadline, a byte cap. Never a raw fetch.
 * An http link is read over https; a page that won't answer there keeps
 * its preview only.
 */
import { assertPublicHost, publicFetch } from "../netlify/lib/connectors/icons";
import { sniffImage } from "./art";
import { MAX_PAGE_BYTES, MAX_SAVED_IMAGE_BYTES } from "./saved-rules";

export class PageFetchError extends Error {
  constructor(readonly reason: "not_allowed" | "internal" | "timeout" | "too_big" | "not_html" | "not_image" | "http" | "failed") {
    super(reason);
  }
}

/** Replaceable in tests: the network, the address check and the deadline. */
export const pageDeps = {
  fetch: (input: string | URL, init?: RequestInit) => publicFetch(input, init),
  assertPublic: (url: URL) => assertPublicHost(url),
  timeoutMs: 8_000,
  /** Tests point this at a local server; production always reads https. */
  upgrade: (url: URL) => {
    if (url.protocol === "http:") url.protocol = "https:";
    return url;
  },
};

const MAX_REDIRECTS = 5;

async function get(raw: string, accept: "html" | "image", maxBytes: number, signal: AbortSignal): Promise<{ bytes: Buffer; type: string; url: string }> {
  let url: URL;
  try {
    url = pageDeps.upgrade(new URL(raw));
  } catch {
    throw new PageFetchError("not_allowed");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.username || url.password) throw new PageFetchError("not_allowed");
    try {
      await pageDeps.assertPublic(url);
    } catch {
      throw new PageFetchError("internal");
    }
    let res: Response;
    try {
      res = await pageDeps.fetch(url, {
        redirect: "manual",
        signal,
        headers: {
          Accept: accept === "html" ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" : "image/webp,image/*;q=0.9",
          "User-Agent": "Mozilla/5.0 (compatible; Athena-personal-notes/1.0; saved link)",
          "Accept-Language": "en-GB,en;q=0.8",
        },
      });
    } catch {
      throw new PageFetchError(signal.aborted ? "timeout" : "failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!next) throw new PageFetchError("http");
      url = pageDeps.upgrade(new URL(next, url));
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new PageFetchError("http");
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (accept === "html" && type && !/text\/html|application\/xhtml/.test(type)) {
      await res.body.cancel().catch(() => undefined);
      throw new PageFetchError("not_html");
    }
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new PageFetchError("too_big");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new PageFetchError("too_big");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof PageFetchError) throw error;
      throw new PageFetchError(signal.aborted ? "timeout" : "failed");
    }
    const bytes = Buffer.concat(chunks);
    if (accept === "image" && !sniffImage(bytes)) throw new PageFetchError("not_image");
    return { bytes, type, url: url.toString() };
  }
  throw new PageFetchError("http");
}

function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return run(ctl.signal).finally(() => clearTimeout(timer));
}

/** The page's HTML as text, decoded by its declared charset, and where it ended up after redirects. */
export async function fetchPageHtml(raw: string): Promise<{ html: string; url: string }> {
  return withDeadline(pageDeps.timeoutMs, async (signal) => {
    const { bytes, type, url } = await get(raw, "html", MAX_PAGE_BYTES, signal);
    const head = bytes.subarray(0, 2048).toString("latin1");
    const label = type.match(/charset=([\w-]+)/)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(label);
    } catch {
      decoder = new TextDecoder("utf-8");
    }
    return { html: decoder.decode(bytes), url };
  });
}

/** A page's lead image, for its card (6 MB), or an image the extension sent by address (`maxBytes`, up to 10 MB). */
export async function fetchPageImage(raw: string, maxBytes = 6 * 1024 * 1024): Promise<Buffer> {
  return withDeadline(pageDeps.timeoutMs, async (signal) => (await get(raw, "image", Math.min(MAX_SAVED_IMAGE_BYTES, maxBytes), signal)).bytes);
}
