/**
 * Note templates shared and added (lib/template-share.ts) in plain words: the share sheet's reach card, intro and
 * findings, an added template's line in the template list and editor, and a day's "Start from a template". Pure, so
 * the tests can read them without a DOM.
 */
import { tierIcon, tierWords } from "../community/words";

/** The reach card on the share sheet: always tier 1. */
export function templateReachWords(): { title: string; detail: string; icon: "shield" } {
  const r = { tier: 1 as const, model: false, lookups: [] };
  return { title: tierWords(r), detail: "Its fields fill in from the records of whoever uses it, in their own Athena.", icon: tierIcon(r) as "shield" };
}

export const TEMPLATE_SHARE_INTRO = "A file anyone can add to their own templates. Only this template's words go. Notes you made from it stay here.";

/** "In the name", "In the words", "In the summary and the words": where a finding is. */
export function templateWhereWords(where: readonly string[]): string {
  const names: Record<string, string> = { name: "the name", summary: "the summary", body: "the words" };
  const parts = [...new Set(where)].map((w) => names[w] ?? `the ${w}`);
  return `In ${parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
}

/** The line over the findings. */
export function templateFindingsLede(n: number): string {
  if (!n) return "Nothing is flagged. Athena checked for your people, places, contact details and private links. Read it through yourself before you share it.";
  return `${n === 1 ? "This looks like one" : "These look like some"} of your own details. Change ${n === 1 ? "it" : "them"} in the template, or mark ${n === 1 ? "it" : "each one"} fine to share.`;
}

/** "By @kind-margins · version 1.0", "From a file": an added template's line in the editor. Pure. */
export function sharedByWords(s: { author: string | null; version: string | null; catalogue_id: string | null }): string {
  const who = s.author ? `Shared by @${s.author}` : s.catalogue_id ? "Shared through Community" : "Shared from a file";
  return [who, s.version ? `version ${s.version}` : null].filter(Boolean).join(" · ");
}

/** Under an added template's origin in the editor: what changing it means. */
export function sharedChangeWords(changed: boolean): string {
  return changed ? "You've changed it, so it's yours now. A new version from Community would go beside it." : "Someone else wrote it. Change it as you like: a new version from Community never overwrites your changes.";
}

/** The picker's tag on an added template. */
export const SHARED_TAG = "Shared";

// ---------- a day's journal ----------

/** The templates a journal can start from: the owner's own and those they added, not Athena's starters. Pure. */
export const journalTemplates = <T extends { starter: string | null }>(all: readonly T[]): T[] => all.filter((t) => !t.starter);

/** The quiet choice under an empty journal. */
export const START_LABEL = "Start from a template";

/** The sheet's lede, its empty state, and the toasts. Pure. */
export const startWords = {
  title: "Start from a template",
  lede: "Your journal starts with its headings and questions. Dates fill in with this day's.",
  empty: "Templates you write, or add from Community, show here.",
  browse: "Browse templates",
  failed: "Templates didn't load. Check you're online and try again.",
  /** Toasts. */
  started: (name: string) => `Started from ${name}`,
  notEmpty: "You've started writing, so your words stay as they are.",
  undone: "Back to an empty page",
  undoKept: "You've written since, so your words stay as they are.",
} as const;
