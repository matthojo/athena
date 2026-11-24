/**
 * "Ignore emails like this" from the review inbox: a mail rule (lib/mail-rules.ts)
 * added to the account a find's email was read from, so the next sync never
 * reads mail like it, and the finds it would have kept out leave the Inbox now.
 *
 * The account is the one the email was read from (suggestions.email,
 * 0086). A find filed before that was recorded falls back to the mail
 * accounts of the collection that filed it (its `source`).
 */
import { getConnector, listCollections, saveMailRules, type Connector } from "./connectors";
import { NO_RULES, RULE_LIMITS, readRules, readSender, readSubject } from "./mail-rules";
import { AthenaInputError } from "./db";
import { listSuggestions, rejectSuggestion, type Suggestion } from "./memory";
import { caughtBy, similarKey } from "./suggestion-similar";

/** The providers whose accounts carry mail rules (netlify/lib/connectors/routes.ts READS_MAIL). */
export const MAIL_PROVIDERS = new Set(["gmail", "outlook-mail", "fastmail"]);

export interface IgnoreRule {
  kind: "sender" | "subject";
  /** An address or a domain (sender), or a phrase (subject). */
  value: string;
}

export interface IgnoreResult {
  rule: IgnoreRule;
  /** The accounts the rule was added to, by name. */
  accounts: string[];
  /** The Inbox finds that left with it: this one, the ones the rule catches, and its repeats. */
  dismissed: string[];
}

/** The rule as the owner gave it, made safe for the rules (or refused). */
export function readIgnoreRule(raw: unknown): IgnoreRule {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const value = typeof r.value === "string" ? r.value : "";
  if (r.kind === "sender") {
    const v = readSender(value);
    if (!v) throw new AthenaInputError("That isn't an email address or a domain.");
    return { kind: "sender", value: v };
  }
  if (r.kind === "subject") {
    const v = readSubject(value);
    if (!v) throw new AthenaInputError("A subject phrase needs 2 to 100 characters.");
    return { kind: "subject", value: v };
  }
  throw new AthenaInputError("Say whether to ignore a sender or a subject.");
}

/** The mail accounts a find's email came through. */
async function accountsFor(s: Suggestion): Promise<Connector[]> {
  if (s.email?.connector_id) {
    const c = await getConnector(s.email.connector_id);
    if (c && MAIL_PROVIDERS.has(c.provider)) return [c];
  }
  if (!s.source) return [];
  const ids = new Set((await listCollections()).filter((c) => c.source === s.source).flatMap((c) => c.connector_ids));
  const found = await Promise.all([...ids].map((id) => getConnector(id)));
  return found.filter((c): c is Connector => !!c && MAIL_PROVIDERS.has(c.provider));
}

/** Add the rule to that account (or accounts) and dismiss what it catches. */
export async function ignoreLike(id: string, rule: IgnoreRule): Promise<IgnoreResult> {
  const pending = await listSuggestions({ status: "pending", limit: 1000 });
  const s = pending.find((p) => p.id === id);
  if (!s) throw new AthenaInputError("That's no longer in your Inbox.", 404);
  const accounts = await accountsFor(s);
  if (!accounts.length) throw new AthenaInputError("Athena can't tell which email account this came from. Add the rule in Settings, under the account's email rules.");
  for (const c of accounts) {
    if (c.mail_rules_unreadable) throw new AthenaInputError(`The email rules for ${c.name} can't be read on this server, so they can't be changed here.`);
    const rules = c.mail_rules ?? { ...NO_RULES };
    const list = rule.kind === "sender" ? rules.skip_senders : rules.skip_subjects;
    if (list.some((v) => v.toLowerCase() === rule.value.toLowerCase())) continue;
    const limit = rule.kind === "sender" ? RULE_LIMITS.senders : RULE_LIMITS.subjects;
    if (list.length >= limit) throw new AthenaInputError(`${c.name} already skips ${limit} ${rule.kind === "sender" ? "senders" : "subjects"}. Remove one in Settings first.`);
    const next = rule.kind === "sender" ? { ...rules, skip_senders: [...list, rule.value] } : { ...rules, skip_subjects: [...list, rule.value] };
    await saveMailRules(c.id, readRules(next));
  }
  const accountIds = new Set(accounts.map((c) => c.id));
  const key = similarKey(s);
  const leaving = pending.filter((p) => {
    if (p.id === s.id) return true;
    // Read from one of these accounts, and kept out from now on.
    const sameAccount = p.email?.connector_id ? accountIds.has(p.email.connector_id) : p.source === s.source;
    if (sameAccount && caughtBy(p.email, rule)) return true;
    // A repeat of this one, from the same collection, with no email recorded to check.
    return !p.email && p.source === s.source && !!key && similarKey(p) === key;
  });
  for (const p of leaving) await rejectSuggestion(p.id);
  return { rule, accounts: accounts.map((c) => c.name), dismissed: leaving.map((p) => p.id) };
}
