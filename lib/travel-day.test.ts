// Travelling today: legs, the strip's window, when it asks again, and the words (lib/travel-day.ts, lib/flight-text.ts, lib/airports.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedToInstant } from "./dates";
import type { TrainStatus } from "./live-travel-text";
import { airportFor, callsignFor, flightNumberIn, terminalIn } from "./airports";
import { bookingFlight, flightBriefingLine, flightCandidate, flightChip, flightLiveLine, flightPush, flightStatusReport, type FlightStatus } from "./flight-text";
import { legKind, legView, liveLegs, nextRefresh, REFRESH_MS, stripPhase, stripWindow, travelLegs, travelledLine, tubeLine, type TravelBooking } from "./travel-day";

const TZ = "Europe/London";
const DAY = "2026-11-09";
const at = (time: string, date = DAY, tz = TZ) => zonedToInstant(date, time, tz).toISOString();
const clock = (time: string) => new Date(at(time));

let n = 0;
function booking(over: Partial<TravelBooking>): TravelBooking {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    trip_id: "00000000-0000-4000-8000-999999999999",
    kind: "train",
    status: "confirmed",
    title: "",
    provider: "",
    reference: "",
    start_date: DAY,
    starts_at: null,
    start_tz: TZ,
    start_place: "",
    start_city: "",
    end_date: DAY,
    ends_at: null,
    end_tz: TZ,
    end_place: "",
    end_city: "",
    seat: "",
    ...over,
  };
}

const train = booking({ kind: "train", title: "GWR to Bristol", reference: "GW7HQ2LM", starts_at: at("07:10"), ends_at: at("08:46"), start_place: "London Paddington", start_city: "London", end_place: "Bristol Temple Meads", end_city: "Bristol" });
const flight = booking({ kind: "flight", title: "BA 432", reference: "K7Q2XB", starts_at: at("10:40"), ends_at: at("13:20", DAY, "Europe/Lisbon"), end_tz: "Europe/Lisbon", start_place: "Heathrow T5", start_city: "London", end_place: "Lisbon Airport T1", end_city: "Lisbon" });
const car = booking({ kind: "car", title: "Hertz", reference: "H-55210", starts_at: at("14:15", DAY, "Europe/Lisbon"), start_tz: "Europe/Lisbon", start_place: "Lisbon Airport, arrivals hall", start_city: "Lisbon" });
const hotel = booking({ kind: "hotel", title: "Memmo Alfama", reference: "4471 2290", starts_at: at("15:00", DAY, "Europe/Lisbon"), start_tz: "Europe/Lisbon", start_place: "Travessa das Merceeiras 27, Lisbon", start_city: "Lisbon" });
const show = booking({ kind: "event", title: "Fado", starts_at: at("21:00", DAY, "Europe/Lisbon"), start_tz: "Europe/Lisbon" });
const tomorrow = booking({ kind: "train", title: "LNER", starts_at: at("09:00", "2026-11-10") });
const trip = { id: "t", title: "Lisbon", starts_on: DAY, ends_on: "2026-11-12", bookings: [hotel, show, flight, car, train, tomorrow] };

const lateTrain: TrainStatus = { from: "PAD", to: "BRI", scheduled: "07:10", expected: "07:22", late: 12, state: "late", platform: "4", destination: "Bristol Temple Meads", reason: null, checked_at: at("06:50") };
// A status with every field filled, as a provider with schedules would give: the words cover them all.
const onTime: FlightStatus = { provider: "opensky", flight: "BA 432", state: "on_time", late: 0, scheduled: "10:40", expected: null, arrives: null, gate: "B32", terminal: "5", belt: null, checked_at: at("09:20") };

test("airports and flight numbers: names, codes and callsigns", () => {
  assert.equal(airportFor("Heathrow T5")?.iata, "LHR");
  assert.equal(airportFor("Lisbon Airport T1")?.iata, "LIS");
  assert.equal(airportFor("", "Lisbon")?.icao, "LPPT");
  assert.equal(airportFor("London (LGW)")?.iata, "LGW");
  assert.equal(airportFor("Somewhere small"), null);
  assert.equal(terminalIn("Heathrow T5"), "5");
  assert.equal(terminalIn("Gatwick North Terminal"), null);
  assert.deepEqual(flightNumberIn("BA 432"), { airline: "BA", number: "432", label: "BA 432", compact: "BA432" });
  assert.equal(flightNumberIn("Flight EZY8001 to Nice")?.label, "U2 8001");
  assert.equal(flightNumberIn("Your trip to Lisbon"), null);
  assert.equal(callsignFor(flightNumberIn("BA 0432")!), "BAW432");
  assert.equal(bookingFlight(flight)?.label, "BA 432");
});

test("legs: the day's travel in time order, events and other days left out", () => {
  const legs = travelLegs([trip], DAY, TZ);
  assert.deepEqual(
    legs.map((l) => l.kind),
    ["train", "flight", "car", "hotel"],
  );
  assert.equal(legKind({ kind: "other", title: "National Express to Bristol", provider: "" }), "coach");
  assert.equal(legKind({ kind: "other", title: "Portsmouth to Caen", provider: "Brittany Ferries" }), "ferry");
  assert.equal(legKind({ kind: "other", title: "Spa day", provider: "" }), null);
  assert.equal(travelLegs([{ ...trip, archived_at: "2026-11-01" }], DAY, TZ).length, 0);
});

test("the strip shows from 05:00 (or 3 hours before an early first leg) until the last leg is in", () => {
  const legs = travelLegs([trip], DAY, TZ);
  const w = stripWindow(legs, DAY, TZ)!;
  assert.equal(new Date(w.from).toISOString(), at("04:10"));
  assert.equal(new Date(w.until).toISOString(), at("15:00", DAY, "Europe/Lisbon"));
  assert.equal(stripPhase(legs, DAY, TZ, clock("03:00")), "before");
  assert.equal(stripPhase(legs, DAY, TZ, clock("04:10")), "travelling");
  assert.equal(stripPhase(legs, DAY, TZ, clock("15:01")), "travelled");
  assert.equal(stripPhase([], DAY, TZ, clock("09:00")), "none");
  // A late first leg: the strip still shows from the morning.
  const late = travelLegs([{ ...trip, bookings: [hotel] }], DAY, TZ);
  assert.equal(new Date(stripWindow(late, DAY, TZ)!.from).toISOString(), at("05:00"));
});

test("live windows and refresh: every 2½ minutes while a leg is live, else wait for the next window, else stop", () => {
  const legs = travelLegs([trip], DAY, TZ);
  // 03:30: nothing live; the train's window opens at 04:10.
  assert.equal(liveLegs(legs, clock("03:30")).length, 0);
  assert.equal(nextRefresh(legs, clock("03:30")), 40 * 60_000);
  // 07:00: the train is live; the flight isn't yet (it opens at 07:40).
  assert.deepEqual(
    liveLegs(legs, clock("07:00")).map((l) => l.kind),
    ["train"],
  );
  assert.equal(nextRefresh(legs, clock("07:00")), REFRESH_MS);
  // 07:50: the train has gone (window ends 30 min after it leaves), the flight is live.
  assert.deepEqual(
    liveLegs(legs, clock("07:50")).map((l) => l.kind),
    ["flight"],
  );
  // After the flight's window (45 min after landing) nothing is asked again today.
  assert.equal(nextRefresh(legs, clock("14:30")), null);
  assert.equal(flightCandidate(flight, clock("07:39")), false);
  assert.equal(flightCandidate(flight, clock("07:40")), true);
  assert.equal(flightCandidate({ ...flight, status: "cancelled" }, clock("09:00")), false);
  assert.equal(flightCandidate({ ...flight, title: "Flight to Lisbon" }, clock("09:00")), false);
});

test("a leg in words: the lines the strip, the screen reader and Ask read", () => {
  const legs = travelLegs([trip], DAY, TZ);
  const [t, f, c, h] = legs;
  const tv = legView(t, { kind: "train", status: lateTrain }, clock("06:50"), TZ);
  assert.equal(tv.line, "07:10 to Bristol · 12 min late · platform 4");
  assert.equal(tv.title, "GWR to Bristol");
  assert.deepEqual([tv.from, tv.to, tv.expected, tv.where, tv.reference], ["London Paddington", "Bristol Temple Meads", "07:22", "Platform 4", "GW7HQ2LM"]);
  assert.deepEqual(tv.chip, { label: "12 min late", tone: "warn", title: "National Rail, checked at 06:50" });

  const fv = legView(f, { kind: "flight", status: onTime }, clock("09:20"), TZ);
  assert.equal(fv.line, "BA 432 to Lisbon · on time · gate B32 · terminal 5");
  assert.equal(fv.where, "Gate B32 · Terminal 5");
  assert.equal(fv.chip?.title, "OpenSky, checked at 09:20");

  // Before its window: when live times start. In it with nothing known: says so plainly.
  assert.equal(legView(f, undefined, clock("06:00"), TZ).note, "Live times from 07:40");
  const none = legView(f, null, clock("09:00"), TZ);
  assert.equal(none.note, "Live times unavailable");
  assert.equal(none.line, "BA 432 to Lisbon · live times unavailable");

  assert.equal(legView(c, undefined, clock("09:00"), TZ).from, "Pick up at Lisbon Airport, arrivals hall");
  const hv = legView(h, undefined, clock("09:00"), TZ);
  assert.equal(hv.from, "Check in at Travessa das Merceeiras 27, Lisbon");
  assert.equal(hv.line, "15:00 check in at Memmo Alfama");
  assert.equal(legView(t, undefined, clock("09:00"), TZ).past, true);

  // Cancelled by email: struck through with its chip, whatever the board says.
  const gone = legView({ ...t, booking: { ...t.booking, status: "cancelled" } }, undefined, clock("06:00"), TZ);
  assert.equal(gone.cancelled, true);
  assert.equal(gone.chip?.label, "Cancelled");
});

test("flight chips, push, briefing and Ask's answer", () => {
  assert.deepEqual(flightChip(onTime), { label: "On time", tone: "good" });
  assert.deepEqual(flightChip({ ...onTime, state: "late", late: 25 }), { label: "25 min late", tone: "warn" });
  assert.deepEqual(flightChip({ ...onTime, state: "departed" }), { label: "Departed", tone: "calm" });
  assert.deepEqual(flightChip({ ...onTime, state: "cancelled" }), { label: "Cancelled", tone: "bad" });
  assert.equal(flightLiveLine(flight, onTime), "BA 432 to Lisbon: on time, gate B32, terminal 5");
  assert.equal(flightLiveLine(flight, { ...onTime, state: "landed", arrives: "13:12", belt: "7" }), "BA 432 to Lisbon: landed 13:12, belt 7");
  assert.equal(flightLiveLine(flight, { ...onTime, state: "departed", arrives: "13:20" }), "BA 432 to Lisbon: departed, lands 13:20");
  assert.deepEqual(flightPush(flight, { ...onTime, state: "late", late: 25, expected: "11:05" }, TZ), {
    title: "Flight BA 432 to Lisbon",
    body: "BA 432 to Lisbon: 25 min late, gate B32, terminal 5 · departs 11:05 · ref K7Q2XB",
  });
  // Without live times, the push as it was.
  assert.equal(flightPush(flight, null, TZ).body, "Departs 10:40 · Heathrow T5 · ref K7Q2XB");
  assert.equal(flightBriefingLine(flight, onTime), "BA 432 Heathrow to Lisbon at 10:40: on time, gate B32, terminal 5, ref K7Q2XB");
});

test("flight_status answers with live lines, or why not", async () => {
  const report = await flightStatusReport([{ ...flight, id: "b1" }, { ...flight, id: "b2", title: "Flight to Lisbon" }], {
    now: clock("09:20"),
    today: DAY,
    tz: TZ,
    provider: "opensky",
    lookup: async () => null,
  });
  const rows = report.flights as Array<Record<string, unknown>>;
  assert.equal(rows[0].why, "OpenSky has nothing on this flight right now. It sees a plane once it's moving, from 45 minutes before it's due to leave.");
  assert.equal(rows[1].why, "There's no flight number on this booking.");
  assert.equal(report.source_note, "OpenSky has no gates. The terminal is the one on the booking.");
  const live = await flightStatusReport([{ ...flight, id: "b1" }], { now: clock("09:20"), today: DAY, tz: TZ, provider: "opensky", lookup: async () => onTime });
  assert.equal((live.flights as Array<Record<string, unknown>>)[0].live, "BA 432 to Lisbon: on time, gate B32, terminal 5");
  assert.equal((await flightStatusReport([], { now: clock("09:20"), today: DAY, tz: TZ, provider: "opensky", lookup: async () => null })).flights_note, "No flights in the next 24 hours.");
});

test("the day's summary and the Tube line", () => {
  const legs = travelLegs([trip], DAY, TZ);
  assert.equal(travelledLine(legs), "GWR to Bristol, BA 432 to Lisbon, Hertz car hire and Memmo Alfama.");
  assert.equal(tubeLine([]), null);
  assert.equal(tubeLine([{ id: "elizabeth", name: "Elizabeth line", severity: 3, description: "part suspended", reason: null }]), "Elizabeth line: part suspended");
});

test("the briefing words a flight with live times, and a train as before", async () => {
  const { travelLine } = await import("./briefing");
  assert.equal(travelLine(flight, DAY, TZ, { [flight.id]: onTime }), "BA 432 Heathrow to Lisbon at 10:40: on time, gate B32, terminal 5, ref K7Q2XB");
  assert.equal(travelLine(train, DAY, TZ, { [train.id]: lateTrain }), "07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4, ref GW7HQ2LM");
  assert.equal(travelLine(flight, DAY, TZ, {}), "Flight BA 432 to Lisbon today 10:40 from Heathrow T5, ref K7Q2XB");
});
