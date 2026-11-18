/**
 * The one way Athena talks to iCloud: WebDAV over HTTPS with the owner's
 * Apple ID and app-specific password (HTTP Basic), for icloud-calendar.ts
 * and icloud-contacts.ts.
 *
 *  - Read-only by construction: `DavMethod` is GET, PROPFIND or REPORT. The
 *    writes are three, each on one event's file: `putIfMatch`, a conditional
 *    PUT to answer an invite (icloud-rsvp.ts) or move an event
 *    (icloud-move.ts); `putIfNoneMatch`, a PUT that can only make a new file,
 *    of a new event checked by isNewEventIcs (icloud-create.ts); and
 *    `deleteIfMatch`, the Undo of that, sent only for an event Athena added
 *    (calendar_creates). There's no POST, PROPPATCH or MOVE.
 *  - Only iCloud's own hosts: caldav.icloud.com and contacts.icloud.com, and
 *    the account's partition servers they point to (p42-caldav.icloud.com…).
 *    A redirect is followed by hand, and only to those hosts, so the
 *    password is never sent anywhere else.
 *  - Replies are capped (8 MB), and request addresses, bodies and the
 *    password are never logged.
 *  - Discovery as RFC 6764 / 4791 / 6352 describe it: the principal
 *    (current-user-principal), then its calendar or address book home.
 */
import type { ConnectorSecrets } from "../../../lib/connectors";
import { isNewEventIcs } from "./icloud-create";

export type DavMethod = "GET" | "PROPFIND" | "REPORT";
export type DavService = "caldav" | "carddav";

const START: Record<DavService, string> = { caldav: "https://caldav.icloud.com", carddav: "https://contacts.icloud.com" };
const HOSTS: Record<DavService, RegExp> = {
  caldav: /^(?:p\d{1,3}-)?caldav\.icloud\.com$/,
  carddav: /^(?:p\d{1,3}-)?contacts\.icloud\.com$/,
};

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** Waits before retrying a busy reply; tests shorten them. */
export const davRetryWaits = { ms: [500, 1500] };

export const NEW_PASSWORD = "Make a new app-specific password";

/** iCloud said no, or didn't answer. `needsOwner`: only the owner can fix it (a new password). */
export class IcloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly needsOwner = false,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IcloudError";
  }
}

/** Is this an address Athena may send the password to? */
export function icloudHost(service: DavService, url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.port === "" || u.port === "443") && HOSTS[service].test(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function refused(status: number): IcloudError {
  if (status === 401) return new IcloudError(401, NEW_PASSWORD, true);
  if (status === 403) return new IcloudError(403, "iCloud turned that down. Check iCloud is on for this Apple ID.");
  if (status === 404) return new IcloudError(404, "iCloud can't find that");
  if (status === 429 || status >= 500) return new IcloudError(status, "iCloud isn't answering right now. Try again in a few minutes.", false, true);
  return new IcloudError(status, `iCloud refused that (${status})`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCapped(res: Response): Promise<string> {
  const length = Number(res.headers.get("content-length"));
  if (length > MAX_BYTES) throw new IcloudError(413, "iCloud sent more than Athena reads at once");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new IcloudError(413, "iCloud sent more than Athena reads at once");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A signed-in iCloud service: requests carry the Apple ID and password, to iCloud only. */
export class DavSession {
  private readonly auth: string;

  constructor(
    readonly service: DavService,
    secrets: Pick<ConnectorSecrets, "token" | "username">,
  ) {
    const user = secrets.username?.trim();
    const password = secrets.token?.trim();
    if (!user || !password) throw new IcloudError(401, "Add your Apple ID and an app-specific password", true);
    this.auth = `Basic ${Buffer.from(`${user}:${password.replace(/\s+/g, "")}`, "utf8").toString("base64")}`;
  }

  get origin(): string {
    return START[this.service];
  }

  /** One request. 207 and 2xx come back as text; anything else is thrown as an IcloudError. */
  async request(method: DavMethod, url: string, opts: { body?: string; depth?: 0 | 1 } = {}): Promise<{ status: number; text: string; url: string; etag?: string }> {
    return this.send(method, url, opts);
  }

  /**
   * The one write: an event's file put back with only your answer changed
   * (icloud-rsvp.ts), or only its start and end (icloud-move.ts). Only over
   * the version Athena read (If-Match), so a change made meanwhile is a 412,
   * never overwritten. Calendar events only.
   */
  async putIfMatch(url: string, ics: string, etag: string): Promise<void> {
    if (this.service !== "caldav" || !etag || !/\.ics$/i.test(new URL(url).pathname)) throw new IcloudError(400, "Athena only changes calendar events");
    await this.send("PUT", url, { body: ics, ifMatch: etag, contentType: "text/calendar; charset=utf-8" });
  }

  /** A new event's file (isNewEventIcs), only where there's none (If-None-Match: *), so nothing is ever replaced. */
  async putIfNoneMatch(url: string, ics: string): Promise<void> {
    if (this.service !== "caldav" || !/\.ics$/i.test(new URL(url).pathname) || !isNewEventIcs(ics)) throw new IcloudError(400, "Athena only adds calendar events");
    await this.send("PUT", url, { body: ics, ifNoneMatch: true, contentType: "text/calendar; charset=utf-8" });
  }

  /** Undo of putIfNoneMatch: one event's file, over the version Athena read (If-Match). The caller checks calendar_creates first. */
  async deleteIfMatch(url: string, etag: string): Promise<void> {
    if (this.service !== "caldav" || !etag || !/\.ics$/i.test(new URL(url).pathname)) throw new IcloudError(400, "Athena only removes calendar events it added");
    await this.send("DELETE", url, { ifMatch: etag });
  }

  private async send(
    method: DavMethod | "PUT" | "DELETE",
    url: string,
    opts: { body?: string; depth?: 0 | 1; ifMatch?: string; ifNoneMatch?: boolean; contentType?: string },
  ): Promise<{ status: number; text: string; url: string; etag?: string }> {
    let at = url;
    for (let attempt = 0, hops = 0; ; ) {
      if (!icloudHost(this.service, at)) throw new IcloudError(400, "Athena only talks to iCloud's own servers");
      const headers: Record<string, string> = { Authorization: this.auth, "User-Agent": "Athena" };
      if (opts.body !== undefined) headers["Content-Type"] = opts.contentType ?? "application/xml; charset=utf-8";
      if (opts.depth !== undefined) headers.Depth = String(opts.depth);
      if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
      if (opts.ifNoneMatch) headers["If-None-Match"] = "*";
      let res: Response;
      try {
        res = await fetch(at, { method, headers, body: opts.body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        if (attempt < davRetryWaits.ms.length) {
          await sleep(davRetryWaits.ms[attempt++]);
          continue;
        }
        throw new IcloudError(503, "iCloud isn't answering right now. Try again in a few minutes.", false, true);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, at).toString();
        if (++hops > 3 || !icloudHost(this.service, next)) throw new IcloudError(502, "iCloud pointed Athena somewhere it won't send your password");
        at = next;
        continue;
      }
      if (res.ok) return { status: res.status, text: await readCapped(res), url: at, etag: res.headers.get("etag") ?? undefined };
      await res.body?.cancel().catch(() => undefined);
      const err = refused(res.status);
      if (err.retryable && attempt < davRetryWaits.ms.length) {
        await sleep(davRetryWaits.ms[attempt++]);
        continue;
      }
      throw err;
    }
  }

  /** PROPFIND or REPORT, as a parsed multistatus. */
  async multistatus(method: "PROPFIND" | "REPORT", url: string, body: string, depth: 0 | 1): Promise<DavResponse[]> {
    const r = await this.request(method, url, { body, depth });
    return parseMultistatus(r.text, r.url);
  }

  /** An address on the service: an href from a reply, made absolute. */
  resolve(href: string, base: string = this.origin): string {
    return new URL(href, base).toString().replace(/:443\//, "/");
  }
}

// ---------- XML: just enough for WebDAV multistatus replies ----------

export interface XmlNode {
  /** Local name, without its namespace prefix: "href", "calendar-data". */
  name: string;
  children: XmlNode[];
  text: string;
  /** Attributes by local name (`<c:comp name="VEVENT"/>`). */
  attrs: Record<string, string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()],
  );

/** A small, forgiving XML reader: elements and attributes by local name, and their text. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", children: [], text: "", attrs: {} };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(xml)); ) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
    else if (m[3]) {
      const name = m[3].includes(":") ? m[3].slice(m[3].indexOf(":") + 1) : m[3];
      if (m[2]) {
        // A closing tag: pop back to its element (tolerating a stray one).
        for (let i = stack.length - 1; i > 0; i--)
          if (stack[i].name === name) {
            stack.length = i;
            break;
          }
      } else {
        const attrs: Record<string, string> = {};
        for (const a of m[4].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          if (/^xmlns(:|$)/.test(a[1])) continue;
          attrs[a[1].includes(":") ? a[1].slice(a[1].indexOf(":") + 1) : a[1]] = unescapeXml(a[2] ?? a[3] ?? "");
        }
        const node: XmlNode = { name, children: [], text: "", attrs };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return root;
}

/** The first descendant with this local name. */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const d = find(c, name);
    if (d) return d;
  }
  return undefined;
}

export function findAll(node: XmlNode | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node?.children ?? []) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

export interface DavResponse {
  /** Absolute address of the resource. */
  href: string;
  /** Properties that came back 200, by local name. */
  props: Map<string, XmlNode>;
}

/** A 207 multistatus: each resource and its found properties. */
export function parseMultistatus(xml: string, base: string): DavResponse[] {
  const out: DavResponse[] = [];
  for (const r of findAll(parseXml(xml), "response")) {
    const hrefNode = r.children.find((c) => c.name === "href");
    if (!hrefNode) continue;
    const props = new Map<string, XmlNode>();
    for (const ps of r.children.filter((c) => c.name === "propstat")) {
      const status = find(ps, "status")?.text ?? "";
      if (status && !/\s2\d\d\s/.test(` ${status} `)) continue;
      for (const p of find(ps, "prop")?.children ?? []) props.set(p.name, p);
    }
    out.push({ href: new URL(hrefNode.text.trim(), base).toString().replace(/:443\//, "/"), props });
  }
  return out;
}

/** A property's own href (current-user-principal, calendar-home-set…). */
export const hrefOf = (p: XmlNode | undefined): string | undefined => find(p, "href")?.text.trim() || undefined;

// ---------- Discovery ----------

const PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const HOME: Record<DavService, string> = {
  caldav: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/><c:calendar-user-address-set/></d:prop></d:propfind>`,
  carddav: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>`,
};

export interface DavHome {
  /** The calendar or address book home, absolute, ending in "/". */
  home: string;
  /** The owner's own addresses (mailto:, lower-cased, without "mailto:"), from CalDAV. */
  emails: string[];
}

/**
 * Who's signed in, and where their calendars or address books live. Two
 * PROPFINDs; the first proves the Apple ID and password work.
 */
export async function discover(session: DavSession): Promise<DavHome> {
  const start = `${session.origin}/`;
  const [me] = await session.multistatus("PROPFIND", start, PRINCIPAL, 0);
  const principalHref = hrefOf(me?.props.get("current-user-principal"));
  if (!principalHref) throw new IcloudError(502, "iCloud didn't say whose account this is");
  const principal = session.resolve(principalHref, me.href);
  const [p] = await session.multistatus("PROPFIND", principal, HOME[session.service], 0);
  const homeHref = hrefOf(p?.props.get(session.service === "caldav" ? "calendar-home-set" : "addressbook-home-set"));
  if (!homeHref) throw new IcloudError(502, session.service === "caldav" ? "iCloud has no calendars for this Apple ID" : "iCloud has no contacts for this Apple ID");
  let home = session.resolve(homeHref, principal);
  if (!home.endsWith("/")) home += "/";
  if (!icloudHost(session.service, home)) throw new IcloudError(502, "iCloud pointed Athena somewhere it won't send your password");
  const emails = findAll(p.props.get("calendar-user-address-set"), "href")
    .map((h) => h.text.trim())
    .filter((h) => /^mailto:/i.test(h))
    .map((h) => decodeURIComponent(h.slice(7)).toLowerCase());
  return { home, emails: [...new Set(emails)] };
}

/** Escape text for an XML body. */
export const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The last path segment of an address, decoded: a calendar's or contact's id. */
export function lastSegment(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}
