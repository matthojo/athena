/**
 * Team setup's draft, kept on this device (docs/team.md: "A draft in
 * progress is kept on the device"). Closing the sheet keeps it; adding the
 * assistant clears it. Anything unreadable or older than two weeks is
 * dropped. Storage can be missing (private windows), so every call is safe.
 */
import type { AvatarSpec, Personality, TeamQuestion, TeamTriggerInput } from "../../../lib/team-types";

/** 0 the job, in your words · 1 the conversation: it introduces itself, asks its questions and sets out how it'll work. */
export type SetupStep = 0 | 1;
/** Shuffle's locks on the reveal. "look" keeps the whole character; the wardrobe has the per-part locks. */
export type SetupLock = "name" | "personality" | "look";

export interface SetupDraft {
  v: 1;
  step: SetupStep;
  /** The owner's own sentence, as typed. */
  text: string;
  /** The sentence the draft below was made from: a changed sentence drafts again. */
  draftedFrom: string | null;
  name: string;
  job: string;
  instructions: string;
  triggers: TeamTriggerInput[];
  /** The switches offered, and which are on. */
  offered: string[];
  allow: string[];
  /** The draft said the job needs something online (`TeamDraft.web`): the terms offer it, switched on. */
  webSuggested: boolean;
  /** Can look things up online: on when suggested, until you turn it off. */
  web: boolean;
  seed: string | null;
  avatar: AvatarSpec | null;
  personality: Personality | null;
  locks: SetupLock[];
  /** Setup's questions for this job (none: the step is skipped), and the answers by question id. */
  questions: TeamQuestion[];
  answers: Record<string, string>;
  /** How many questions it has asked so far (answered or passed over). */
  asked: number;
  /** You skipped the rest of the questions. */
  skipped: boolean;
  savedAt: number;
}

const KEY = "athena.team.setup";
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;

export function emptyDraft(text = ""): SetupDraft {
  return { v: 1, step: 0, text, draftedFrom: null, name: "", job: "", instructions: "", triggers: [], offered: [], allow: [], webSuggested: false, web: false, seed: null, avatar: null, personality: null, locks: [], questions: [], answers: {}, asked: 0, skipped: false, savedAt: Date.now() };
}

export function loadSetup(now = Date.now()): SetupDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SetupDraft>;
    if (d?.v !== 1 || typeof d.text !== "string" || now - Number(d.savedAt) > MAX_AGE) return null;
    const base = emptyDraft();
    const questions = Array.isArray(d.questions) ? d.questions : [];
    // Drafts from the five-step setup: any step past the first is the conversation, and past
    // the questions step (2 and on, or 1 and on before questions existed) means they were all asked.
    const oldStep = Number(d.step) || 0;
    const step: SetupStep = oldStep > 0 ? 1 : 0;
    const pastQuestions = typeof d.asked !== "number" && (Array.isArray(d.questions) ? oldStep >= 2 : oldStep >= 1);
    const asked = typeof d.asked === "number" ? Math.max(0, Math.min(questions.length, Math.floor(d.asked))) : pastQuestions ? questions.length : 0;
    const merged: SetupDraft = { ...base, ...d, step, questions, asked, skipped: d.skipped === true, answers: d.answers && typeof d.answers === "object" ? d.answers : {}, triggers: Array.isArray(d.triggers) ? d.triggers : [], offered: Array.isArray(d.offered) ? d.offered : [], allow: Array.isArray(d.allow) ? d.allow : [], webSuggested: d.webSuggested === true, web: d.webSuggested === true && d.web === true, locks: readLocks(d.locks) };
    // A step past the first needs a draft to stand on.
    if (!merged.seed || !merged.avatar) merged.step = 0;
    return merged;
  } catch {
    return null;
  }
}

/** A draft saved before the locks were merged may hold per-part locks: any of them means the look was kept. */
function readLocks(raw: unknown): SetupLock[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<SetupLock>();
  for (const p of raw) out.add(p === "name" || p === "personality" ? p : "look");
  return [...out];
}

export function saveSetup(d: SetupDraft): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch {
    /* storage full or blocked: the draft lives as long as the sheet */
  }
}

export function clearSetup(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Something worth coming back to: more than an empty first step. */
export function hasProgress(d: SetupDraft | null): boolean {
  return !!d && (d.text.trim().length > 0 || d.step > 0);
}
