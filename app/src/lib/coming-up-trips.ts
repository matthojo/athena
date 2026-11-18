/**
 * Trips and parcels for Home's Coming up. Home loads this module after its
 * first paint (views/home.ts), so the trips data, wording and sample data stay
 * out of the entry chunk: each trip's next booking this week, and parcels
 * arriving or out for delivery, worked out on this device in its own zone.
 */

import { icons } from "../components/icons";
import { loadPurchases, loadTrips, onLogisticsChange } from "../db/trips";
import { dayLabel } from "./format";
import { deviceZone, localToday } from "./time";
import { BOOKING_ICON, PURCHASE_ICON } from "./trips-meta";
import { bookingName, bookingStart, deliveriesComingUp, travelComingUp } from "../../../lib/trip-text";

export { onLogisticsChange };

/** One Coming up row, built by Home's own row builder so it matches the rest of the card. */
export type ComingUpItem = (lead: Node, title: string, sub: string, run: () => void, tone?: "late" | "today") => HTMLElement;

export interface ComingUpLogistics {
  travel: number;
  parcels: number;
  /** At most three of each. */
  rows: (item: ComingUpItem, tile: (icon: Node) => HTMLElement, open: { trip: (id: string) => void; purchase: (id: string) => void }) => HTMLElement[];
}

export async function loadComingUpLogistics(): Promise<ComingUpLogistics> {
  const [{ items: trips }, { items: purchases }] = await Promise.all([loadTrips(), loadPurchases()]);
  const today = localToday();
  const travel = travelComingUp(trips, today, new Date(), 6).slice(0, 3);
  const parcels = deliveriesComingUp(purchases, today, deviceZone(), 6).slice(0, 3);
  return {
    travel: travel.length,
    parcels: parcels.length,
    rows: (item, tile, open) => [
      // A journey: its next booking, in the local time of where it happens.
      ...travel.map((t) => {
        const s = bookingStart(t.booking);
        const clock = s.time ? `${s.time}${s.tz && s.tz !== deviceZone() && s.city ? ` ${s.city} time` : ""}` : "";
        const sub = [dayLabel(t.days_until, t.date), clock, s.place].filter(Boolean).join(" · ");
        return item(tile(icons[BOOKING_ICON[t.booking.kind]]()), bookingName(t.booking), sub, () => open.trip(t.trip.id));
      }),
      ...parcels.map(({ purchase: p, state }) =>
        item(
          tile(icons[PURCHASE_ICON[p.status]]()),
          p.items[0] ? (p.items.length > 1 ? `${p.items[0]} and ${p.items.length - 1} more` : p.items[0]) : `Order from ${p.retailer}`,
          `${state.label} · ${p.retailer}`,
          () => open.purchase(p.id),
          state.tone === "late" ? "late" : state.tone === "today" ? "today" : undefined
        )
      ),
    ],
  };
}
