/**
 * A reply as it's written (lib/ask-stream.ts on the server): the words so far,
 * shown in the place the finished reply will take, so nothing moves when it
 * lands. Citation markers show as quiet placeholders until the finished reply
 * brings its checked sources; a marker cut off part-way ("[", "[1") waits for
 * the rest. The finished reply always replaces the draft.
 */
import { citationParts } from "../../../lib/answer-text";

export type TextEvent = { delta: string } | { reset: true };

/** The words so far, after one more piece. */
export function applyText(draft: string, e: TextEvent): string {
  return "reset" in e ? "" : draft + e.delta;
}

/** The draft as the finished answer will read: one plain paragraph, no Markdown, no half-written marker or link at the end. */
export function draftText(raw: string): string {
  return raw
    .replace(/\*\*|__|`/g, "")
    .replace(/\s*\n+\s*/g, " ")
    // A marker or a link still being written ("[1", "[@Pri", "[@Priya](athena://pe") waits for the rest.
    .replace(/\s?\[[^\]]*(?:\]\([^)]*)?$/, "")
    .replace(/\s{2,}/g, " ")
    .trimStart();
}

/** The draft split for display: plain runs, and the numbers of markers (placeholders until the sources come). */
export const draftParts = (raw: string): Array<string | number> => citationParts(draftText(raw));

/** One event of a streamed reply, as the app reads it (app/src/db/api.ts). */
export type StreamEvent = { type: "step"; id: string; text: string; done: boolean } | ({ type: "text" } & TextEvent) | { type: "done"; reply: unknown };

/** A stream played through: the steps as they ended, the draft as it stood when the reply came, and the reply. */
export function assemble<R>(events: StreamEvent[]): { steps: Array<{ id: string; text: string; done: boolean }>; draft: string; reply: R | null } {
  const steps: Array<{ id: string; text: string; done: boolean }> = [];
  let draft = "";
  let reply: R | null = null;
  for (const e of events) {
    if (reply) break;
    if (e.type === "step") {
      const i = steps.findIndex((s) => s.id === e.id);
      if (i >= 0) steps[i] = { id: e.id, text: e.text, done: e.done };
      else steps.push({ id: e.id, text: e.text, done: e.done });
    } else if (e.type === "text") draft = applyText(draft, e);
    else reply = e.reply as R;
  }
  return { steps, draft, reply };
}
