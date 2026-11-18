/**
 * Pinned answers in Ask. Pinning a reply keeps it at the top of Ask's
 * history, in a Pinned list above the conversations; tapping one opens its
 * conversation at that reply. The pin is kept on the reply's own message
 * (pinned_at), so it syncs with the conversation and needs no schema change.
 * Archived conversations' pins don't show.
 */
import { plainText } from "./ask-rich";
import { replaceAthenaLinks } from "../../../lib/links";

export interface PinnedAnswer {
  threadId: string;
  /** The reply's place in the conversation. */
  index: number;
  /** What was asked (your message before it). */
  question: string;
  /** The reply, as plain words. */
  text: string;
  pinned_at: string;
}

type PinMessage = { role: string; text?: string; question?: string; reply?: { text?: string } | null; pinned_at?: string | null };

/** Every pinned reply across the conversations, newest pin first. */
export function pinnedAnswers(threads: ReadonlyArray<{ id: string; archived_at?: string | null; messages: readonly PinMessage[] }>): PinnedAnswer[] {
  const out: PinnedAnswer[] = [];
  for (const t of threads) {
    if (t.archived_at) continue;
    t.messages.forEach((m, index) => {
      if (!m.pinned_at || (m.role !== "answer" && m.role !== "assistant")) return;
      const before = t.messages.slice(0, index).reverse().find((x) => x.role === "me");
      const said = m.role === "answer" ? (m.text ?? "") : (m.reply?.text ?? "");
      out.push({ threadId: t.id, index, question: plain(m.question ?? before?.text ?? ""), text: plain(plainText(said)), pinned_at: m.pinned_at });
    });
  }
  return out.sort((a, b) => b.pinned_at.localeCompare(a.pinned_at));
}

/** Pin or unpin one reply. */
export function setPinned<T extends { pinned_at?: string | null }>(m: T, on: boolean, now = new Date()): T {
  if (on) m.pinned_at = m.pinned_at ?? now.toISOString();
  else delete m.pinned_at;
  return m;
}

const plain = (t: string) => replaceAthenaLinks(t, (l) => l.label.replace(/^@/, "")).replace(/\s+/g, " ").trim();
