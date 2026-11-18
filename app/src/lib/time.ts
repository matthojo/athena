/**
 * Time as this device sees it. Instants come from the server in UTC; dates
 * without a time (birthdays, all-day events) are plain calendar dates. Every
 * "today", day and HH:MM in the app goes through here, so it's in whatever
 * time zone the device is in right now.
 */

import { browserTimeZone, localWhen, zonedToday, type DatedThing } from "../../../lib/dates";

/** The device's IANA time zone, e.g. "Europe/Paris". */
export const deviceZone = (): string => browserTimeZone();

/** Today's date here, "YYYY-MM-DD". */
export const localToday = (at: Date = new Date()): string => zonedToday(at, deviceZone());

/** An event's day and start time here (timed one-offs from their UTC start). */
export const whenLocal = (e: DatedThing): { date: string; time: string | null } => localWhen(e, deviceZone());

/** "Paris" from "Europe/Paris", for small hints. */
export function zoneLabel(tz: string = deviceZone()): string {
  return tz.split("/").pop()!.replace(/_/g, " ");
}
