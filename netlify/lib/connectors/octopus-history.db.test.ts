// Real path for Octopus's meter history (octopus-direct.ts octopusBackfill, backfill.ts): connecting through the real
// /api routes, the real adapter and the history engine, sealed home days on Postgres with every migration.
// Octopus is stubbed at fetch. Nothing calls a model.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/octopus-history.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the connector tables, the home days and history loads first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

/** Half-hourly electricity from `since` on, 0.2 kWh each, for whatever window is asked. */
function octopusRoute(since: string, asked: Array<{ from: string; to: string }>): F.Route {
  return (u) => {
    if (u.host !== "api.octopus.energy") return undefined;
    if (!u.pathname.includes("/consumption/")) return { status: 404, body: {} };
    if (u.searchParams.get("page_size") === "1") return { body: { results: [{ consumption: 0.2, interval_start: new Date().toISOString() }] } };
    const from = Date.parse(u.searchParams.get("period_from")!);
    const to = Date.parse(u.searchParams.get("period_to")!);
    asked.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    const results: Array<{ consumption: number; interval_start: string }> = [];
    for (let t = Math.max(from, Date.parse(`${since}T00:00:00Z`)); t < to; t += 30 * 60_000) results.push({ consumption: 0.2, interval_start: new Date(t).toISOString() });
    return { body: { results } };
  };
}

async function setup() {
  const { handleConnectorRoutes } = await import("./routes");
  const B = await import("./backfill");
  const { qRaw } = await import("../../../lib/db");
  const { lifeRetryWaits } = await import("./feeds-shared");
  lifeRetryWaits.ms = [1, 1];
  for (const t of ["collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'home'`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'history_load.%' OR key = 'money_backfill'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"UTC"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const triggered: string[] = [];
  B.backfillTrigger.send = async (_origin, ids) => void triggered.push(...ids);
  const api = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  const connect = async () => {
    const made = await api("POST", "/connectors", { provider: "octopus", name: "Octopus Energy", account_label: "home", url: "1200012345678 21L1234567", token: "sk_live_x" });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const checked = await api("POST", `/connectors/${made.json.id}/check`);
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    return made.json.id as string;
  };
  const homeDays = async () => (await import("../../../lib/money")).readHomeDays("2000-01-01", "2100-01-01").then((r) => [...r.days.keys()].sort());
  return { api, B, connect, homeDays, triggered, qRaw };
}

test("Octopus: connecting loads 24 months of meter days, carries on after running out of time, and stops at the floor", { skip }, async () => {
  F.installFetch();
  try {
    const asked: Array<{ from: string; to: string }> = [];
    F.stub(octopusRoute("2020-01-01", asked));
    const { api, B, connect, homeDays, triggered } = await setup();
    const { historyFloor } = await import("./octopus-history");
    const { zonedToday, addDays } = await import("../../../lib/dates");
    const today = zonedToday(new Date(), "UTC");
    const id = await connect();
    assert.deepEqual(triggered, [id], "checking the account starts the load in the background");
    const start = (await api("GET", `/connectors/${id}/backfill`)).json;
    assert.equal(start.progress.state, "running");
    assert.equal(start.progress.unit, "day");

    // A budget that runs out after a few months: it stops and keeps its place.
    let t = 0;
    const part = (await B.runBackfill(id, { budgetMs: 3_500, clock: () => (t += 500) }))!;
    assert.equal(part.state, "running");
    assert.ok(part.items > 0 && part.items < 400, `${part.items} days so far`);
    const sofar = part.items;
    const askedBefore = asked.length;

    // The next run carries on from that page, not from the start.
    const done = (await B.runBackfill(id, { budgetMs: 60_000 }))!;
    assert.equal(done.state, "done");
    assert.equal(asked[askedBefore].to, asked[askedBefore - 1].from, "picks up where it stopped");
    assert.equal(done.oldest, historyFloor(today));
    const days = await homeDays();
    assert.equal(days[0], historyFloor(today));
    assert.equal(days.at(-1), addDays(today, -4), "the newest few days are the Life log run's");
    assert.equal(done.items, days.length);
    assert.ok(done.items > sofar);
    assert.ok(asked.every((a) => a.from.slice(0, 10) >= historyFloor(today)), "nothing older than 24 months asked");
    assert.ok(F.calls.every((c) => c.url.host === "api.octopus.energy"));

    // The page shows where it got to, in days.
    const shown = (await api("GET", `/connectors/${id}/backfill`)).json.progress;
    assert.equal(shown.state, "done");
    assert.equal(shown.oldest, historyFloor(today));
    assert.equal(shown.cursor, undefined, "cursors stay on the server");

    // Load history again: from the newest page, and nothing changes.
    asked.length = 0;
    await api("POST", `/connectors/${id}/backfill`);
    const again = (await B.runBackfill(id, { budgetMs: 60_000 }))!;
    assert.equal(again.state, "done");
    assert.equal(again.added, 0, "the same readings: no day changed");
    assert.equal((await homeDays()).length, days.length);
  } finally {
    F.restoreFetch();
  }
});

test("Octopus: a meter fitted recently stops at the first empty month; a new meter under Edit starts the history again", { skip }, async () => {
  F.installFetch();
  try {
    const { zonedToday, addDays } = await import("../../../lib/dates");
    const today = zonedToday(new Date(), "UTC");
    const since = addDays(today, -75);
    const asked: Array<{ from: string; to: string }> = [];
    F.stub(octopusRoute(since, asked));
    const { api, B, connect, homeDays, qRaw } = await setup();
    const id = await connect();
    const done = (await B.runBackfill(id, { budgetMs: 60_000 }))!;
    assert.equal(done.state, "done");
    assert.equal(done.oldest, since);
    assert.ok(asked.length <= 4, `${asked.length} months asked`);
    assert.equal((await homeDays())[0], since);

    // A run's own step leaves the history to a finished load.
    const { getBackfill } = B;
    assert.equal((await getBackfill(id))!.state, "done");

    // Edit: a different meter. The load is forgotten, and checking the account starts it again.
    const edited = await api("PATCH", `/connectors/${id}`, { url: "1200098765432 21L7654321" });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(await getBackfill(id), null);
    const [state] = await qRaw<{ value: Record<string, unknown> }>(`SELECT value FROM settings WHERE key = 'money_backfill'`);
    assert.equal(state?.value?.[id], undefined, "the run's place is forgotten too");
    await api("POST", `/connectors/${id}/check`);
    assert.equal((await getBackfill(id))!.state, "running");
  } finally {
    F.restoreFetch();
  }
});

test("House's weather: the Home place's typed address is looked up once through Places' geocoder when it has no visits", { skip }, async () => {
  const { qRaw, upsertPlace } = await import("../../../lib/db");
  const { placeDeps } = await import("../../../lib/static-map");
  const { homeSpot } = await import("../../../lib/house-data");
  await qRaw(`DELETE FROM place_geo`);
  await qRaw(`DELETE FROM places`);
  assert.equal(await homeSpot(), null, "no Home place: nothing asked");
  const asked: string[] = [];
  const real = placeDeps.geocode;
  placeDeps.geocode = async (address: string) => (asked.push(address), { lat: 51.556781, lng: -0.143219 });
  try {
    await upsertPlace({ name: "Home", address: "1 Test Street, London N6" });
    assert.deepEqual(await homeSpot(), { lat: 51.55678, lng: -0.14322 });
    assert.deepEqual(asked, ["1 Test Street, London N6"], "only the address goes to the geocoder");
  } finally {
    placeDeps.geocode = real;
  }
});
