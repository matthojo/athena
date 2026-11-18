// GET /api/travel/live, the real path: the route, travelLive, National Rail's and TfL's clients (live-travel.ts) and OpenSky's
// (live-flights.ts), with only the network stubbed (globalThis.fetch: the providers' documented or recorded answers) and the
// database's three reads given (the bookings, the owner's zone and their usual lines).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zonedToInstant } from "../../lib/dates";
import type { Booking } from "../../lib/trips";
import type { TravelLive } from "../../lib/travel-day";
import { clearLiveCache, commuteDisruptions } from "./live-travel";
import { clearFlightCache } from "./live-flights";
import { handleTravelRoutes } from "./travel-day-routes";

const fixture = (p: string) => readFileSync(new URL(`../../lib/fixtures/${p}`, import.meta.url), "utf8");
const DAY = "2026-11-09";
const at = (t: string, tz = "Europe/London") => zonedToInstant(DAY, t, tz).toISOString();

const base = { trip_id: "00000000-0000-4000-8000-000000000001", status: "confirmed", provider: "", segment: "", start_date: DAY, start_tz: "Europe/London", end_date: DAY, end_tz: "Europe/London", seat: "", details: "", email_link: "", previous_starts_at: null, archived_at: null } as unknown as Booking;
const TRAIN = { ...base, id: "00000000-0000-4000-8000-000000000011", kind: "train", title: "GWR to Bristol", reference: "GW7HQ2LM", starts_at: at("07:10"), ends_at: at("08:46"), start_place: "London Paddington", start_city: "London", end_place: "Bristol Temple Meads", end_city: "Bristol" } as Booking;
const FLIGHT = { ...base, id: "00000000-0000-4000-8000-000000000012", kind: "flight", title: "BA 550", reference: "K7Q2XB", seat: "14A", starts_at: at("10:40"), ends_at: at("13:20", "Europe/Lisbon"), end_tz: "Europe/Lisbon", start_place: "Heathrow T5", start_city: "London", end_place: "Lisbon Airport T1", end_city: "Lisbon" } as Booking;
const HOTEL = { ...base, id: "00000000-0000-4000-8000-000000000013", kind: "hotel", title: "Memmo Alfama", reference: "4471", starts_at: at("15:00", "Europe/Lisbon"), start_place: "Lisbon", start_city: "Lisbon", end_place: "", end_city: "Lisbon" } as Booking;
const ALL = new Map([TRAIN, FLIGHT, HOTEL].map((b) => [b.id, b]));

const realFetch = globalThis.fetch;
let asked: URL[] = [];

beforeEach(() => {
  clearLiveCache();
  clearFlightCache();
  asked = [];
  process.env.ATHENA_RDM_KEY = "rdm-test";
  process.env.ATHENA_TFL_KEY = "tfl-test";
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(input);
    asked.push(url);
    const body = url.host === "api1.raildata.org.uk" ? fixture("rdm-departures-pad-bri.json") : url.host === "api.tfl.gov.uk" ? fixture("tfl-line-status.json") : url.host === "opensky-network.org" ? fixture("recorded/opensky-states-lhr.json") : null;
    return body ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : new Response("", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ATHENA_RDM_KEY;
  delete process.env.ATHENA_TFL_KEY;
});

const deps = (now: string) => ({
  now: new Date(at(now)),
  getBooking: async (id: string) => ALL.get(id) ?? null,
  tz: async () => "Europe/London",
  commute: () => commuteDisruptions(["elizabeth", "jubilee"]),
});

async function get(path: string, now: string): Promise<{ status: number; body: TravelLive & { error?: string } }> {
  const url = new URL(`https://athena.example${path}`);
  const req = new Request(url);
  const res = await handleTravelRoutes(req, url, url.pathname.split("/").slice(1), (d, s = 200) => new Response(JSON.stringify(d), { status: s }), deps(now));
  assert.ok(res, "the route answers");
  return { status: res.status, body: (await res.json()) as TravelLive & { error?: string } };
}

test("later that morning: the train gone, the flight departed (OpenSky), the hotel with nothing, and the owner's lines", async () => {
  const { status, body } = await get(`/api/travel/live?ids=${TRAIN.id},${FLIGHT.id},${HOTEL.id}`, "10:50");
  assert.equal(status, 200);
  assert.equal(body.flights, "opensky");
  // The 07:10 left over an hour ago: past its window, so nobody asked National Rail.
  assert.equal(body.live[TRAIN.id], null);
  assert.ok(!asked.some((u) => u.host === "api1.raildata.org.uk"));
  const flight = body.live[FLIGHT.id];
  assert.ok(flight && flight.kind === "flight");
  assert.deepEqual([flight.status.state, flight.status.provider, flight.status.gate], ["departed", "opensky", null]);
  assert.equal(body.live[HOTEL.id], null);
  assert.deepEqual(body.lines.map((l) => `${l.name}: ${l.description}`), ["Elizabeth line: part suspended"]);
  // Nothing personal left Athena: no reference, seat or booking id in any request.
  for (const url of asked) for (const secret of ["GW7HQ2LM", "K7Q2XB", "14A", "BAW550", TRAIN.id, FLIGHT.id]) assert.ok(!url.toString().includes(secret), `${url.host} got no ${secret}`);
});

test("the train an hour before it leaves: 12 min late from platform 4, as the board says", async () => {
  const { body } = await get(`/api/travel/live?ids=${TRAIN.id}`, "06:10");
  const train = body.live[TRAIN.id];
  assert.ok(train && train.kind === "train");
  assert.deepEqual([train.status.state, train.status.late, train.status.platform, train.status.expected], ["late", 12, "4", "07:22"]);
});

test("before OpenSky can see the plane: the flight is null and nothing is asked", async () => {
  const { body } = await get(`/api/travel/live?ids=${FLIGHT.id}`, "09:00");
  assert.equal(body.live[FLIGHT.id], null);
  assert.ok(!asked.some((u) => u.host === "opensky-network.org"));
});

test("bad requests are refused before anything is asked", async () => {
  assert.equal((await get("/api/travel/live", "08:00")).status, 400);
  assert.equal((await get("/api/travel/live?ids=nope", "08:00")).status, 400);
  const nine = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
  assert.equal((await get(`/api/travel/live?ids=${nine}`, "08:00")).status, 400);
  const url = new URL("https://athena.example/api/travel/other");
  assert.equal(await handleTravelRoutes(new Request(url), url, ["", "travel", "other"], () => new Response()), null);
  assert.equal(asked.length, 0);
});
