/**
 * The review inbox's repeats and the email each find came from:
 *
 *  - sameKey / groupSame: finds that are the same thing (a booking email,
 *    then its reminder), so the Inbox shows them as one card, "Found 3
 *    times", whose answer covers all of them, and propose() doesn't file
 *    one again while it's still waiting. Another date or number is another
 *    thing, never grouped.
 *  - mailFrom: the sender and subject of each email a collection read,
 *    from its mail tools' JSON (Google's MCP field names, which the
 *    Gmail, Outlook and Fastmail tools all use), so a find can keep where
 *    it came from (suggestions.email, sealed).
 *  - ignoreChoices: what "Ignore emails like this" offers for that email:
 *    its sender, the sender's whole domain, or a phrase from its subject,
 *    each a mail rule (lib/mail-rules.ts) the next sync applies.
 *
 * Pure: no database, no network, so the app and tests use it too.
 */
import { readSender, readSubject, senderAddress } from "./mail-rules";

/** Where a find came from, when it was an email: shown to the owner, sealed at rest. */
export interface SuggestionEmail {
  /** The From header as the mail tool gave it ("Larkspur Home <orders@larkspur.example>"). */
  from: string;
  subject: string;
  /** The account it was read from, whose mail rules "Ignore emails like this" changes. */
  connector_id?: string | null;
}

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
/** Words left dangling at either end of a subject phrase once a date is gone ("on", "at", "for"). */
const DANGLING = new Set(["on", "at", "for", "from", "by", "the", "of", "in", "to", "and"]);
/** Words that don't change what a find says. */
const FILLER = new Set(["a", "an", "the"]);

/**
 * What a find says, for telling when two are the same thing: what accepting
 * does (its op) and its words, ignoring case, punctuation and "a", "an",
 * "the". Dates, times and numbers stay, so the same class on two days, or
 * two orders, are two things.
 */
export function sameKey(s: { op: string; summary: string }): string {
  const words = s.summary
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
  return `${s.op}|${words.join(" ")}`;
}

/**
 * Finds that are the same thing, together, in the order given: each group
 * sits where its first find was, and the first is the one the card shows.
 * An answer on the card is an answer for every find in it.
 */
export function groupSame<T extends { op: string; summary: string }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const s of items) {
    const key = sameKey(s);
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()];
}

// ---------- Which email a find came from ----------

interface OutMessage {
  id?: unknown;
  threadId?: unknown;
  sender?: unknown;
  subject?: unknown;
}

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "");

/**
 * Each email in a mail tool's reply, by thread and message id: search_threads
 * ({ threads: [{ id, messages }] }), get_thread ({ id, messages }) and
 * get_message ({ id, threadId, sender, subject }). A thread is known by its
 * first message that has a sender: the one that started it. Anything else
 * gives nothing.
 */
export function mailFrom(reply: string): Map<string, { from: string; subject: string }> {
  const out = new Map<string, { from: string; subject: string }>();
  let data: unknown;
  try {
    data = JSON.parse(reply);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object") return out;
  const put = (id: unknown, m: { from: string; subject: string }) => {
    if (typeof id !== "string" || !id || !m.from) return;
    const had = out.get(id);
    if (!had || (!had.subject && m.subject)) out.set(id, m);
  };
  const thread = (t: { id?: unknown; messages?: unknown }) => {
    const messages = (Array.isArray(t.messages) ? t.messages : []) as OutMessage[];
    const view = messages.map((m) => ({ id: m?.id, m: { from: text(m?.sender), subject: text(m?.subject) } }));
    for (const v of view) put(v.id, v.m);
    const first = view.find((v) => v.m.from);
    if (first) put(t.id, { ...first.m, subject: first.m.subject || view.find((v) => v.m.subject)?.m.subject || "" });
  };
  const d = data as { threads?: unknown; messages?: unknown } & OutMessage;
  if (Array.isArray(d.threads)) for (const t of d.threads) if (t && typeof t === "object") thread(t as { id?: unknown; messages?: unknown });
  if (Array.isArray(d.messages)) thread(d);
  if (typeof d.sender === "string") {
    const m = { from: text(d.sender), subject: text(d.subject) };
    put(d.id, m);
    put(d.threadId, m);
  }
  return out;
}

/** The email id inside a find's source_ref ("email-digest:18c2…#2" → "18c2…"). */
export function emailIdOf(sourceRef: string | null | undefined, source: string | null | undefined): string | null {
  if (!sourceRef) return null;
  const rest = source && sourceRef.startsWith(`${source}:`) ? sourceRef.slice(source.length + 1) : sourceRef;
  const id = rest.split("#")[0].trim();
  return id || null;
}

// ---------- Ignore emails like this ----------

/** Addresses anyone can have: skipping the whole domain would skip half the world. */
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "pm.me", "fastmail.com", "fastmail.fm", "gmx.com", "gmx.co.uk", "btinternet.com", "sky.com", "virginmedia.com",
]);
/** Second-level suffixes where a name sits one label further in (shop.co.uk). */
const SECOND_LEVEL = /^(?:co|org|ac|gov|ltd|plc|me|net|com)\.[a-z]{2}$/;

/** The sender's organisation's domain: "mail.orders.larkspur.example" → "larkspur.example". */
export function senderDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const labels = address.slice(at + 1).toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const keep = labels.length > 2 && SECOND_LEVEL.test(labels.slice(-2).join(".")) ? 3 : 2;
  const domain = labels.slice(-keep).join(".");
  return SHARED_DOMAINS.has(domain) ? null : domain;
}

/**
 * A phrase from a subject that the next one like it will share: the longest
 * run of words without a date, a number or a reference in it ("Your order
 * #4417 has shipped" → "has shipped"; "Spin class this Thursday" → "Spin
 * class this"). Re: and Fwd: are dropped. Null when nothing is left worth
 * matching on.
 */
export function subjectPhrase(subject: string): string | null {
  const clean = subject.replace(/^(?:\s*(?:re|fw|fwd)\s*:\s*)+/i, "").trim();
  const runs: string[][] = [[]];
  for (const word of clean.split(/\s+/)) {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const changes = !bare || /\d/.test(word) || new RegExp(`^(?:${MONTH}|${WEEKDAY}|today|tomorrow|tonight)$`, "i").test(bare);
    if (changes) runs.push([]);
    else runs[runs.length - 1].push(word);
  }
  const phrases = runs
    .map((r) => {
      while (r.length && DANGLING.has(r[r.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ""))) r.pop();
      while (r.length && DANGLING.has(r[0].toLowerCase().replace(/[^\p{L}]/gu, ""))) r.shift();
      return r.join(" ").replace(/[\s:;,.!?·|–—-]+$/u, "").replace(/^[\s:;,.!?·|–—-]+/u, "");
    })
    .filter((p) => p.split(/\s+/).length >= 2 || p.length >= 6);
  const best = phrases.sort((a, b) => b.length - a.length)[0];
  return best ? readSubject(best) : null;
}

export interface IgnoreChoices {
  /** The exact address. */
  sender: string | null;
  /** Everyone at the sender's organisation; null for a shared one (gmail.com). */
  domain: string | null;
  /** A phrase its subject shares with the next one like it. */
  subject: string | null;
}

export function ignoreChoices(email: Pick<SuggestionEmail, "from" | "subject"> | null | undefined): IgnoreChoices {
  if (!email) return { sender: null, domain: null, subject: null };
  const sender = readSender(senderAddress(email.from));
  const domain = sender ? senderDomain(sender) : null;
  return { sender, domain: domain ? readSender(domain) : null, subject: email.subject ? subjectPhrase(email.subject) : null };
}

/** Whether a find's email is caught by a rule the owner just added. */
export function caughtBy(email: Pick<SuggestionEmail, "from" | "subject"> | null | undefined, rule: { kind: "sender" | "subject"; value: string }): boolean {
  if (!email) return false;
  if (rule.kind === "subject") return email.subject.toLowerCase().replace(/\s+/g, " ").includes(rule.value.toLowerCase());
  const address = senderAddress(email.from);
  const v = rule.value.toLowerCase();
  if (v.includes("@")) return address === v;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domain === v || domain.endsWith(`.${v}`);
}
