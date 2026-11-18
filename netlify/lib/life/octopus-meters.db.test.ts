// Real path for Octopus's meters: the real connector routes, a real Life log run (executeRun) reading Octopus without
// Claude, the real /api function for Days and the Money page, and Postgres with every migration. Octopus is stubbed at fetch.
// A gas-only account syncs gas days and nothing for electricity; changed under Edit to both meters, it syncs both.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/life/octopus-meters.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Octopus meters: gas only syncs gas days, both meters sync both, each meter's own error", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { handleConnectorRoutes } = await import("../connectors/routes");
  const { executeRun } = await import("../connectors/runner");
  const { q, qRaw } = await import("../../../lib/db");
  const C = await import("../../../lib/connectors");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { openStrict } = await import("../../../lib/data-box");
  const { lifeRetryWaits } = await import("../connectors/lifelog-b-http");
  const F = await import("../connectors/fixtures/life-recorded");
  lifeRetryWaits.ms = [1, 1];
  const TZ = "Europe/London";

  for (const t of ["collected_items", "collection_runs", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('money', 'home')`);
  await qRaw(`DELETE FROM settings WHERE key IN ('money_backfill', 'days_money_home')`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const today = zonedToday(new Date(), TZ);
  const day = addDays(today, -1);

  // ---- Octopus, stubbed: one day of half hours from each meter; the gas meter can be made to go missing ----
  const realFetch = globalThis.fetch;
  const seen: URL[] = [];
  let gasMissing = false;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    seen.push(u);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.host !== "api.octopus.energy" || (init.method ?? "GET") !== "GET") throw new Error(`unexpected fetch ${u.host}${u.pathname} ${init.method}`);
    if (u.pathname === "/v1/accounts/A-1234ABCD/") return reply(F.OCTOPUS_ACCOUNT);
    const gas = u.pathname.startsWith("/v1/gas-meter-points/1234567890/meters/G4A12345678/consumption/");
    const electric = u.pathname.startsWith("/v1/electricity-meter-points/1200012345678/meters/21L1234567/consumption/");
    if ((gas && gasMissing) || (!gas && !electric)) return reply(F.OCTOPUS_NOT_FOUND, 404);
    // 0.5 kWh of gas a half hour (24 a day); electricity as the fixture day (7.3 a day).
    const half = gas ? F.octopusDay(day, () => 0.5) : F.octopusDay(day);
    return reply({ count: 48, next: null, results: u.searchParams.get("page_size") === "1" ? half.slice(0, 1) : half });
  }) as typeof fetch;

  const routes = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return JSON.parse(await res.text());
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const homeRow = async (date: string) => {
    const [row] = await qRaw<{ ciphertext: string; label: string }>(`SELECT ciphertext, label FROM sensitive_blobs WHERE domain = 'home' AND source = 'octopus' AND day = $1::date`, [date]);
    return row ? { label: row.label, figures: JSON.parse(openStrict(row.ciphertext)) as Record<string, unknown> } : null;
  };
  const runLife = async (lifeId: string) => {
    const run = await C.queueRun(lifeId, "manual");
    await executeRun(run.id, new Date());
    const [done] = await q<{ status: string; error: string | null; summary: string | null }>(`SELECT status, error, summary FROM collection_runs WHERE id = $1`, [run.id]);
    return done;
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = () => undefined;

  try {
    // ---- the form's fields: a half-typed meter is refused in words, a gas-only account is added ----
    const bad = await call("POST", "/connectors", { provider: "octopus", name: "Octopus Energy", account_label: "home", url: JSON.stringify({ gas: { mprn: "1234567890", serial: "" } }), token: "sk_live_x" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "Add the gas meter's serial.");
    const octopus = await routes("POST", "/connectors", { provider: "octopus", name: "Octopus Energy", account_label: "home", url: JSON.stringify({ gas: { mprn: "1234567890", serial: "g4a12345678", m3: false } }), token: "sk_live_x" });
    assert.ok(octopus.id, JSON.stringify(octopus));
    assert.equal((await C.getConnector(octopus.id))!.url, "https://api.octopus.energy/v1/gas-meter-points/1234567890/meters/G4A12345678/");
    const checked = await routes("POST", `/connectors/${octopus.id}/check`);
    assert.equal(checked.status, "connected", JSON.stringify(checked));

    // ---- Find my meters: the saved key, the account number, the current home's meters only ----
    const found = await call("POST", "/connectors/find-address", { provider: "octopus", query: "A-1234ABCD", connector_id: octopus.id });
    assert.equal(found.status, 200, found.text);
    assert.deepEqual(found.json.choices.map((c: { group: string }) => c.group), ["electricity", "gas", "gas"]);
    assert.doesNotMatch(found.text, /Road|Street|postcode|sk_live/);
    assert.equal((await call("POST", "/connectors/find-address", { provider: "monzo", query: "A-1234ABCD" })).status, 404);

    // ---- a Life log run: gas days only, no electricity figures, no model ----
    const life = await routes("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [octopus.id], schedule: "daily", run_at: "23:30" });
    seen.length = 0;
    const first = await runLife(life.id);
    assert.equal(first.status, "succeeded", first.error ?? "");
    assert.match(first.summary ?? "", /Octopus Energy: 1 day updated/);
    assert.ok(seen.length && seen.every((u) => u.pathname.startsWith("/v1/gas-meter-points/")), "a gas-only account never asks for electricity");
    const gasDay = await homeRow(day);
    assert.deepEqual(gasDay?.figures, { gas_kwh: 24 });
    assert.equal(gasDay?.label, `Home · ${day} · Octopus Energy`);

    // Days, with Home on: only gas. House (where energy moved from Money): a gas month, no electricity.
    await call("PUT", "/life/prefs", { home: true });
    let d = await call("GET", `/days/${day}`);
    assert.deepEqual(d.json.home, { line: "Gas 24.0 kWh", gas_kwh: 24 });
    let m = await call("GET", "/life/house");
    assert.equal(m.status, 200, m.text);
    assert.deepEqual(m.json.energy.fuels, ["gas"]);
    assert.deepEqual(m.json.energy.months, [{ month: day.slice(0, 7), gas: { kwh: 24, days: 1, per_day: 24 } }]);

    // ---- Edit: add the electricity meter. The address changes, history starts again, both fuels sync ----
    const patched = await call("PATCH", `/connectors/${octopus.id}`, { url: JSON.stringify({ electricity: { mpan: "1200012345678", serial: "21l1234567" }, gas: { mprn: "1234567890", serial: "G4A12345678", m3: false } }) });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.url, "https://api.octopus.energy/v1/electricity-meter-points/1200012345678/meters/21L1234567/?gas=1234567890%3AG4A12345678");
    assert.equal(patched.json.status, "pending");
    const [state] = await qRaw<{ value: Record<string, unknown> }>(`SELECT value FROM settings WHERE key = 'money_backfill'`);
    assert.equal(state?.value?.[octopus.id], undefined, "the backfill starts again for the new meter");
    assert.equal((await call("PATCH", `/connectors/${octopus.id}`, { url: JSON.stringify({ electricity: { mpan: "12" } }) })).json.error, "An MPAN is 13 digits.");
    assert.equal((await routes("POST", `/connectors/${octopus.id}/check`)).status, "connected");

    seen.length = 0;
    const second = await runLife(life.id);
    assert.equal(second.status, "succeeded", second.error ?? "");
    assert.doesNotMatch(second.summary ?? "", /kWh|\d+\.\d/);
    assert.ok(seen.some((u) => u.pathname.includes("/electricity-meter-points/")) && seen.some((u) => u.pathname.includes("/gas-meter-points/")));
    const both = (await homeRow(day))!.figures;
    assert.equal(both.kwh, 7.3);
    assert.equal(both.gas_kwh, 24);
    assert.equal((both.half_hours as number[]).length, 48);
    d = await call("GET", `/days/${day}`);
    assert.equal(d.json.home.line, "7.3 kWh, mostly 18:00–22:00 · gas 24.0 kWh");
    assert.equal(d.json.home.by_hour.length, 24);
    m = await call("GET", "/life/house");
    assert.equal(m.json.energy.months.at(-1).electricity.kwh, 7.3);
    assert.equal(m.json.energy.months.at(-1).gas.kwh, 24);

    // ---- the gas meter goes missing: Octopus says which meter, as something to fix ----
    gasMissing = true;
    const err = await call("POST", `/connectors/${octopus.id}/check`);
    assert.equal(err.status, 400);
    assert.equal(err.json.error, "Octopus can't find that gas meter. Check the MPRN and serial under Edit.");
    assert.equal((await C.getConnector(octopus.id))!.status, "needs_auth");
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, orig);
  }
});
