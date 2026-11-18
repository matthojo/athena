/**
 * How Home's briefing card frames the morning's note. The briefing is
 * written at 07:30 and opens with a greeting ("Morning, Alex. The 09:15 to
 * Bristol…"). From 18:00, when the headline says "Good evening", the card
 * looks back instead: it's labelled as this morning's, and the line is shown
 * as a quote from then, so it doesn't read as a second greeting.
 *
 * Uses the headline's own rule (phaseAt), so the two turn at the same minute.
 */
import { phaseAt } from "../components/day-words";

export interface BriefingFrame {
  /** The eyebrow or title over the card: "Today's briefing" or "This morning's briefing". */
  label: string;
  /** The writer's line as shown: as written by day, in quotation marks in the evening. Null without one. */
  line: string | null;
  /** The card's accessible name. */
  ariaLabel: string;
  /** True from 18:00, when the card looks back at the morning. */
  lookingBack: boolean;
}

/** Wraps a line in curly quotes, dropping any the writer already put round it. */
export function quoteLine(line: string): string {
  const bare = line.trim().replace(/^["“]+|["”]+$/g, "");
  return `“${bare}”`;
}

export function briefingFrame(now: Date, voice: string | null, title: string): BriefingFrame {
  const lookingBack = phaseAt(now) === "evening";
  const label = lookingBack ? "This morning's briefing" : "Today's briefing";
  const line = voice ? (lookingBack ? quoteLine(voice) : voice) : null;
  return { label, line, ariaLabel: `Open ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${voice ?? title}`, lookingBack };
}
