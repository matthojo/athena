/**
 * Team setup: what the new assistant says while you hire it, in its own
 * tone (docs/team.md, "Setup"). Pure, so it's tested without a page.
 *
 *   promiseLine("Finds a good price", [gift idea trigger]) → "When you save a gift idea, I'll find a good price."
 *   nextRun([{ kind: "schedule", days: [5], time: "17:00" }], wednesday) → "Friday at 17:00"
 */
import type { Personality } from "../../../lib/team-types";
import { clockWords, connectorById, dayList, prefers12h, triggerSentence, WEEK, type TriggerLike } from "./trigger-editor-words";

/** A trigger as drafted or as saved. */
type Trigger = TriggerLike & { paused?: boolean };

type Tone = Personality["tone"];

const IRREGULAR: Record<string, string> = { does: "do", has: "have", goes: "go", is: "be" };

/** "Finds good prices" → "find good prices". Null when the job doesn't start with a verb we can turn round. */
export function firstPerson(job: string): string | null {
  const t = job.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const [word, ...rest] = t.split(" ");
  if (!word || !/^[A-Za-z]+s$/.test(word) || /ss$/i.test(word)) return null;
  const w = word.toLowerCase();
  const verb = IRREGULAR[w] ?? (/ies$/.test(w) ? `${w.slice(0, -3)}y` : /(ch|sh|x|z|ss)es$/.test(w) ? w.slice(0, -2) : w.slice(0, -1));
  return [verb, ...rest].join(" ");
}

const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What it promises to do, in the first person, with when when there's one trigger. */
export function promiseLine(job: string, triggers: Trigger[], hour12 = prefers12h()): string {
  const act = firstPerson(job);
  if (!act) return job.trim() ? `My job: ${lcFirst(job.trim().replace(/[.!]+$/, ""))}.` : "Tell me what you need and I'll start.";
  if (triggers.length === 1) return `${triggerSentence(triggers[0], hour12)}, I'll ${act}.`;
  if (!triggers.length) return `I'll ${act} whenever you ask.`;
  return `I'll ${act}.`;
}

const SUBJECT: Record<string, string> = { does: "do", did: "did", should: "should", can: "can", could: "could", would: "would", will: "will", may: "may", must: "must" };

/**
 * A setup question as the assistant asks it: "Should it copy due dates?" →
 * "Should I copy due dates?". Only "it" right after a modal, and "it did",
 * change, since those are about the assistant; anything else is left alone.
 */
export function inVoice(question: string): string {
  // Already in its voice (the server writes them that way): leave it be, so it's never turned round twice.
  if (/\bI\b|\bI['’](m|ll|ve|d)\b|\b(me|my|myself)\b/i.test(question.replace(/\bi\.e\./gi, ""))) return question;
  return question
    .replace(/\b(does|did|should|can|could|would|will|may|must) it\b/gi, (m, verb: string) => {
      const v = SUBJECT[verb.toLowerCase()];
      return `${verb[0] === verb[0].toUpperCase() ? v.charAt(0).toUpperCase() + v.slice(1) : v} I`;
    })
    .replace(/\bwhat it (did|does|found|finds)\b/gi, (_m, verb: string) => `what I ${verb.toLowerCase() === "does" ? "do" : verb.toLowerCase() === "finds" ? "find" : verb.toLowerCase()}`);
}

const INTRO: Record<Tone, (name: string) => string> = {
  warm: (n) => `Hi, I'm ${n}. Happy to help with this.`,
  crisp: (n) => `I'm ${n}. Good to meet you.`,
  playful: (n) => `Hi! I'm ${n}. I like the sound of this one.`,
  calm: (n) => `Hello. I'm ${n}.`,
  wry: (n) => `I'm ${n}. I hear you have a job going.`,
};

const COUNT = ["", "One", "Two", "Three", "Four", "Five"];

const ASK: Record<Tone, (n: number) => string> = {
  warm: () => "A few questions first, so I get it right.",
  crisp: (n) => `${COUNT[n] ?? "A few"} quick question${n === 1 ? "" : "s"}.`,
  playful: () => "Quick questions, then I'm off.",
  calm: () => "A few questions first. Take your time.",
  wry: () => "Just a few questions. I'll keep them short.",
};

const THANKS: Record<Tone, string> = {
  warm: "Thank you. That helps a lot.",
  crisp: "Got it.",
  playful: "Perfect, thanks!",
  calm: "Thanks. That's all I need.",
  wry: "Noted. That wasn't so bad.",
};

const SKIPPED: Record<Tone, string> = {
  warm: "No problem. I'll learn as I go.",
  crisp: "Fine. I'll work it out.",
  playful: "Fair enough! I'll figure it out.",
  calm: "That's fine. I'll learn as I go.",
  wry: "Fine by me. Fewer forms.",
};

const FIRST_DAY: Record<Tone, string> = {
  warm: "Thanks for having me. I'll get started.",
  crisp: "I'm on it.",
  playful: "I'm in! Starting now.",
  calm: "Thank you. I'll start now.",
  wry: "First day. Let's see what's waiting.",
};

const toneOf = (p: Pick<Personality, "tone"> | null | undefined): Tone => (p && p.tone in INTRO ? p.tone : "warm");

export const voice = {
  intro: (p: Personality | null, name: string) => INTRO[toneOf(p)](name),
  ask: (p: Personality | null, count: number) => ASK[toneOf(p)](count),
  thanks: (p: Personality | null) => THANKS[toneOf(p)],
  skipped: (p: Personality | null) => SKIPPED[toneOf(p)],
  /** No questions came back: nothing to ask. */
  ready: () => "I've got what I need.",
  terms: () => "Here's how I'll work. Change anything you like.",
  firstDay: (p: Personality | null) => FIRST_DAY[toneOf(p)],
};

/**
 * When a schedule next fires, from `now`: "today at 17:00", "tomorrow at 9:00",
 * "Friday at 17:00". Null with no schedule trigger. Event triggers have no time.
 */
export function nextRun(triggers: Trigger[], now = new Date(), hour12 = prefers12h()): string | null {
  let best: { at: number; time: string } | null = null;
  for (const t of triggers) {
    if (t.kind !== "schedule" || t.paused) continue;
    const time = t.time ?? "09:00";
    const [hh, mm] = time.split(":").map(Number);
    const days = dayList(t.days);
    const allowed = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
    for (let ahead = 0; ahead < 8; ahead++) {
      const d = new Date(now);
      d.setDate(now.getDate() + ahead);
      d.setHours(hh || 0, mm || 0, 0, 0);
      if (d.getTime() <= now.getTime() || !allowed.includes(d.getDay())) continue;
      if (!best || d.getTime() < best.at) best = { at: d.getTime(), time };
      break;
    }
  }
  if (!best) return null;
  const at = new Date(best.at);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : WEEK.find((w) => w.day === at.getDay())!.long;
  return `${day} at ${clockWords(best.time, hour12)}`;
}

/** The first-day line for when it starts: "First run tomorrow at 9:00" or "Starts when you save a gift idea". */
export function startsLine(triggers: Trigger[], now = new Date(), hour12 = prefers12h()): string {
  const next = nextRun(triggers, now, hour12);
  if (next) return `First run ${next}`;
  const ev = triggers.find((t) => t.kind === "event" && !t.paused);
  if (ev) return `Starts ${lcFirst(triggerSentence(ev, hour12))}`;
  return "Starts when you ask";
}


/**
 * What the first day offers. A scheduled assistant can run now; one that only
 * waits for something to arrive checks what's already there. Both are a run.
 * With both kinds of trigger, it runs.
 */
export function firstGo(triggers: Trigger[]): "run" | "check" {
  const live = triggers.filter((t) => !t.paused);
  if (live.some((t) => t.kind === "schedule")) return "run";
  return live.some((t) => t.kind === "event") ? "check" : "run";
}

const ALREADY_COLLECTED: Record<string, string> = {
  issue: "the issues already assigned to you",
  email: "the email already in your inbox",
  event: "what's already on your calendar",
  "pull-request": "the pull requests already open",
  message: "the messages you already have",
};

/** What a check looks over: "the gift ideas you've already saved". */
export function alreadyThere(triggers: Trigger[]): string {
  const e = triggers.find((t) => t.kind === "event" && !t.paused)?.event;
  if (!e) return "what's already there";
  if (e.source === "collected") return ALREADY_COLLECTED[connectorById(e.connector)?.kind ?? e.kind ?? ""] ?? "what's already come in";
  if (e.source === "saved") return e.savedAction === "gift-idea" || e.savedAction === "gift_idea" ? "the gift ideas you've already saved" : "the links you've already saved";
  return e.tag ? `the notes you've already tagged #${e.tag.replace(/^#/, "")}` : "the notes you've already written";
}
