/**
 * Check-in questions shared and added (lib/checkin-share.ts) in plain words: the share sheet's reach card and
 * findings, and a set's line in Settings. Pure, so the tests can read them without a DOM.
 */
import type { CheckinSet } from "../../../lib/checkin-types";
import { tierIcon, tierWords } from "../community/words";

/** The reach card on the share sheet: always tier 1, with a word on Go deeper when one of them offers it. */
export function shareReachWords(deeper: boolean): { title: string; detail: string; icon: "shield" } {
  const r = { tier: 1 as const, model: false, lookups: [] };
  const base = "Questions only ask, and answers stay in the check-ins of whoever adds them.";
  return { title: tierWords(r), detail: deeper ? `${base} Go deeper reaches their AI model only when they tap it.` : base, icon: tierIcon(r) as "shield" };
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
