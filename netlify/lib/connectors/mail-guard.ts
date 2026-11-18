/**
 * The owner's mail rules (lib/mail-rules.ts) as an opened Gmail or Outlook
 * account carries them. google-gmail.ts and microsoft-mail.ts check them on
 * every search and read; this holds what those checks share.
 */
import type { Connector } from "../../../lib/connectors";
import { FILTERED_NOTE, REFUSED_NOTE, hasRules, passes, threadKept, withGmailRules, type MailLabel, type MailPreview, type MailRules, type RuleMessage } from "../../../lib/mail-rules";
import { ToolInputError } from "./google-api";

export interface MailGuard {
  /** Null when the account has no rules. */
  rules: MailRules | null;
  /** Rules are stored but couldn't be opened here: every mail tool refuses. */
  unreadable: boolean;
  /** Threads (Gmail) or conversations (Outlook) the rules kept out since the account opened. Ids only, never sent anywhere. */
  skipped: Set<string>;
}

export function mailGuard(connector: Pick<Connector, "mail_rules" | "mail_rules_unreadable">): MailGuard {
  return { rules: hasRules(connector.mail_rules) ? connector.mail_rules : null, unreadable: !!connector.mail_rules_unreadable, skipped: new Set() };
}

/** The rules to apply, or null for none. Refuses when they exist but can't be read: never read without them. */
export function activeRules(guard: MailGuard | undefined): MailRules | null {
  if (guard?.unreadable) throw new ToolInputError("The owner's email rules can't be read on this server, so Athena won't read this account's email here.");
  return guard?.rules ?? null;
}

/** How many threads the rules kept out since the account opened. */
export const skippedCount = (guard: MailGuard | undefined) => guard?.skipped.size ?? 0;

/** What an opened Gmail or Outlook account offers the settings page and the runner, beside its tools. */
export interface MailAccount {
  /** Labels or folders the owner can pick for a rule. */
  labels(): Promise<MailLabel[]>;
  /** The last 24 hours under these rules, from counts and senders only. */
  preview(rules: MailRules): Promise<MailPreview>;
  /** Threads the rules kept out since the account opened. */
  skipped(): number;
}

// ---------- Gmail through Google's MCP server (oauth.google_route "mcp") ----------

interface OutMessage {
  sender?: unknown;
  subject?: unknown;
  labelIds?: unknown;
}

const outView = (m: OutMessage): RuleMessage => ({
  from: typeof m.sender === "string" ? m.sender : "",
  subject: typeof m.subject === "string" ? m.subject : "",
  labels: Array.isArray(m.labelIds) ? m.labelIds.map(String) : [],
});

/**
 * The same rules for a Gmail account on Google's MCP server, which Athena
 * can't change: the search gets the rules appended, and what comes back is
 * checked in its JSON (sender, subject, labelIds: the fields Athena's own
 * tools mirror). A reply that can't be read is refused, never passed on.
 */
export async function guardedMcpGmail(
  rules: MailRules,
  name: string,
  args: Record<string, unknown>,
  call: (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
): Promise<{ text: string; isError: boolean }> {
  if (name === "search_threads") {
    const r = await call({ ...args, query: withGmailRules(typeof args.query === "string" ? args.query : "", rules) });
    if (r.isError) return r;
    let data: { threads?: Array<{ messages?: OutMessage[] }> } & Record<string, unknown>;
    try {
      data = JSON.parse(r.text);
    } catch {
      return { text: REFUSED_NOTE, isError: true };
    }
    if (!Array.isArray(data.threads)) return Object.keys(data).length ? { text: REFUSED_NOTE, isError: true } : r;
    const threads = data.threads.flatMap((t) => {
      // IDS_ONLY gives no messages to check: those threads can't be shown.
      const kept = threadKept(Array.isArray(t.messages) ? t.messages : [], outView, rules);
      return kept ? [{ ...t, messages: kept }] : [];
    });
    return { text: JSON.stringify({ ...data, threads, note: FILTERED_NOTE }), isError: false };
  }
  if (name === "get_thread" || name === "get_message") {
    const r = await call(args);
    if (r.isError) return r;
    try {
      const data = JSON.parse(r.text) as { messages?: OutMessage[] } & OutMessage;
      if (name === "get_message") return passes(outView(data), rules) ? r : { text: REFUSED_NOTE, isError: true };
      const kept = threadKept(Array.isArray(data.messages) ? data.messages : [], outView, rules);
      return kept ? { text: JSON.stringify({ ...data, messages: kept }), isError: false } : { text: REFUSED_NOTE, isError: true };
    } catch {
      return { text: REFUSED_NOTE, isError: true };
    }
  }
  return call(args);
}
