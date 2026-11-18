/**
 * The owner's rules for which emails Athena reads, per Gmail, Outlook or Fastmail
 * account (`connectors.mail_rules`, sealed: migration 0043). The adapters
 * (google-gmail.ts, microsoft-mail.ts) enforce them on every search and
 * read, whoever asks: collections, Ask, Talk, MCP and the briefing all go
 * through the same tools. The model is never told what the rules say.
 *
 * Pure: no database, no network, so the app and tests use it too.
 */

export interface MailLabel {
  /** Gmail's label id (INBOX, Label_12…) or an Outlook folder id. */
  id: string;
  name: string;
}

export interface MailRules {
  /** Skip mail that never reached the inbox (a filter archived it, or it skipped the inbox). */
  inbox_only: boolean;
  /** Addresses (a@b.com) and whole domains (name.com, which covers mail.name.com too). */
  skip_senders: string[];
  /** Words or phrases; a subject containing one is skipped (any case). */
  skip_subjects: string[];
  skip_labels: MailLabel[];
  /** When not empty, only mail with one of these labels or folders is read. */
  only_labels: MailLabel[];
}

export const NO_RULES: MailRules = { inbox_only: false, skip_senders: [], skip_subjects: [], skip_labels: [], only_labels: [] };

export const RULE_LIMITS = { senders: 200, subjects: 50, labels: 50 } as const;

/** What a run or a search tells the model: never which rules. */
export const FILTERED_NOTE = "Some mail is filtered out by the owner's rules and never appears here.";
export const REFUSED_NOTE = "That email is filtered out by the owner's rules, so Athena can't read it.";

export function hasRules(r: MailRules | null | undefined): r is MailRules {
  return !!r && (r.inbox_only || r.skip_senders.length > 0 || r.skip_subjects.length > 0 || r.skip_labels.length > 0 || r.only_labels.length > 0);
}

// ---------- Reading what the owner typed ----------

const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ADDRESS = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9.-]+$/;

/**
 * "name.com", "@Namecheap.com", "Billing <billing@x.com>", "x.com/" → the
 * address or domain, lowercased; null when it's neither.
 */
export function readSender(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  const angle = /<([^>]+)>/.exec(v);
  if (angle) v = angle[1].trim();
  v = v.replace(/^mailto:/, "").replace(/^\*?@/, "").replace(/^\*\./, "").replace(/\/+$/, "");
  if (ADDRESS.test(v)) return DOMAIN.test(v.split("@")[1]) ? v : null;
  return DOMAIN.test(v) ? v : null;
}

/** A subject phrase: trimmed, inner spaces tidied, no quotes (they'd break the search), 2–100 characters. */
export function readSubject(raw: string): string | null {
  const v = raw.replace(/["\\{}()]/g, " ").replace(/\s+/g, " ").trim();
  return v.length >= 2 && v.length <= 100 ? v : null;
}

const LABEL_ID = /^[\w.:/+=-]{1,400}$/;

function readLabels(raw: unknown): MailLabel[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, MailLabel>();
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const id = typeof (l as MailLabel).id === "string" ? (l as MailLabel).id.trim() : "";
    const name = typeof (l as MailLabel).name === "string" ? (l as MailLabel).name.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (LABEL_ID.test(id) && name && !out.has(id)) out.set(id, { id, name });
  }
  return [...out.values()].slice(0, RULE_LIMITS.labels);
}

const unique = (list: Array<string | null>) => [...new Set(list.filter((v): v is string => !!v))];

/** Rules from untrusted JSON (the app, or the sealed column): anything unreadable is dropped. */
export function readRules(raw: unknown): MailRules {
  if (!raw || typeof raw !== "object") return { ...NO_RULES };
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    inbox_only: r.inbox_only === true,
    skip_senders: unique(strings(r.skip_senders).map(readSender)).slice(0, RULE_LIMITS.senders),
    skip_subjects: unique(strings(r.skip_subjects).map(readSubject)).filter((s, i, all) => all.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i).slice(0, RULE_LIMITS.subjects),
    skip_labels: readLabels(r.skip_labels),
    only_labels: readLabels(r.only_labels),
  };
}

// ---------- Matching one message ----------

/** One message as the rules see it, from either provider. */
export interface RuleMessage {
  /** The sender's address (any case; a "Name <a@b>" header is fine). */
  from: string;
  subject: string;
  /** Gmail's labelIds; for Outlook, its Gmail-style labels (INBOX, SENT…) and its folder's id. */
  labels: string[];
}

/** The address inside a From header, lowercased. */
export function senderAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from);
  const v = (angle ? angle[1] : from).trim().toLowerCase();
  const at = /[^\s<>"]+@[^\s<>"]+/.exec(v);
  return at ? at[0] : v;
}

/** Skipped by sender: the exact address, or a domain the address's domain is or sits under. */
export function senderSkipped(from: string, r: MailRules): boolean {
  const address = senderAddress(from);
  const domain = address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : "";
  return r.skip_senders.some((s) => (s.includes("@") ? s === address : !!domain && (domain === s || domain.endsWith(`.${s}`))));
}

export function subjectSkipped(subject: string, r: MailRules): boolean {
  const s = subject.toLowerCase().replace(/\s+/g, " ");
  return r.skip_subjects.some((p) => s.includes(p.toLowerCase()));
}

/** Not skipped by sender, subject or label. */
export function keepsMessage(m: RuleMessage, r: MailRules): boolean {
  if (senderSkipped(m.from, r) || subjectSkipped(m.subject, r)) return false;
  const skip = new Set(r.skip_labels.map((l) => l.id));
  return !m.labels.some((l) => skip.has(l));
}

/** Reached the owner: in the inbox (or sent by them) when that's asked for, and in an allowed label when there's a list. */
export function reachesOwner(m: Pick<RuleMessage, "labels">, r: MailRules): boolean {
  if (r.inbox_only && !m.labels.some((l) => l === "INBOX" || l === "SENT")) return false;
  if (r.only_labels.length && !r.only_labels.some((l) => m.labels.includes(l.id))) return false;
  return true;
}

/** A message on its own (a search hit, get_message): both checks. */
export const passes = (m: RuleMessage, r: MailRules) => reachesOwner(m, r) && keepsMessage(m, r);

/**
 * A thread: some message in it reached the owner, and the messages shown are
 * the ones the rules keep. Null when nothing in it may be read.
 */
export function threadKept<T>(messages: T[], view: (m: T) => RuleMessage, r: MailRules): T[] | null {
  const seen = messages.map(view);
  if (!seen.some((m) => reachesOwner(m, r))) return null;
  const kept = messages.filter((_, i) => keepsMessage(seen[i], r));
  return kept.length ? kept : null;
}

// ---------- Gmail's search syntax ----------

/** A label as a Gmail search term: the inbox and categories by their own operators, the rest by name. */
export function gmailLabelTerm(l: MailLabel): string {
  if (l.id === "INBOX") return "in:inbox";
  if (l.id === "SENT") return "in:sent";
  if (l.id === "STARRED") return "is:starred";
  if (l.id === "IMPORTANT") return "is:important";
  if (l.id === "UNREAD") return "is:unread";
  const category = /^CATEGORY_(\w+)$/.exec(l.id);
  if (category) return `category:${category[1].toLowerCase()}`;
  return `label:"${l.name.replace(/["\\]/g, "")}"`;
}

const quote = (v: string) => `"${v.replace(/["\\]/g, "")}"`;

/**
 * The model's query as one group that can't reach the terms after it: when
 * its brackets don't balance (a stray ")" closing ours early), they're
 * dropped. Gmail ANDs what follows the group.
 */
export function gmailGroup(query: string): string {
  const q = query.trim();
  if (!q) return "";
  let depth = 0;
  let braces = 0;
  let quoted = false;
  let balanced = true;
  for (const ch of q) {
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (depth < 0 || braces < 0) balanced = false;
  }
  const clean = balanced && depth === 0 && braces === 0 && !quoted ? q : q.replace(/[(){}"]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `(${clean})` : "";
}

/** The rules as Gmail search terms, ANDed after the model's query. */
export function gmailRuleTerms(r: MailRules): string[] {
  const terms: string[] = [];
  if (r.inbox_only) terms.push("{in:inbox in:sent}");
  if (r.only_labels.length) terms.push(`{${r.only_labels.map(gmailLabelTerm).join(" ")}}`);
  for (const s of r.skip_senders) terms.push(`-from:${s}`);
  for (const s of r.skip_subjects) terms.push(`-subject:${quote(s)}`);
  for (const l of r.skip_labels) terms.push(`-${gmailLabelTerm(l)}`);
  return terms;
}

/** Every search the model makes, with the rules appended. */
export function withGmailRules(query: string, r: MailRules | null | undefined): string {
  if (!hasRules(r)) return query;
  return [gmailGroup(query), ...gmailRuleTerms(r)].filter(Boolean).join(" ");
}

/** The mail the rules take out of a search: the model's query, and any one rule. For counting only. */
export function gmailSkippedQuery(query: string, r: MailRules): string {
  const any: string[] = [];
  if (r.inbox_only) any.push("(-in:inbox -in:sent)");
  if (r.only_labels.length) any.push(`(${r.only_labels.map((l) => `-${gmailLabelTerm(l)}`).join(" ")})`);
  for (const s of r.skip_senders) any.push(`from:${s}`);
  for (const s of r.skip_subjects) any.push(`subject:${quote(s)}`);
  for (const l of r.skip_labels) any.push(gmailLabelTerm(l));
  return [gmailGroup(query), `{${any.join(" ")}}`].filter(Boolean).join(" ");
}

// ---------- The preview and its suggestions ----------

export interface SenderSuggestion {
  /** A domain, or an address at a webmail domain. */
  sender: string;
  count: number;
  /** How many of those never reached the inbox. */
  outside_inbox: number;
}

export interface MailPreview {
  hours: number;
  total: number;
  skipped: number;
  /** More mail than Athena counted: the figures are a floor. */
  capped: boolean;
  suggestions: SenderSuggestion[];
}

/** Webmail domains: a sender there is suggested by address, never the whole domain. */
const WEBMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com", "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.co.uk", "aol.com", "proton.me", "protonmail.com", "pm.me", "fastmail.com", "hey.com", "gmx.com", "zoho.com"]);
const TWO_PART_SUFFIX = /\.(co|com|org|net|ac|gov|ltd|plc|me)\.[a-z]{2}$/;

/** What to suggest skipping for one sender: its organisation's domain (mail.name.com → name.com), or the address at a webmail domain. */
export function suggestionKey(from: string): string | null {
  const address = senderAddress(from);
  if (!address.includes("@")) return null;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (!DOMAIN.test(domain)) return null;
  if (WEBMAIL.has(domain)) return address;
  const parts = domain.split(".");
  const keep = TWO_PART_SUFFIX.test(domain) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/**
 * The busiest senders in a sample, as suggestions: at least `min` emails
 * the rules would still let through, never the owner's own domain or address.
 */
export function topSenders(sample: Array<{ from: string; labels: string[]; subject?: string }>, r: MailRules, opts: { own?: string; min?: number; limit?: number } = {}): SenderSuggestion[] {
  const own = opts.own ? suggestionKey(opts.own) : null;
  const by = new Map<string, SenderSuggestion>();
  for (const m of sample) {
    const key = suggestionKey(m.from);
    // Only mail the rules would still let through: a sender they already skip needs no suggestion.
    if (!key || key === own || !passes({ subject: "", ...m }, r)) continue;
    const s = by.get(key) ?? { sender: key, count: 0, outside_inbox: 0 };
    s.count++;
    if (!m.labels.includes("INBOX")) s.outside_inbox++;
    by.set(key, s);
  }
  return [...by.values()]
    .filter((s) => s.count >= (opts.min ?? 10))
    .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender))
    .slice(0, opts.limit ?? 3);
}
