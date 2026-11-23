/** How nudges say times, days and names. Owner's zone, British English, no model. */
import { zonedParts } from "../dates";
import { firstNameOf } from "../nudges";

export { firstNameOf };

/**
 * "14:00", "09:30": a time in a nudge. The server can't see the device's
 * 12/24-hour setting, so everything it writes is 24-hour "HH:MM", like the
 * briefing and the rest of lib/.
 */
export function hhmm(iso: string, tz: string): string {
  const { hour, minute } = zonedParts(new Date(iso), tz);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The same "HH:MM", under the name the rules use for an event's start. */
export const clock = hhmm;

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayOf = (date: string) => WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()];

/** "3 November". */
export const dayMonth = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

/** "on Tuesday" within the last six days, else "on 3 November". */
export function onDay(date: string, today: string): string {
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return days > 0 && days < 7 ? `on ${weekdayOf(date)}` : `on ${dayMonth(date)}`;
}

/** "Priya", "Priya and Tom", "Priya, Tom and Sam". */
export function names(list: string[]): string {
  const xs = list.map(firstNameOf);
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "1h 30m", "45m", "5h". */
export function duration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const numberWord = (n: number) => NUMBER[n] ?? String(n);

/** One line of quoted text, cut at a word. */
export function clip(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}
