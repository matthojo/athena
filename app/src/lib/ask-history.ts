/**
 * The conversation so far, as a follow-up sends it:
 * written answers and the assistant's replies alike, across any turn that
 * got only a keyword search, the latest 12 turns. Each of Athena's turns
 * carries `refs`, up to 8 of what it cited, so "open the second one" and
 * "what else did that email say?" have something to point at.
 *
 * Pure: the thread is read by shape.
 */
import { citedNumbers } from "../../../lib/answer-text";
import { parseAthenaLinks } from "../../../lib/links";
import { MAX_REFS, MAX_TURNS, sourceRef, type AskTurn } from "./ask-contract";
import { withoutCitations } from "./ask-rich";

interface Cited {
  n: number;
  kind: string;
  id?: string | null;
  url?: string | null;
}

/** A message of the thread, as much of it as the history reads. */
export interface HistoryMessage {
  role: string;
  /** Your words. */
  text?: string;
  reply?: { text: string; sources?: Cited[]; changes?: Array<{ kind: string; id: string }> } | null;
}

const capped = (refs: Array<string | null>): string[] => [...new Set(refs.filter((r): r is string => !!r))].slice(0, MAX_REFS);

/** A written answer's refs: what its text cites, in the order cited, then its other sources. */
export function answerRefs(reply: { text: string; sources?: Cited[] }): string[] {
  const sources = reply.sources ?? [];
  const byN = new Map(sources.map((s) => [s.n, s]));
  const cited = citedNumbers(reply.text).map((n) => byN.get(n)).filter((s): s is Cited => !!s);
  return capped([...cited, ...sources].map(sourceRef));
}

/** The assistant names two things differently from the refs a follow-up carries: a to-do and a Watch & read title. */
const REF_KIND: Record<string, string> = { commitment: "todo", reading: "watch" };
const ref = (kind: string, id: string) => `${REF_KIND[kind] ?? kind}:${id}`;

/** The assistant's refs: the things in Athena its text links to, then what it changed. */
export function assistantRefs(reply: { text: string; changes?: Array<{ kind: string; id: string }> }): string[] {
  return capped([...parseAthenaLinks(reply.text).map((l) => ref(l.kind, l.id)), ...(reply.changes ?? []).map((c) => (c.id ? ref(c.kind, c.id) : null))]);
}

/**
 * The turns to send with a follow-up, oldest first. A question that got only
 * a keyword search stays in (it's what you asked); with nothing of Athena's
 * between two of yours, they go as one turn, so the turns always alternate.
 */
export function answerHistory(thread: ReadonlyArray<HistoryMessage>): AskTurn[] {
  const turns: AskTurn[] = [];
  for (const m of thread) {
    const last = turns[turns.length - 1];
    if (m.role === "me") {
      const text = m.text?.trim();
      if (!text) continue;
      if (last?.role === "user") last.text += `\n\n${text}`;
      else turns.push({ role: "user", text });
      continue;
    }
    if ((m.role !== "answer" && m.role !== "assistant") || !m.reply) continue;
    const text = m.role === "answer" ? withoutCitations(m.reply.text) : m.reply.text.trim();
    // Athena's turn answers yours: one with nothing before it, or no words, isn't sent.
    if (!text || last?.role !== "user") continue;
    // One history for every turn: what a reply cited, then what its text links to and what it changed (older instruction replies have only those).
    turns.push({ role: "assistant", text, refs: capped([...(m.role === "answer" ? answerRefs(m.reply) : []), ...assistantRefs(m.reply)]) });
  }
  const latest = turns.slice(-MAX_TURNS);
  // It starts with your words, and ends with Athena's: the new question follows.
  while (latest.length && latest[0].role !== "user") latest.shift();
  while (latest.length && latest[latest.length - 1].role !== "assistant") latest.pop();
  return latest;
}
