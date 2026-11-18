/**
 * Awaiting reply's sent mail: the owner's sent threads from the last 15 days
 * in each connected Gmail or Outlook account, through the account's own
 * search_threads (read-only; the owner's mail rules are applied there, so a
 * skipped sender or label never reaches a rule). Only each thread's latest
 * message is read: if it's the owner's, nobody has answered. Nothing is
 * stored from here except, if a nudge is made, the subject and snippet
 * sealed inside it.
 *
 * Read at most once an hour, inside working hours (netlify/functions/reminders.ts).
 */
import { listConnectors } from "../../../lib/connectors";
import { resolvePerson } from "../../../lib/memory";
import { callTool, openConnector } from "../connectors/mcp-client";
import { parseAddress } from "../connectors/gmail-drafts";
import type { SentThread } from "../../../lib/proactive/types";

const MAIL = new Set(["gmail", "outlook-mail", "fastmail"]);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A search_threads result (THREAD_VIEW_SUMMARY) → threads whose latest message is the owner's. */
export function sentThreads(text: string, connector: { id: string; created_at?: string }): Array<Omit<SentThread, "to"> & { to: { name: string; email: string } }> {
  let parsed: { threads?: Array<{ id?: unknown; messages?: Array<Record<string, unknown>> }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: Array<Omit<SentThread, "to"> & { to: { name: string; email: string } }> = [];
  for (const t of parsed.threads ?? []) {
    const latest = (t.messages ?? [])[(t.messages ?? []).length - 1];
    if (!latest || !str(t.id)) continue;
    const labels = ((latest.labelIds ?? latest.label_ids) as string[] | undefined) ?? [];
    const to = ((latest.toRecipients ?? latest.to_recipients) as string[] | undefined)?.map(parseAddress).find(Boolean);
    const date = str(latest.date);
    if (!to || !date || Number.isNaN(Date.parse(date))) continue;
    out.push({
      id: str(t.id),
      connector_id: connector.id,
      subject: str(latest.subject),
      to,
      sent_at: new Date(date).toISOString(),
      snippet: str(latest.snippet),
      unanswered: labels.includes("SENT"),
      labels,
      // Sent before this mailbox was connected: history, not a live thread.
      backfilled: !!connector.created_at && Date.parse(date) < Date.parse(connector.created_at),
    });
  }
  return out;
}

export async function loadSentMail(): Promise<SentThread[]> {
  const accounts = (await listConnectors()).filter((c) => MAIL.has(c.provider) && c.status === "connected" && c.allowed_tools.includes("search_threads"));
  const out: SentThread[] = [];
  for (const c of accounts) {
    const open = await openConnector(c.id).catch(() => null);
    if (!open) continue;
    try {
      const r = await callTool(open, "search_threads", { query: "in:sent newer_than:15d", pageSize: 30, view: "THREAD_VIEW_SUMMARY" });
      if (r.isError) continue;
      for (const t of sentThreads(r.text, c)) {
        const [match] = await resolvePerson({ email: t.to.email }).catch(() => []);
        out.push({ ...t, to: { id: match?.person.id ?? null, name: match?.person.name ?? t.to.name, email: t.to.email } });
      }
    } catch (error) {
      console.error("Athena proactive: couldn't read sent mail", (error as Error).message?.slice(0, 120));
    } finally {
      await open.close().catch(() => undefined);
    }
  }
  return out.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
}
