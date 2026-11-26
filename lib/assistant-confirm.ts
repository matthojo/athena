/**
 * What Ask's assistant may not do on its own: answer
 * an invite, save a draft to Gmail or Outlook, or send a note to Google
 * Docs or Notion. Each of those tools now only prepares a card; the app
 * shows it and acts when the owner taps, through the same routes the rest
 * of the app uses (POST /api/events/:id/rsvp, POST /api/drafts, POST
 * /api/documents). Nothing leaves Athena from a model turn alone, the way
 * move_event and create_event already work (lib/assistant-scheduling.ts).
 *
 * Logging from a sentence waits the same way:
 * spending, health figures, a day's entry or a meter reading is saved only
 * when the owner taps Add or Save (lib/ask-logging.ts LogCard).
 */
import type { MessageDraft } from "./drafts";
import { logWords, type LogCard } from "./ask-logging";

/**
 * `Draft` is the draft as the holder sees it: the server's MessageDraft here, the app's own (which allows
 * for drafts kept from before a field existed) in app/src/types.ts.
 */
export type ConfirmCard<Draft = MessageDraft> =
  /** answer_invite: nothing is saved or sent until the owner taps the answer. */
  | {
      kind: "rsvp";
      event_id: string;
      title: string;
      /** When it is, for the card: the instant for a timed event, else its date. */
      starts_at: string | null;
      date: string;
      answer: "going" | "maybe" | "declined";
      /** Only after the owner said "all of them" to a repeating invite. */
      series?: boolean;
      /** "Google Calendar" when the answer will be sent there; null when it stays in Athena. */
      sends_to: string | null;
    }
  /** draft_message, an email with a Drafts account: written, not saved anywhere. The owner reads it and saves it. */
  | { kind: "draft"; draft: Draft; title: string; to: string; drafts_in: string }
  /** send_note: nothing is made in Google Docs or Notion until the owner taps Send. */
  | { kind: "send_note"; note_id: string; title: string; to: "google-docs" | "notion"; updates: boolean }
  /** log_spending, log_health, log_day_entry, log_meter_reading: nothing is saved until the owner taps it. */
  | LogCard;

/** What the model is told after any of them, so it never claims the thing is done. */
export const WAITING = "Ready for the owner to confirm in the app. Nothing has been sent or saved yet: say it's ready to confirm, never that it's done.";

const firstName = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];
const DOCS = { "google-docs": "Google Docs", notion: "Notion" } as const;

/** "Fri 13 Nov, 10:00" for a timed event (in `tz`, or the device's zone), "Fri 13 Nov" for a day. */
function when(card: Extract<ConfirmCard<unknown>, { kind: "rsvp" }>, tz?: string): string {
  const day = (d: Date, timeZone?: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(d).replace(",", "");
  if (card.starts_at) {
    const d = new Date(card.starts_at);
    return `${day(d, tz)}, ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(d)}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(card.date) ? day(new Date(`${card.date}T12:00:00Z`), "UTC") : "";
}

/** What each card says in the app (components/ask-confirm.ts): its title, the line under it, the button, and its name for screen readers. */
export function confirmWords(card: ConfirmCard<unknown>, tz?: string): { title: string; meta: string; action: string; label: string } {
  if (card.kind === "rsvp") {
    const says = card.answer === "going" ? "Going" : card.answer === "maybe" ? "Maybe" : "Declined";
    const where = card.sends_to ? `goes to ${card.sends_to}${card.series ? ", every date" : ""}` : "stays in Athena";
    return { title: card.title, meta: [when(card, tz), `${says} · ${where}`].filter(Boolean).join(" · "), action: card.answer === "declined" ? "Decline" : says, label: `Answer ${card.title}: ${says}` };
  }
  if (card.kind === "log_spending" || card.kind === "log_health" || card.kind === "log_entry" || card.kind === "log_reading") return logWords(card);
  if (card.kind === "draft") {
    return { title: card.title, meta: `Email to ${firstName(card.to)} · not in ${card.drafts_in} Drafts yet`, action: "Read…", label: `Email to ${card.to}, waiting for you` };
  }
  const where = DOCS[card.to];
  return { title: card.title, meta: card.updates ? `Updates the copy in ${where}` : `Makes a new ${card.to === "notion" ? "page" : "doc"} in ${where}`, action: card.updates ? "Update" : "Send", label: `Send ${card.title} to ${where}` };
}
