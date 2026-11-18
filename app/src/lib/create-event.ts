/**
 * The words and the prefill behind adding an event (components/create-sheet.ts):
 *
 *  - inviteLine: who gets an invite, as a sentence ("Priya and Marcus get an
 *    invite").
 *  - slotBooking: the slot card's "Book it", as the event to confirm.
 *  - bookingAsk: a Check in card about a booking or appointment (a table, the
 *    dentist, a class), as an event with no guests, and its day and time
 *    where the email says them.
 *  - blockAsk: a to-do's "Block time for this": what the block is called and
 *    how long it is.
 *
 * Pure, so each entry point is tested on its own (create-event.test.ts).
 */
import type { CreateInput, CreateKind, SlotCard } from "../db/scheduling";

const first = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").trim().split(/\s+/)[0] || name;

/** "Priya", "Priya and Marcus", "Priya, Marcus and Elena". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The confirm sheet's line about invites. */
export function inviteLine(attendees: Array<{ name: string; email: string }>, kind: CreateKind): string {
  if (kind === "focus") return "On your calendar only. No one is invited.";
  if (!attendees.length) return kind === "booking" ? "Just for you. No one is invited." : "No one is invited.";
  const names = attendees.map((a) => first(a.name || a.email.split("@")[0]));
  return `${namesList(names)} ${names.length === 1 ? "gets" : "get"} an invite.`;
}

/** What a booked slot is called: "Call with Priya and Marcus", or "Meeting with …" when it's longer than 30 minutes. */
export function bookingTitle(card: Pick<SlotCard, "minutes" | "people" | "title">): string {
  const names = card.people.map((p) => first(p.name || p.email.split("@")[0])).filter(Boolean);
  if (!names.length) return card.title;
  return `${card.minutes > 30 ? "Meeting" : "Call"} with ${namesList(names)}`;
}

/** "Book it" on a slot: that time, a plain title, and the people on the card. */
export function slotBooking(card: SlotCard, i: number): CreateInput {
  const s = card.slots[i];
  return {
    kind: "meeting",
    // A card about something in particular ("Pricing tiers") keeps its own title.
    title: /^A \d+ (min|hour)/.test(card.title) ? bookingTitle(card) : card.title,
    start: s.start,
    end: s.end,
    who: card.people.map((p) => ({ name: p.name, ...(p.email ? { email: p.email } : {}) })),
  };
}

// ---------- Check in: bookings and appointments ----------

/** Words that mean the email confirms a booking or an appointment. */
const BOOKED =
  /\b(booking|booked|reservation|reserved|appointment|table for \d+|your table|check-?up|dentist|dental|hygienist|doctor'?s?|gp\b|physio\w*|optician|haircut|barber|hairdresser|vet\b|massage|class\b|lesson|session at|tickets? for|confirmed for)\b/i;
/** Not a booking: Check in's "Suggest times" covers meeting requests. */
const ASKING = /\b(could we|can we|shall we|would you|are you free|find a time|grab \d+|let me know when)\b/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000));

/** The day the words name, on or after `today` (YYYY-MM-DD): "12 November", "Nov 12", "Friday", "tomorrow", "14/11". */
export function dayIn(words: string, today: string): string | null {
  const t = words.toLowerCase();
  if (/\btoday\b|\btonight\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const year = Number(today.slice(0, 4));
  const ymd = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const pick = (m: number, d: number) => {
    if (!(m >= 0 && m < 12 && d >= 1 && d <= 31)) return null;
    let y = year;
    let out = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (out < today) out = `${++y}-${out.slice(5)}`;
    return out;
  };
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
  if (dm) return pick(MONTHS.indexOf(dm[2]), Number(dm[1]));
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (md) return pick(MONTHS.indexOf(md[1]), Number(md[2]));
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/.exec(t);
  if (slash) return pick(Number(slash[2]) - 1, Number(slash[1]));
  const wd = new RegExp(`\\b(?:(next)\\s+)?(${DAYS.join("|")})\\b`).exec(t);
  if (wd) {
    const want = DAYS.indexOf(wd[2]);
    const now = new Date(`${today}T12:00:00Z`).getUTCDay();
    let ahead = (want - now + 7) % 7;
    if (wd[1] && ahead < 7) ahead += ahead === 0 ? 7 : 0;
    return addDays(today, ahead);
  }
  return null;
}

/** The time the words name, as HH:MM: "7:30pm", "19:30", "at 3pm", "at noon". */
export function timeIn(words: string): string | null {
  const t = words.toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(t)) return "12:00";
  const ampm = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(t);
  if (ampm) {
    let hh = Number(ampm[1]) % 12;
    if (ampm[3] === "pm") hh += 12;
    return `${String(hh).padStart(2, "0")}:${ampm[2] ?? "00"}`;
  }
  const h24 = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(t);
  if (h24) return `${h24[1].padStart(2, "0")}:${h24[2]}`;
  return null;
}

/** How long, from what it is: a meal 90 minutes, an appointment 30, a class an hour. */
export function bookingMinutes(words: string): number {
  // "We'll hold it for 15 minutes" is how long they wait, not how long it lasts.
  const t = words.toLowerCase().replace(/\b(hold|held|keep|kept|wait|late)\b[^.!?]*/g, "");
  const said = /\b(\d{2,3})[\s-]*(?:mins?|minutes?)\b/.exec(t);
  if (said) return Math.min(480, Math.max(10, Number(said[1])));
  const hours = /\b(\d)[\s-]*hours?\b/.exec(t);
  if (hours) return Math.min(8, Number(hours[1])) * 60;
  if (/\b(table|dinner|lunch|brunch|restaurant|reservation)\b/.test(t)) return 90;
  if (/\b(tickets?|theatre|theater|concert|gig|show|play|film|cinema)\b/.test(t)) return 150;
  if (/\b(dentist|dental|hygienist|doctor|gp|optician|check-?up|vet|haircut|barber)\b/.test(t)) return 30;
  return 60;
}

/** A place the words name after "at": "Table for 4 at Dishoom King's Cross". */
function placeIn(words: string): string | undefined {
  const m = /\bat\s+((?:the\s+)?[A-Z][\w'’&-]*(?:\s+[A-Z][\w'’&-]*){0,4})/.exec(words);
  const place = m?.[1]?.trim();
  if (!place || /^(the\s+)?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Noon)$/i.test(place)) return undefined;
  return place;
}

/**
 * Check in's "Add to calendar": a card whose words confirm a booking or an
 * appointment, as the event to confirm. No guests, ever. The start is the
 * day and time the words give; without a time it's 09:00 that day, and
 * without a day it's tomorrow, for the owner to fix in the sheet.
 */
export function bookingAsk(s: { summary: string; source_quote?: string | null; payload?: Record<string, unknown> | null }, today: string, at: (date: string, time: string) => string): (CreateInput & { known: { day: boolean; time: boolean } }) | null {
  const words = `${s.summary} ${s.source_quote ?? ""}`;
  if (!BOOKED.test(words) || ASKING.test(words)) return null;
  const p = s.payload ?? {};
  const payloadDay = [p.date, p.due_on, p.starts_on].find((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
  const payloadAt = [p.starts_at, p.start].find((v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)));
  const day = payloadDay ?? dayIn(words, today);
  const payloadTime = typeof p.time === "string" && /^\d{2}:\d{2}$/.test(p.time) ? p.time : null;
  const time = payloadTime ?? timeIn(words);
  const minutes = bookingMinutes(words);
  const start = payloadAt ?? at(day ?? addDays(today, 1), time ?? "09:00");
  const title = (typeof p.title === "string" && p.title.trim() ? p.title : s.summary).trim().replace(/[.\s]+$/, "").slice(0, 200);
  const location = typeof p.location === "string" && p.location.trim() ? p.location.trim() : placeIn(s.summary) ?? placeIn(s.source_quote ?? "");
  return {
    kind: "booking",
    title,
    start: new Date(Date.parse(start)).toISOString(),
    minutes,
    ...(location ? { location } : {}),
    known: { day: !!(payloadAt || day), time: !!(payloadAt || time) },
  };
}

// ---------- To-dos: block time ----------

/** "Block time for this": the to-do's title, an hour unless it says how long, before it's due. */
export function blockAsk(c: { title: string; notes?: string | null; due_on?: string | null }): { title: string; minutes: number; due: string | null } {
  const words = `${c.title} ${c.notes ?? ""}`;
  const said = /\b(\d{2,3})[\s-]*(?:mins?|minutes?)\b/i.exec(words);
  const hours = /\b(\d{1,2}(?:\.5)?)[\s-]*(?:h|hours?)\b/i.exec(words);
  const minutes = said ? Math.min(240, Math.max(15, Number(said[1]))) : hours ? Math.min(240, Math.round(Number(hours[1]) * 60)) : 60;
  return { title: c.title.trim().slice(0, 200), minutes, due: c.due_on ?? null };
}
