/**
 * A connector's logo, from what its MCP server says about itself.
 *
 * Order of preference:
 *  1. `serverInfo.icons` from the server's `initialize` reply (MCP lets a
 *     server list icons with sizes and a light/dark theme). SVG first, then
 *     the largest raster.
 *  2. The icon of the server's website (`serverInfo.websiteUrl`, else the
 *     server URL's own origin): apple-touch-icon, then the largest
 *     `<link rel="icon">`, then /favicon.ico.
 *
 * Every image is fetched here, on the server, once (sign-in or "Check
 * tools"), and stored as a data: URI of at most 96 KB. The app only ever
 * shows that stored copy in an <img>, where SVG scripts don't run.
 *
 * Fetching addresses a remote server chose is a classic SSRF vector, so:
 * https only; every hostname (and every redirect hop) is resolved and refused
 * if it lands on a loopback, private, link-local or otherwise internal
 * address; 5 s timeout; size caps; image content types only.
 */
import { lookup } from "node:dns/promises";
import { lookup as lookupCb, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

const MAX_IMAGE_BYTES = 96 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;

export interface ServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export interface StoredServerInfo {
  name?: string;
  title?: string;
  version?: string;
  description?: string;
  website_url?: string;
  icon?: { light?: string; dark?: string; source: "server" | "website" };
}

// ---------- safe fetching ----------

/** A dotted IPv4 address that isn't on the public internet (or isn't a dotted IPv4 address at all). */
function internalV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

function v4Parts(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.map(Number);
}

/** An IPv6 address as its eight 16-bit groups, `::` expanded and a dotted IPv4 tail folded in; null if it isn't one. */
function v6Groups(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const p = v4Parts(dotted[2]);
    if (!p) return null;
    v = `${dotted[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const side = (s: string) => (s ? s.split(":") : []);
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Is this IP address (v4 or v6, as text) loopback, private, link-local,
 * shared, reserved, multicast or otherwise not a public internet address?
 * IPv6 forms that carry an IPv4 address (mapped ::ffff:a.b.c.d in either
 * spelling, compatible ::a.b.c.d, SIIT, NAT64 64:ff9b::/96, 6to4 2002::/16,
 * Teredo) are judged by that IPv4 address. Anything unparseable counts as
 * internal: fail closed.
 */
export function isInternalAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/%.*$/, ""));
  if (kind === 4) {
    const p = v4Parts(ip);
    return !p || internalV4(p[0], p[1], p[2]);
  }
  if (kind !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => internalV4(hi >> 8, hi & 0xff, lo >> 8);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:0:0/96 (mapped), ::ffff:0:0:0/96 (SIIT).
  if (zeros(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return v4(g[6], g[7]);
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  // NAT64: 64:ff9b::/96 carries an IPv4 address; 64:ff9b:1::/48 is for local use only.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || (zeros(2, 6) ? v4(g[6], g[7]) : true);
  // 6to4 (2002:AABB:CCDD::) and Teredo (2001:0::, client address inverted in the last 32 bits).
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  if (g[0] === 0x2001 && g[1] === 0) return v4(~g[6] & 0xffff, ~g[7] & 0xffff);
  // 2001:db8::/32 documentation, 100::/64 discard.
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  if (g[0] === 0x100 && zeros(1, 4)) return true;
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8.
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

/** Name resolution, swappable in tests. */
export const publicHostNet = {
  lookup: (host: string): Promise<Array<{ address: string; family: number }>> => lookup(host, { all: true }),
};

/** Refuse hosts that are, or resolve to, internal addresses. */
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("icons must be https");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new Error("internal host");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await publicHostNet.lookup(host);
  if (!addresses.length) throw new Error("no address");
  for (const a of addresses) {
    if (isInternalAddress(a.address)) throw new Error("internal address");
  }
}

// ---------- pinned fetch ----------

/**
 * The address check again, at the moment of connecting: the socket's own
 * lookup refuses an internal answer. assertPublicHost alone checks one DNS
 * answer and fetch then asks again, so a name that answers public, then
 * internal (DNS rebinding), would get through.
 */
/** What the owner reads when an address they typed is on a private network. */
export const PRIVATE_ADDRESS = "That address is on a private network, which Athena won't connect to. Use the https address that opens from anywhere.";

export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  lookupCb(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    const bad = addresses.find((a) => isInternalAddress(a.address));
    if (!addresses.length || bad) return callback(Object.assign(new Error(PRIVATE_ADDRESS), { code: "EINTERNAL" }), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const nativeFetch = globalThis.fetch;

/** Headers that carry a credential, so never follow a redirect to another origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * fetch for addresses the owner typed (Plex, Jellyfin, Mastodon, icons, art,
 * maps): https only, every connection's address checked as it's made, every
 * redirect hop too, and credentials dropped when a redirect leaves the
 * origin. Under the test runner a replaced globalThis.fetch gets the call;
 * anywhere else a replacement is ignored, so the checks always apply.
 */
export async function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (globalThis.fetch !== nativeFetch && process.env.NODE_TEST_CONTEXT) return globalThis.fetch(input, init);
  let url = new URL(input);
  let current = init;
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== "https:") throw new TypeError("https only");
    const res = await pinnedRequest(url, current);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || init.redirect === "manual") return res;
    if (init.redirect === "error") throw new TypeError("redirect refused");
    await res.body?.cancel();
    const next = new URL(location, url);
    current = redirectedInit(current, res.status, url, next);
    url = next;
  }
  throw new TypeError("too many redirects");
}

/**
 * The request to send on to a redirect's target, as fetch would: a 303 (or a
 * POST answered 301 or 302) becomes a GET without a body, and a different
 * origin gets no credentials.
 */
export function redirectedInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const toGet = status === 303 ? method !== "GET" && method !== "HEAD" : (status === 301 || status === 302) && method === "POST";
  const crossOrigin = from.origin !== to.origin;
  if (!toGet && !crossOrigin) return init;
  const headers = new Headers(init.headers);
  if (crossOrigin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
  if (toGet) for (const h of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(h);
  return toGet ? { ...init, headers, method: "GET", body: undefined } : { ...init, headers };
}

/**
 * A host written as an IP literal (https://10.0.0.1, https://[::1]) is
 * connected to without a lookup, so pinnedLookup never sees it: judge it
 * here instead, on every hop.
 */
export function isInternalLiteral(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) !== 0 && isInternalAddress(host);
}

function pinnedRequest(url: URL, init: RequestInit): Promise<Response> {
  if (isInternalLiteral(url)) return Promise.reject(Object.assign(new Error(PRIVATE_ADDRESS), { code: "EINTERNAL" }));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req = request(url, { method: init.method ?? "GET", headers, lookup: pinnedLookup, signal: init.signal ?? undefined }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
      const status = res.statusCode ?? 502;
      const empty = status === 204 || status === 304 || init.method === "HEAD";
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: out }));
    });
    req.on("error", reject);
    const body = init.body;
    if (body == null) req.end();
    else if (typeof body === "string") req.end(body);
    else if (body instanceof URLSearchParams) {
      if (!headers["content-type"]) req.setHeader("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      req.end(body.toString());
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) req.end(Buffer.from(body as ArrayBuffer));
    else {
      req.destroy();
      reject(new TypeError("unsupported body"));
    }
  });
}

/** GET with manual, re-checked redirects, a timeout and a byte cap. */
async function safeGet(raw: string, maxBytes: number): Promise<{ bytes: Buffer; type: string; url: URL } | null> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(url);
    const res = await publicFetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "image/*,text/html;q=0.8" } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return null;
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return { bytes: Buffer.concat(chunks), type: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), url };
  }
  return null;
}

/** Recognise an image by its first bytes, so a mislabelled or HTML reply isn't stored as a logo. */
function sniff(bytes: Buffer, declared: string): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if ((declared === "image/svg+xml" || head.startsWith("<?xml") || head.startsWith("<svg")) && head.includes("<svg")) return "image/svg+xml";
  return null;
}

/** An icon reference (https URL or data: URI) → a stored data: URI, or null. */
async function toDataUri(src: string): Promise<string | null> {
  try {
    if (src.startsWith("data:")) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
      if (!m) return null;
      const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
      if (bytes.length > MAX_IMAGE_BYTES) return null;
      const type = sniff(bytes, m[1].toLowerCase());
      return type ? `data:${type};base64,${bytes.toString("base64")}` : null;
    }
    const got = await safeGet(src, MAX_IMAGE_BYTES);
    if (!got || got.bytes.length === 0) return null;
    // The bytes decide, not the header: an HTML error page labelled image/png is refused.
    const type = sniff(got.bytes, got.type);
    if (!type || (got.type.startsWith("text/html"))) return null;
    return `data:${type};base64,${got.bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

// ---------- choosing ----------

function largestSize(sizes?: string[]): number {
  let best = 0;
  for (const s of sizes ?? []) {
    if (s === "any") return 10_000;
    const n = Number(s.split("x")[0]);
    if (Number.isFinite(n)) best = Math.max(best, n);
  }
  return best;
}

/** SVG first, then the biggest raster; icons without a size come last. */
function rank(icons: ServerIcon[]): ServerIcon[] {
  const isSvg = (i: ServerIcon) => i.mimeType === "image/svg+xml" || /\.svg(\?|$)/i.test(i.src) || i.src.startsWith("data:image/svg");
  return [...icons].sort((a, b) => Number(isSvg(b)) - Number(isSvg(a)) || largestSize(b.sizes) - largestSize(a.sizes));
}

async function firstWorking(icons: ServerIcon[]): Promise<string | null> {
  for (const icon of rank(icons).slice(0, 4)) {
    const uri = await toDataUri(icon.src);
    if (uri) return uri;
  }
  return null;
}

/** <link rel="apple-touch-icon" | "icon"> candidates from a page, best first. */
function linkIcons(html: string, base: URL): ServerIcon[] {
  const found: Array<ServerIcon & { weight: number }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
    const rel = (attr("rel") ?? "").toLowerCase();
    const href = attr("href");
    if (!href || !/\b(icon|apple-touch-icon)\b/.test(rel) || /mask-icon/.test(rel)) continue;
    let src: string;
    try {
      src = new URL(href, base).toString();
    } catch {
      continue;
    }
    const sizes = (attr("sizes") ?? "").split(/\s+/).filter(Boolean);
    const weight = rel.includes("apple-touch-icon") ? 2000 : largestSize(sizes) || (/\.svg(\?|$)/i.test(src) ? 1500 : 16);
    found.push({ src, sizes, mimeType: attr("type"), weight });
  }
  return found.sort((a, b) => b.weight - a.weight);
}

async function websiteIcon(site: URL): Promise<string | null> {
  try {
    const page = await safeGet(site.toString(), MAX_HTML_BYTES);
    if (page && page.type.includes("html")) {
      for (const icon of linkIcons(page.bytes.toString("utf8"), page.url).slice(0, 4)) {
        const uri = await toDataUri(icon.src);
        if (uri) return uri;
      }
    }
  } catch {
    // fall through to /favicon.ico
  }
  return toDataUri(new URL("/favicon.ico", site).toString());
}

/** The registrable site behind a server URL: mcp.acme.com → https://acme.com/. */
function siteFor(serverUrl: string): URL {
  const u = new URL(serverUrl);
  const parts = u.hostname.split(".");
  const host = parts.length > 2 && /^(mcp|api|server|gateway)$/i.test(parts[0]) ? parts.slice(1).join(".") : u.hostname;
  return new URL(`https://${host}/`);
}

/** Give up on logos after this long overall (the OAuth callback waits on it). */
const OVERALL_MS = 8000;

/**
 * Turn an `initialize` serverInfo into what Athena stores: text fields, plus
 * (when `withIcon`) light/dark logos as data URIs if any can be found within
 * a few seconds. Never throws.
 */
export async function resolveServerInfo(
  info: Record<string, unknown> | undefined,
  serverUrl: string,
  opts: { withIcon: boolean; previous?: StoredServerInfo } = { withIcon: true },
): Promise<StoredServerInfo> {
  const text = describe(info);
  if (!opts.withIcon) return text;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StoredServerInfo>((resolve) => {
    // Out of time: keep whatever logo we had before.
    timer = setTimeout(() => resolve({ ...text, icon: opts.previous?.icon }), OVERALL_MS);
  });
  try {
    return await Promise.race([withLogo(text, info, serverUrl, opts.previous), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(info: Record<string, unknown> | undefined): StoredServerInfo {
  const str = (k: string, max = 300) => (typeof info?.[k] === "string" ? (info[k] as string).slice(0, max) : undefined);
  const stored: StoredServerInfo = {
    name: str("name", 120),
    title: str("title", 120),
    version: str("version", 40),
    description: str("description", 500),
    website_url: (() => {
      const w = str("websiteUrl", 500);
      try {
        return w && new URL(w).protocol === "https:" ? w : undefined;
      } catch {
        return undefined;
      }
    })(),
  };

  return stored;
}

async function withLogo(stored: StoredServerInfo, info: Record<string, unknown> | undefined, serverUrl: string, previous?: StoredServerInfo): Promise<StoredServerInfo> {
  stored = { ...stored };
  const icons = (Array.isArray(info?.icons) ? info!.icons : []).filter(
    (i): i is ServerIcon => !!i && typeof i === "object" && typeof (i as ServerIcon).src === "string",
  );
  if (icons.length) {
    const light = await firstWorking(icons.filter((i) => i.theme !== "dark"));
    const dark = await firstWorking(icons.filter((i) => i.theme === "dark"));
    if (light || dark) {
      stored.icon = { light: light ?? undefined, dark: dark ?? undefined, source: "server" };
      return stored;
    }
  }

  try {
    const site = stored.website_url ? new URL(stored.website_url) : siteFor(serverUrl);
    const fromSite = await websiteIcon(site);
    if (fromSite) stored.icon = { light: fromSite, source: "website" };
  } catch {
    // no logo; the app falls back to a generic mark
  }
  if (!stored.icon && previous?.icon) stored.icon = previous.icon;
  return stored;
}
