/**
 * Gmail's tools for google-direct.ts, over the Gmail API
 * (gmail.googleapis.com/gmail/v1). The same names and arguments as Google's
 * Gmail MCP server, and output shaped like its (camelCase JSON), so
 * precheck.ts, gmail-drafts.ts and Ask read it unchanged. Kept compact for
 * Claude's context:
 *
 *  - bodies are plain text: text/plain when the email has it, otherwise its
 *    HTML turned into text; quoted earlier replies are dropped (the thread
 *    has those messages anyway);
 *  - attachments are named, never read;
 *  - a long thread keeps its newest messages whole and only snippets of the
 *    oldest, so the JSON always fits in one tool result.
 *
 * Reads are GETs. create_draft is the only write, it only saves a draft, and
 * google-direct.ts offers it only for an account with drafts on.
 */
import { randomBytes } from "node:crypto";
import { GOOGLE_API_URL } from "../../../lib/connector-presets";
import { GoogleApiError, ToolInputError, apiUrl, arg, clean, clip, decodeEntities, htmlToText, mapLimit, tidyText, type DirectTool, type GoogleContext } from "./google-api";
import {
  FILTERED_NOTE,
  REFUSED_NOTE,
  gmailSkippedQuery,
  hasRules,
  keepsMessage,
  reachesOwner,
  threadKept,
  topSenders,
  withGmailRules,
  type MailLabel,
  type MailPreview,
  type MailRules,
  type RuleMessage,
} from "../../../lib/mail-rules";
import { activeRules } from "./mail-guard";

const GMAIL = `${GOOGLE_API_URL.gmail}/users/me`;
const enc = encodeURIComponent;

/** Per message body, and for all of a thread's bodies together (characters). */
const MESSAGE_BODY_MAX = 8_000;
const THREAD_BODY_BUDGET = 16_000;
const SNIPPET_MAX = 200;

const VIEWS = ["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_IDS_ONLY", "THREAD_VIEW_SUMMARY"] as const;
const FORMATS = ["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY", "PLAIN_TEXT"] as const;
type MessageFormat = (typeof FORMATS)[number];

interface GmailHeader {
  name?: string;
  value?: string;
}
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

// ---------- Headers, addresses, links ----------

export function header(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name?.toLowerCase() === wanted)?.value?.trim() ?? "";
}

/** "A <a@x>, \"B, Jr\" <b@y>" → each address as written. */
function addresses(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted && angle) angle--;
    if (ch === "," && !quoted && !angle) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Opens the thread in Gmail, in the right account even when several are signed in. */
export function threadUrl(email: string, threadId: string): string {
  return `https://mail.google.com/mail/${email ? `?authuser=${enc(email)}` : ""}#all/${threadId}`;
}

function draftUrl(email: string, messageId: string): string {
  return `https://mail.google.com/mail/${email ? `?authuser=${enc(email)}` : ""}#drafts?compose=${messageId}`;
}

/** Gmail's internalDate (ms since 1970) as ISO 8601, to the second. */
function isoDate(internalDate: string | undefined): string | undefined {
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
}

// ---------- Bodies ----------

function charsetOf(part: GmailPart): string {
  return /charset\s*=\s*"?([\w.:-]+)/i.exec(header(part, "Content-Type"))?.[1]?.toLowerCase() ?? "utf-8";
}

/** A part's body: base64url bytes, decoded in its own character set. */
function decodePart(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isAttachment(part: GmailPart): boolean {
  const type = (part.mimeType ?? "").toLowerCase();
  if (part.filename) return true;
  if (/^\s*attachment/i.test(header(part, "Content-Disposition"))) return true;
  return !!part.body?.attachmentId && !type.startsWith("text/");
}

/**
 * Drop what earlier messages already said: lines quoted with ">", the "On …
 * wrote:" line that leads into them, and Outlook's "Original Message" blocks.
 * A message that's nothing but a quote is kept as it is.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line)) break;
    if (/^\s*_{10,}\s*$/.test(line) && /^\s*From:/i.test(lines[i + 1] ?? "")) break;
    if (/^\s*>/.test(line)) continue;
    // "On Tue, 4 Nov 2026 at 10:00, Priya <priya@example.com> wrote:", sometimes wrapped over two lines.
    const two = `${line} ${lines[i + 1] ?? ""}`;
    if (/^\s*On\b.{4,200}\bwrote:\s*$/i.test(line) || (/^\s*On\b/i.test(line) && /\bwrote:\s*$/i.test(lines[i + 1] ?? "") && two.length < 260)) {
      const rest = lines.slice(i + (/wrote:\s*$/i.test(line) ? 1 : 2));
      if (rest.every((l) => !l.trim() || /^\s*>/.test(l))) break;
    }
    kept.push(line);
  }
  const out = tidyText(kept.join("\n"));
  return out || tidyText(text);
}

/**
 * A message's text and its attachments' names. text/plain is preferred over
 * text/html wherever the email offers both; HTML is used, as text, only when
 * there's no plain version. Attachments are listed, never decoded.
 */
export function messageText(payload: GmailPart | undefined): { text: string; attachments: string[] } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? "").toLowerCase();
    if (type.startsWith("multipart/") || (type === "message/rfc822" && part.parts?.length)) {
      const parts = part.parts ?? [];
      if (type === "multipart/alternative") {
        // Alternatives say the same thing: take the plain one if there is one, else the richest (the last).
        const text = parts.find((p) => (p.mimeType ?? "").toLowerCase() === "text/plain" && !isAttachment(p));
        walk(text ?? parts[parts.length - 1] ?? {});
        return;
      }
      parts.forEach(walk);
      return;
    }
    if (isAttachment(part)) {
      // Pictures shown inside the email (a logo, a signature) aren't worth naming.
      const inlineImage = type.startsWith("image/") && !!header(part, "Content-ID") && !/^\s*attachment/i.test(header(part, "Content-Disposition"));
      if (part.filename && !inlineImage) attachments.push(part.filename);
      return;
    }
    if (type === "text/plain") plain.push(decodePart(part));
    else if (type === "text/html") html.push(decodePart(part));
  };
  if (payload) walk(payload);
  const text = plain.length ? plain.join("\n\n") : html.map(htmlToText).join("\n\n");
  return { text: stripQuoted(text), attachments };
}

// ---------- Output ----------

interface MessageOut {
  format: MessageFormat;
  body?: string;
  attachments?: string[];
  withThreadId?: boolean;
}

/** One message as Claude sees it, in Google's MCP field names. */
function messageOut(m: GmailMessage, o: MessageOut) {
  const p = m.payload;
  const metadataOnly = o.format === "METADATA_ONLY";
  return clean({
    id: m.id,
    threadId: o.withThreadId ? m.threadId : undefined,
    sender: header(p, "From"),
    toRecipients: addresses(header(p, "To")),
    ccRecipients: addresses(header(p, "Cc")),
    subject: metadataOnly ? undefined : header(p, "Subject"),
    // A snippet only where there's no body to read instead.
    snippet: metadataOnly || o.body ? undefined : clip(decodeEntities(m.snippet ?? ""), SNIPPET_MAX),
    date: isoDate(m.internalDate),
    labelIds: m.labelIds ?? [],
    plaintextBody: o.body,
    attachments: o.attachments,
  });
}

const withBody = (format: MessageFormat) => format !== "MINIMAL" && format !== "METADATA_ONLY";

/** A search result's JSON at most (characters): under callTool's 24,000 cap, so even 50 threads arrive whole and parseable. */
const SEARCH_BUDGET = 22_000;

type ThreadOut = { id: string; messageCount?: number; viewUrl?: string; messages?: Array<Partial<ReturnType<typeof messageOut>>> };

/**
 * Make a long search result fit SEARCH_BUDGET, giving up the least useful
 * parts first and only as far as needed: shorter snippets, then the
 * messages' own ids (the thread's stays), then snippets, and last the Gmail
 * links (which Ask cites).
 */
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
const METADATA_HEADERS = ["From", "To", "Cc", "Subject"];
const notDraft = (m: GmailMessage) => !(m.labelIds ?? []).includes("DRAFT");

/** A message as the owner's rules see it. */
export const ruleView = (m: GmailMessage): RuleMessage => ({ from: header(m.payload, "From"), subject: header(m.payload, "Subject"), labels: m.labelIds ?? [] });

/**
 * Threads the rules take out of this search, counted (ids only, no bodies)
 * for the run's "skipped" figure. Never fails the search.
 */
async function countSkipped(ctx: GoogleContext, query: string, rules: MailRules, includeTrash: boolean | undefined): Promise<void> {
  try {
    const r = await ctx.get<{ threads?: Array<{ id: string }> }>(
      apiUrl(GMAIL, "/threads", { q: gmailSkippedQuery(query, rules), maxResults: 100, includeSpamTrash: includeTrash, fields: "threads/id" }),
    );
    for (const t of r.threads ?? []) if (t.id) ctx.mail?.skipped.add(t.id);
  } catch {
    // Only a count.
  }
}

// ---------- Tools ----------

const searchThreads: DirectTool = {
  name: "search_threads",
  summary: "Search your email",
  description:
    "Search the owner's Gmail threads with Gmail's search syntax (from:, to:, subject:, after:YYYY/MM/DD, before:, is:unread, in:inbox, -in:sent, category:, label:, has:attachment, OR, quotes for exact phrases). " +
    "Returns each thread's id, messageCount, viewUrl and up to 5 of its latest messages (sender, recipients, subject, snippet, date, labelIds); bodies aren't included, so read a thread with get_thread. " +
    "view: THREAD_VIEW_SUMMARY gives only the latest message per thread, THREAD_VIEW_IDS_ONLY only ids, THREAD_VIEW_METADATA_ONLY leaves out subjects and snippets. " +
    "after: and before: count from midnight; after: includes the day, before: doesn't. An empty object {} means nothing matched. Use pageToken from nextPageToken for more.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search, e.g. \"from:priya@example.com after:2026/11/01 -in:sent\". Leave out to list recent threads." },
      pageSize: { type: "integer", description: "Threads to return, 1–50 (default 20)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
      view: { type: "string", enum: [...VIEWS] },
      includeTrash: { type: "boolean", description: "Include threads in Trash and Spam." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 50, fallback: 20 });
    const view = arg.oneOf(args, "view", VIEWS) ?? "THREAD_VIEW_MINIMAL";
    // The owner's rules go on every search, server-side; the model only ever sees what's left.
    const rules = activeRules(ctx.mail);
    const query = arg.str(args, "query", { max: 2000 }) ?? "";
    const pageToken = arg.str(args, "pageToken", { max: 500 });
    const includeTrash = arg.bool(args, "includeTrash");
    const [list] = await Promise.all([
      ctx.get<{ threads?: Array<{ id: string }>; nextPageToken?: string }>(
        apiUrl(GMAIL, "/threads", { q: withGmailRules(query, rules) || undefined, maxResults: pageSize, pageToken, includeSpamTrash: includeTrash }),
      ),
      rules && !pageToken ? countSkipped(ctx, query, rules, includeTrash) : undefined,
    ]);
    const ids = (list.threads ?? []).map((t) => t.id).filter(Boolean);
    if (!ids.length) return {};
    // With rules, even ids are checked against each thread's messages first.
    if (view === "THREAD_VIEW_IDS_ONLY" && !rules) return clean({ threads: ids.map((id) => ({ id })), nextPageToken: list.nextPageToken });
    const format: MessageFormat = view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    const summary = view === "THREAD_VIEW_SUMMARY";
    const threads = await mapLimit(ids, 6, async (id): Promise<ThreadOut | null> => {
      let thread: { messages?: GmailMessage[] };
      try {
        thread = await ctx.get(
          apiUrl(GMAIL, `/threads/${enc(id)}`, { format: "metadata", metadataHeaders: METADATA_HEADERS, fields: "id,messages(id,labelIds,snippet,internalDate,payload/headers)" }),
        );
      } catch (error) {
        // Deleted between the search and now: leave it out.
        if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) return null;
        throw error;
      }
      let messages = (thread.messages ?? []).filter(notDraft);
      // The second check: whatever the search let through, a thread the rules keep out never reaches the model.
      if (rules) {
        const kept = threadKept(messages, ruleView, rules);
        if (!kept) {
          ctx.mail?.skipped.add(id);
          return null;
        }
        messages = kept;
      }
      const shown = messages.slice(summary ? -1 : -5).map((m) => {
        const out = messageOut(m, { format });
        // A one-line-per-thread summary leaves recipients out, to stay short.
        if (summary) {
          delete out.toRecipients;
          delete out.ccRecipients;
        }
        return out;
      });
      return { id, messageCount: messages.length, viewUrl: threadUrl(ctx.email, id), messages: shown };
    });
    const kept = threads.filter((t): t is ThreadOut => t !== null);
    if (!kept.length && !list.nextPageToken) return {};
    if (view === "THREAD_VIEW_IDS_ONLY") return clean({ threads: kept.map((t) => ({ id: t.id })), nextPageToken: list.nextPageToken, note: FILTERED_NOTE });
    return fitThreads(kept, list.nextPageToken, rules ? FILTERED_NOTE : undefined);
  },
};

const getThread: DirectTool = {
  name: "get_thread",
  summary: "Read a whole conversation",
  description:
    "Read a whole Gmail thread by its id: every message with sender, recipients, subject, date, labelIds and plaintextBody (the body as plain text, earlier quoted replies left out), plus attachment names. " +
    "A very long thread gives only snippets for its oldest messages. messageFormat MINIMAL leaves out bodies (subject and snippet only); METADATA_ONLY leaves out subjects too. Drafts aren't included.",
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread's id, from search_threads." },
      messageFormat: { type: "string", enum: [...FORMATS], description: "Default PLAIN_TEXT. FULL_CONTENT is the same here (bodies are always plain text)." },
    },
    required: ["threadId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const threadId = arg.str(args, "threadId", { required: true, max: 200 })!;
    const format = arg.oneOf(args, "messageFormat", FORMATS) ?? "PLAIN_TEXT";
    const bodies = withBody(format);
    const rules = activeRules(ctx.mail);
    const thread = await ctx.get<{ id: string; messages?: GmailMessage[] }>(
      apiUrl(GMAIL, `/threads/${enc(threadId)}`, bodies ? { format: "full" } : { format: "metadata", metadataHeaders: METADATA_HEADERS }),
    );
    let messages = (thread.messages ?? []).filter(notDraft);
    if (rules) {
      const kept = threadKept(messages, ruleView, rules);
      if (!kept) throw new ToolInputError(REFUSED_NOTE);
      messages = kept;
    }
    // Newest first within the budget, so the latest messages are whole and the JSON fits one tool result.
    let budget = THREAD_BODY_BUDGET;
    const out = new Array<ReturnType<typeof messageOut>>(messages.length);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!bodies) {
        out[i] = messageOut(m, { format });
        continue;
      }
      const { text, attachments } = messageText(m.payload);
      const body = budget > 300 ? clip(text, Math.min(MESSAGE_BODY_MAX, budget)) : undefined;
      if (body) budget -= body.length;
      out[i] = messageOut(m, { format, body, attachments });
    }
    return clean({ id: thread.id, viewUrl: threadUrl(ctx.email, thread.id), messages: out });
  },
};

const getMessage: DirectTool = {
  name: "get_message",
  summary: "Read one email",
  description:
    "Read one Gmail message by its id: sender, recipients, subject, date, labelIds, threadId and plaintextBody (plain text, quoted replies left out), plus attachment names. For a whole conversation use get_thread.",
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
    const messageId = arg.str(args, "messageId", { required: true, max: 200 })!;
    const format = arg.oneOf(args, "messageFormat", FORMATS) ?? "PLAIN_TEXT";
    const bodies = withBody(format);
    const rules = activeRules(ctx.mail);
    const m = await ctx.get<GmailMessage>(
      apiUrl(GMAIL, `/messages/${enc(messageId)}`, bodies ? { format: "full" } : { format: "metadata", metadataHeaders: METADATA_HEADERS }),
    );
    if (rules && !(await messageReadable(ctx, m, rules))) throw new ToolInputError(REFUSED_NOTE);
    if (!bodies) return { ...messageOut(m, { format, withThreadId: true }), viewUrl: threadUrl(ctx.email, m.threadId ?? m.id) };
    const { text, attachments } = messageText(m.payload);
    return { ...messageOut(m, { format, body: clip(text, 20_000), attachments, withThreadId: true }), viewUrl: threadUrl(ctx.email, m.threadId ?? m.id) };
  },
};

/** One message: kept by the rules, and its thread reached the owner (the inbox, or a label they allow). */
async function messageReadable(ctx: GoogleContext, m: GmailMessage, rules: MailRules): Promise<boolean> {
  const view = ruleView(m);
  if (notDraft(m) && !keepsMessage(view, rules)) return false;
  if (reachesOwner(view, rules)) return true;
  if (!m.threadId) return false;
  const thread = await ctx.get<{ messages?: GmailMessage[] }>(apiUrl(GMAIL, `/threads/${enc(m.threadId)}`, { format: "minimal", fields: "messages(labelIds)" }));
  return (thread.messages ?? []).some((x) => reachesOwner({ labels: x.labelIds ?? [] }, rules));
}

const listLabels: DirectTool = {
  name: "list_labels",
  summary: "See your labels",
  description: "List the owner's Gmail labels: each label's id, name and whether it's a system label (INBOX, SENT, CATEGORY_PROMOTIONS…) or one they made. Search by a label's name with label:<name>.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async run(ctx) {
    const r = await ctx.get<{ labels?: Array<{ id: string; name?: string; type?: string }> }>(apiUrl(GMAIL, "/labels"));
    const labels = (r.labels ?? []).map((l) => clean({ id: l.id, name: l.name, type: l.type === "system" ? "system" : "user" }));
    return labels.length ? { labels } : {};
  },
};

// ---------- create_draft: the only write ----------

const PLAIN_EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const CRLF = "\r\n";

/** A header value with non-ASCII characters as RFC 2047 encoded words (UTF-8, base64), each short enough for one line. */
export function encodeHeader(value: string): string {
  const v = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

/** Text as base64 lines of 76, CRLF line ends: safe for any character in any mail system. */
function base64Body(text: string): string {
  const b64 = Buffer.from(text.replace(/\r?\n/g, CRLF), "utf8").toString("base64");
  return b64.match(/.{1,76}/g)?.join(CRLF) ?? "";
}

/** An RFC 2822 message for a draft: plain text, or plain text and HTML as alternatives. Gmail adds From itself. */
export function buildDraftMime(d: { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; html?: string; inReplyTo?: string; references?: string }): string {
  const headers = [
    d.to.length ? `To: ${d.to.join(", ")}` : "",
    d.cc.length ? `Cc: ${d.cc.join(", ")}` : "",
    d.bcc.length ? `Bcc: ${d.bcc.join(", ")}` : "",
    `Subject: ${encodeHeader(d.subject)}`,
    d.inReplyTo ? `In-Reply-To: ${d.inReplyTo}` : "",
    d.references ? `References: ${d.references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const textPart = [`Content-Type: text/plain; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", base64Body(d.text)];
  if (!d.html) return [...headers, ...textPart].join(CRLF);
  const boundary = `athena-${randomBytes(12).toString("hex")}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(d.html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

function emails(args: Record<string, unknown>, key: string): string[] {
  const list = arg.strings(args, key, 50);
  const bad = list.find((a) => !PLAIN_EMAIL.test(a));
  if (bad) throw new ToolInputError(`${key}: "${bad}" isn't a plain email address`);
  return list;
}

/** The account's Gmail signature (HTML), or "" when there isn't one or it can't be read. */
async function signature(ctx: GoogleContext): Promise<string> {
  try {
    const r = await ctx.get<{ sendAs?: Array<{ isDefault?: boolean; isPrimary?: boolean; signature?: string }> }>(apiUrl(GMAIL, "/settings/sendAs"));
    const list = r.sendAs ?? [];
    return (list.find((s) => s.isDefault) ?? list.find((s) => s.isPrimary))?.signature ?? "";
  } catch {
    return "";
  }
}

const createDraft: DirectTool = {
  name: "create_draft",
  summary: "Save a draft for you to check and send",
  description:
    "Save a draft email in the owner's Gmail Drafts for them to check and send. It never sends. body is plain text (no Markdown); htmlBody is optional. " +
    "To reply inside a thread, give replyToMessageId (the message being answered): the draft joins that thread. includeSignature adds the owner's Gmail signature. Returns the draft's id, threadId and viewUrl.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" }, description: "Plain email addresses." },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text." },
      htmlBody: { type: "string" },
      includeSignature: { type: "boolean" },
      replyToMessageId: { type: "string" },
    },
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    if (args.attachments !== undefined) throw new ToolInputError("Athena's drafts can't carry attachments");
    const to = emails(args, "to");
    const cc = emails(args, "cc");
    const bcc = emails(args, "bcc");
    const subject = arg.str(args, "subject", { max: 1000 }) ?? "";
    const html = arg.str(args, "htmlBody", { max: 200_000 });
    let text = arg.str(args, "body", { max: 100_000 }) ?? (html ? htmlToText(html) : "");
    let htmlOut = html;
    if (arg.bool(args, "includeSignature")) {
      const sig = await signature(ctx);
      if (sig) {
        text = `${text.trimEnd()}\n\n${htmlToText(sig)}`;
        if (htmlOut) htmlOut = `${htmlOut}<br><br>${sig}`;
      }
    }
    // A reply: the same thread, with In-Reply-To and References so every mail app threads it too.
    const replyTo = arg.str(args, "replyToMessageId", { max: 200 });
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (replyTo) {
      let original: GmailMessage;
      try {
        original = await ctx.get<GmailMessage>(
          apiUrl(GMAIL, `/messages/${enc(replyTo)}`, { format: "metadata", metadataHeaders: ["Message-ID", "References", "In-Reply-To"] }),
        );
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) throw new ToolInputError("The message to reply to wasn't found");
        throw error;
      }
      threadId = original.threadId;
      const messageId = header(original.payload, "Message-ID");
      if (messageId) {
        // One header line each: a CR or LF from the original message must not start a header of its own.
        inReplyTo = messageId.replace(/[\r\n]+/g, " ");
        const earlier = header(original.payload, "References") || header(original.payload, "In-Reply-To");
        references = [earlier, messageId].filter(Boolean).join(" ").replace(/[\r\n]+/g, " ");
      }
    }
    const raw = Buffer.from(buildDraftMime({ to, cc, bcc, subject, text, html: htmlOut, inReplyTo, references }), "utf8").toString("base64url");
    const draft = await ctx.saveDraft<{ id?: string; message?: { id?: string; threadId?: string } }>({ message: { raw, ...(threadId ? { threadId } : {}) } });
    return clean({ id: draft.id, threadId: draft.message?.threadId, viewUrl: draft.message?.id ? draftUrl(ctx.email, draft.message.id) : undefined });
  },
};

/** Gmail's tools; create_draft is offered only to an account with drafts on (google-direct.ts). */
export const GMAIL_TOOLS: DirectTool[] = [searchThreads, getThread, getMessage, listLabels, createDraft];

// ---------- The settings page: labels to pick, and a count-only preview ----------

const CATEGORY_NAMES: Record<string, string> = { CATEGORY_PROMOTIONS: "Promotions", CATEGORY_SOCIAL: "Social", CATEGORY_UPDATES: "Updates", CATEGORY_FORUMS: "Forums" };

/** Labels worth a rule: the inbox, Gmail's categories, and the owner's own. Sent, drafts, spam and the like aren't. */
export async function gmailRuleLabels(ctx: GoogleContext): Promise<MailLabel[]> {
  const r = await ctx.get<{ labels?: Array<{ id: string; name?: string; type?: string }> }>(apiUrl(GMAIL, "/labels"));
  const own = (r.labels ?? []).filter((l) => l.type !== "system" && l.name).map((l) => ({ id: l.id, name: l.name! })).sort((a, b) => a.name.localeCompare(b.name));
  const system = (r.labels ?? []).filter((l) => l.id === "INBOX" || CATEGORY_NAMES[l.id]).map((l) => ({ id: l.id, name: l.id === "INBOX" ? "Inbox" : CATEGORY_NAMES[l.id] }));
  return [...system, ...own];
}

const PREVIEW_CAP = 2_000;
/** Mail that arrived: not the owner's own, not drafts or chats. */
const ARRIVED = "newer_than:1d -in:sent -in:drafts -in:chats";

/** Message ids for a search, up to PREVIEW_CAP: ids only, never a body. */
async function messageIds(ctx: GoogleContext, q: string): Promise<{ ids: string[]; capped: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const r = await ctx.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      apiUrl(GMAIL, "/messages", { q, maxResults: 500, pageToken, fields: "messages/id,nextPageToken" }),
    );
    ids.push(...(r.messages ?? []).map((m) => m.id));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < PREVIEW_CAP);
  return { ids: ids.slice(0, PREVIEW_CAP), capped: !!pageToken };
}

/**
 * The last 24 hours under these rules: how many emails arrived and how many
 * the rules would skip, from Gmail's search alone. Then the busiest senders,
 * as suggestions: who sent the newest 100 (From and labels only), and an
 * exact count for the top few.
 */
export async function gmailPreview(ctx: GoogleContext, rules: MailRules): Promise<MailPreview> {
  const all = await messageIds(ctx, ARRIVED);
  const kept = hasRules(rules) ? await messageIds(ctx, withGmailRules(ARRIVED, rules)) : all;
  const sample = await mapLimit(all.ids.slice(0, 100), 8, (id) =>
    ctx.get<GmailMessage>(apiUrl(GMAIL, `/messages/${enc(id)}`, { format: "metadata", metadataHeaders: ["From"], fields: "labelIds,payload/headers" })).catch(() => null),
  );
  const seen = sample.filter((m): m is GmailMessage => !!m).map((m) => ({ from: header(m.payload, "From"), labels: m.labelIds ?? [] }));
  const top = topSenders(seen, rules, { own: ctx.email, min: 8 });
  const suggestions = await mapLimit(top, 3, async (s) => {
    const [sent, outside] = await Promise.all([messageIds(ctx, `${ARRIVED} from:${s.sender}`), messageIds(ctx, `${ARRIVED} from:${s.sender} -in:inbox`)]);
    return { sender: s.sender, count: sent.ids.length, outside_inbox: Math.min(outside.ids.length, sent.ids.length) };
  });
  return {
    hours: 24,
    total: all.ids.length,
    skipped: Math.max(0, all.ids.length - kept.ids.length),
    capped: all.capped,
    suggestions: suggestions.filter((s) => s.count >= 10).sort((a, b) => b.count - a.count),
  };
}
