/**
 * What a suggestion in the review inbox would change when it's accepted, if
 * that's something already saved: the order a delivery email moves on, the
 * booking a changed time updates, the detail a new value replaces. The Inbox
 * reads it to say "Update status" rather than "Add to Purchases".
 *
 * Worked out when the Inbox is listed (lib/suggestion-target-db.ts), never
 * stored: what's saved can change while a suggestion waits.
 *
 * Pure: no database, so the app uses it too.
 */

export interface SuggestionTarget {
  id: string;
  /** Its name, for a to-do, event, person or booking. */
  name?: string;
  /** Where an order or booking has got to now ("dispatched", "confirmed"). */
  status?: string;
  /** The value a detail has now, which accepting replaces. */
  value?: string;
}
