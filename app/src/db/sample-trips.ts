/**
 * Sample trips and purchases, so sample mode shows the whole feature: a trip
 * to Lisbon that starts today (the Heathrow Express to the airport, a flight
 * whose time changed, car hire and a hotel: the Travelling today strip, with
 * live times through the morning from sampleTravelLive), a fado night and
 * the flight home; a train trip later in the month, a day trip to Bristol,
 * a past weekend in Paris; and parcels in every state — out for delivery
 * today, arriving later this week, delayed, just ordered, delivered and
 * refunded. Same rules as sample-data.ts: stable ids, dates relative to today.
 */

import { addDays, zonedParts, zonedToInstant } from "../../../lib/dates";
import type { TrainStatus } from "../../../lib/live-travel-text";
import type { FlightStatus } from "../../../lib/flight-text";
import type { TravelLive } from "../../../lib/travel-day";
import { localToday } from "../lib/time";
import type { Booking, BookingKind, Purchase, PurchaseStatus, PurchaseUpdate, Trip } from "../types";

const id = (n: number) => `7a1b0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const at = (date: string, time: string, tz: string) => zonedToInstant(date, time, tz).toISOString();

const LONDON = "Europe/London";
const LISBON = "Europe/Lisbon";
const PARIS = "Europe/Paris";

function booking(trip: string, n: number, b: Partial<Booking> & Pick<Booking, "kind" | "title" | "start_date">): Booking {
  return {
    id: id(100 + n),
    trip_id: trip,
    status: "confirmed",
    provider: "",
    reference: "",
    segment: "",
    starts_at: null,
    start_tz: LONDON,
    start_place: "",
    start_city: "",
    end_date: null,
    ends_at: null,
    end_tz: "",
    end_place: "",
    end_city: "",
    seat: "",
    details: "",
    email_link: "https://mail.google.com/mail/#inbox",
    previous_starts_at: null,
    cancelled_at: null,
    cancel_email_link: "",
    source: "email-digest",
    source_ref: null,
    confidence: 0.95,
    archived_at: null,
    created_at: daysAgo(12),
    updated_at: daysAgo(2),
    ...b,
  };
}

function timed(kind: BookingKind, date: string, time: string, tz: string, end?: { date: string; time: string; tz: string }) {
  return {
    kind,
    start_date: date,
    starts_at: at(date, time, tz),
    start_tz: tz,
    ...(end ? { end_date: end.date, ends_at: at(end.date, end.time, end.tz), end_tz: end.tz } : {}),
  };
}

export function sampleTrips(): Trip[] {
  const today = localToday();
  const d = (n: number) => addDays(today, n);
  const lisbon = id(1);
  const edinburgh = id(2);
  const paris = id(3);
  const trip = (tid: string, title: string, bookings: Booking[], age: number): Trip => {
    const live = bookings.filter((b) => b.status !== "cancelled");
    const starts = live.map((b) => b.start_date).sort();
    const ends = live.map((b) => b.end_date ?? b.start_date).sort();
    return { id: tid, title, starts_on: starts[0], ends_on: ends[ends.length - 1], notes: "", source: "email-digest", archived_at: null, created_at: daysAgo(age), updated_at: daysAgo(2), bookings };
  };
  return [
    trip(
      lisbon,
      "Lisbon",
      [
        // Today: the train to the airport, the flight, the car and the hotel (the Travelling today strip, components/travel-today.ts).
        booking(lisbon, 6, {
          ...timed("train", d(0), "08:10", LONDON, { date: d(0), time: "08:31", tz: LONDON }),
          title: "Heathrow Express to Heathrow",
          provider: "Heathrow Express",
          reference: "HX4Q7N2P",
          segment: "outbound",
          start_place: "London Paddington",
          start_city: "London",
          end_place: "Heathrow Terminal 5",
          end_city: "London",
          details: "Express Saver, any train today",
        }),
        booking(lisbon, 1, {
          ...timed("flight", d(0), "10:40", LONDON, { date: d(0), time: "13:20", tz: LISBON }),
          title: "BA 432",
          provider: "British Airways",
          reference: "K7Q2XB",
          segment: "outbound",
          status: "changed",
          previous_starts_at: at(d(0), "10:10", LONDON),
          start_place: "Heathrow T5",
          start_city: "London",
          end_place: "Lisbon Airport T1",
          end_city: "Lisbon",
          seat: "14A",
          details: "1 cabin bag, 1 checked bag",
        }),
        booking(lisbon, 2, {
          ...timed("car", d(0), "14:15", LISBON, { date: d(3), time: "16:00", tz: LISBON }),
          title: "Hertz",
          provider: "Hertz",
          reference: "H-55210",
          start_place: "Lisbon Airport, arrivals hall",
          start_city: "Lisbon",
          end_place: "Lisbon Airport",
          end_city: "Lisbon",
          details: "Compact, automatic",
        }),
        booking(lisbon, 3, {
          ...timed("hotel", d(0), "15:00", LISBON, { date: d(3), time: "11:00", tz: LISBON }),
          title: "Memmo Alfama",
          provider: "Booking.com",
          reference: "4471 2290",
          start_place: "Travessa das Merceeiras 27, Lisbon",
          start_city: "Lisbon",
          end_city: "Lisbon",
          details: "Double room with a river view, 2 guests",
        }),
        booking(lisbon, 4, {
          ...timed("event", d(1), "21:00", LISBON),
          title: "Fado at Clube de Fado",
          provider: "Clube de Fado",
          reference: "CF-8812",
          start_place: "Rua de São João da Praça 94, Lisbon",
          start_city: "Lisbon",
          details: "Table for 2, dinner from 20:00",
        }),
        booking(lisbon, 5, {
          ...timed("flight", d(3), "18:05", LISBON, { date: d(3), time: "20:40", tz: LONDON }),
          title: "BA 437",
          provider: "British Airways",
          reference: "K7Q2XB",
          segment: "return",
          start_place: "Lisbon Airport T1",
          start_city: "Lisbon",
          end_place: "Heathrow T5",
          end_city: "London",
          seat: "21C",
        }),
      ],
      12
    ),
    trip(
      edinburgh,
      "Edinburgh",
      [
        booking(edinburgh, 11, {
          ...timed("train", d(24), "08:00", LONDON, { date: d(24), time: "12:20", tz: LONDON }),
          title: "LNER to Edinburgh",
          provider: "LNER",
          reference: "TL4K88QW",
          segment: "outbound",
          start_place: "London King's Cross",
          start_city: "London",
          end_place: "Edinburgh Waverley",
          end_city: "Edinburgh",
          seat: "Coach K, seat 32",
        }),
        booking(edinburgh, 12, {
          ...timed("hotel", d(24), "15:00", LONDON, { date: d(26), time: "11:00", tz: LONDON }),
          title: "The Balmoral",
          provider: "The Balmoral",
          reference: "BAL-30917",
          start_place: "1 Princes Street, Edinburgh",
          start_city: "Edinburgh",
          end_city: "Edinburgh",
        }),
        booking(edinburgh, 13, {
          ...timed("train", d(26), "17:30", LONDON, { date: d(26), time: "21:52", tz: LONDON }),
          title: "LNER to London",
          provider: "LNER",
          reference: "TL4K88QW",
          segment: "return",
          start_place: "Edinburgh Waverley",
          start_city: "Edinburgh",
          end_place: "London King's Cross",
          end_city: "London",
          seat: "Coach K, seat 32",
        }),
      ],
      3
    ),
    trip(
      paris,
      "Paris",
      [
        booking(paris, 21, {
          ...timed("train", d(-38), "08:01", LONDON, { date: d(-38), time: "11:20", tz: PARIS }),
          title: "Eurostar 9014",
          provider: "Eurostar",
          reference: "PNRX42",
          segment: "outbound",
          start_place: "London St Pancras",
          start_city: "London",
          end_place: "Paris Gare du Nord",
          end_city: "Paris",
          seat: "Coach 7, seat 61",
        }),
        booking(paris, 22, {
          ...timed("hotel", d(-38), "15:00", PARIS, { date: d(-36), time: "11:00", tz: PARIS }),
          title: "Hôtel des Grands Boulevards",
          reference: "HGB-1188",
          start_place: "17 Boulevard Poissonnière, Paris",
          start_city: "Paris",
          end_city: "Paris",
        }),
        booking(paris, 23, {
          ...timed("train", d(-36), "19:13", PARIS, { date: d(-36), time: "20:30", tz: LONDON }),
          title: "Eurostar 9055",
          provider: "Eurostar",
          reference: "PNRX42",
          segment: "return",
          start_place: "Paris Gare du Nord",
          start_city: "Paris",
          end_place: "London St Pancras",
          end_city: "London",
          seat: "Coach 7, seat 62",
        }),
      ],
      60
    ),
    bristolDayTrip(),
  ];
}

/** The sample train to the airport (the Lisbon trip, today at 08:10). */
const AIRPORT_TRAIN = id(106);
const LISBON_FLIGHT = id(101);

/** The Bristol day trip's train: 07:10, twelve days from now. */
function sampleDeparture(): { date: string; time: string } {
  return { date: addDays(localToday(), 12), time: "07:10" };
}

/** "08:10", the sample train to the airport, so the sample briefing names the same train as the strip. */
export function sampleTrainTime(): string {
  return "08:10";
}

function bristolDayTrip(): Trip {
  const bristol = id(4);
  const go = sampleDeparture();
  const leaves = zonedToInstant(go.date, go.time, LONDON);
  const arrives = new Date(leaves.getTime() + 96 * 60_000);
  const back = zonedParts(new Date(leaves.getTime() + 8 * 3_600_000), LONDON);
  const backArrives = new Date(zonedToInstant(back.date, back.time, LONDON).getTime() + 99 * 60_000);
  const outbound = booking(bristol, 31, {
    kind: "train",
    start_date: go.date,
    starts_at: leaves.toISOString(),
    start_tz: LONDON,
    end_date: zonedParts(arrives, LONDON).date,
    ends_at: arrives.toISOString(),
    end_tz: LONDON,
    title: "GWR to Bristol",
    provider: "Great Western Railway",
    reference: "GW7HQ2LM",
    segment: "outbound",
    start_place: "London Paddington",
    start_city: "London",
    end_place: "Bristol Temple Meads",
    end_city: "Bristol",
    seat: "Coach B, seat 32",
    created_at: daysAgo(6),
  });
  const ret = booking(bristol, 32, {
    kind: "train",
    start_date: back.date,
    starts_at: zonedToInstant(back.date, back.time, LONDON).toISOString(),
    start_tz: LONDON,
    end_date: zonedParts(backArrives, LONDON).date,
    ends_at: backArrives.toISOString(),
    end_tz: LONDON,
    title: "GWR to London",
    provider: "Great Western Railway",
    reference: "GW7HQ2LM",
    segment: "return",
    start_place: "Bristol Temple Meads",
    start_city: "Bristol",
    end_place: "London Paddington",
    end_city: "London",
    seat: "Coach B, seat 41",
    created_at: daysAgo(6),
  });
  return {
    id: bristol,
    title: "Bristol",
    starts_on: go.date,
    ends_on: ret.end_date,
    notes: "",
    source: "email-digest",
    archived_at: null,
    created_at: daysAgo(6),
    updated_at: daysAgo(1),
    bookings: [outbound, ret],
  };
}

/** Minutes past local midnight in London, now. */
const londonMinutes = (now: Date) => {
  const [hh, mm] = zonedParts(now, LONDON).time.split(":").map(Number);
  return hh * 60 + mm;
};

/**
 * Live times for sample mode, so the strip and the Trips card show them
 * without a key, and change through the morning as a real day would: the
 * train to Heathrow is on time until 07:40, then 12 minutes late from
 * platform 7. Every other booking has none.
 */
export function sampleTrainStatus(b: Pick<Booking, "id" | "starts_at">, now = new Date()): TrainStatus | null {
  if (b.id !== AIRPORT_TRAIN || !b.starts_at) return null;
  const left = Date.parse(b.starts_at) - now.getTime();
  if (left > 3 * 3_600_000 || left < -30 * 60_000) return null;
  const scheduled = zonedParts(new Date(b.starts_at), LONDON).time;
  const late = londonMinutes(now) >= 7 * 60 + 40;
  return {
    from: "PAD",
    to: "HWV",
    scheduled,
    expected: late ? zonedParts(new Date(Date.parse(b.starts_at) + 12 * 60_000), LONDON).time : null,
    late: late ? 12 : 0,
    state: late ? "late" : "on_time",
    platform: late ? "7" : null,
    destination: "Heathrow Terminal 5",
    reason: late ? "This train has been delayed by a fault with the signalling system" : null,
    checked_at: now.toISOString(),
  };
}

/**
 * BA 432 as OpenSky would see it: nothing while it's at the gate, departed
 * once it's in the air (10:52, twelve minutes after its time), landed at 13:20.
 * OpenSky has no gates; the terminal comes from the booking.
 */
export function sampleFlightStatus(b: Pick<Booking, "id" | "starts_at" | "ends_at">, now = new Date()): FlightStatus | null {
  if (b.id !== LISBON_FLIGHT || !b.starts_at || !b.ends_at) return null;
  const t = now.getTime();
  const leaves = Date.parse(b.starts_at);
  const lands = Date.parse(b.ends_at);
  if (t > lands + 45 * 60_000) return null;
  const base: FlightStatus = { provider: "opensky", flight: "BA 432", state: "departed", late: 0, scheduled: zonedParts(new Date(leaves), LONDON).time, expected: null, arrives: null, gate: null, terminal: null, belt: null, checked_at: now.toISOString() };
  if (t >= lands) return { ...base, state: "landed" };
  if (t >= leaves + 12 * 60_000) return base;
  return null;
}

/** GET /api/travel/live in sample mode: the two above, and the Elizabeth line part suspended (as the sample briefing says). */
export function sampleTravelLive(bookings: Booking[], now = new Date()): TravelLive {
  const live: TravelLive["live"] = {};
  for (const b of bookings) {
    const train = b.kind === "train" ? sampleTrainStatus(b, now) : null;
    const flight = b.kind === "flight" ? sampleFlightStatus(b, now) : null;
    live[b.id] = train ? { kind: "train", status: train } : flight ? { kind: "flight", status: flight } : null;
  }
  return {
    live,
    lines: [{ id: "elizabeth", name: "Elizabeth line", severity: 3, description: "part suspended", reason: "No service between Paddington and Heathrow while engineers fix a signal." }],
    flights: "opensky",
    checked_at: now.toISOString(),
  };
}

export function samplePurchases(): Purchase[] {
  const today = localToday();
  const d = (n: number) => addDays(today, n);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || LONDON;
  const step = (n: number, status: PurchaseStatus, date: string, time: string, detail = ""): PurchaseUpdate => ({
    id: id(400 + n),
    status,
    at: at(date, time, tz),
    detail,
    email_link: "https://mail.google.com/mail/#inbox",
  });
  const purchase = (n: number, p: Partial<Purchase> & Pick<Purchase, "retailer" | "items" | "status" | "updates">): Purchase => {
    const last = p.updates[p.updates.length - 1];
    return {
      id: id(300 + n),
      order_number: "",
      ordered_on: p.updates[0] ? p.updates[0].at.slice(0, 10) : today,
      status_at: last?.at ?? new Date().toISOString(),
      expected_on: null,
      delivered_at: null,
      carrier: "",
      tracking_number: "",
      tracking_url: "",
      email_link: "https://mail.google.com/mail/#inbox",
      source: "email-digest",
      source_ref: null,
      confidence: 0.95,
      archived_at: null,
      created_at: p.updates[0]?.at ?? new Date().toISOString(),
      updated_at: last?.at ?? new Date().toISOString(),
      ...p,
    };
  };
  return [
    purchase(1, {
      retailer: "Amazon",
      items: ["Kindle Paperwhite"],
      order_number: "202-8841937-5520413",
      status: "out_for_delivery",
      expected_on: today,
      carrier: "Royal Mail",
      tracking_number: "RM482915563GB",
      tracking_url: "https://www.royalmail.com/track-your-item",
      updates: [
        step(1, "ordered", d(-3), "20:14"),
        step(2, "dispatched", d(-1), "16:40", "Handed to Royal Mail"),
        step(3, "out_for_delivery", today, "07:05", "Arriving between 10:00 and 14:00"),
      ],
    }),
    purchase(2, {
      retailer: "IKEA",
      items: ["KALLAX shelf unit", "Desk lamp"],
      order_number: "IK-1155-0287",
      status: "dispatched",
      expected_on: d(2),
      carrier: "DPD",
      tracking_number: "15501234567890",
      tracking_url: "https://track.dpd.co.uk",
      updates: [step(4, "ordered", d(-4), "11:02"), step(5, "dispatched", d(-1), "09:15", "Two parcels")],
    }),
    purchase(3, {
      retailer: "Runners Need",
      items: ["Trail running shoes"],
      order_number: "RN-77310",
      status: "delayed",
      expected_on: d(3),
      carrier: "Evri",
      tracking_number: "H00YA1234567890",
      updates: [
        step(6, "ordered", d(-5), "18:30"),
        step(7, "dispatched", d(-3), "12:00"),
        step(8, "delayed", d(-1), "08:45", "Held at the depot. New delivery day is a little later"),
      ],
    }),
    purchase(4, {
      retailer: "Hay",
      items: ["Ceramic mugs, set of 4"],
      order_number: "HAY-200931",
      status: "ordered",
      updates: [step(9, "ordered", today, "08:12")],
    }),
    purchase(5, {
      retailer: "John Lewis",
      items: ["Noise-cancelling headphones"],
      order_number: "JL-58821004",
      status: "delivered",
      carrier: "DPD",
      tracking_number: "15509876543210",
      delivered_at: at(d(-3), "12:41", tz),
      updates: [
        step(10, "ordered", d(-6), "21:05"),
        step(11, "dispatched", d(-5), "10:30"),
        step(12, "out_for_delivery", d(-3), "07:20"),
        step(13, "delivered", d(-3), "12:41", "Left with a neighbour at number 12"),
      ],
    }),
    purchase(6, {
      retailer: "Uniqlo",
      items: ["Merino jumper"],
      order_number: "UQ-4410982",
      status: "refunded",
      updates: [step(14, "ordered", d(-21), "13:00"), step(15, "delivered", d(-18), "11:10"), step(16, "returned", d(-12), "17:00"), step(17, "refunded", d(-10), "09:00")],
    }),
  ];
}
