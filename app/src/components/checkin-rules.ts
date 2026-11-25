/**
 * Check-ins, the pure parts the flow, Today, the day page, Settings and the
 * sample store share: a scale's sentence, where a check-in picks up, the
 * day's pick, which card Today shows, and how an answer reads back. No DOM,
 * no network, so it's tested on its own (checkin-rules.test.ts).
 */

import type { Checkin, CheckinAnswer, CheckinKind, CheckinQuestion, CheckinSettings, CheckinValue, QuestionType, RoutineSettings, ScaleValue } from "../../../lib/checkin-types";
import { MAX_PER_DAY } from "../../../lib/checkin-types";

export const ROUTINE_NAME: Record<CheckinKind, string> = { morning: "Morning preparation", evening: "Evening reflection" };

export const TYPE_NAME: Record<QuestionType, string> = { scale: "Scale", choices: "Words", areas: "Areas", text: "Written" };

/** Settings, under "Your questions": where their answers go (lib/checkin-types.ts ownMirror). */
export const OWN_ANSWERS_WORDS = "Written answers to your questions go into that day's journal, like answers to Athena's written questions. The rest stay in your check-ins.";

/** Writing a question: where its answers go, for the kind of answer picked (lib/checkin-types.ts ownMirror). */
export function ownAnswersWords(type: QuestionType): string {
  return type === "text"
    ? "What you write goes into that day's journal, under the check-in's heading. Change or undo it and the journal follows."
    : "Answers stay in your check-ins. Only written answers go into your journal.";
}

/** The Delete dialog for one of the owner's own questions. */
export const DELETE_OWN_BODY = "It comes out of both check-ins. Answers you've already given stay on their days, and so does anything already copied into your journal.";

/** "Right now I feel" + "energised". Falls back to the ends when a question has no levels. */
export function scaleWords(q: CheckinQuestion, v: ScaleValue): { lead: string; level: string } {
  const level = q.levels?.[v - 1] ?? (v <= 2 ? q.low ?? String(v) : v >= 4 ? q.high ?? String(v) : String(v));
  return { lead: q.lead ?? "", level };
}

export const scaleSentence = (q: CheckinQuestion, v: ScaleValue): string => {
  const { lead, level } = scaleWords(q, v);
  return lead ? `${lead} ${level}` : level;
};

/** The first question in the plan with no answer yet: where the flow opens. plan.length when every one has one. */
export function firstOpen(c: Pick<Checkin, "plan" | "answers">): number {
  const i = c.plan.findIndex((q) => !c.answers[q.id]);
  return i < 0 ? c.plan.length : i;
}

/** How many of the plan's questions still wait. */
export const leftToAnswer = (c: Pick<Checkin, "plan" | "answers">): number => c.plan.filter((q) => !c.answers[q.id]).length;

/** The check-in with this answer in (or out, for null). */
export function withAnswer(c: Checkin, questionId: string, value: CheckinValue | null, at: string): Checkin {
  const answers = { ...c.answers };
  if (value === null) delete answers[questionId];
  else answers[questionId] = { question_id: questionId, value, answered_at: at };
  return { ...c, answers };
}

/** An answer with nothing in it counts as skipped. */
export function isEmptyValue(v: CheckinValue): boolean {
  if ("picks" in v) return v.picks.length === 0;
  if ("text" in v) return !v.text.trim() && !v.deeper?.text?.trim();
  return false;
}

/** An answer as one short line, for the day page. Null for a skip. */
export function answerLine(q: CheckinQuestion, a: CheckinAnswer | undefined): string | null {
  if (!a) return null;
  const v = a.value;
  if ("skipped" in v) return null;
  if ("scale" in v) return scaleSentence(q, v.scale);
  if ("picks" in v) return v.picks.length ? listWords(v.picks) : null;
  return v.text.trim() || null;
}

/** "Calm, Grateful and Tired". */
export function listWords(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * The day's questions (the owner's decision, 17 Nov 2026): pinned ones every
 * day; the rest take turns, least recently asked first, until the count is
 * reached. Asked in the routine's order. `lastAsked` maps a question id to the
 * last date it was in a plan. Questions no longer in the library drop out.
 */
export function pickPlan(routine: RoutineSettings, library: CheckinQuestion[], lastAsked: Record<string, string> = {}): CheckinQuestion[] {
  if (!routine.enabled) return [];
  const byId = new Map(library.map((q) => [q.id, q]));
  const listed = routine.questions.filter((x) => byId.has(x.id));
  const count = Math.max(1, Math.min(MAX_PER_DAY, routine.per_day));
  const chosen = new Set(listed.filter((x) => x.pinned).map((x) => x.id));
  const rest = listed
    .filter((x) => !x.pinned)
    .map((x, i) => ({ id: x.id, i, last: lastAsked[x.id] ?? "" }))
    .sort((a, b) => a.last.localeCompare(b.last) || a.i - b.i);
  for (const r of rest) {
    if (chosen.size >= count) break;
    chosen.add(r.id);
  }
  return listed.filter((x) => chosen.has(x.id)).map((x) => byId.get(x.id)!);
}

/** How many questions a routine asks a day, as set (and never more than it has). */
export const plannedCount = (r: RoutineSettings): number => Math.min(Math.max(1, r.per_day), Math.max(r.questions.length, 1));

/**
 * Which cards Today shows (owner, 17 Nov 2026): a card for each routine
 * that's on, morning first, side by side, at any time of day; a done one
 * stays and says so. The set-up offer when both are off and it hasn't been
 * dismissed.
 */
export type TodayCheckin = { show: "routines"; kinds: CheckinKind[] } | { show: "offer" } | { show: "none" };

export function todayCheckin(settings: Pick<CheckinSettings, "morning" | "evening">, offerDismissed: boolean): TodayCheckin {
  const kinds = (["morning", "evening"] as const).filter((k) => settings[k].enabled);
  if (kinds.length) return { show: "routines", kinds };
  return offerDismissed ? { show: "none" } : { show: "offer" };
}

/** "4 questions", or "2 of 4 left" once started. */
export function cardDetail(total: number, left: number): string {
  if (left < total && left > 0) return `${left} of ${total} left`;
  return `${total} ${total === 1 ? "question" : "questions"}`;
}

/** Checks an own question before it's saved. A sentence for the owner, or null when it's fine. */
export function ownQuestionProblem(q: CheckinQuestion): string | null {
  if (!q.prompt.trim()) return "Write the question first.";
  if (!q.kinds.length) return "Pick morning, evening or both.";
  if (q.type === "scale") {
    if (!q.lead?.trim()) return "Add the start of the sentence, like “Today I feel”.";
    if (!q.levels || q.levels.some((l) => !l.trim())) return "Fill in all five steps.";
  }
  if ((q.type === "choices" || q.type === "areas") && !(q.options ?? []).filter((o) => o.trim()).length) return "Add at least one choice.";
  return null;
}

/** A new own question's id: "own_" and a random part. */
export const ownId = (): string => `own_${Math.random().toString(36).slice(2, 10)}`;

/** Move one item in a list (Settings' up and down). */
export function moved<T>(xs: T[], from: number, to: number): T[] {
  if (to < 0 || to >= xs.length || from === to) return xs;
  const out = [...xs];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
