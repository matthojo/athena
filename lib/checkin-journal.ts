/**
 * Check-ins in the day's journal (the `day_journal` mirror): pure, so the server (lib/checkins.ts, lib/days.ts) and
 * sample mode build and swap a check-in's section the same way.
 *
 * Each check-in keeps one section in the day's journal: its heading (CHECKIN_HEADINGS), then each written answer
 * under its prompt. The section is found again by its exact text and swapped, so saving the same answer twice changes
 * nothing, an undone answer comes back out, and the owner's own text is never touched. A written question the owner
 * wrote, or one from a shared set, is copied in the same way: Athena gives it the `day_journal` mirror
 * (lib/checkin-types.ts ownMirror). The plan keeps each question as it was asked, so a day planned before that rule
 * keeps its answers out of the journal, and removing a set later leaves past days' sections alone.
 */
import { MAX_JOURNAL_CHARS } from "./day-types";
import type { CheckinAnswer, CheckinKind, CheckinQuestion } from "./checkin-types";

/** The journal section's heading for each check-in. */
export const CHECKIN_HEADINGS: Record<CheckinKind, string> = { morning: "Morning preparation", evening: "Evening reflection" };

/** A check-in's section for the day's journal: its heading, then each written answer under its prompt. Null: nothing written. Pure. */
export function journalSection(kind: CheckinKind, s: { plan: readonly CheckinQuestion[]; answers: Readonly<Record<string, CheckinAnswer>> }): string | null {
  const pairs: string[] = [];
  for (const q of s.plan) {
    if (q.mirror !== "day_journal") continue;
    const v = s.answers[q.id]?.value;
    if (!v || !("text" in v)) continue;
    pairs.push(`${q.prompt}\n${v.text}`);
    if (v.deeper?.text) pairs.push(`${v.deeper.question}\n${v.deeper.text}`);
  }
  return pairs.length ? `${CHECKIN_HEADINGS[kind]}\n${pairs.join("\n\n")}` : null;
}

/**
 * A journal with one check-in's section swapped: `was` (the section as Athena last wrote it) is
 * replaced by `now`, or taken out with the blank line that kept it apart. When `was` isn't there
 * (never written, or the owner changed it, which makes it theirs), `now` goes at the end. The
 * owner's text is never touched. A section that won't fit in MAX_JOURNAL_CHARS is cut short to
 * fit; `section` is what was written (null: nothing). Pure.
 */
export function swapJournalSection(journal: string | null | undefined, was: string | null, now: string | null): { journal: string; section: string | null } {
  const have = journal ?? "";
  const at = was ? have.indexOf(was) : -1;
  let before = at >= 0 ? have.slice(0, at) : have;
  let after = at >= 0 ? have.slice(at + was!.length) : "";
  if (!now) {
    if (at < 0) return { journal: have, section: null };
    if (before.endsWith("\n\n")) before = before.slice(0, -2);
    else if (after.startsWith("\n\n")) after = after.slice(2);
    else if (!before.trim()) after = after.replace(/^\n+/, "");
    return { journal: before + after, section: null };
  }
  if (at < 0) {
    before = before.trimEnd();
    if (before) before += "\n\n";
  }
  const room = MAX_JOURNAL_CHARS - before.length - after.length;
  const section = (now.length > room ? now.slice(0, Math.max(0, room)) : now).trimEnd();
  if (!section) return swapJournalSection(have, was, null);
  return { journal: before + section + after, section };
}
