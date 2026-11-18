// Live flights (netlify/lib/live-flights.ts): OpenSky's answer read into a status, the cache, rate limits, what leaves Athena, and the provider seam.
// OpenSky's answer is a real one, recorded around Heathrow on 9 Nov 2026 (lib/fixtures/recorded/opensky-states-lhr.json).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zonedToInstant } from "../../lib/dates";
import type { TravelBooking } from "../../lib/travel-day";
import type { FlightStatus } from "../../lib/flight-text";
import { clearFlightCache, findState, flightStatus, readOpenSky, type FlightProvider } from "./live-flights";

const OPENSKY = JSON.parse(readFileSync(new URL("../../lib/fixtures/recorded/opensky-states-lhr.json", import.meta.url), "utf8")) as unknown;

const DAY = "2026-11-09";
const at = (t: string, tz = "Europe/London") => zonedToInstant(DAY, t, tz).toISOString();
const clock = (t: string) => new Date(at(t));

const flight = (over: Partial<TravelBooking> = {}): TravelBooking => ({
  id: "00000000-0000-4000-8000-000000000101",
  trip_id: "00000000-0000-4000-8000-000000000001",
  kind: "flight",
  status: "confirmed",
  title: "BA 432",
  provider: "British Airways",
  reference: "K7Q2XB",
  start_date: DAY,
  starts_at: at("10:40"),
  start_tz: "Europe/London",
  start_place: "Heathrow T5",
  start_city: "London",
  end_date: DAY,
  ends_at: at("13:20", "Europe/Lisbon"),
  end_tz: "Europe/Lisbon",
  end_place: "Lisbon Airport T1",
  end_city: "Lisbon",
  seat: "14A",
  ...over,
});

function stub(answer: (url: URL, init?: RequestInit) => Response) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return answer(url, init);
  };
  return { fetch, calls };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => clearFlightCache());

test("OpenSky: the recorded answer, read by callsign", () => {
  assert.deepEqual(findState(OPENSKY, "BAW550"), { onGround: false, speed: 49.9, seenAt: 1794210815000 });
  assert.equal(findState(OPENSKY, "BAW960")?.onGround, true);
  assert.equal(findState(OPENSKY, "BAW432"), null);
  assert.equal(findState({ states: null }, "BAW550"), null);
  assert.equal(findState("nonsense", "BAW550"), null);
});

test("OpenSky: what a sighting means, by where and when", () => {
  const ctx = { flight: "BA 432", leaves: Date.parse(at("10:40")), scheduled: "10:40", terminal: "5" };
  assert.equal(readOpenSky({ onGround: false, speed: 80 }, "from", { ...ctx, now: clock("10:50") })?.state, "departed");
  // On the ground where it leaves: nothing to say until it's 15 minutes past its time.
  assert.equal(readOpenSky({ onGround: true, speed: 0 }, "from", { ...ctx, now: clock("10:45") }), null);
  const late = readOpenSky({ onGround: true, speed: 0 }, "from", { ...ctx, now: clock("11:00") });
  assert.deepEqual([late?.state, late?.terminal, late?.gate], ["delayed", "5", null]);
  assert.equal(readOpenSky({ onGround: true, speed: 3 }, "to", { ...ctx, now: clock("13:25") })?.state, "landed");
  assert.equal(readOpenSky({ onGround: false, speed: 90 }, "to", { ...ctx, now: clock("13:00") })?.state, "departed");
  assert.equal(readOpenSky(null, "from", { ...ctx, now: clock("10:50") }), null);
});

test("OpenSky: asked for an airport's area only; cached; nothing personal in the request", async () => {
  const s = stub(() => json(OPENSKY));
  const a = await flightStatus(flight({ title: "BA 550" }), { fetch: s.fetch, now: clock("10:50") });
  assert.deepEqual([a?.provider, a?.state, a?.flight], ["opensky", "departed", "BA 550"]);
  assert.equal(s.calls.length, 1);
  const { url } = s.calls[0];
  assert.equal(url.origin + url.pathname, "https://opensky-network.org/api/states/all");
  assert.deepEqual([...url.searchParams.keys()], ["lamin", "lomin", "lamax", "lomax"]);
  for (const secret of ["K7Q2XB", "14A", "00000000", "British", "BAW", "550"]) assert.ok(!url.toString().includes(secret), `the URL carries no ${secret}`);
  // A minute later the cache answers, even for another flight from the same airport; three minutes later it asks again.
  await flightStatus(flight({ title: "BA 960" }), { fetch: s.fetch, now: clock("10:51") });
  assert.equal(s.calls.length, 1);
  await flightStatus(flight({ title: "BA 550" }), { fetch: s.fetch, now: clock("10:54") });
  assert.equal(s.calls.length, 2);
});

test("still on the ground 15 minutes after its time: delayed, with the terminal from the booking", async () => {
  const s = stub(() => json(OPENSKY));
  const a = await flightStatus(flight({ title: "BA 960", starts_at: at("10:20") }), { fetch: s.fetch, now: clock("10:50") });
  assert.deepEqual([a?.state, a?.terminal, a?.gate], ["delayed", "5", null]);
});

test("rate limits: a 429 rests OpenSky; it stops before its credits run out", async () => {
  const s = stub(() => json({}, 429, { "x-rate-limit-retry-after-seconds": "600" }));
  assert.equal(await flightStatus(flight({ title: "BA 550" }), { fetch: s.fetch, now: clock("10:50") }), null);
  await flightStatus(flight({ title: "BA 550", start_place: "Gatwick" }), { fetch: s.fetch, now: clock("10:55") });
  assert.equal(s.calls.length, 1);

  clearFlightCache();
  const low = stub(() => json(OPENSKY, 200, { "x-rate-limit-remaining": "8", "x-rate-limit-retry-after-seconds": "3600" }));
  const first = await flightStatus(flight({ title: "BA 550" }), { fetch: low.fetch, now: clock("10:50") });
  assert.equal(first?.state, "departed", "the answer that said 'running low' is still used");
  await flightStatus(flight({ title: "BA 550", start_place: "Gatwick", start_city: "London" }), { fetch: low.fetch, now: clock("10:51") });
  assert.equal(low.calls.length, 1);
});

test("OpenSky: asks the airport it leaves from, then the one it lands at; nothing outside those times", async () => {
  const s = stub(() => json(OPENSKY));
  // 3 hours before: in the strip's window, but OpenSky can't see a plane that isn't moving yet: no request.
  assert.equal(await flightStatus(flight(), { fetch: s.fetch, now: clock("08:00") }), null);
  assert.equal(s.calls.length, 0);
  await flightStatus(flight(), { fetch: s.fetch, now: clock("10:20") });
  assert.equal(Number(s.calls[0].url.searchParams.get("lamin")).toFixed(1), "51.3");
  await flightStatus(flight(), { fetch: s.fetch, now: clock("13:00") });
  assert.equal(Number(s.calls[1].url.searchParams.get("lamin")).toFixed(1), "38.6");
  // A flight that's done, or a booking without a number: never asked.
  assert.equal(await flightStatus(flight(), { fetch: s.fetch, now: clock("15:00") }), null);
  assert.equal(await flightStatus(flight({ title: "Flight to Lisbon" }), { fetch: s.fetch, now: clock("10:20") }), null);
  assert.equal(s.calls.length, 2);
});

test("the provider seam: another provider plugs in, is only asked inside the window, and can't break anything", async () => {
  const asked: string[] = [];
  const other: FlightProvider = {
    id: "opensky",
    async status(b, deps) {
      asked.push(`${b.title}@${deps.now.toISOString()}`);
      return { provider: "opensky", flight: "BA 432", state: "boarding", late: 0, scheduled: "10:40", expected: null, arrives: null, gate: "B32", terminal: "5", belt: null, checked_at: deps.now.toISOString() } satisfies FlightStatus;
    },
  };
  assert.equal((await flightStatus(flight(), { now: clock("09:55") }, other))?.gate, "B32");
  assert.equal(await flightStatus(flight(), { now: clock("06:00") }, other), null);
  assert.equal(asked.length, 1);
  const broken: FlightProvider = { id: "opensky", status: async () => { throw new Error("boom"); } };
  assert.equal(await flightStatus(flight(), { now: clock("09:55") }, broken), null);
});

test("failures are null, never an error", async () => {
  const boom = stub(() => {
    throw new TypeError("network");
  });
  assert.equal(await flightStatus(flight({ title: "BA 550" }), { fetch: boom.fetch, now: clock("10:50") }), null);
  clearFlightCache();
  const bad = stub(() => new Response("not json", { status: 200 }));
  assert.equal(await flightStatus(flight({ title: "BA 550" }), { fetch: bad.fetch, now: clock("10:50") }), null);
  clearFlightCache();
  const gone = stub(() => new Response("", { status: 503 }));
  assert.equal(await flightStatus(flight({ title: "BA 550" }), { fetch: gone.fetch, now: clock("10:50") }), null);
});
