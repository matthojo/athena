/**
 * Check-in questions shared and added (lib/checkin-share.ts) in plain words: the share sheet's reach card and
 * findings, and a set's line in Settings. Pure, so the tests can read them without a DOM.
 */
import type { CheckinSet } from "../../../lib/checkin-types";
import { tierIcon, tierWords } from "../community/words";

/** The reach card on the share sheet: the tier by the name Community gives it, then why. */
export function shareReachWords(model: boolean): { title: string; detail: string; icon: "shield" | "sparkle" } {
  const r = { tier: (model ? 2 : 1) as 1 | 2, model, lookups: [] };
  if (!model) return { title: tierWords(r), detail: "Questions only ask, and answers stay in the Athena of whoever adds them. Nothing is sent anywhere.", icon: tierIcon(r) as "shield" };
  return { title: tierWords(r), detail: "One of them offers Go deeper. When whoever adds them taps it, the question and what they wrote go to the AI model they chose.", icon: tierIcon(r) as "sparkle" };
}

/** "In the name", "In question 2", "In questions 1 and 3, and the summary": where a finding is. */
export function questionWhereWords(where: readonly string[]): string {
  const nums = [...new Set(where.filter((w) => w.startsWith("question:")).map((w) => Number(w.slice(9))))].sort((a, b) => a - b);
  const rest = [...new Set(where.filter((w) => !w.startsWith("question:")))].map((w) => `the ${w}`);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const parts = [...(nums.length ? [`${nums.length === 1 ? "question" : "questions"} ${list(nums.map(String))}`] : []), ...rest];
  return `In ${parts.length > 1 && nums.length > 1 ? `${parts[0]}, and ${list(parts.slice(1))}` : list(parts)}`;
}

/** The line over the findings. */
export function shareFindingsLede(n: number): string {
  if (!n) return "Nothing is flagged. Athena checked for your people, places, contact details and private links. Read them through yourself before you share them.";
  return `${n === 1 ? "This looks like one" : "These look like some"} of your own details. Change ${n === 1 ? "it" : "them"} in the question, or mark ${n === 1 ? "it" : "each one"} fine to share.`;
}

/** "4 questions · From Community · By @quiet-desk": a set's line in Settings. */
export function setMetaWords(set: Pick<CheckinSet, "catalogue_id" | "author">, count: number): string {
  return [count === 1 ? "1 question" : count ? `${count} questions` : "No questions left", set.catalogue_id ? "From Community" : "From a file", set.author ? `By @${set.author}` : null].filter(Boolean).join(" · ");
}

/** Under a set's switch. */
export const setSwitchWords = (paused: boolean): string => (paused ? "Switched off. Its questions wait until you switch it back on." : "Its questions take their turns with yours.");

/** A question's line in a routine, when it came from a set. */
export const fromSetWords = (name: string, paused: boolean): string => (paused ? `From ${name}, switched off` : `From ${name}`);

/** Settings, over the sets: where their answers go (lib/checkin-share.ts sharedMirror), and what removing one keeps. */
export const SETS_ANSWERS_WORDS = "Written answers to these questions go into that day's journal, as your answers to Athena's own written questions do. Other answers stay in your check-ins. Removing a set doesn't change anything already in your journal.";

/** The Remove dialog for a set. */
export const removeSetBody = "Its questions come out of both check-ins. Answers you've already given stay on their days, and so does anything already copied into your journal.";
