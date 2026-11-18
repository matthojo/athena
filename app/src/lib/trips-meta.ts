/**
 * Icons and small display helpers for trips and purchases, shared by Home's
 * Coming up, the Trips and Purchases pages and the Archived page. The words
 * themselves come from lib/trip-text.ts, which the briefing uses too.
 */

import type { IconName } from "../components/icons";
import type { BookingKind, PurchaseStatus } from "../types";

export const BOOKING_ICON: Record<BookingKind, IconName> = {
  flight: "plane",
  train: "train",
  hotel: "bed",
  car: "car",
  event: "ticket",
  other: "suitcase",
};

export const PURCHASE_ICON: Record<PurchaseStatus, IconName> = {
  ordered: "parcel",
  dispatched: "parcel",
  out_for_delivery: "truck",
  delivered: "check",
  delayed: "hourglass",
  returned: "restore",
  refunded: "restore",
  cancelled: "close",
};

/** The four steps the delivery tracker shows. */
export const TRACK_STEPS: { status: PurchaseStatus; label: string }[] = [
  { status: "ordered", label: "Ordered" },
  { status: "dispatched", label: "Dispatched" },
  { status: "out_for_delivery", label: "Out for delivery" },
  { status: "delivered", label: "Delivered" },
];

/** How far along the tracker a status is (a delay sits at Dispatched); -1 when it isn't a delivery any more. */
export function trackIndex(status: PurchaseStatus): number {
  switch (status) {
    case "ordered":
      return 0;
    case "dispatched":
    case "delayed":
      return 1;
    case "out_for_delivery":
      return 2;
    case "delivered":
      return 3;
    default:
      return -1;
  }
}

const NOON = (date: string) => new Date(`${date}T12:00:00Z`);
const LONG_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });

/** "Thursday 12 Nov" */
export const longDay = (date: string): string => LONG_DAY.format(NOON(date));
/** "Thu 12 Nov" */
export const shortWeekday = (date: string): string => SHORT_DAY.format(NOON(date));
/** "Nov" and "12", for a date tile. */
export const monthDay = (date: string): { month: string; day: string } => ({ month: MONTH.format(NOON(date)), day: String(Number(date.slice(8, 10))) });

/** "2h 30m", "45m", "3h". */
export function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const mins = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!(mins > 0) || mins > 36 * 60) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** A web address that's safe to open (http or https), or null. */
export function safeLink(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Directions to an address, in the phone's maps app. */
export const mapsLink = (place: string): string => `https://maps.apple.com/?q=${encodeURIComponent(place)}`;
