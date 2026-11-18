// Run: npx tsx --test netlify/lib/car-routes.test.ts
// The car end to end with both APIs stubbed at fetch: the keys are checked, a registration is looked up,
// Life admin gets its renewals and the vehicle card has its data. Only DVLA and DVSA hear the registration.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkCarKey, carLookups, clearMotToken, CarKeyError, MOT_URL, VES_URL } from "./car-api";
import { handleCarRoutes, runCarSync } from "./car-routes";
import { memoryCar } from "../../lib/car-sync.fixtures";
import { MOT_SAMPLE, VES_SAMPLE } from "../../lib/car.fixtures";

const TOKEN_URL = "https://login.microsoftonline.com/a1b2c3d4-0000-4000-8000-000000000000/oauth2/v2.0/token";
const MOT_CREDS = { client_id: "client-1", client_secret: "secret-1", api_key: "mot-key", token_url: TOKEN_URL };
const REG = "AB12CDE";

function apis() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? String(init.body) : "";
    calls.push({ url: u, method: init.method ?? "GET", headers, body });
    if (u === VES_URL) {
      if (headers["x-api-key"] !== "dvla-key") return Response.json({ message: "Forbidden" }, { status: 403 });
      const reg = JSON.parse(body).registrationNumber;
      if (reg === "A") return Response.json({ errors: [{ status: "400", code: "105", title: "Invalid vrn number" }] }, { status: 400 });
      return Response.json({ ...VES_SAMPLE, registrationNumber: reg, make: "FORD", colour: "BLUE", yearOfManufacture: 2019, taxStatus: "Taxed", taxDueDate: "2027-04-01", motStatus: "Valid", motExpiryDate: "2026-12-01" });
    }
    if (u === TOKEN_URL) {
      const form = new URLSearchParams(body);
      if (form.get("client_secret") !== "secret-1") return Response.json({ error: "invalid_client" }, { status: 401 });
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("scope"), "https://tapi.dvsa.gov.uk/.default");
      return Response.json({ token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: "mot-token" });
    }
    if (u.startsWith(`${MOT_URL}/`)) {
      if (headers.Authorization !== "Bearer mot-token" || headers["X-API-Key"] !== "mot-key") return Response.json({ errorCode: "MOTH-FB-03" }, { status: 403 });
      if (u.endsWith("/A")) return Response.json({ errorCode: "MOTH-IV-03", errorMessage: "The VRM provided in the request is invalid" }, { status: 400 });
      return Response.json({ ...MOT_SAMPLE, registration: u.split("/").pop(), motTests: MOT_SAMPLE.motTests.map((t, i) => (i === 0 ? { ...t, expiryDate: "2026-12-01" } : t)) });
    }
    return new Response("not stubbed", { status: 599 });
  }) as typeof fetch;
  return { f, calls };
}

const reply = (data: unknown, status = 200) => Response.json(data, { status });
const req = (method: string, body?: unknown) => new Request("https://athena.test/api/car", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });

beforeEach(() => clearMotToken());

test("checking the keys sends no registration; a bad key is the owner's to fix", async () => {
  const { f, calls } = apis();
  await checkCarKey("dvla", { token: "dvla-key" }, f);
  await checkCarKey("dvsa-mot", { token: "mot-key", ownClient: { client_id: "client-1", client_secret: "secret-1" }, tokenUrl: TOKEN_URL }, f);
  assert.ok(calls.every((c) => !c.body.includes(REG) && !c.url.includes(REG)));
  await assert.rejects(checkCarKey("dvla", { token: "wrong" }, f), (e: unknown) => e instanceof CarKeyError && e.owner && /didn't accept the key/.test(e.message));
  await assert.rejects(checkCarKey("dvsa-mot", { token: "mot-key", ownClient: { client_id: "client-1", client_secret: "nope" }, tokenUrl: TOKEN_URL }, f), (e: unknown) => e instanceof CarKeyError && e.owner);
  await assert.rejects(checkCarKey("dvsa-mot", { token: "mot-key", ownClient: { client_id: "client-1", client_secret: "secret-1" }, tokenUrl: "https://evil.example/token" }, f), /token URL/);
});

test("key, then lookup, then renewals and the card: the real path with both APIs stubbed", async () => {
  const { f, calls } = apis();
  const errors: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    const keys = { dvla: "dvla-key", mot: MOT_CREDS };
    const lookups = await carLookups(f, keys);
    const car = memoryCar(lookups);
    const deps = { ports: car.ports, keys, today: "2026-11-10" };

    const added = await handleCarRoutes(req("POST", { registration: "ab12 cde" }), new URL("https://athena.test/api/car/vehicles"), ["api", "car", "vehicles"], reply, deps);
    assert.equal(added!.status, 201);
    const body = (await added!.json()) as { id: string; keys: { dvla: boolean; mot: boolean }; vehicles: Array<Record<string, unknown>> };
    assert.deepEqual(body.keys, { dvla: true, mot: true });

    // DVLA: the registration in a POST body, never the URL. DVSA: a token once, then the lookup with both headers.
    const ves = calls.filter((c) => c.url === VES_URL);
    assert.equal(ves.length, 1);
    assert.equal(ves[0].method, "POST");
    assert.deepEqual(JSON.parse(ves[0].body), { registrationNumber: REG });
    assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
    assert.equal(calls.filter((c) => c.url === `${MOT_URL}/${REG}`).length, 1);
    const hosts = new Set(calls.map((c) => new URL(c.url).host));
    assert.deepEqual([...hosts].sort(), ["driver-vehicle-licensing.api.gov.uk", "history.mot.api.gov.uk", "login.microsoftonline.com"]);
    assert.ok(!calls.some((c) => c.url === TOKEN_URL && c.body.includes(REG)), "the sign-in never hears the registration");

    // Life admin: one MOT and one tax renewal, named by the car.
    assert.deepEqual([...car.assets.values()].map((a) => [a.name, a.renews_on]), [["Ford Focus MOT", "2026-12-01"], ["Ford Focus tax", "2027-04-01"]]);

    // The card.
    const [card] = body.vehicles as Array<{ label: string; registration: string; colour: string; year: number; mot: { on: string; days: number; status: string }; tax: { status: string }; last_test: { result: string; miles: number }; miles_a_year: number; advisories: string[] }>;
    assert.equal(card.label, "Ford Focus");
    assert.equal(card.registration, REG);
    assert.equal(card.colour, "BLUE");
    assert.equal(card.year, 2019);
    assert.deepEqual(card.mot, { on: "2026-12-01", days: 21, status: "Valid" });
    assert.equal(card.tax.status, "Taxed");
    assert.deepEqual(card.last_test, { date: "2025-02-17", result: "PASSED", miles: 41830 });
    assert.equal(card.advisories.length, 3);

    // The daily read: nothing more today; tomorrow one read per source, and the token is reused.
    assert.equal(await runCarSync("2026-11-10", { ports: car.ports }), 0);
    assert.equal(await runCarSync("2026-11-11", { ports: car.ports }), 1);
    assert.equal(calls.filter((c) => c.url === VES_URL).length, 2);
    assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
    assert.equal(car.assets.size, 2, "no duplicates");

    // Taking it off archives both renewals.
    const gone = await handleCarRoutes(req("DELETE"), new URL(`https://athena.test/api/car/vehicles/${body.id}`), ["api", "car", "vehicles", body.id], reply, deps);
    assert.equal(gone!.status, 200);
    assert.ok([...car.assets.values()].every((a) => a.archived_at));
  } finally {
    console.error = was;
  }
  assert.ok(errors.every((e) => !e.includes(REG)), "the registration is never logged");
});

test("without keys: the source says so and nothing errors", async () => {
  const car = memoryCar();
  const deps = { ports: car.ports, keys: { dvla: null, mot: null }, today: "2026-11-10" };
  const got = await handleCarRoutes(req("GET"), new URL("https://athena.test/api/car"), ["api", "car"], reply, deps);
  assert.deepEqual(await got!.json(), { vehicles: [], keys: { dvla: false, mot: false } });
  const add = await handleCarRoutes(req("POST", { registration: REG }), new URL("https://athena.test/api/car/vehicles"), ["api", "car", "vehicles"], reply, deps);
  assert.equal(add!.status, 400);
  assert.match(((await add!.json()) as { error: string }).error, /Add a DVLA or DVSA key first/);
  const lookups = await carLookups(apis().f, { dvla: null, mot: null });
  assert.deepEqual(await lookups.ves(REG), { none: true });
  assert.deepEqual(await lookups.mot(REG), { none: true });
});
