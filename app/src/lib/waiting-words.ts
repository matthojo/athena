/**
 * The words for what waits on the owner, said once: Home's "Waiting for you"
 * card and To do's line under its title. Three kinds of thing can wait:
 * what the team can't do without approval or an answer (Team chat), what
 * Athena wasn't sure about (Inbox), and to-dos that are due. Each is a short
 * phrase that opens where it's dealt with; with nothing waiting there are no
 * parts and the card stays away.
 */

import { countWord } from "./format";

export interface WaitingCounts {
  /** Posts in Team chat that wait for the owner (team/waiting.ts). */
  team: number;
  /** Suggestions in the Inbox. */
  inbox: number;
  overdue: number;
  dueToday: number;
}

export interface WaitingPart {
  key: "team" | "inbox" | "todo";
  text: string;
  href: string;
  /** Overdue to-dos read as late. */
  tone?: "late";
}

/** "One overdue, one due today." Empty when nothing is due. */
export function dueLine(overdue: number, dueToday: number): string {
  const parts = [overdue ? `${countWord(overdue)} overdue` : "", dueToday ? `${countWord(dueToday, overdue > 0)} due today` : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "";
}

/** The phrases on Home's card, in the order they're said. `teamHref` is the oldest post that waits, when known. */
export function waitingParts(c: WaitingCounts, teamHref = "#/team/chat"): WaitingPart[] {
  const parts: WaitingPart[] = [];
  if (c.team > 0) parts.push({ key: "team", text: `${c.team} from your team`, href: teamHref });
  if (c.inbox > 0) parts.push({ key: "inbox", text: `${c.inbox} in your inbox`, href: "#/review" });
  const due = [c.overdue > 0 ? `${c.overdue} overdue` : "", c.dueToday > 0 ? `${c.dueToday} due today` : ""].filter(Boolean).join(", ");
  if (due) parts.push({ key: "todo", text: due, href: "#/loops", ...(c.overdue > 0 ? { tone: "late" as const } : {}) });
  return parts;
}

/** The card as one sentence, for a screen reader: "Waiting for you: 4 from your team, 7 in your inbox, 1 overdue, 1 due today." */
export function waitingSentence(parts: readonly WaitingPart[]): string {
  return parts.length ? `Waiting for you: ${parts.map((p) => p.text).join(", ")}.` : "";
}
