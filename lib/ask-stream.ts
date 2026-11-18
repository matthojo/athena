/**
 * Ask's reply text as it's written, and the follow-ups that come with it.
 *
 * Streaming: a written answer arrives as the `answer` tool's input, a JSON
 * object written a few characters at a time ({"text":"Elena said…). The
 * answer's text is read out of that partial JSON as it grows (answerTextSoFar),
 * and only the new characters go to the app ({type:"text", delta}). The
 * assistant's reply is plain text, sent the same way; a turn that turns out to
 * call a tool takes back what it said ({type:"text", reset:true}), since only
 * the last turn's words are the reply. The finished reply ({type:"done"})
 * always wins: it has the checked, renumbered citations.
 *
 * Follow-ups: two or three short next questions or actions, written by the
 * model in the same call as the reply (no extra request). The answer tool has a
 * `next` field; the assistant ends its reply with <next>a | b | c</next>,
 * which is taken off before the reply is shown (splitNext). cleanFollowups
 * keeps them short, distinct and plain.
 */

/** One piece of reply text for the app: new characters, or "take back what you have". */
export type TextEvent = { delta: string } | { reset: true };
export type TextSink = (event: TextEvent) => void;

/**
 * The `text` field's value so far, from the start of a JSON object that's
 * still being written. Only a top-level "text" key counts (a source's title
 * can't leak in). An escape cut off at the end is left for the next read.
 */
export function answerTextSoFar(partial: string): string {
  let depth = 0;
  let i = 0;
  let key: string | null = null;
  let expectKey = false;
  while (i < partial.length) {
    const ch = partial[i];
    if (ch === '"') {
      const { value, end, complete } = readString(partial, i + 1);
      if (depth === 1 && expectKey) {
        key = value;
        expectKey = false;
      } else if (depth === 1 && key === "text") {
        return value;
      }
      if (!complete) return "";
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      if (ch === "{" && depth === 1) expectKey = true;
    } else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 1) {
      expectKey = true;
      key = null;
    }
    i++;
  }
  return "";
}

/** A JSON string from just after its opening quote: what's readable so far, and where it ended. */
function readString(s: string, start: number): { value: string; end: number; complete: boolean } {
  let out = "";
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { value: out, end: i + 1, complete: true };
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
    i += 2;
  }
  return { value: out, end: s.length, complete: false };
}

/** What's new since the last read of a growing text; all of it again if it changed underneath (rare). */
export function textDelta(before: string, now: string): TextEvent[] {
  if (now === before) return [];
  if (now.startsWith(before)) return [{ delta: now.slice(before.length) }];
  return [{ reset: true }, ...(now ? [{ delta: now }] : [])];
}

const NEXT_OPEN = "<next>";

/** The assistant's reply without its <next> block, and the follow-ups in it. */
export function splitNext(text: string): { text: string; next: string[] } {
  const at = text.indexOf("<next");
  if (at < 0) return { text: text.trim(), next: [] };
  const block = text.slice(at);
  const inner = /^<next>([\s\S]*?)(?:<\/next>|$)/.exec(block)?.[1] ?? "";
  return { text: text.slice(0, at).trim(), next: cleanFollowups(inner.split(/\s*[|\n]\s*/)) };
}

/** The reply as it may be shown while it's written: no <next> block, not even its first few characters. */
export function visibleDraft(text: string): string {
  const at = text.indexOf("<next");
  if (at >= 0) return text.slice(0, at).trimEnd();
  for (let n = Math.min(NEXT_OPEN.length - 1, text.length); n > 0; n--) {
    if (NEXT_OPEN.startsWith(text.slice(-n))) return text.slice(0, -n).trimEnd();
  }
  return text;
}

const MAX_FOLLOWUPS = 3;
const MAX_FOLLOWUP_CHARS = 60;

/** Two or three short, distinct follow-ups in plain words; anything else is dropped. */
export function cleanFollowups(raw: unknown, opts: { not?: string } = {}): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  if (opts.not) seen.add(followupKey(opts.not));
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item
      .replace(/<[^>]*>/g, "")
      .replace(/\[\d+\]/g, "")
      .replace(/^[\s\-*•\d.)"“]+|["”\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length < 3 || t.length > MAX_FOLLOWUP_CHARS) continue;
    const key = followupKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.charAt(0).toUpperCase() + t.slice(1));
    if (out.length === MAX_FOLLOWUPS) break;
  }
  return out;
}

const followupKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** For the assistant's instructions: how to give its follow-ups. */
export const NEXT_RULE = `After your reply, on its own line, give two or three short things the owner might ask or tell you next, each under 8 words and in their voice, like <next>Remind me on Friday | Who else is coming?</next>. Leave it out when you've asked them to choose.`;
