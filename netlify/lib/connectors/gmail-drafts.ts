/**
 * lib/drafts.ts's MailPort, through the account's own Gmail or Outlook
 * connection with its stored sign-in (Google's Gmail API directly,
 * google-direct.ts; Google's Gmail MCP server for an account switched to it;
 * or Microsoft Graph, microsoft-direct.ts, whose tools share Gmail's names
 * and shapes): get_thread to read what a to-do came from, search_threads and
 * get_thread for a few of the owner's own sent emails (their voice), and
 * create_draft to save one. Nothing here sends; callTool refuses send tools
 * outright, and create_draft only ever runs for an account with drafts on.
 */

import type { MailPort, GmailThread } from "../../../lib/drafts";
import { AthenaInputError } from "../../../lib/db";
import { callTool, classifyFailure, ConnectorNeedsSignIn, openConnector, type OpenConnector } from "./mcp-client";

async function withAccount<T>(connectorId: string, run: (open: OpenConnector) => Promise<T>): Promise<T> {
  const open = await openConnector(connectorId);
  try {
    return await run(open);
  } catch (error) {
    if (error instanceof AthenaInputError || error instanceof ConnectorNeedsSignIn) throw error;
    throw await classifyFailure(open.connector, error);
  } finally {
    await open.close();
  }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Gmail's fields come back camelCase or snake_case depending on the server version. */
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v !== undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** "Priya Shah <priya@example.com>" → name and address. */
export function parseAddress(raw: string): { name: string; email: string } | null {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { name: (m?.[1] ?? "").trim() || email.split("@")[0], email };
}

/** A get_thread result → the latest few messages as text, and the one to reply to. */
export function parseThread(text: string): GmailThread | null {
  const thread = parse(text);
  const messages = Array.isArray(thread?.messages) ? (thread!.messages as Array<Record<string, unknown>>) : [];
  if (!messages.length) return null;
  const sent = (m: Record<string, unknown>) => ((pick(m, "labelIds", "label_ids") as string[] | undefined) ?? []).includes("SENT");
  const replyTo = [...messages].reverse().find((m) => !sent(m)) ?? messages[messages.length - 1];
  const subject = str(pick(messages[0], "subject")) || str(pick(replyTo, "subject"));
  const lines = messages.slice(-4).map((m) => {
    const body = str(pick(m, "plaintextBody", "plaintext_body", "snippet")).trim();
    const who = sent(m) ? "The owner" : str(pick(m, "sender", "from"));
    return `From: ${who} · ${str(pick(m, "date"))}\n${body.length > 1_500 ? `${body.slice(0, 1_500)}…` : body}`;
  });
  return {
    subject,
    text: lines.join("\n\n---\n\n"),
    replyToMessageId: str(pick(replyTo, "id")) || null,
    from: sent(replyTo) ? null : parseAddress(str(pick(replyTo, "sender", "from"))),
  };
}

/** The owner's own messages in a get_thread result, newest first, as plain text. */
export function ownMessages(text: string): string[] {
  const thread = parse(text);
  const messages = Array.isArray(thread?.messages) ? (thread!.messages as Array<Record<string, unknown>>) : [];
  return messages
    .filter((m) => ((pick(m, "labelIds", "label_ids") as string[] | undefined) ?? []).includes("SENT"))
    .map((m) => str(pick(m, "plaintextBody", "plaintext_body")).trim())
    .filter((b) => b.length >= 10)
    .reverse();
}

const providerName = (p: string) => (p === "outlook-mail" ? "Outlook" : p === "fastmail" ? "Fastmail" : "Gmail");

export const mailPort: MailPort = {
  async readThread(connectorId, threadId) {
    return withAccount(connectorId, async (open) => {
      // Respect the owner's own switch: if they've turned get_thread off for this account, don't read.
      if (!open.connector.allowed_tools.includes("get_thread")) return null;
      const r = await callTool(open, "get_thread", { threadId, messageFormat: "PLAIN_TEXT" });
      return r.isError ? null : parseThread(r.text);
    });
  },
  async createDraft(connectorId, draft) {
    return withAccount(connectorId, async (open) => {
      const r = await callTool(open, "create_draft", {
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        includeSignature: true,
        ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
      });
      if (r.isError) {
        const where = providerName(open.connector.provider);
        // Fastmail's own words already say what to do (a token without Make changes).
        if (open.connector.provider === "fastmail") throw new AthenaInputError(r.text.slice(0, 300));
        throw new AthenaInputError(
          /scope|permission|insufficient|forbidden|403/i.test(r.text)
            ? `${where} hasn't given Athena draft access for ${open.connector.name} yet. Turn drafts off and on again in Sources, and finish signing in.`
            : `${where} couldn't save the draft: ${r.text.slice(0, 200)}`,
        );
      }
      const made = parse(r.text) ?? {};
      return { id: str(pick(made, "id")), url: str(pick(made, "viewUrl", "view_url")) || null };
    });
  },
  async sentSamples(connectorId, to) {
    return withAccount(connectorId, async (open) => {
      const allowed = open.connector.allowed_tools;
      if (!allowed.includes("search_threads") || !allowed.includes("get_thread")) return [];
      const query = `in:sent${to ? ` to:${to.replace(/[\s"()]/g, "")}` : ""}`;
      const found = await callTool(open, "search_threads", { query, pageSize: 3, view: "THREAD_VIEW_IDS_ONLY" });
      if (found.isError) return [];
      const ids = ((parse(found.text)?.threads as Array<{ id?: unknown }> | undefined) ?? []).map((t) => str(t.id)).filter(Boolean).slice(0, 2);
      const out: string[] = [];
      for (const id of ids) {
        const r = await callTool(open, "get_thread", { threadId: id, messageFormat: "PLAIN_TEXT" });
        if (!r.isError) out.push(...ownMessages(r.text).slice(0, 1));
      }
      return out;
    });
  },
};

/** The old name. */
export const gmailPort = mailPort;
