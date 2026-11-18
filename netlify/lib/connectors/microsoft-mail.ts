/**
 * Outlook mail's tools for microsoft-direct.ts, over Microsoft Graph
 * (/me/messages). The same names, arguments and JSON fields as Athena's
 * Gmail tools (google-gmail.ts), so precheck.ts, the email digest recipe and
 * Ask read an Outlook account exactly as they read Gmail:
 *
 *  - a "thread" is an Outlook conversation (conversationId);
 *  - search takes Gmail's syntax (from:, after:, -in:sent, is:unread…) and
 *    turns it into Graph's $filter or $search, with the rest checked here;
 *  - bodies are plain text (Graph converts HTML itself), quoted earlier
 *    replies are dropped (uniqueBody, then the same quote stripping as Gmail);
 *  - attachments are named, never read: only their names are asked for;
 *  - a long conversation keeps its newest messages whole.
 *
 * Every request is a GET, except create_draft: for an account with drafts
 * on ("Let Athena save drafts", Mail.ReadWrite), it saves a new draft
 * (POST /me/messages) or a draft reply (createReply). microsoft-graph.ts
 * refuses any other write (isDraftCreate), so nothing here can send.
 */
import { createHash } from "node:crypto";
import { ToolInputError, arg, clean, clip, mapLimit, tidyText } from "./google-api";
import { stripQuoted } from "./google-gmail";
import { GRAPH, GraphApiError, graphUrl, person, utcIso, type DraftCreateBody, type GraphContext, type GraphTool } from "./microsoft-graph";
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
import { activeRules } from "./mail-guard";

const MESSAGE_BODY_MAX = 8_000;
const THREAD_BODY_BUDGET = 16_000;
const SNIPPET_MAX = 200;
const SEARCH_BUDGET = 22_000;
/** Graph's page size when searching: messages, not threads, so a page holds fewer threads than this. */
const GRAPH_PAGE = 50;
const MAX_GRAPH_PAGES = 6;

const VIEWS = ["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_IDS_ONLY", "THREAD_VIEW_SUMMARY"] as const;
const FORMATS = ["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY", "PLAIN_TEXT"] as const;
type MessageFormat = (typeof FORMATS)[number];

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}
export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: Recipient;
  sender?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  uniqueBody?: { contentType?: string; content?: string };
  isRead?: boolean;
  isDraft?: boolean;
  parentFolderId?: string;
  flag?: { flagStatus?: string };
  importance?: string;
  inferenceClassification?: string;
  categories?: string[];
  webLink?: string;
  hasAttachments?: boolean;
}

const LIST_FIELDS =
  "id,conversationId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,isDraft,parentFolderId,flag,importance,inferenceClassification,categories,webLink,hasAttachments";

// ---------- Folders ----------

/** Outlook's well-known folders, by the names Gmail's in: and its system labels use. */
const WELL_KNOWN: Record<string, { graph: string; label: string }> = {
  inbox: { graph: "inbox", label: "INBOX" },
  sent: { graph: "sentitems", label: "SENT" },
  drafts: { graph: "drafts", label: "DRAFT" },
  trash: { graph: "deleteditems", label: "TRASH" },
  spam: { graph: "junkemail", label: "SPAM" },
  archive: { graph: "archive", label: "ARCHIVE" },
};
const ALIASES: Record<string, string> = { bin: "trash", deleted: "trash", "deleted items": "trash", junk: "spam", "junk email": "spam", "sent items": "sent", draft: "drafts" };

interface Folders {
  /** Well-known name (inbox, sent…) → its id in this mailbox. */
  ids: Map<string, string>;
  /** Folder id → Gmail-style system label (INBOX, SENT…). */
  labels: Map<string, string>;
}

const folderCache = new WeakMap<GraphContext, Promise<Folders>>();

/** This mailbox's well-known folder ids, looked up once per opened account. A folder it doesn't have (Archive, sometimes) is left out. */
function folders(ctx: GraphContext): Promise<Folders> {
  let p = folderCache.get(ctx);
  if (!p) {
    p = (async () => {
      const ids = new Map<string, string>();
      const labels = new Map<string, string>();
      await Promise.all(
        Object.entries(WELL_KNOWN).map(async ([name, f]) => {
          try {
            const r = await ctx.get<{ id?: string }>(graphUrl(`/me/mailFolders/${f.graph}`, { $select: "id" }));
            if (r.id) {
              ids.set(name, r.id);
              labels.set(r.id, f.label);
            }
          } catch (error) {
            if (!(error instanceof GraphApiError && (error.status === 404 || error.status === 400))) throw error;
          }
        }),
      );
      return { ids, labels };
    })();
    p.catch(() => folderCache.delete(ctx));
    folderCache.set(ctx, p);
  }
  return p;
}

/** A folder named in in: or label:, as a Graph path segment: a well-known name, or a folder the owner made, matched by its name. */
async function folderPath(ctx: GraphContext, name: string): Promise<string> {
  const key = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  if (WELL_KNOWN[key]) return WELL_KNOWN[key].graph;
  const r = await ctx.get<{ value?: Array<{ id: string; displayName?: string }> }>(graphUrl("/me/mailFolders", { $top: 250, $select: "id,displayName" }));
  const found = (r.value ?? []).find((f) => f.displayName?.toLowerCase() === name.toLowerCase());
  if (!found) throw new ToolInputError(`There's no folder called "${name}". list_labels shows the folders there are`);
  return encodeURIComponent(found.id);
}

// ---------- Gmail's search syntax, for Graph ----------

export interface MailQuery {
  /** KQL for Graph's $search: words, phrases, from:, to:, subject:, hasattachments… Empty means a $filter listing will do. */
  kql: string[];
  /** Received at or after / before this instant (from after:, before:, newer_than:, older_than:). */
  after?: Date;
  before?: Date;
  /** Whether after/before came from whole days, which KQL can only take as dates. */
  unread?: boolean;
  flagged?: boolean;
  important?: boolean;
  /** Focused (category:primary) or Other (the rest of Gmail's categories). */
  focused?: boolean;
  /** in: or label:, one folder to look in. */
  folder?: string;
  /** -in: or -label:, folders to leave out. */
  notFolders: string[];
  /** in:anywhere: Deleted Items and Junk too. */
  anywhere: boolean;
}

const DAY = 86_400_000;

/**
 * A Gmail date (2026/11/05, 2026-11-05, or seconds since 1970) as the
 * instant it starts. Gmail counts whole days in the owner's time zone, which
 * Graph won't say without another permission, so the earliest that day
 * starts anywhere (UTC+14) for after:, and the latest (UTC−12) for before:.
 * A day either side at most; never too few.
 */
export function gmailDate(raw: string, edge: "after" | "before"): Date {
  if (/^\d{9,11}$/.test(raw)) return new Date(Number(raw) * 1000);
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw);
  if (!m) throw new ToolInputError(`"${raw}" isn't a date Gmail's search takes. Use YYYY/MM/DD`);
  const midnightUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(midnightUtc + (edge === "after" ? -14 : 12) * 3_600_000);
}

function relative(raw: string): number {
  const m = /^(\d+)([hdmy])$/i.exec(raw);
  if (!m) throw new ToolInputError(`"${raw}" isn't a span Gmail's search takes. Use a number and d, m or y, like 2d`);
  const n = Number(m[1]);
  return n * { h: 3_600_000, d: DAY, m: 30 * DAY, y: 365 * DAY }[m[2].toLowerCase() as "h" | "d" | "m" | "y"];
}

/** A KQL value: bare when it's one plain word, otherwise quoted. */
function kqlValue(v: string): string {
  const clean = v.replace(/["\\]/g, "").trim();
  return /^[\w.@+-]+$/.test(clean) ? clean : `\\"${clean}\\"`;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Read a Gmail search into what Graph can be asked, and what Athena checks itself. */
export function parseGmailQuery(query: string, now: Date): MailQuery {
  const q: MailQuery = { kql: [], notFolders: [], anywhere: false };
  const tokens = query.match(/-?[\w]+:"[^"]*"|-?[\w]+:\S+|-?"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const neg = raw.startsWith("-") && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    const op = /^([\w]+):(.*)$/.exec(t);
    if (!op) {
      if (t === "OR" || t === "AND") {
        if (q.kql.length) q.kql.push(t);
        continue;
      }
      if (t === "(" || t === ")") continue;
      const word = t.replace(/^\(+|\)+$/g, "").replace(/^"|"$/g, "");
      if (word) q.kql.push(`${neg ? "NOT " : ""}${kqlValue(word)}`);
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
        q.kql.push(`${neg ? "NOT " : ""}${key}:${kqlValue(value)}`);
        break;
      case "filename":
        q.kql.push(`${neg ? "NOT " : ""}attachment:${kqlValue(value)}`);
        break;
      case "has":
        if (value.toLowerCase() === "attachment") q.kql.push(`hasattachments:${neg ? "false" : "true"}`);
        break;
      case "after":
      case "newer":
        q.after = gmailDate(value, "after");
        break;
      case "before":
      case "older":
        q.before = gmailDate(value, "before");
        break;
      case "newer_than":
        q.after = new Date(now.getTime() - relative(value));
        break;
      case "older_than":
        q.before = new Date(now.getTime() - relative(value));
        break;
      case "is": {
        const v = value.toLowerCase();
        if (v === "unread") q.unread = !neg;
        else if (v === "read") q.unread = neg;
        else if (v === "starred" || v === "flagged") q.flagged = !neg;
        else if (v === "important") q.important = !neg;
        break;
      }
      case "category":
        q.focused = (value.toLowerCase() === "primary") !== neg;
        break;
      case "in":
      case "label": {
        const v = value.toLowerCase();
        // Gmail's chats and the All Mail views have no Outlook folder.
        if (v === "chats" || v === "chat") break;
        if (v === "anywhere") {
          q.anywhere = !neg;
          break;
        }
        if (neg) q.notFolders.push(value);
        else q.folder = value;
        break;
      }
      default:
        // An operator Outlook has no match for: search for the words.
        q.kql.push(kqlValue(value));
    }
  }
  while (q.kql.length && /^(OR|AND)$/.test(q.kql[q.kql.length - 1])) q.kql.pop();
  return q;
}

/**
 * The owner's rules on a translated search: in a $search they're KQL NOT
 * terms Graph applies itself. A $filter listing can't say "not from", so
 * there the check on each message (passes) does it; the inbox rule picks
 * the Inbox folder when the search names none.
 */
export function withOutlookRules(q: MailQuery, rules: MailRules | null): MailQuery {
  if (!hasRules(rules)) return q;
  const out: MailQuery = { ...q, kql: [...q.kql], notFolders: [...q.notFolders] };
  if (out.kql.length) {
    for (const s of rules.skip_senders) out.kql.push(`NOT from:${kqlValue(s)}`);
    for (const s of rules.skip_subjects) out.kql.push(`NOT subject:${kqlValue(s)}`);
  }
  if (rules.inbox_only && !out.folder && !rules.only_labels.length && !out.anywhere) out.folder = "inbox";
  return out;
}

/** The first page's URL: $search when there are words to look for, otherwise a $filter listing, newest first. */
export function firstPageUrl(path: string, q: MailQuery): string {
  if (q.kql.length) {
    // KQL takes dates, not times: whole days, a superset; the exact bounds are checked on each message.
    const dates = [q.after ? `received>=${ymd(q.after)}` : "", q.before ? `received<=${ymd(new Date(q.before.getTime() + DAY))}` : ""].filter(Boolean);
    return graphUrl(path, { $search: `"${[...q.kql, ...dates].join(" ")}"`, $top: GRAPH_PAGE, $select: LIST_FIELDS });
  }
  // Graph sorts a filtered list only by a property the filter starts with: hence receivedDateTime first, always.
  const filter = [
    `receivedDateTime ge ${(q.after ?? new Date(0)).toISOString()}`,
    q.before ? `receivedDateTime lt ${q.before.toISOString()}` : "",
    q.unread === true ? "isRead eq false" : q.unread === false ? "isRead eq true" : "",
    q.flagged === true ? "flag/flagStatus eq 'flagged'" : "",
    q.important === true ? "importance eq 'high'" : "",
    q.focused === true ? "inferenceClassification eq 'focused'" : q.focused === false ? "inferenceClassification eq 'other'" : "",
  ].filter(Boolean);
  return graphUrl(path, { $filter: filter.join(" and "), $orderby: "receivedDateTime desc", $top: GRAPH_PAGE, $select: LIST_FIELDS });
}

/** What Graph couldn't be asked, or was asked only roughly, checked on each message. */
function matches(m: GraphMessage, q: MailQuery, skip: Set<string>): boolean {
  if (m.isDraft) return false;
  if (m.parentFolderId && skip.has(m.parentFolderId)) return false;
  const at = Date.parse(m.receivedDateTime ?? "");
  if (!Number.isNaN(at) && ((q.after && at < q.after.getTime()) || (q.before && at >= q.before.getTime()))) return false;
  if (q.unread !== undefined && !!m.isRead === q.unread) return false;
  if (q.flagged !== undefined && (m.flag?.flagStatus === "flagged") !== q.flagged) return false;
  if (q.important !== undefined && (m.importance === "high") !== q.important) return false;
  if (q.focused !== undefined && m.inferenceClassification && (m.inferenceClassification === "focused") !== q.focused) return false;
  return true;
}

// ---------- Output ----------

/** A message as the owner's rules see it: its sender's address, subject, Gmail-style labels and its folder's id. */
export function ruleView(m: GraphMessage, f: Folders): RuleMessage {
  return { from: (m.from ?? m.sender)?.emailAddress?.address ?? "", subject: m.subject ?? "", labels: [...labelIds(m, f), ...(m.parentFolderId ? [m.parentFolderId] : [])] };
}

/** Gmail-style labels for an Outlook message: its folder (INBOX, SENT…), UNREAD, STARRED, IMPORTANT, CATEGORY_OTHER, and its categories. */
function labelIds(m: GraphMessage, f: Folders): string[] {
  return [
    f.labels.get(m.parentFolderId ?? "") ?? "",
    m.isRead === false ? "UNREAD" : "",
    m.flag?.flagStatus === "flagged" ? "STARRED" : "",
    m.importance === "high" ? "IMPORTANT" : "",
    m.inferenceClassification === "other" ? "CATEGORY_OTHER" : "",
    ...(m.categories ?? []),
  ].filter(Boolean);
}

function messageOut(m: GraphMessage, f: Folders, o: { format: MessageFormat; body?: string; attachments?: string[]; withThreadId?: boolean }) {
  const metadataOnly = o.format === "METADATA_ONLY";
  return clean({
    id: m.id,
    threadId: o.withThreadId ? m.conversationId : undefined,
    sender: person(m.from ?? m.sender),
    toRecipients: (m.toRecipients ?? []).map(person).filter(Boolean),
    ccRecipients: (m.ccRecipients ?? []).map(person).filter(Boolean),
    subject: metadataOnly ? undefined : (m.subject ?? "").trim(),
    snippet: metadataOnly || o.body ? undefined : clip(tidyText(m.bodyPreview ?? ""), SNIPPET_MAX),
    date: utcIso(m.receivedDateTime),
    labelIds: labelIds(m, f),
    plaintextBody: o.body,
    attachments: o.attachments,
  });
}

const withBody = (format: MessageFormat) => format !== "MINIMAL" && format !== "METADATA_ONLY";

/**
 * Outlook's own way of quoting: a "From: … Sent: …" block (often under a
 * rule of underscores) above the earlier message. Cut there, then strip
 * Gmail-style quotes too. A message that's nothing but a quote is kept.
 */
export function stripOutlookQuoted(text: string): string {
  const lines = tidyText(text).split("\n");
  for (let i = 1; i < lines.length; i++) {
    const block = lines.slice(i, i + 5).join("\n");
    const header = /^\s*(?:_{8,}\s*\n\s*)?(From|Van|De|Von):\s.+\n(?:.*\n){0,2}?\s*(Sent|Date|Verzonden|Envoyé|Gesendet):\s/i;
    if (header.test(block) || (/^\s*_{8,}\s*$/.test(lines[i]) && /^\s*From:/i.test(lines[i + 1] ?? ""))) {
      const kept = lines.slice(0, i).join("\n").trim();
      if (kept) return stripQuoted(kept);
      break;
    }
  }
  return stripQuoted(lines.join("\n"));
}

/** A message's own words: what's new in it (uniqueBody), or its whole body when Graph doesn't say. */
export function bodyText(m: GraphMessage): string {
  const unique = m.uniqueBody?.content?.trim();
  const whole = m.body?.content?.trim() ?? "";
  return stripOutlookQuoted(unique || whole);
}

/** Attachment names, never their contents. Pictures inside the email (logos, signatures) aren't named. */
async function attachmentNames(ctx: GraphContext, m: GraphMessage): Promise<string[] | undefined> {
  if (!m.hasAttachments) return undefined;
  try {
    const r = await ctx.get<{ value?: Array<{ name?: string; isInline?: boolean }> }>(
      graphUrl(`/me/messages/${encodeURIComponent(m.id)}/attachments`, { $select: "name,isInline" }),
    );
    return (r.value ?? []).filter((a) => !a.isInline && a.name).map((a) => a.name!);
  } catch {
    return undefined;
  }
}

/** Every message in a conversation, oldest first, drafts left out. Deleted Items and Junk only when asked for. */
async function conversation(ctx: GraphContext, conversationId: string, opts: { bodies: boolean; skip: Set<string> }): Promise<GraphMessage[]> {
  const fields = opts.bodies ? `${LIST_FIELDS},uniqueBody,body` : LIST_FIELDS;
  const r = await ctx.get<{ value?: GraphMessage[] }>(
    graphUrl("/me/messages", { $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`, $select: fields, $top: 100 }),
    { text: opts.bodies },
  );
  return (r.value ?? [])
    .filter((m) => !m.isDraft && !(m.parentFolderId && opts.skip.has(m.parentFolderId)))
    .sort((a, b) => Date.parse(a.receivedDateTime ?? "") - Date.parse(b.receivedDateTime ?? ""));
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

// ---------- Page tokens: where to carry on, and which conversations were already given ----------

interface Position {
  /** The Graph page to read (a first-page URL or an @odata.nextLink). */
  l: string;
  /** Messages already gone through on that page. */
  s: number;
  /** Short hashes of the conversations already returned, so none comes back twice. */
  h: string[];
}

const short = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 10);

function readToken(raw: string | undefined): Position | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Position;
    if (typeof v.l === "string" && v.l.startsWith(`${GRAPH}/`) && typeof v.s === "number" && Array.isArray(v.h)) return v;
  } catch {
    // fall through
  }
  throw new ToolInputError("pageToken isn't one this tool gave out. Leave it out to start from the beginning");
}

const makeToken = (p: Position) => Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

/** Folder ids to leave out of a search: Deleted Items and Junk unless asked for, and any -in: folder. */
async function skipped(ctx: GraphContext, f: Folders, q: MailQuery, includeTrash: boolean): Promise<Set<string>> {
  const skip = new Set<string>();
  const anywhere = includeTrash || q.anywhere || !!q.folder;
  if (!anywhere) for (const name of ["trash", "spam"]) f.ids.get(name) && skip.add(f.ids.get(name)!);
  if (f.ids.get("drafts")) skip.add(f.ids.get("drafts")!);
  for (const name of q.notFolders) {
    const key = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
    const known = f.ids.get(key);
    if (known) skip.add(known);
    else {
      const path = await folderPath(ctx, name).catch(() => "");
      if (path) skip.add(decodeURIComponent(path));
    }
  }
  return skip;
}

/** One page of the whole mailbox for the same search, metadata only: conversations the rules keep out, counted. Never fails the search. */
async function countSkipped(ctx: GraphContext, f: Folders, asked: MailQuery, rules: MailRules, skip: Set<string>): Promise<void> {
  try {
    const page = await ctx.get<{ value?: GraphMessage[] }>(firstPageUrl("/me/messages", asked));
    for (const m of page.value ?? []) if (m.conversationId && matches(m, asked, skip) && !passes(ruleView(m, f), rules)) ctx.mail?.skipped.add(m.conversationId);
  } catch {
    // Only a count.
  }
}

// ---------- Tools ----------

const searchThreads: GraphTool = {
  name: "search_threads",
  summary: "Search your email",
  description:
    "Search the owner's Outlook email with Gmail's search syntax, which Athena translates: words and \"exact phrases\", from:, to:, cc:, subject:, after:YYYY/MM/DD, before:, newer_than:2d, is:unread, is:starred (flagged), is:important, in:inbox, in:sent, -in:sent, label:<folder name>, category:primary (Focused), has:attachment, OR. " +
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
      includeTrash: { type: "boolean", description: "Include Deleted Items and Junk Email." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 50, fallback: 20 });
    const view = arg.oneOf(args, "view", VIEWS) ?? "THREAD_VIEW_MINIMAL";
    // The owner's rules go on every search, server-side, and every message is checked against them below.
    const rules = activeRules(ctx.mail);
    const asked = parseGmailQuery(arg.str(args, "query", { max: 2000 }) ?? "", ctx.now());
    const q = withOutlookRules(asked, rules);
    const from = readToken(arg.str(args, "pageToken", { max: 4000 }));
    const f = await folders(ctx);
    const skip = await skipped(ctx, f, q, arg.bool(args, "includeTrash"));
    // Searching the Inbox alone hides what the rules keep out: count that from one page of the whole mailbox (metadata only).
    if (rules && !from && q.folder !== asked.folder) await countSkipped(ctx, f, asked, rules, skip);
    const path = q.folder ? `/me/mailFolders/${await folderPath(ctx, q.folder)}/messages` : "/me/messages";

    // Walk Graph's pages of messages, newest first, gathering conversations until there are enough.
    const seen = new Set(from?.h ?? []);
    const found: Array<{ id: string; latest: GraphMessage }> = [];
    let url = from?.l ?? firstPageUrl(path, q);
    let skipFirst = from?.s ?? 0;
    let next: Position | undefined;
    for (let pages = 0; pages < MAX_GRAPH_PAGES && !next; pages++) {
      const page = await ctx.get<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(url);
      const items = page.value ?? [];
      for (let i = skipFirst; i < items.length; i++) {
        const m = items[i];
        if (!m.conversationId || !matches(m, q, skip)) continue;
        if (rules && !passes(ruleView(m, f), rules)) {
          ctx.mail?.skipped.add(m.conversationId);
          continue;
        }
        const key = short(m.conversationId);
        if (seen.has(key)) continue;
        if (found.length >= pageSize) {
          next = { l: url, s: i, h: [...seen] };
          break;
        }
        seen.add(key);
        found.push({ id: m.conversationId, latest: m });
      }
      skipFirst = 0;
      if (next) break;
      const link = page["@odata.nextLink"];
      if (!link) break;
      url = link;
      if (pages === MAX_GRAPH_PAGES - 1) next = { l: link, s: 0, h: [...seen] };
    }
    if (!found.length && !next) return {};
    const nextPageToken = next ? makeToken({ ...next, h: next.h.slice(-200) }) : undefined;
    if (view === "THREAD_VIEW_IDS_ONLY") return clean({ threads: found.map((t) => ({ id: t.id })), nextPageToken, note: rules ? FILTERED_NOTE : undefined });

    const format: MessageFormat = view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    const summary = view === "THREAD_VIEW_SUMMARY";
    const threads = await mapLimit(found, 6, async (t): Promise<ThreadOut> => {
      // A one-line summary needs only the message the search found; otherwise the conversation's latest five.
      const messages = summary ? [t.latest] : await conversation(ctx, t.id, { bodies: false, skip }).catch(() => [t.latest]);
      // The search found a message the rules keep; the rest of its conversation is checked too.
      const kept = rules ? messages.filter((m) => keepsMessage(ruleView(m, f), rules)) : messages;
      const list = kept.length ? kept : [t.latest];
      const shown = list.slice(-5).map((m) => {
        const out = messageOut(m, f, { format });
        if (summary) {
          delete out.toRecipients;
          delete out.ccRecipients;
        }
        return out;
      });
      return { id: t.id, messageCount: summary ? undefined : list.length, viewUrl: list[list.length - 1].webLink ?? t.latest.webLink, messages: shown };
    });
    return fitThreads(threads, nextPageToken, rules ? FILTERED_NOTE : undefined);
  },
};

const getThread: GraphTool = {
  name: "get_thread",
  summary: "Read a whole conversation",
  description:
    "Read a whole Outlook conversation by its id (from search_threads): every message with sender, recipients, subject, date, labelIds and plaintextBody (the body as plain text, earlier quoted replies left out), plus attachment names. " +
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
    const f = await folders(ctx);
    let messages = await conversation(ctx, threadId, { bodies, skip: new Set(f.ids.get("drafts") ? [f.ids.get("drafts")!] : []) });
    if (!messages.length) throw new ToolInputError(`Not found: there's no conversation ${threadId} in this mailbox. It may have been deleted`);
    if (rules) {
      const kept = threadKept(messages, (m) => ruleView(m, f), rules);
      if (!kept) throw new ToolInputError(REFUSED_NOTE);
      messages = kept;
    }
    let budget = THREAD_BODY_BUDGET;
    const out = new Array<ReturnType<typeof messageOut>>(messages.length);
    const names = bodies ? await mapLimit(messages, 4, (m) => attachmentNames(ctx, m)) : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!bodies) {
        out[i] = messageOut(m, f, { format });
        continue;
      }
      const text = bodyText(m);
      const body = budget > 300 ? clip(text, Math.min(MESSAGE_BODY_MAX, budget)) : undefined;
      if (body) budget -= body.length;
      out[i] = messageOut(m, f, { format, body, attachments: names[i] });
    }
    return clean({ id: threadId, viewUrl: messages[messages.length - 1].webLink, messages: out });
  },
};

const getMessage: GraphTool = {
  name: "get_message",
  summary: "Read one email",
  description:
    "Read one Outlook message by its id: sender, recipients, subject, date, labelIds, threadId and plaintextBody (plain text, quoted replies left out), plus attachment names. For a whole conversation use get_thread.",
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
    const f = await folders(ctx);
    let m: GraphMessage;
    try {
      m = await ctx.get<GraphMessage>(graphUrl(`/me/messages/${encodeURIComponent(messageId)}`, { $select: bodies ? `${LIST_FIELDS},uniqueBody,body` : LIST_FIELDS }), { text: bodies });
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404) throw new ToolInputError(`Not found: there's no message ${messageId} in this mailbox`);
      throw error;
    }
    const rules = activeRules(ctx.mail);
    if (rules) {
      const v = ruleView(m, f);
      // The message itself, then (when it's outside the inbox) whether its conversation ever reached the owner.
      const reached =
        reachesOwner(v, rules) ||
        (!!m.conversationId && (await conversation(ctx, m.conversationId, { bodies: false, skip: new Set() }).catch(() => [])).some((x) => reachesOwner(ruleView(x, f), rules)));
      if (!keepsMessage(v, rules) || !reached) throw new ToolInputError(REFUSED_NOTE);
    }
    const base = { format, withThreadId: true };
    if (!bodies) return { ...messageOut(m, f, base), viewUrl: m.webLink };
    return { ...messageOut(m, f, { ...base, body: clip(bodyText(m), 20_000), attachments: await attachmentNames(ctx, m) }), viewUrl: m.webLink };
  },
};

const listLabels: GraphTool = {
  name: "list_labels",
  summary: "See your folders",
  description:
    "List the owner's Outlook mail folders (Outlook's labels): each folder's id, name and whether it's one of Outlook's own (Inbox, Sent Items, Deleted Items…) or one they made. Search inside one with in:<folder name>.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async run(ctx) {
    const f = await folders(ctx);
    const r = await ctx.get<{ value?: Array<{ id: string; displayName?: string }> }>(graphUrl("/me/mailFolders", { $top: 250, $select: "id,displayName" }));
    const labels = (r.value ?? []).map((l) => clean({ id: l.id, name: l.displayName, type: f.labels.has(l.id) ? "system" : "user" }));
    return labels.length ? { labels } : {};
  },
};

/** Outlook mail's tools: reads only. */
// ---------- create_draft: the only write ----------

const PLAIN_EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

/** What create_draft asks Graph for: the URL and body, built from the tool's arguments (exported for tests). */
export function outlookDraftRequest(args: Record<string, unknown>): { url: string; body: DraftCreateBody } {
  for (const k of ["cc", "bcc", "attachments", "htmlBody"]) if (args[k] !== undefined) throw new ToolInputError(`Athena's Outlook drafts don't take ${k}`);
  const to = arg.strings(args, "to", 50);
  const bad = to.find((a) => !PLAIN_EMAIL.test(a));
  if (bad) throw new ToolInputError(`to: "${bad}" isn't a plain email address`);
  const subject = arg.str(args, "subject", { max: 1000 }) ?? "";
  const text = arg.str(args, "body", { max: 100_000 }) ?? "";
  const toRecipients = to.map((address) => ({ emailAddress: { address } }));
  const replyTo = arg.str(args, "replyToMessageId", { max: 500 });
  if (replyTo) {
    // A reply draft in the same conversation; Outlook quotes the message below the words.
    return { url: `${GRAPH}/me/messages/${encodeURIComponent(replyTo)}/createReply`, body: { comment: text, ...(to.length ? { message: { toRecipients } } : {}) } };
  }
  return { url: `${GRAPH}/me/messages`, body: { subject, body: { contentType: "Text", content: text }, toRecipients } };
}

const createDraft: GraphTool = {
  name: "create_draft",
  summary: "Save a draft for you to check and send",
  description:
    "Save a draft email in the owner's Outlook Drafts for them to check and send. It never sends. body is plain text. " +
    "To reply inside a conversation, give replyToMessageId (the message being answered): the draft joins it. Returns the draft's id, threadId and viewUrl.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" }, description: "Plain email addresses." },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text." },
      includeSignature: { type: "boolean", description: "Ignored: Outlook adds the signature when you open the draft." },
      replyToMessageId: { type: "string" },
    },
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    if (!ctx.saveDraft) throw new ToolInputError("Drafts aren't turned on for this Outlook account");
    const { url, body } = outlookDraftRequest(args);
    try {
      const made = await ctx.saveDraft<{ id?: string; conversationId?: string; webLink?: string }>(url, body);
      return clean({ id: made.id, threadId: made.conversationId, viewUrl: made.webLink });
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404) throw new ToolInputError("The message to reply to wasn't found");
      throw error;
    }
  },
};

/** Outlook's tools; create_draft is offered only to an account with drafts on (microsoft-direct.ts). */
export const OUTLOOK_MAIL_TOOLS: GraphTool[] = [searchThreads, getThread, getMessage, listLabels, createDraft];

// ---------- The settings page: folders to pick, and a count-only preview ----------

/** Folders worth a rule: the Inbox and the owner's own. Sent Items, Drafts, Deleted Items and Junk aren't. */
export async function outlookRuleLabels(ctx: GraphContext): Promise<MailLabel[]> {
  const f = await folders(ctx);
  const r = await ctx.get<{ value?: Array<{ id: string; displayName?: string }> }>(graphUrl("/me/mailFolders", { $top: 250, $select: "id,displayName" }));
  const list = (r.value ?? []).filter((l) => l.displayName && (!f.labels.has(l.id) || f.labels.get(l.id) === "INBOX" || f.labels.get(l.id) === "ARCHIVE"));
  const inbox = list.filter((l) => f.labels.get(l.id) === "INBOX");
  const rest = list.filter((l) => f.labels.get(l.id) !== "INBOX").sort((a, b) => a.displayName!.localeCompare(b.displayName!));
  return [...inbox, ...rest].map((l) => ({ id: l.id, name: l.displayName! }));
}

const PREVIEW_CAP = 2_000;

/**
 * The last 24 hours under these rules. Outlook can't count a search, so this
 * lists what arrived (sender, subject and folder only, never a body) and
 * checks each against the rules here. The busiest senders come from the same list.
 */
export async function outlookPreview(ctx: GraphContext, rules: MailRules): Promise<MailPreview> {
  const f = await folders(ctx);
  const own = new Set(["sent", "drafts"].map((n) => f.ids.get(n)).filter(Boolean));
  const since = new Date(ctx.now().getTime() - DAY).toISOString();
  let url = graphUrl("/me/messages", {
    $filter: `receivedDateTime ge ${since}`,
    $orderby: "receivedDateTime desc",
    $top: 250,
    $select: "id,from,sender,subject,parentFolderId,isRead,flag,importance,inferenceClassification,categories,isDraft",
  });
  const seen: RuleMessage[] = [];
  let capped = false;
  for (;;) {
    const page = await ctx.get<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(url);
    for (const m of page.value ?? []) if (!m.isDraft && !own.has(m.parentFolderId ?? "")) seen.push(ruleView(m, f));
    const next = page["@odata.nextLink"];
    if (!next) break;
    if (seen.length >= PREVIEW_CAP) {
      capped = true;
      break;
    }
    url = next;
  }
  const kept = hasRules(rules) ? seen.filter((m) => passes(m, rules)).length : seen.length;
  return { hours: 24, total: seen.length, skipped: seen.length - kept, capped, suggestions: topSenders(seen, rules, { own: ctx.email, min: 10 }) };
}
