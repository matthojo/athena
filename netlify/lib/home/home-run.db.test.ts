// The Home collection on its real path: the real connector and collection routes, a real run (executeRun) with no way to
// reach Claude, Postgres with every migration, and Octopus stubbed at fetch. A Home run reads the meter into sealed home
// days and records its run like any other; the scheduler claims it without AI Gateway; a Life log with the same account
// leaves it to Home, and reads it again once Home is turned off; a refused key fails the run and names the account.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/home/home-run.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
const AI_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  for (const k of AI_ENV) delete process.env[k];
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Home reads the meter hourly with no Claude, and the Life log leaves it to Home", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { handleConnectorRoutes } = await import("../connectors/routes");
  const { executeRun, aiConfigured } = await import("../connectors/runner");
  const { q, qRaw } = await import("../../../lib/db");
  const C = await import("../../../lib/connectors");
  const { NO_MODEL_RECIPES } = await import("../../../lib/connector-presets");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { openStrict } = await import("../../../lib/data-box");
  const { lifeRetryWaits } = await import("../connectors/lifelog-b-http");
  const F = await import("../connectors/fixtures/life-recorded");
  lifeRetryWaits.ms = [1, 1];
  const TZ = "Europe/London";

  const wipe = async () => {
    for (const t of ["collected_items", "collection_runs", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('money', 'home')`);
    await qRaw(`DELETE FROM settings WHERE key IN ('money_backfill', 'days_money_home')`);
  };
  await wipe();
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const day = addDays(zonedToday(new Date(), TZ), -1);

  // ---- Octopus, stubbed: yesterday's half hours; the key can be refused. Anything else (Claude included) fails the test. ----
  const realFetch = globalThis.fetch;
  const seen: URL[] = [];
  let refuse = false;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    if (u.host !== "api.octopus.energy" || (init.method ?? "GET") !== "GET") throw new Error(`unexpected fetch ${u.host}${u.pathname} ${init.method}`);
    seen.push(u);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (refuse) return reply({ detail: "Invalid API key." }, 401);
    if (!u.pathname.startsWith("/v1/electricity-meter-points/1200012345678/meters/21L1234567/consumption/")) return reply(F.OCTOPUS_NOT_FOUND, 404);
    const half = F.octopusDay(day);
    return reply({ count: half.length, next: null, results: u.searchParams.get("page_size") === "1" ? half.slice(0, 1) : half });
  }) as typeof fetch;

  const routes = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return JSON.parse(await res.text());
  };
  const run = async (collectionId: string) => {
    const queued = await C.queueRun(collectionId, "manual");
    await executeRun(queued.id, new Date());
    const [done] = await q<{ status: string; error: string | null; summary: string | null; stats: Record<string, unknown> }>(`SELECT status, error, summary, stats FROM collection_runs WHERE id = $1`, [queued.id]);
    return done;
  };
  const homeRow = async () => {
    const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'home' AND source = 'octopus' AND day = $1::date`, [day]);
    return row ? (JSON.parse(openStrict(row.ciphertext)) as Record<string, unknown>) : null;
  };
  const withAi = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.ANTHROPIC_API_KEY = "test";
    try {
      return await fn();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = () => undefined;

  try {
    assert.equal(aiConfigured(), false, "Home runs with no way to reach Claude");
    const octopus = await routes("POST", "/connectors", { provider: "octopus", name: "Octopus Energy", account_label: "", url: JSON.stringify({ electricity: { mpan: "1200012345678", serial: "21L1234567" } }), token: "sk_live_x" });
    assert.ok(octopus.id, JSON.stringify(octopus));
    assert.equal((await routes("POST", `/connectors/${octopus.id}/check`)).status, "connected");

    // ---- the Home collection, made through the routes like the app's offer, hourly ----
    const home = await routes("POST", "/collections", { recipe: "home", name: "Home", label: "", connector_ids: [octopus.id], schedule: "hourly", every_hours: 1, run_at: null, lookback_hours: 24 });
    assert.equal(home.recipe, "home", JSON.stringify(home));
    assert.equal(home.source, "home");
    assert.ok(NO_MODEL_RECIPES.includes("home"));
    // The scheduler claims it without AI Gateway (collect.ts passes NO_MODEL_RECIPES then).
    await qRaw(`UPDATE collections SET next_run_at = $2 WHERE id = $1`, [home.id, new Date(Date.now() - 60_000).toISOString()]);
    const claimed = await C.claimDueCollections(new Date(), { recipes: NO_MODEL_RECIPES });
    assert.equal(claimed.length, 1);
    await qRaw(`DELETE FROM collection_runs`);

    seen.length = 0;
    const first = await run(home.id);
    assert.equal(first.status, "succeeded", first.error ?? "");
    assert.match(first.summary ?? "", /Octopus Energy: 1 day updated/);
    assert.doesNotMatch(first.summary ?? "", /kWh|\d+\.\d/);
    assert.equal(first.stats.accounts_checked, 1);
    assert.equal(first.stats.days_updated, 1);
    assert.equal((await homeRow())?.kwh, 7.3);
    assert.ok(seen.length > 0);

    // ---- a Life log with the same account leaves it to Home: no Octopus request, no Claude ----
    const life = await routes("POST", "/collections", { recipe: "life-log", name: "Life log", label: "", connector_ids: [octopus.id], schedule: "daily", run_at: "21:30" });
    seen.length = 0;
    const lifeRun = await withAi(() => run(life.id));
    assert.equal(lifeRun.status, "succeeded", lifeRun.error ?? "");
    assert.equal(lifeRun.summary, "Home reads these accounts every hour.");
    assert.equal(seen.length, 0, "the Life log didn't ask Octopus");

    // Home turned off: the Life log reads it again, before Claude, as it did before Home.
    await routes("PATCH", `/collections/${home.id}`, { enabled: false });
    const lifeAgain = await withAi(() => run(life.id));
    assert.equal(lifeAgain.status, "succeeded", lifeAgain.error ?? "");
    assert.match(lifeAgain.summary ?? "", /Octopus Energy: 0 days updated/);
    assert.ok(seen.length > 0);
    await routes("PATCH", `/collections/${home.id}`, { enabled: true });

    // ---- Octopus refuses the key: the run fails, names the account, and what was saved stands ----
    refuse = true;
    const refused = await run(home.id);
    assert.equal(refused.status, "failed");
    assert.equal(refused.error, "Every account needs signing in again.");
    assert.deepEqual(refused.stats.blocked_by, [octopus.id]);
    assert.equal((await C.getConnector(octopus.id))?.status, "needs_auth");
    assert.equal((await homeRow())?.kwh, 7.3);

    // ---- a Home with no account it reads ----
    const gmail = await C.createConnector({ name: "Gmail", provider: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", auth_type: "oauth", secrets: {} });
    const wrong = await C.upsertCollection(undefined, { name: "Home 2", recipe: "home", connector_ids: [gmail.id], label: "two", source: "home-two", schedule: "manual", run_at: null });
    const none = await run(wrong.id);
    assert.equal(none.status, "failed");
    assert.match(none.error ?? "", /None of these accounts is one Home reads/);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, orig);
    await wipe();
  }
});
