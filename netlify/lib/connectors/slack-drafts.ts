/**
 * lib/drafts.ts's SlackPort, through a connected Slack account's own MCP
 * server, read-only, with the owner's allowed tools only:
 *
 *  - findMember: slack_search_users, by the person's email first, then by
 *    their exact name. One clear match is the answer; two or more is
 *    "ambiguous" and Athena doesn't guess.
 *  - ownMessages: slack_search_public_and_private (or slack_search_public)
 *    for "from:me", the owner's own recent messages, as text only.
 *
 * Nothing here posts: callTool refuses any send tool by name, and Slack's
 * write tools are never allowed for an account (listAllowedTools).
 * Slack's server answers in JSON or in plain text depending on its version,
 * so both are read.
 */
import { listConnectors, type Connector } from "../../../lib/connectors";
import type { SlackPort } from "../../../lib/drafts";
import { callTool, openConnector } from "./mcp-client";

const MEMBER = /^[UW][A-Z0-9]{7,}$/;
const TEAM = /^T[A-Z0-9]{6,}$/;

export interface SlackUser {
  id: string;
  team: string | null;
  emails: string[];
  names: string[];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Every user-shaped object in a JSON reply: an id like U…, with whatever email and names it carries. */
function usersFromJson(value: unknown, out: SlackUser[]): void {
  if (Array.isArray(value)) return value.forEach((v) => usersFromJson(v, out));
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  const id = [o.id, o.user_id, o.userId, o.member_id].map(str).find((x) => MEMBER.test(x));
  if (id) {
    const p = (o.profile && typeof o.profile === "object" ? o.profile : {}) as Record<string, unknown>;
    const pick = (...vs: unknown[]) => vs.map(str).filter(Boolean);
    out.push({
      id,
      team: [o.team_id, o.teamId, o.team].map(str).find((x) => TEAM.test(x)) ?? null,
      emails: pick(o.email, p.email).map((e) => e.toLowerCase()),
      // Real names only: a handle or display name ("priya") isn't who someone is.
      names: pick(o.real_name, o.realName, p.real_name, p.real_name_normalized),
    });
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") usersFromJson(v, out);
}

/**
 * A slack_search_users reply as users. JSON when it is; otherwise one
 * block per user (separated by blank lines or list markers), each with a
 * member ID, and its email and names from "Email:", "Name:" or "Real name:" lines, or
 * a leading "Name (U…)". Display names and handles aren't kept: only real
 * names are matched.
 */
export function parseSlackUsers(text: string): SlackUser[] {
  try {
    const out: SlackUser[] = [];
    usersFromJson(JSON.parse(text), out);
    return dedupe(out);
  } catch {
    // Plain text.
  }
  const blocks = text.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+\.)\s)/);
  const out: SlackUser[] = [];
  for (const block of blocks) {
    const id = block.match(/\b([UW][A-Z0-9]{7,})\b/)?.[1];
    if (!id) continue;
    const field = (label: string) => [...block.matchAll(new RegExp(`${label}\\s*[:=]\\s*([^\\n,;|]+)`, "gi"))].map((m) => m[1].replace(/[*_`]/g, "").trim());
    const lead = block.match(/^\s*(?:[-*•]|\d+\.)?\s*\**([^()\n*:]+?)\**\s*\((?:@?[\w.-]+,\s*)?[UW][A-Z0-9]{7,}\)/)?.[1]?.trim();
    out.push({
      id,
      team: block.match(/\b(T[A-Z0-9]{6,})\b/)?.[1] ?? null,
      emails: [...new Set([...field("e-?mail"), ...(block.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi) ?? [])].map((e) => e.toLowerCase()))],
      names: [...new Set([...field("real ?name"), ...field("(?<!display |user )name"), ...(lead ? [lead] : [])])],
    });
  }
  return dedupe(out);
}

function dedupe(users: SlackUser[]): SlackUser[] {
  const by = new Map<string, SlackUser>();
  for (const u of users) {
    const had = by.get(u.id);
    by.set(u.id, had ? { id: u.id, team: had.team ?? u.team, emails: [...new Set([...had.emails, ...u.emails])], names: [...new Set([...had.names, ...u.names])] } : u);
  }
  return [...by.values()];
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** The one user who is this person: by email, then by exact name. More than one: "ambiguous". */
export function matchSlackUser(users: SlackUser[], person: { name: string; email: string | null }): SlackUser | "ambiguous" | null {
  const email = person.email?.trim().toLowerCase();
  if (email) {
    const byEmail = users.filter((u) => u.emails.includes(email));
    if (byEmail.length === 1) return byEmail[0];
    if (byEmail.length > 1) return "ambiguous";
  }
  const name = norm(person.name);
  const byName = users.filter((u) => u.names.some((n) => norm(n) === name));
  if (byName.length === 1) return byName[0];
  return byName.length > 1 ? "ambiguous" : null;
}

/** The text of each message in a search reply: JSON `text` fields, or "Text:" lines and quoted lines. */
export function parseSlackMessages(text: string): string[] {
  try {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string" && o.text.trim()) out.push(o.text.trim());
      else for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
    };
    walk(JSON.parse(text));
    return out;
  } catch {
    return [...text.matchAll(/^\s*(?:text|message)\s*:\s*(.+)$/gim), ...text.matchAll(/^\s*>\s?(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  }
}

/** Slack accounts that are connected, with the tool allowed. */
async function accountsWith(...tools: string[]): Promise<Array<{ c: Connector; tool: string }>> {
  return (await listConnectors())
    .filter((c) => c.provider === "slack" && c.status === "connected")
    .flatMap((c) => {
      const tool = tools.find((t) => c.allowed_tools.includes(t));
      return tool ? [{ c, tool }] : [];
    });
}

async function call(connectorId: string, tool: string, args: Record<string, unknown>): Promise<string | null> {
  const open = await openConnector(connectorId);
  try {
    const r = await callTool(open, tool, args);
    return r.isError ? null : r.text;
  } finally {
    await open.close();
  }
}

export const slackPort: SlackPort = {
  async findMember(person) {
    for (const { c, tool } of await accountsWith("slack_search_users")) {
      for (const query of [person.email, person.name].filter((q): q is string => !!q?.trim())) {
        try {
          const text = await call(c.id, tool, { query });
          if (!text) continue;
          const found = matchSlackUser(parseSlackUsers(text), person);
          if (found === "ambiguous") return "ambiguous";
          if (found) return { user: found.id, team: found.team };
        } catch (error) {
          console.warn("Athena drafts: Slack user lookup failed", error instanceof Error ? error.message : error);
        }
      }
    }
    return null;
  },
  async ownMessages() {
    for (const { c, tool } of await accountsWith("slack_search_public_and_private", "slack_search_public")) {
      try {
        const text = await call(c.id, tool, { query: "from:me" });
        const messages = text ? parseSlackMessages(text) : [];
        if (messages.length) return messages.slice(0, 10);
      } catch (error) {
        console.warn("Athena drafts: couldn't read the owner's Slack messages", error instanceof Error ? error.message : error);
      }
    }
    return [];
  },
};
