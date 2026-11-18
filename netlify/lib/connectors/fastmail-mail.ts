/**
 * Fastmail's mail tools for fastmail-direct.ts, over JMAP (RFC 8620, 8621).
 * The same names, arguments and JSON fields as Athena's Gmail tools
 * (google-gmail.ts), so precheck.ts, the email digest recipe and Ask read a
 * Fastmail account exactly as they read Gmail:
 *
 *  - a "thread" is a JMAP Thread;
 *  - search takes Gmail's syntax (from:, after:, -in:sent, is:unread…) and
 *    turns it into a JMAP filter, which Fastmail applies itself;
 *  - bodies are plain text (the text part, or the HTML one converted), with
 *    quoted earlier replies dropped as for Gmail;
 *  - attachments are named, never read;
 *  - a long conversation keeps its newest messages whole.
 *
 * The only methods sent are Mailbox/get, Email/query, Email/get and
 * Thread/get, plus, for an account with drafts on, create_draft's one new
 * email in Drafts (isDraftCreate). fastmail-direct.ts refuses any other,
 * so nothing here can send, move, flag or delete.
 */
import { ToolInputError, arg, clean, clip, htmlToText, tidyText } from "./google-api";
import { stripQuoted } from "./google-gmail";
import type { DirectToolInfo } from "./direct";
import {
  FILTERED_NOTE,
  REFUSED_NOTE,
  hasRules,
  keepsMessage,
  passes,
  reachesOwner,
  threadKept,
  topSenders,
  type MailLabel,
  type MailPreview,
  type MailRules,
  type RuleMessage,
} from "../../../lib/mail-rules";
import { activeRules, type MailGuard } from "./mail-guard";

const MESSAGE_BODY_MAX = 8_000;
const THREAD_BODY_BUDGET = 16_000;
const SNIPPET_MAX = 200;
const SEARCH_BUDGET = 22_000;
/** The most of one body Fastmail is asked for. */
const BODY_BYTES = 60_000;

const VIEWS = ["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_IDS_ONLY", "THREAD_VIEW_SUMMARY"] as const;
const FORMATS = ["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY", "PLAIN_TEXT"] as const;
type MessageFormat = (typeof FORMATS)[number];

// ---------- JMAP ----------

/** One method call: its name, arguments and an id the answer carries back. */
export type JmapCall = [name: string, args: Record<string, unknown>, id: string];
export type JmapReply = [name: string, result: Record<string, unknown>, id: string];

/** The only methods Athena sends. Anything that changes the mailbox (…/set, …/copy, EmailSubmission) isn't here. */
export const READ_METHODS = new Set(["Mailbox/get", "Email/query", "Email/get", "Thread/get"]);

export interface FastmailContext {
  /** Send method calls (READ_METHODS only); the replies, in order. accountId is filled in. */
  call(calls: JmapCall[]): Promise<JmapReply[]>;
  /** The account's address. */
  email: string;
  /** "Let Athena save drafts" is on for this account. */
  drafts?: boolean;
  /** The owner's rules for which emails Athena reads, and the threads they kept out since the account opened. */
  mail?: MailGuard;
  now(): Date;
}

export interface FastmailTool extends DirectToolInfo {
  run(ctx: FastmailContext, args: Record<string, unknown>): Promise<unknown>;
}

/** A reply by its call id; a method-level error becomes something the model (or the owner) can read. */
function reply(replies: JmapReply[], id: string): Record<string, unknown> {
  const r = replies.find((x) => x[2] === id);
  if (!r) throw new ToolInputError("Fastmail didn't answer that");
  if (r[0] === "error") {
    const type = String(r[1].type ?? "");
    if (type === "accountReadOnly" || type === "forbidden") throw new ToolInputError(NO_DRAFTS);
    if (type === "unsupportedFilter" || type === "invalidArguments" || type === "tooLarge") throw new ToolInputError(`Fastmail couldn't run that search (${type}). Try simpler terms`);
    throw new ToolInputError(`Fastmail refused that (${type || "error"})`);
  }
  return r[1];
}

interface Address {
  name?: string | null;
  email?: string | null;
}
interface BodyPart {
  partId?: string;
  type?: string;
  name?: string | null;
  disposition?: string | null;
}
export interface JmapEmail {
  id: string;
  threadId?: string;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from?: Address[] | null;
  to?: Address[] | null;
  cc?: Address[] | null;
  subject?: string | null;
  receivedAt?: string;
  preview?: string;
  hasAttachment?: boolean;
  textBody?: BodyPart[];
  bodyValues?: Record<string, { value?: string; isTruncated?: boolean }>;
  attachments?: BodyPart[];
}

const LIST_PROPS = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "subject", "receivedAt", "preview", "hasAttachment"];
const BODY_PROPS = [...LIST_PROPS, "textBody", "bodyValues", "attachments"];

// ---------- Mailboxes (Fastmail's folders or labels) ----------

/** JMAP's roles, by the names Gmail's in: and its system labels use. */
const ROLE_LABEL: Record<string, string> = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT", trash: "TRASH", junk: "SPAM", archive: "ARCHIVE" };
const ALIASES: Record<string, string> = { bin: "trash", deleted: "trash", "deleted items": "trash", spam: "junk", "junk mail": "junk", "sent items": "sent", draft: "drafts" };

interface Mailbox {
  id: string;
  name: string;
  role: string | null;
}
interface Mailboxes {
  list: Mailbox[];
  byId: Map<string, Mailbox>;
  /** Role (inbox, sent, drafts, trash, junk, archive) → mailbox id. */
  role: Map<string, string>;
}

const mailboxCache = new WeakMap<FastmailContext, Promise<Mailboxes>>();

/** This account's mailboxes, read once per opened account. */
export function mailboxes(ctx: FastmailContext): Promise<Mailboxes> {
  let p = mailboxCache.get(ctx);
  if (!p) {
    p = (async () => {
      const r = reply(await ctx.call([["Mailbox/get", { ids: null, properties: ["id", "name", "role"] }, "m"]]), "m");
      const list = (Array.isArray(r.list) ? (r.list as Array<Partial<Mailbox>>) : []).filter((m): m is Mailbox => typeof m.id === "string").map((m) => ({ id: m.id, name: m.name ?? "", role: m.role ?? null }));
      const role = new Map<string, string>();
      for (const m of list) if (m.role && !role.has(m.role)) role.set(m.role, m.id);
      return { list, byId: new Map(list.map((m) => [m.id, m])), role };
    })();
    p.catch(() => mailboxCache.delete(ctx));
    mailboxCache.set(ctx, p);
  }
  return p;
}

/** A folder named in in: or label:, as its mailbox id: a role, or a folder the owner made, matched by its name. */
function mailboxId(boxes: Mailboxes, name: string): string {
  const key = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  const byRole = boxes.role.get(key);
  if (byRole) return byRole;
  const found = boxes.list.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new ToolInputError(`There's no folder called "${name}". list_labels shows the folders there are`);
  return found.id;
}

// ---------- Gmail's search syntax, as a JMAP filter ----------

type Filter = Record<string, unknown>;
const not = (f: Filter): Filter => ({ operator: "NOT", conditions: [f] });
const any = (fs: Filter[]): Filter => (fs.length === 1 ? fs[0] : { operator: "OR", conditions: fs });
const all = (fs: Filter[]): Filter => (fs.length === 1 ? fs[0] : { operator: "AND", conditions: fs });

const DAY = 86_400_000;

/**
 * A Gmail date (2026/11/05, 2026-11-05, or seconds since 1970) as the
 * instant it starts. Gmail counts whole days in the owner's time zone, which
 * a token doesn't say, so the earliest that day starts anywhere (UTC+14) for
 * after:, and the latest (UTC−12) for before:. A day either side at most.
 */
function gmailDate(raw: string, edge: "after" | "before"): Date {
  if (/^\d{9,11}$/.test(raw)) return new Date(Number(raw) * 1000);
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw);
  if (!m) throw new ToolInputError(`"${raw}" isn't a date Gmail's search takes. Use YYYY/MM/DD`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + (edge === "after" ? -14 : 12) * 3_600_000);
}

function relative(raw: string): number {
  const m = /^(\d+)([hdmy])$/i.exec(raw);
  if (!m) throw new ToolInputError(`"${raw}" isn't a span Gmail's search takes. Use a number and d, m or y, like 2d`);
  return Number(m[1]) * { h: 3_600_000, d: DAY, m: 30 * DAY, y: 365 * DAY }[m[2].toLowerCase() as "h" | "d" | "m" | "y"];
}

/** JMAP wants UTC date-times without milliseconds. */
const utc = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

export interface MailQuery {
  /** Every condition the search names, to be ANDed. */
  conditions: Filter[];
  /** in: or label: named a folder, so Trash and Junk aren't left out. */
  namedFolder: boolean;
  /** in:anywhere. */
  anywhere: boolean;
}

/** Read a Gmail search into JMAP conditions. `A OR B` joins the terms either side of it. */
export function parseGmailQuery(query: string, now: Date, boxes: Mailboxes): MailQuery {
  const q: MailQuery = { conditions: [], namedFolder: false, anywhere: false };
  let orNext = false;
  const add = (f: Filter | null) => {
    if (!f) return;
    if (orNext && q.conditions.length) {
      const prev = q.conditions.pop()!;
      q.conditions.push({ operator: "OR", conditions: [...(prev.operator === "OR" ? (prev.conditions as Filter[]) : [prev]), f] });
    } else q.conditions.push(f);
    orNext = false;
  };
  const tokens = query.match(/-?[\w]+:"[^"]*"|-?[\w]+:\S+|-?"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const neg = raw.startsWith("-") && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    const wrap = (f: Filter) => (neg ? not(f) : f);
    const op = /^([\w]+):(.*)$/.exec(t);
    if (!op) {
      if (t === "OR") {
        orNext = q.conditions.length > 0;
        continue;
      }
      if (t === "AND" || t === "(" || t === ")") continue;
      const word = t.replace(/^\(+|\)+$/g, "").replace(/^"|"$/g, "");
      if (word) add(wrap({ text: word }));
      continue;
    }
    const key = op[1].toLowerCase();
    const value = op[2].replace(/^"|"$/g, "");
    switch (key) {
      case "from":
      case "to":
      case "cc":
      case "bcc":
      case "subject":
        add(wrap({ [key]: value }));
        break;
      case "has":
        if (value.toLowerCase() === "attachment") add({ hasAttachment: !neg });
        break;
      case "after":
      case "newer":
        add({ after: utc(gmailDate(value, "after")) });
        break;
      case "before":
      case "older":
        add({ before: utc(gmailDate(value, "before")) });
        break;
      case "newer_than":
        add({ after: utc(new Date(now.getTime() - relative(value))) });
        break;
      case "older_than":
        add({ before: utc(new Date(now.getTime() - relative(value))) });
        break;
      case "is": {
        const v = value.toLowerCase();
        if (v === "unread") add(neg ? { hasKeyword: "$seen" } : { notKeyword: "$seen" });
        else if (v === "read") add(neg ? { notKeyword: "$seen" } : { hasKeyword: "$seen" });
        else if (v === "starred" || v === "flagged") add(neg ? { notKeyword: "$flagged" } : { hasKeyword: "$flagged" });
        // is:important has no Fastmail match: left out, never a wrong answer.
        break;
      }
      case "category":
        // Gmail's tabs: Fastmail has none.
        break;
      case "in":
      case "label": {
        const v = value.toLowerCase();
        if (v === "chats" || v === "chat") break;
        if (v === "anywhere") {
          q.anywhere = !neg;
          break;
        }
        if (neg) {
          // A folder this mailbox doesn't have can't hold anything to leave out.
          const key2 = ALIASES[v] ?? v;
          const id = boxes.role.get(key2) ?? boxes.list.find((m) => m.name.toLowerCase() === v)?.id;
          if (id) add(not({ inMailbox: id }));
        } else {
          add({ inMailbox: mailboxId(boxes, value) });
          q.namedFolder = true;
        }
        break;
      }
      default:
        // An operator Fastmail has no match for: search for the words.
        add(wrap({ text: value }));
    }
  }
  return q;
}

/** The owner's rules as JMAP conditions, so Fastmail leaves that mail out itself; each message is still checked here (passes). */
export function ruleConditions(rules: MailRules | null, boxes: Mailboxes): Filter[] {
  if (!hasRules(rules)) return [];
  const out: Filter[] = [];
  for (const s of rules.skip_senders) out.push(not({ from: s }));
  for (const s of rules.skip_subjects) out.push(not({ subject: s }));
  for (const l of rules.skip_labels) if (boxes.byId.has(l.id)) out.push(not({ inMailbox: l.id }));
  if (rules.inbox_only) {
    const own = ["inbox", "sent"].map((r) => boxes.role.get(r)).filter((id): id is string => !!id);
    if (own.length) out.push(any(own.map((id) => ({ inMailbox: id }))));
  }
  if (rules.only_labels.length) out.push(any(rules.only_labels.map((l) => ({ inMailbox: l.id }))));
  return out;
}

/** The whole filter for a search: what was asked, without Drafts (and Trash and Junk unless asked for), and the rules. */
export function searchFilter(q: MailQuery, boxes: Mailboxes, opts: { includeTrash: boolean; rules: MailRules | null }): Filter {
  const hide = ["drafts", ...(opts.includeTrash || q.anywhere || q.namedFolder ? [] : ["trash", "junk"])].map((r) => boxes.role.get(r)).filter((id): id is string => !!id);
  return all([...q.conditions, ...(hide.length ? [{ inMailboxOtherThan: hide }] : []), ...ruleConditions(opts.rules, boxes)].filter(Boolean)) ?? {};
}

// ---------- Output ----------

/** "Priya Shah <priya@example.com>", or whichever half Fastmail gave. */
export function person(a: Address | undefined | null): string {
  const name = a?.name?.trim();
  const email = a?.email?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || "";
}

const isDraft = (m: JmapEmail) => !!m.keywords?.$draft;

/** Gmail-style labels: its folders by role (INBOX, SENT…) or name, UNREAD and STARRED. */
function labelIds(m: JmapEmail, boxes: Mailboxes): string[] {
  const folders = Object.keys(m.mailboxIds ?? {}).map((id) => {
    const box = boxes.byId.get(id);
    return box ? ((box.role && ROLE_LABEL[box.role]) ?? box.name) : "";
  });
  return [...folders, m.keywords?.$seen ? "" : "UNREAD", m.keywords?.$flagged ? "STARRED" : ""].filter(Boolean);
}

/** A message as the owner's rules see it: sender, subject, its Gmail-style labels and its mailboxes' ids. */
export function ruleView(m: JmapEmail, boxes: Mailboxes): RuleMessage {
  return { from: m.from?.[0]?.email ?? "", subject: m.subject ?? "", labels: [...labelIds(m, boxes), ...Object.keys(m.mailboxIds ?? {})] };
}

/** Where the owner opens it. Fastmail's web addresses carry the thread and message ids. */
export const viewUrl = (m: Pick<JmapEmail, "id" | "threadId">): string => (m.threadId ? `https://app.fastmail.com/mail/Inbox/${encodeURIComponent(m.threadId)}.${encodeURIComponent(m.id)}` : "https://app.fastmail.com/mail/");

function messageOut(m: JmapEmail, boxes: Mailboxes, o: { format: MessageFormat; body?: string; attachments?: string[]; withThreadId?: boolean }) {
  const metadataOnly = o.format === "METADATA_ONLY";
  return clean({
    id: m.id,
    threadId: o.withThreadId ? m.threadId : undefined,
    sender: person(m.from?.[0]),
    toRecipients: (m.to ?? []).map(person).filter(Boolean),
    ccRecipients: (m.cc ?? []).map(person).filter(Boolean),
    subject: metadataOnly ? undefined : (m.subject ?? "").trim(),
    snippet: metadataOnly || o.body ? undefined : clip(tidyText(m.preview ?? ""), SNIPPET_MAX),
    date: m.receivedAt ? new Date(m.receivedAt).toISOString() : undefined,
    labelIds: labelIds(m, boxes),
    plaintextBody: o.body,
    attachments: o.attachments,
  });
}

const withBody = (format: MessageFormat) => format !== "MINIMAL" && format !== "METADATA_ONLY";

/** A message's own words: its text parts (an HTML-only email converted), quoted earlier replies dropped. */
export function bodyText(m: JmapEmail): string {
  const parts = (m.textBody ?? []).map((p) => {
    const value = (p.partId && m.bodyValues?.[p.partId]?.value) || "";
    return p.type === "text/html" ? htmlToText(value) : value;
  });
  return stripQuoted(tidyText(parts.join("\n").trim()));
}

/** Attachment names, never their contents. Pictures inside the email aren't named. */
function attachmentNames(m: JmapEmail): string[] | undefined {
  const names = (m.attachments ?? []).filter((a) => a.name && a.disposition !== "inline").map((a) => a.name!);
  return names.length ? names : undefined;
}

const byDate = (a: JmapEmail, b: JmapEmail) => Date.parse(a.receivedAt ?? "") - Date.parse(b.receivedAt ?? "");

/** Every message in a thread, oldest first, drafts left out. */
async function thread(ctx: FastmailContext, threadId: string, bodies: boolean): Promise<JmapEmail[]> {
  const replies = await ctx.call([
    ["Thread/get", { ids: [threadId] }, "t"],
    [
      "Email/get",
      { "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: bodies ? BODY_PROPS : LIST_PROPS, ...(bodies ? { fetchTextBodyValues: true, maxBodyValueBytes: BODY_BYTES } : {}) },
      "e",
    ],
  ]);
  if (!Array.isArray(reply(replies, "t").list) || !(reply(replies, "t").list as unknown[]).length) return [];
  return ((reply(replies, "e").list as JmapEmail[] | undefined) ?? []).filter((m) => !isDraft(m)).sort(byDate);
}

type ThreadOut = { id: string; messageCount?: number; viewUrl?: string; messages?: Array<Partial<ReturnType<typeof messageOut>>> };

/** As Gmail's: shorter snippets first, then message ids, then snippets, then links, only as far as needed. */
function fitThreads(threads: ThreadOut[], nextPageToken?: string, note?: string): Record<string, unknown> {
  const size = () => JSON.stringify({ threads, nextPageToken, note }).length;
  const messages = threads.flatMap((t) => t.messages ?? []);
  const steps: Array<() => void> = [
    () => messages.forEach((m) => m.snippet && (m.snippet = clip(m.snippet, 100))),
    () => messages.forEach((m) => delete m.id),
    () => messages.forEach((m) => delete m.snippet),
    () => threads.forEach((t) => delete t.viewUrl),
  ];
  for (const shrink of steps) {
    if (size() <= SEARCH_BUDGET) break;
    shrink();
  }
  return clean({ threads, nextPageToken, note });
}

// ---------- Page tokens: how far into the search ----------

function readToken(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /^p(\d{1,7})$/.exec(raw);
  if (!m) throw new ToolInputError("pageToken isn't one this tool gave out. Leave it out to start from the beginning");
  return Number(m[1]);
}

// ---------- Tools ----------

const searchThreads: FastmailTool = {
  name: "search_threads",
  summary: "Search your email",
  description:
    "Search the owner's Fastmail email with Gmail's search syntax, which Athena translates: words and \"exact phrases\", from:, to:, cc:, subject:, after:YYYY/MM/DD, before:, newer_than:2d, is:unread, is:starred (flagged), in:inbox, in:sent, -in:sent, label:<folder name>, has:attachment, OR. " +
    "Returns each conversation's id (use it as threadId), messageCount, viewUrl and up to 5 of its latest messages (sender, recipients, subject, snippet, date, labelIds); bodies aren't included, so read one with get_thread. " +
    "view: THREAD_VIEW_SUMMARY gives only the latest message per conversation, THREAD_VIEW_IDS_ONLY only ids, THREAD_VIEW_METADATA_ONLY leaves out subjects and snippets. " +
    "after: and before: are whole days and may include a few hours either side; check each message's date. An empty object {} means nothing matched. Use pageToken from nextPageToken for more.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail-style search, e.g. \"from:priya@example.com after:2026/11/01 -in:sent\". Leave out to list recent email." },
      pageSize: { type: "integer", description: "Conversations to return, 1–50 (default 20)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
      view: { type: "string", enum: [...VIEWS] },
      includeTrash: { type: "boolean", description: "Include Trash and Spam." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 50, fallback: 20 });
    const view = arg.oneOf(args, "view", VIEWS) ?? "THREAD_VIEW_MINIMAL";
    // The owner's rules go on every search, in the filter, and every message is checked against them below.
    const rules = activeRules(ctx.mail);
    const boxes = await mailboxes(ctx);
    const asked = parseGmailQuery(arg.str(args, "query", { max: 2000 }) ?? "", ctx.now(), boxes);
    const includeTrash = arg.bool(args, "includeTrash");
    const position = readToken(arg.str(args, "pageToken", { max: 20 }));
    const sort = [{ property: "receivedAt", isAscending: false }];
    const whole = (id: string): JmapCall[] => [
      ["Email/get", { "#ids": { resultOf: id, name: "Email/query", path: "/ids" }, properties: ["threadId"] }, `${id}h`],
      ["Thread/get", { "#ids": { resultOf: `${id}h`, name: "Email/get", path: "/list/*/threadId" } }, `${id}t`],
      ["Email/get", { "#ids": { resultOf: `${id}t`, name: "Thread/get", path: "/list/*/emailIds" }, properties: LIST_PROPS }, `${id}e`],
    ];
    const replies = await ctx.call([
      // One more than asked for says whether there's another page.
      ["Email/query", { filter: searchFilter(asked, boxes, { includeTrash, rules }), sort, collapseThreads: true, position, limit: pageSize + 1 }, "q"],
      ...whole("q"),
      // The same search without the rules, first page only, metadata only: conversations the rules keep out, counted.
      ...(rules && !position ? ([["Email/query", { filter: searchFilter(asked, boxes, { includeTrash, rules: null }), sort, collapseThreads: true, position: 0, limit: 50 }, "u"], ["Email/get", { "#ids": { resultOf: "u", name: "Email/query", path: "/ids" }, properties: ["threadId", "from", "subject", "mailboxIds", "keywords"] }, "ue"]] as JmapCall[]) : []),
    ]);
    if (rules && !position) {
      try {
        for (const m of (reply(replies, "ue").list as JmapEmail[] | undefined) ?? []) if (m.threadId && !passes(ruleView(m, boxes), rules)) ctx.mail?.skipped.add(m.threadId);
      } catch {
        // Only a count.
      }
    }
    const ids = (reply(replies, "q").ids as string[] | undefined) ?? [];
    if (!ids.length) return {};
    const hits = new Map(((reply(replies, "qh").list as JmapEmail[] | undefined) ?? []).map((m) => [m.id, m.threadId ?? ""]));
    const emails = ((reply(replies, "qe").list as JmapEmail[] | undefined) ?? []).filter((m) => !isDraft(m));
    const byThread = new Map<string, JmapEmail[]>();
    for (const m of emails) if (m.threadId) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    const more = ids.length > pageSize;
    const found: Array<{ id: string; hit: JmapEmail; messages: JmapEmail[] }> = [];
    for (const emailId of ids.slice(0, pageSize)) {
      const threadId = hits.get(emailId);
      const messages = (threadId ? byThread.get(threadId) : undefined)?.sort(byDate) ?? [];
      const hit = messages.find((m) => m.id === emailId);
      if (!threadId || !hit || found.some((t) => t.id === threadId)) continue;
      if (rules && !passes(ruleView(hit, boxes), rules)) {
        ctx.mail?.skipped.add(threadId);
        continue;
      }
      found.push({ id: threadId, hit, messages });
    }
    const nextPageToken = more ? `p${position + pageSize}` : undefined;
    if (!found.length && !nextPageToken) return {};
    const note = rules ? FILTERED_NOTE : undefined;
    if (view === "THREAD_VIEW_IDS_ONLY") return clean({ threads: found.map((t) => ({ id: t.id })), nextPageToken, note });

    const format: MessageFormat = view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    const summary = view === "THREAD_VIEW_SUMMARY";
    const threads = found.map((t): ThreadOut => {
      // The search found a message the rules keep; the rest of its conversation is checked too.
      const kept = rules ? t.messages.filter((m) => keepsMessage(ruleView(m, boxes), rules)) : t.messages;
      const list = kept.length ? kept : [t.hit];
      // A one-line summary is the conversation's latest message; otherwise its latest five.
      const shown = (summary ? list.slice(-1) : list.slice(-5)).map((m) => {
        const out = messageOut(m, boxes, { format });
        if (summary) {
          delete out.toRecipients;
          delete out.ccRecipients;
        }
        return out;
      });
      return { id: t.id, messageCount: summary ? undefined : list.length, viewUrl: viewUrl(list[list.length - 1]), messages: shown };
    });
    return fitThreads(threads, nextPageToken, note);
  },
};

const getThread: FastmailTool = {
  name: "get_thread",
  summary: "Read a whole conversation",
  description:
    "Read a whole Fastmail conversation by its id (from search_threads): every message with sender, recipients, subject, date, labelIds and plaintextBody (the body as plain text, earlier quoted replies left out), plus attachment names. " +
    "A very long conversation gives only snippets for its oldest messages. messageFormat MINIMAL leaves out bodies (subject and snippet only); METADATA_ONLY leaves out subjects too. Drafts aren't included.",
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The conversation's id, from search_threads." },
      messageFormat: { type: "string", enum: [...FORMATS], description: "Default PLAIN_TEXT. FULL_CONTENT is the same here (bodies are always plain text)." },
    },
    required: ["threadId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const threadId = arg.str(args, "threadId", { required: true, max: 500 })!;
    const format = arg.oneOf(args, "messageFormat", FORMATS) ?? "PLAIN_TEXT";
    const bodies = withBody(format);
    const rules = activeRules(ctx.mail);
    const boxes = await mailboxes(ctx);
    let messages = await thread(ctx, threadId, bodies);
    if (!messages.length) throw new ToolInputError(`Not found: there's no conversation ${threadId} in this mailbox. It may have been deleted`);
    if (rules) {
      const kept = threadKept(messages, (m) => ruleView(m, boxes), rules);
      if (!kept) throw new ToolInputError(REFUSED_NOTE);
      messages = kept;
    }
    let budget = THREAD_BODY_BUDGET;
    const out = new Array<ReturnType<typeof messageOut>>(messages.length);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!bodies) {
        out[i] = messageOut(m, boxes, { format });
        continue;
      }
      const body = budget > 300 ? clip(bodyText(m), Math.min(MESSAGE_BODY_MAX, budget)) : undefined;
      if (body) budget -= body.length;
      out[i] = messageOut(m, boxes, { format, body, attachments: attachmentNames(m) });
    }
    return clean({ id: threadId, viewUrl: viewUrl(messages[messages.length - 1]), messages: out });
  },
};

const getMessage: FastmailTool = {
  name: "get_message",
  summary: "Read one email",
  description:
    "Read one Fastmail message by its id: sender, recipients, subject, date, labelIds, threadId and plaintextBody (plain text, quoted replies left out), plus attachment names. For a whole conversation use get_thread.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", description: "The message's id." },
      messageFormat: { type: "string", enum: [...FORMATS], description: "Default PLAIN_TEXT. MINIMAL leaves out the body; METADATA_ONLY the subject too." },
    },
    required: ["messageId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const messageId = arg.str(args, "messageId", { required: true, max: 500 })!;
    const format = arg.oneOf(args, "messageFormat", FORMATS) ?? "PLAIN_TEXT";
    const bodies = withBody(format);
    const boxes = await mailboxes(ctx);
    const r = reply(await ctx.call([["Email/get", { ids: [messageId], properties: bodies ? BODY_PROPS : LIST_PROPS, ...(bodies ? { fetchTextBodyValues: true, maxBodyValueBytes: BODY_BYTES } : {}) }, "e"]]), "e");
    const m = (r.list as JmapEmail[] | undefined)?.[0];
    if (!m || isDraft(m)) throw new ToolInputError(`Not found: there's no message ${messageId} in this mailbox`);
    const rules = activeRules(ctx.mail);
    if (rules) {
      const v = ruleView(m, boxes);
      // The message itself, then (when it's outside the inbox) whether its conversation ever reached the owner.
      const reached = reachesOwner(v, rules) || (!!m.threadId && (await thread(ctx, m.threadId, false).catch(() => [])).some((x) => reachesOwner(ruleView(x, boxes), rules)));
      if (!keepsMessage(v, rules) || !reached) throw new ToolInputError(REFUSED_NOTE);
    }
    const base = { format, withThreadId: true };
    if (!bodies) return { ...messageOut(m, boxes, base), viewUrl: viewUrl(m) };
    return { ...messageOut(m, boxes, { ...base, body: clip(bodyText(m), 20_000), attachments: attachmentNames(m) }), viewUrl: viewUrl(m) };
  },
};

const listLabels: FastmailTool = {
  name: "list_labels",
  summary: "See your folders",
  description: "List the owner's Fastmail folders (or labels): each one's id, name and whether it's one of Fastmail's own (Inbox, Sent, Trash…) or one they made. Search inside one with in:<folder name>.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async run(ctx) {
    const boxes = await mailboxes(ctx);
    const labels = boxes.list.map((m) => clean({ id: m.id, name: m.name, type: m.role ? "system" : "user" }));
    return labels.length ? { labels } : {};
  },
};

// ---------- create_draft: the only write ----------

export const NO_DRAFTS = "This Fastmail token can't save drafts. Make a new token with Make changes ticked as well as Read data (never Send email), and paste it under Edit.";

const PLAIN_EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

/**
 * Is this call exactly a new draft, and nothing else? Email/set with only
 * `create`, every new email in one mailbox with the $draft keyword. No
 * update, no destroy, so nothing already there can be moved, changed or
 * deleted; and the request never names JMAP's submission capability, so
 * nothing can be sent. fastmail-direct.ts refuses any other write.
 */
export function isDraftCreate(call: JmapCall): boolean {
  const [name, args] = call;
  if (name !== "Email/set") return false;
  const keys = Object.keys(args).filter((k) => k !== "accountId");
  if (keys.length !== 1 || keys[0] !== "create") return false;
  const created = Object.values((args.create ?? {}) as Record<string, { mailboxIds?: Record<string, boolean>; keywords?: Record<string, boolean> }>);
  return created.length === 1 && created.every((e) => e?.keywords?.$draft === true && Object.keys(e.mailboxIds ?? {}).length === 1);
}

const createDraft: FastmailTool = {
  name: "create_draft",
  summary: "Save a draft for you to check and send",
  description:
    "Save a draft email in the owner's Fastmail Drafts for them to check and send. It never sends. body is plain text. " +
    "To reply inside a conversation, give replyToMessageId (the message being answered): the draft joins it. Returns the draft's id, threadId and viewUrl.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" }, description: "Plain email addresses." },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text." },
      includeSignature: { type: "boolean", description: "Ignored: add your signature when you open the draft." },
      replyToMessageId: { type: "string" },
    },
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    if (!ctx.drafts) throw new ToolInputError("Drafts aren't turned on for this Fastmail account");
    for (const k of ["cc", "bcc", "attachments", "htmlBody"]) if (args[k] !== undefined) throw new ToolInputError(`Athena's Fastmail drafts don't take ${k}`);
    let to = arg.strings(args, "to", 50);
    const bad = to.find((a) => !PLAIN_EMAIL.test(a));
    if (bad) throw new ToolInputError(`to: "${bad}" isn't a plain email address`);
    let subject = arg.str(args, "subject", { max: 1000 }) ?? "";
    const text = arg.str(args, "body", { max: 100_000 }) ?? "";
    const boxes = await mailboxes(ctx);
    const draftsId = boxes.role.get("drafts");
    if (!draftsId) throw new ToolInputError("This Fastmail account has no Drafts folder");
    // A reply joins its conversation by the headers a mail app would set.
    let threading: Record<string, unknown> = {};
    const replyTo = arg.str(args, "replyToMessageId", { max: 500 });
    if (replyTo) {
      const r = reply(await ctx.call([["Email/get", { ids: [replyTo], properties: ["messageId", "references", "subject", "from", "replyTo"] }, "o"]]), "o");
      const original = (r.list as Array<{ messageId?: string[] | null; references?: string[] | null; subject?: string | null; from?: Address[] | null; replyTo?: Address[] | null }> | undefined)?.[0];
      if (!original) throw new ToolInputError("The message to reply to wasn't found");
      const ids = original.messageId ?? [];
      threading = ids.length ? { inReplyTo: ids, references: [...(original.references ?? []), ...ids].slice(-20) } : {};
      if (!subject) subject = /^re:/i.test(original.subject ?? "") ? (original.subject ?? "") : `Re: ${original.subject ?? ""}`.trim();
      if (!to.length) to = (original.replyTo?.length ? original.replyTo : (original.from ?? [])).map((a) => a.email ?? "").filter((a) => PLAIN_EMAIL.test(a));
    }
    const email = {
      mailboxIds: { [draftsId]: true },
      keywords: { $draft: true, $seen: true },
      ...(ctx.email ? { from: [{ email: ctx.email }] } : {}),
      to: to.map((address) => ({ email: address })),
      subject,
      bodyValues: { body: { value: text } },
      textBody: [{ partId: "body", type: "text/plain" }],
      ...threading,
    };
    const made = reply(await ctx.call([["Email/set", { create: { draft: email } }, "d"]]), "d");
    const saved = (made.created as Record<string, { id?: string; threadId?: string }> | undefined)?.draft;
    if (!saved?.id) {
      const why = String((made.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.draft?.type ?? "");
      throw new ToolInputError(why === "forbidden" || why === "accountReadOnly" ? NO_DRAFTS : `Fastmail couldn't save the draft${why ? ` (${why})` : ""}`);
    }
    return clean({ id: saved.id, threadId: saved.threadId, viewUrl: `https://app.fastmail.com/mail/Drafts/${encodeURIComponent(saved.threadId ?? "")}.${encodeURIComponent(saved.id)}` });
  },
};

/** Fastmail's tools; create_draft is offered only to an account with drafts on (fastmail-direct.ts). */
export const FASTMAIL_MAIL_TOOLS: FastmailTool[] = [searchThreads, getThread, getMessage, listLabels, createDraft];

// ---------- The settings page: folders to pick, and a count-only preview ----------

/** Folders worth a rule: the Inbox, the Archive and the owner's own. Sent, Drafts, Trash and Spam aren't. */
export async function fastmailRuleLabels(ctx: FastmailContext): Promise<MailLabel[]> {
  const boxes = await mailboxes(ctx);
  const list = boxes.list.filter((m) => m.name && (!m.role || m.role === "inbox" || m.role === "archive"));
  const inbox = list.filter((m) => m.role === "inbox");
  const rest = list.filter((m) => m.role !== "inbox").sort((a, b) => a.name.localeCompare(b.name));
  return [...inbox, ...rest].map((m) => ({ id: m.id, name: m.name }));
}

/** The most messages one preview looks at (JMAP servers give at most 500 objects a call). */
const PREVIEW_CAP = 500;

/** The last 24 hours under these rules: sender, subject and folder only, never a body, checked against the rules here. */
export async function fastmailPreview(ctx: FastmailContext, rules: MailRules): Promise<MailPreview> {
  const boxes = await mailboxes(ctx);
  const own = ["sent", "drafts"].map((r) => boxes.role.get(r)).filter((id): id is string => !!id);
  const since = utc(new Date(ctx.now().getTime() - DAY));
  const replies = await ctx.call([
    ["Email/query", { filter: all([{ after: since }, ...(own.length ? [{ inMailboxOtherThan: own }] : [])]), sort: [{ property: "receivedAt", isAscending: false }], limit: PREVIEW_CAP, calculateTotal: true }, "q"],
    ["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["from", "subject", "mailboxIds", "keywords"] }, "e"],
  ]);
  const total = Number(reply(replies, "q").total);
  const seen = ((reply(replies, "e").list as JmapEmail[] | undefined) ?? []).filter((m) => !isDraft(m)).map((m) => ruleView(m, boxes));
  const kept = hasRules(rules) ? seen.filter((m) => passes(m, rules)).length : seen.length;
  return { hours: 24, total: seen.length, skipped: seen.length - kept, capped: Number.isFinite(total) && total > seen.length, suggestions: topSenders(seen, rules, { own: ctx.email, min: 10 }) };
}
