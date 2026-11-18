/**
 * iCloud Contacts' tools for icloud-direct.ts, over CardDAV:
 * search_contacts, list_contacts (paged) and get_contact, each giving a
 * person's name, organisation, title, emails, phones, birthday and
 * addresses as compact JSON. Read-only.
 *
 * CardDAV has no paging, and iCloud's support for server-side text search
 * is uneven, so Athena lists the address book's cards (one PROPFIND), reads
 * them in batches (addressbook-multiget REPORTs) and searches and sorts
 * them itself. Photos are never kept, and contact groups are left out.
 */
import { ToolInputError, arg, clean, clip, mapLimit } from "./google-api";
import { DavSession, IcloudError, find, lastSegment, xmlText } from "./icloud-dav";
import { parseLine, unescapeText, type IcalProp } from "./icloud-ical";

const LIST_BUDGET = 18_000;
const BATCH = 200;
/** The most cards Athena reads from one account. */
const MAX_CARDS = 6_000;

export interface IcloudContactsContext {
  session: DavSession;
  /** The address book home, absolute, ending in "/". */
  home: string;
  /** The address books in it (iCloud has one, "card"), absolute, ending in "/". */
  books(): Promise<string[]>;
  /** Every person in them, read once per open. */
  people(): Promise<Contact[]>;
}

export interface IcloudContactsTool {
  name: string;
  description: string;
  summary: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean };
  run(ctx: IcloudContactsContext, args: Record<string, unknown>): Promise<unknown>;
}

// ---------- vCard ----------

export interface Contact {
  id: string;
  name: string;
  nickname?: string;
  organisation?: string;
  department?: string;
  title?: string;
  emails: string[];
  phones: string[];
  birthday?: string;
  addresses: string[];
  urls: string[];
  related: string[];
  note?: string;
  updated?: string;
  /** Searchable text: names, organisation, emails, phone digits. */
  hay: string;
}

interface CardProp extends IcalProp {
  /** "item1" for "item1.EMAIL" (Apple groups a value with its custom label). */
  group?: string;
}

/** Unfolded lines as properties, with their group. */
function cardProps(text: string): CardProp[] {
  const out: CardProp[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    const p = parseLine(line);
    if (!p) continue;
    const dot = p.name.indexOf(".");
    out.push(dot > 0 ? { ...p, group: p.name.slice(0, dot), name: p.name.slice(dot + 1) } : p);
  }
  return out;
}

/** Split a structured value on unescaped `;` (N, ORG, ADR). */
const parts = (v: string) => v.split(/(?<!\\);/).map((s) => unescapeText(s).trim());

const TYPE_WORDS: Record<string, string> = { cell: "mobile", mobile: "mobile", iphone: "iPhone", home: "home", work: "work", main: "main", fax: "fax", pager: "pager", other: "other", school: "school" };

/** "mobile", "work", or Apple's own label ("_$!<Mobile>!$_" → "mobile"; a custom one as written). */
function labelOf(p: CardProp, all: CardProp[]): string | undefined {
  const custom = p.group ? all.find((x) => x.group === p.group && x.name === "X-ABLABEL")?.value : undefined;
  if (custom) {
    const m = /^_\$!<(.+)>!\$_$/.exec(custom.trim());
    return (m ? m[1] : custom).trim().toLowerCase() || undefined;
  }
  const types = (p.params.TYPE ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && t !== "pref" && t !== "internet" && t !== "voice");
  const named = types.map((t) => TYPE_WORDS[t]).filter(Boolean);
  return named.includes("fax") ? `${named.filter((t) => t !== "fax")[0] ?? ""} fax`.trim() : named[0];
}

const withLabel = (v: string, label?: string) => (label ? `${v} (${label})` : v);

/** BDAY: 1988-04-12, 19880412, --0412, or Apple's year-less 1604-04-12 (X-APPLE-OMIT-YEAR). → 1988-04-12 or --04-12. */
export function birthdayOf(p: CardProp | undefined): string | undefined {
  if (!p) return undefined;
  const v = p.value.trim();
  const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(v);
  if (!m) return undefined;
  const noYear = m[1] === "--" || (p.params["X-APPLE-OMIT-YEAR"] && p.params["X-APPLE-OMIT-YEAR"] === m[1]);
  return noYear ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

/** One vCard as a contact; null for a group card or one with nothing to show. */
export function parseCard(text: string, id: string): Contact | null {
  const ps = cardProps(text);
  const one = (name: string) => ps.find((p) => p.name === name);
  const all = (name: string) => ps.filter((p) => p.name === name);
  const value = (name: string) => {
    const p = one(name);
    return p ? unescapeText(p.value).trim() || undefined : undefined;
  };
  if (/group/i.test(value("X-ADDRESSBOOKSERVER-KIND") ?? value("KIND") ?? "")) return null;
  const n = one("N") ? parts(one("N")!.value) : [];
  const composed = [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(" ");
  const org = one("ORG") ? parts(one("ORG")!.value) : [];
  const name = value("FN") || composed || org[0] || "";
  const emails = all("EMAIL").map((p) => withLabel(unescapeText(p.value).trim(), labelOf(p, ps))).filter((e) => e && !e.startsWith(" "));
  const phones = all("TEL").map((p) => withLabel(unescapeText(p.value.replace(/^tel:/i, "")).trim(), labelOf(p, ps)));
  if (!name && !emails.length && !phones.length) return null;
  const addresses = all("ADR").map((p) => {
    const [, ext, street, city, region, code, country] = parts(p.value);
    const line = [street?.replace(/\n+/g, ", "), ext, city, [region, code].filter(Boolean).join(" "), country].filter(Boolean).join(", ");
    return withLabel(line, labelOf(p, ps));
  }).filter((a) => !/^\s*\(/.test(a) && a.trim());
  const related = all("X-ABRELATEDNAMES").map((p) => withLabel(unescapeText(p.value).trim(), labelOf(p, ps)));
  const urls = all("URL").map((p) => unescapeText(p.value).trim()).filter((u) => /^https?:\/\//i.test(u));
  const rev = value("REV");
  const updated = rev && !Number.isNaN(Date.parse(rev.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"))) ? new Date(Date.parse(rev.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"))).toISOString() : undefined;
  const nickname = value("NICKNAME");
  const hay = [name, composed, nickname, org[0], value("TITLE"), ...emails, ...phones.map((p) => p.replace(/\D/g, ""))].filter(Boolean).join("\n").toLowerCase();
  return {
    id,
    name: name || emails[0]?.replace(/ \(.*\)$/, "") || phones[0],
    nickname,
    organisation: org[0] || undefined,
    department: org[1] || undefined,
    title: value("TITLE"),
    emails,
    phones,
    birthday: birthdayOf(one("BDAY")),
    addresses,
    urls,
    related,
    note: value("NOTE"),
    updated,
    hay,
  };
}

/** What Claude reads: essentials in a list, notes and the rest with `detail`. */
export function contactOut(c: Contact, detail: boolean) {
  return clean({
    id: c.id,
    name: c.name,
    nickname: c.nickname,
    organisation: c.organisation,
    department: detail ? c.department : undefined,
    title: c.title,
    emails: c.emails,
    phones: c.phones,
    birthday: c.birthday,
    addresses: c.addresses,
    related: detail ? c.related : undefined,
    urls: detail ? c.urls : undefined,
    note: detail && c.note ? clip(c.note, 2_000) : undefined,
    updated: detail ? c.updated : undefined,
  });
}

// ---------- Reading the address book ----------

const BOOKS_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`;
const CARDS_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`;

/** The address books in the home. */
export async function readBooks(session: DavSession, home: string): Promise<string[]> {
  const all = await session.multistatus("PROPFIND", home, BOOKS_BODY, 1);
  return all.filter((r) => find(r.props.get("resourcetype"), "addressbook")).map((r) => (r.href.endsWith("/") ? r.href : `${r.href}/`));
}

const multiget = (hrefs: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop>${hrefs
    .map((h) => `<d:href>${xmlText(new URL(h).pathname)}</d:href>`)
    .join("")}</card:addressbook-multiget>`;

/** A contact's id: its file's name without .vcf. */
export const contactId = (href: string) => lastSegment(href).replace(/\.vcf$/i, "");
const ID = /^[A-Za-z0-9._@%+~-]{1,300}$/;

/** Every person in the address books, sorted by name. */
export async function readPeople(session: DavSession, books: string[]): Promise<Contact[]> {
  const hrefs: string[] = [];
  for (const book of books) {
    const list = await session.multistatus("PROPFIND", book, CARDS_BODY, 1);
    for (const r of list) if (r.href !== book && r.href.startsWith(book) && !r.href.endsWith("/")) hrefs.push(r.href);
  }
  const batches: string[][] = [];
  for (let i = 0; i < Math.min(hrefs.length, MAX_CARDS); i += BATCH) batches.push(hrefs.slice(i, i + BATCH));
  const read = await mapLimit(batches, 3, async (batch) => {
    const book = books.find((b) => batch[0].startsWith(b)) ?? books[0];
    const replies = await session.multistatus("REPORT", book, multiget(batch), 1);
    return replies.flatMap((r) => {
      const data = r.props.get("address-data")?.text;
      const c = data ? parseCard(data, contactId(r.href)) : null;
      return c ? [c] : [];
    });
  });
  return read.flat().sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

// ---------- Paging ----------

function readToken(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof v.s === "number" && Number.isInteger(v.s) && v.s >= 0) return v.s;
  } catch {
    // fall through
  }
  throw new ToolInputError("pageToken isn't one this tool gave out. Leave it out to start from the beginning");
}

const makeToken = (s: number) => Buffer.from(JSON.stringify({ s }), "utf8").toString("base64url");

function page(found: Contact[], offset: number, want: number) {
  const contacts: Record<string, unknown>[] = [];
  let size = 0;
  let i = offset;
  for (; i < found.length && contacts.length < want && size <= LIST_BUDGET; i++) {
    const c = contactOut(found[i], false);
    contacts.push(c);
    size += JSON.stringify(c).length;
  }
  return clean({ contacts, total: found.length, nextPageToken: i < found.length ? makeToken(i) : undefined });
}

// ---------- Tools ----------

const searchContacts: IcloudContactsTool = {
  name: "search_contacts",
  summary: "Find someone in your contacts",
  description:
    "Search the owner's iCloud contacts by name, nickname, organisation, job title, email or phone number (digits match however the number is written). " +
    "Every word must match. Best matches first (names that start with the words), then A to Z. " +
    "Each contact has its id, name, organisation, title, emails and phones with their labels (work, mobile…), birthday (YYYY-MM-DD, or --MM-DD without a year) and addresses. If nextPageToken comes back, call again with it for more.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A name, company, email or number, e.g. Priya, or Acme, or 07700 900123." },
      pageSize: { type: "integer", description: "Contacts to return, 1–100 (default 20)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const query = arg.str(args, "query", { required: true, max: 200 })!;
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (/^[+\d().-]+$/.test(w) && /\d{3}/.test(w) ? w.replace(/\D/g, "") : w))
      .filter(Boolean);
    if (!words.length) throw new ToolInputError("query is required");
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 100, fallback: 20 });
    const offset = readToken(arg.str(args, "pageToken", { max: 500 }));
    const people = await ctx.people();
    const first = words[0];
    const found = people
      .filter((c) => words.every((w) => c.hay.includes(w)))
      .map((c, i) => ({ c, rank: c.name.toLowerCase().startsWith(first) || c.name.toLowerCase().includes(` ${first}`) ? 0 : 1, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.c);
    return page(found, offset, pageSize);
  },
};

const listContacts: IcloudContactsTool = {
  name: "list_contacts",
  summary: "See all your contacts",
  description:
    "List the owner's iCloud contacts A to Z, a page at a time, with the same fields as search_contacts and the total. If nextPageToken comes back, call again with it for the next page.",
  inputSchema: {
    type: "object",
    properties: {
      pageSize: { type: "integer", description: "Contacts to return, 1–200 (default 50)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 200, fallback: 50 });
    const offset = readToken(arg.str(args, "pageToken", { max: 500 }));
    return page(await ctx.people(), offset, pageSize);
  },
};

const getContact: IcloudContactsTool = {
  name: "get_contact",
  summary: "Read one contact in full",
  description: "Read one contact in full by its id (from search_contacts or list_contacts): everything they give, plus notes, related people, web links and when it last changed.",
  inputSchema: {
    type: "object",
    properties: { contactId: { type: "string", description: "The contact's id." } },
    required: ["contactId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const id = arg.str(args, "contactId", { required: true, max: 300 })!.trim();
    const notFound = () => new ToolInputError(`Not found: there's no contact ${id}. It may have been deleted`);
    if (!ID.test(id) || id === "." || id === "..") throw notFound();
    for (const book of await ctx.books()) {
      try {
        const r = await ctx.session.request("GET", `${book}${encodeURIComponent(id)}.vcf`);
        const c = parseCard(r.text, id);
        if (c) return contactOut(c, true);
      } catch (error) {
        if (!(error instanceof IcloudError && (error.status === 404 || error.status === 410))) throw error;
      }
    }
    throw notFound();
  },
};

export const ICLOUD_CONTACTS_TOOLS: IcloudContactsTool[] = [searchContacts, getContact, listContacts];
