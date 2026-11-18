/**
 * Team setup: when a draft comes back thin (no proposed job or triggers, as
 * sample mode's does), read the owner's own sentence for them. Pure.
 *
 *   jobFromText("When I save a gift idea, find a good price") → "Finds a good price"
 *   triggersFromText("Every Friday at 5, sum up my week") → [{ kind: "schedule", days: [5], time: "17:00" }]
 */
import type { TeamTriggerInput } from "../../../lib/team-types";
import { WEEK } from "./trigger-editor-words";

const IRREGULAR: Record<string, string> = { do: "Does", go: "Goes", have: "Has", be: "Is" };

function thirdPerson(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR[v]) return IRREGULAR[v];
  const s = /(s|sh|ch|x|z)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The action half of "When …, do …" or "Every …, do …", as a job: "Finds a good price". */
export function jobFromText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const m = /^(?:when|whenever|every|each|on|if|after)\b[^,]*,\s*(?:then\s+)?(.+)$/i.exec(t);
  const action = (m ? m[1] : t).replace(/^please\s+/i, "");
  const [verb, ...rest] = action.split(" ");
  if (!verb || !/^[a-z]+$/i.test(verb)) return t;
  const tail = rest.join(" ").replace(/\bmy\b/gi, "your").replace(/\bme\b/gi, "you").replace(/\bI\b/g, "you");
  return `${thirdPerson(verb)}${tail ? ` ${tail}` : ""}`.slice(0, 140);
}

function hourFrom(h: number, mer: string | undefined, evening: boolean): number {
  if (mer) return mer.toLowerCase() === "pm" ? (h % 12) + 12 : h % 12;
  // "at 5" with no am/pm: an afternoon hour reads as afternoon.
  return evening || (h >= 1 && h <= 6) ? (h % 12) + 12 : h;
}

/** Triggers the sentence names on its own: a schedule, or something arriving. */
export function triggersFromText(text: string): TeamTriggerInput[] {
  const t = text.toLowerCase();
  const out: TeamTriggerInput[] = [];
  const every = /\bevery\s+(day|weekday|weekend|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/.exec(t);
  if (every) {
    const word = every[1];
    const named = WEEK.find((w) => w.long.toLowerCase() === word);
    const days = named ? [named.day] : word === "weekday" ? [1, 2, 3, 4, 5] : word === "weekend" ? [0, 6] : [0, 1, 2, 3, 4, 5, 6];
    const at = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t);
    const evening = word === "evening";
    const h = at ? hourFrom(Number(at[1]), at[3], evening) : evening ? 18 : 9;
    out.push({ kind: "schedule", days, time: `${String(Math.min(h, 23)).padStart(2, "0")}:${at?.[2] ?? "00"}` });
  }
  // What email sets off, named in the job ("tell me when a parcel is out for delivery").
  const mailKind = /\b(parcels?|deliver(?:y|ies|ed)|out for delivery)\b/.test(t)
    ? "delivery"
    : /\b(security|sign-?ins?|account alerts?|failed payments?)\b/.test(t)
      ? "alert"
      : /\b(renewals?|renews?|expir(?:y|es|ing))\b/.test(t)
        ? "renewal"
        : /\b(flights?|bookings?|trains?|hotels?)\b/.test(t) && /\b(email|gmail|changed?|cancel+ed|delay(?:ed)?)\b/.test(t)
          ? "booking"
          : null;
  if (mailKind) out.push({ kind: "event", event: { source: "collected", connector: "gmail", kind: mailKind } });
  else if (/\blinear\b/.test(t)) out.push({ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } });
  else if (/\b(email|gmail)\b/.test(t)) out.push({ kind: "event", event: { source: "collected", connector: "gmail", kind: "email" } });
  else if (/\bcalendar\b/.test(t)) out.push({ kind: "event", event: { source: "collected", connector: "google-calendar", kind: "event" } });
  else if (/\bgift idea\b/.test(t)) out.push({ kind: "event", event: { source: "saved", savedAction: "gift-idea" } });
  else if (/\bwhen i save\b|\bsaved? (a )?link\b/.test(t)) out.push({ kind: "event", event: { source: "saved" } });
  else {
    const tag = /#([a-z0-9][\w-]*)/.exec(t);
    if (tag) out.push({ kind: "event", event: { source: "note", tag: tag[1] } });
  }
  return out;
}
