/**
 * An assistant's page in words (team-detail.ts): pure, so the tests can check
 * the sentences without a DOM.
 *
 *   pronouns({ pronoun: "she" }) → { they: "she", them: "her", their: "her" }
 *   runLabel(run, triggers) → "New gift idea: “moka pot”", "Every Friday at 17:00", "Run now"
 *   nextStart(triggers) → "Sunday at 10:00", or null when no schedule is on
 */
import type { AvatarSpec, Personality, TeamRun, TeamTrigger } from "../../../lib/team-types";
import { WEEK, clockWords, dayList, eventWords, prefers12h, triggerSentence } from "./trigger-editor-words";

export interface Pronouns {
  /** "she", "he", "they" */
  they: string;
  /** "her", "him", "them" */
  them: string;
  /** "her", "his", "their" */
  their: string;
  /** Whether a verb after `they` takes the plural ("they run", "she runs"). */
  plural: boolean;
}

export function pronouns(p: Pick<Personality, "pronoun">): Pronouns {
  if (p.pronoun === "she") return { they: "she", them: "her", their: "her", plural: false };
  if (p.pronoun === "he") return { they: "he", them: "him", their: "his", plural: false };
  return { they: "they", them: "them", their: "their", plural: true };
}

/** "Her", "His", "Their": a pronoun at the start of a sentence. */
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What it says when you ask it to start, in its own tone. */
export function startLine(p: Pick<Personality, "tone">): string {
  switch (p.tone) {
    case "warm":
      return "On it!";
    case "playful":
      return "Ooh, on it!";
    case "wry":
      return "Right. On it.";
    case "calm":
      return "Starting now.";
    default:
      return "Starting now.";
  }
}

/** A label the server wrote from a schedule: "Every Friday at 17:00". */
const SCHEDULE_LABEL = /^Every\b.*\bat \d{1,2}:\d{2}$/;

/** What set a run off, in words. The server says so in `label`; older runs fall back to their trigger, or "Run now". */
export function runLabel(r: Pick<TeamRun, "label" | "trigger_id" | "event_id">, triggers: ReadonlyArray<TeamTrigger> = [], hour12 = prefers12h()): string {
  const t = r.trigger_id ? triggers.find((x) => x.id === r.trigger_id) : null;
  const label = r.label?.trim();
  // The server writes a schedule on a 24-hour clock; the app words it from the trigger, in this device's clock.
  if (label && t?.kind === "schedule" && SCHEDULE_LABEL.test(label)) return triggerSentence(t, hour12);
  if (label) return label;
  if (t?.kind === "event") return `${cap(eventWords(t.event))}`;
  if (t) return triggerSentence(t, hour12);
  if (r.event_id) return "Something arrived";
  return "Run now";
}

/** A run that's waiting or working. */
export const isLive = (r: Pick<TeamRun, "status">) => r.status === "queued" || r.status === "running";

/** While it works: what it's doing, in its own words, or a plain stand-in. */
export function liveWords(r: Pick<TeamRun, "status" | "step"> & { retried?: boolean }): string {
  if (r.step?.trim()) return r.step.trim();
  if (r.status === "queued" && r.retried) return "Trying again shortly";
  return r.status === "queued" ? "About to start" : "Getting it done";
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When a schedule next starts it, as the end of "starts …": "today at 17:00",
 * "tomorrow at 9:00", "on Sunday at 10:00". Null when no schedule is on.
 */
export function nextStart(triggers: ReadonlyArray<Pick<TeamTrigger, "kind" | "days" | "time" | "paused">>, now = new Date(), hour12 = prefers12h()): string | null {
  let best: Date | null = null;
  for (const t of triggers) {
    if (t.kind !== "schedule" || t.paused) continue;
    const m = /^(\d{1,2}):(\d{2})/.exec(t.time ?? "09:00");
    if (!m) continue;
    const days = dayList(t.days);
    for (let d = 0; d <= 7; d++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, Number(m[1]), Number(m[2]));
      if (at <= now || (days.length && days.length < 7 && !days.includes(at.getDay()))) continue;
      if (!best || at < best) best = at;
      break;
    }
  }
  if (!best) return null;
  const clock = clockWords(`${String(best.getHours()).padStart(2, "0")}:${String(best.getMinutes()).padStart(2, "0")}`, hour12);
  const days = Math.round((startOfDay(best) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  return `on ${WEEK.find((w) => w.day === best!.getDay())!.long} at ${clock}`;
}

/**
 * What the empty work list says about when it'll first start: "Acorn starts
 * on Sunday at 10:00.", "Penny starts when you save a gift idea.", or, with no
 * triggers on, "Acorn works when you ask."
 */
export function firstStart(name: string, triggers: ReadonlyArray<TeamTrigger>, now = new Date(), hour12 = prefers12h()): string {
  const live = triggers.filter((t) => !t.paused);
  const sched = nextStart(live, now, hour12);
  if (sched) return `${name} starts ${sched}.`;
  const ev = live.find((t) => t.kind === "event");
  if (ev) return `${name} starts ${triggerSentence(ev, hour12).replace(/^When /, "when ")}.`;
  return `${name} works when you ask.`;
}

const OUTFIT_WORD: Record<string, string> = { tee: "T-shirt", hoodie: "hoodie", polo: "polo shirt", overalls: "overalls", blazer: "blazer", vest: "vest", collar: "collar" };
const ACCESSORY_WORD: Record<string, string> = {
  beanie: "a beanie",
  "party-hat": "a party hat",
  bow: "a bow",
  flowers: "flowers",
  headphones: "headphones",
  crown: "a crown",
  glasses: "glasses",
  "eye-patch": "an eye patch",
  scarf: "a scarf",
  "heart-necklace": "a heart necklace",
};
const FUR_WORD: Record<string, string> = { snow: "white", charcoal: "charcoal", cocoa: "brown", honey: "honey", ginger: "ginger", cream: "cream", mint: "mint", lilac: "lilac", sky: "blue", blush: "pink", slate: "grey", butter: "yellow" };
const SPECIES_WORD: Record<string, string> = { cat: "cat", bear: "bear", fox: "fox", bunny: "bunny", monster: "monster" };

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** How it looks, as a sentence: "A white cat in a berry hoodie, with glasses and a heart necklace". */
export function looksWords(a: AvatarSpec): string {
  const fur = FUR_WORD[a.fur] ?? a.fur;
  const article = /^[aeiou]/i.test(fur) ? "An" : "A";
  const outfit = OUTFIT_WORD[a.outfit] ?? a.outfit;
  const wear = a.outfit === "overalls" ? `${a.outfitColor} overalls` : `a ${a.outfitColor} ${outfit}`;
  const extras = a.accessories.map((x) => ACCESSORY_WORD[x] ?? x);
  return `${article} ${fur} ${SPECIES_WORD[a.species] ?? a.species} in ${wear}${extras.length ? `, with ${list(extras)}` : ""}`;
}

const TONE_WORD: Record<string, string> = { warm: "Warm", crisp: "Crisp", playful: "Playful", calm: "Calm", wry: "Wry" };

/** Its character in one line: "Warm, thorough and frugal". */
export function characterWords(p: Pick<Personality, "tone" | "traits">): string {
  return list([TONE_WORD[p.tone] ?? p.tone, ...p.traits.map((t) => t.toLowerCase())]);
}
