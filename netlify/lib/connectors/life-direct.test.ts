// Run: npx tsx --test netlify/lib/connectors/life-direct.test.ts
// Habitify, Monzo, Starling and Octopus over their APIs, with fetch stubbed (fixtures/life-recorded.ts), and lib/money.ts's days and lines.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_CATEGORIES, CONNECTOR_PRESETS, directApi, presetFor } from "../../../lib/connector-presets";
import { categoryOf, dayHome, homeDays, homeLine, homeMonths, isMoneyQuestion, mergeMoney, moneyDays, moneyLine, sameShop, eatingOut } from "../../../lib/money";
import * as F from "./fixtures/life-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { habitsOn, openHabitify, progressNote } from "./habitify-direct";
import { MONZO_FULL_HISTORY_MS, exchangeMonzoCode, monzoAuthorizationUrl, openMonzo, readableWindow } from "./monzo-direct";
import { openStarling } from "./starling-direct";
import { M3_TO_KWH, findOctopusMeters, metersOf, octopusAddress, openOctopus } from "./octopus-direct";
import { openTodoist } from "./todoist-direct";
import { AthenaInputError } from "../../../lib/db";

const conn = (provider: string, auth_type: "token" | "oauth", extra: Partial<Connector> = {}) => ({ id: `${provider}1`, name: provider, provider, auth_type, url: presetFor(provider).url, scope: "", oauth: {}, ...extra }) as Connector;
const saved: Array<{ id: string; tokens: unknown }> = [];
const realSave = lifeTokenStore.save;

beforeEach(() => {
  lifeRetryWaits.ms = [1, 1];
  saved.length = 0;
  lifeTokenStore.save = async (id, mutate) => {
    const s: ConnectorSecrets = { tokens: { refresh_token: "monzo_refresh_1" } };
    mutate(s);
    saved.push({ id, tokens: s.tokens });
  };
});
afterEach(() => {
  F.unstub();
  lifeTokenStore.save = realSave;
});

// ---------- Presets ----------

test("presets: four services in Habits and mind, Money and Home, each read-only, direct, and with plain setup steps", () => {
  const ids = ["habitify", "monzo", "starling", "octopus"];
  for (const id of ids) {
    const p = presetFor(id);
    assert.equal(p.id, id);
    assert.ok(p.setup?.steps.length, `${id}: setup steps`);
    assert.ok(p.readTools.length, `${id}: read tools`);
    assert.ok(directApi({ provider: id, auth_type: p.auth }), `${id}: direct`);
    assert.ok(directFor({ provider: id, auth_type: p.auth, oauth: {} }), `${id}: adapter`);
  }
  assert.deepEqual(["habitify", "monzo", "starling", "octopus"].map((id) => presetFor(id).category), ["habits", "money", "money", "home"]);
  // The directory has each category once (the duplicate Places and travel row is gone).
  const cats = CONNECTOR_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(cats).size, cats.length);
  assert.ok(cats.includes("habits") && cats.includes("money") && cats.includes("home"));
  assert.ok(presetFor("todoist").aliases?.includes("habits") && presetFor("todoist").recipes.includes("life-log"));
  assert.ok(presetFor("octopus").aliases?.includes("electricity"));
  assert.equal(CONNECTOR_PRESETS[CONNECTOR_PRESETS.length - 1].id, "custom");
});

// ---------- Habitify ----------

test("Habitify: a day's habits, bad ones filled in from their logs, archived and not-yet-started ones left out", async () => {
  F.stub(
    F.at("api.habitify.me", "/v2/habits/journal", F.JOURNAL),
    F.at("api.habitify.me", "/v2/habits", F.HABITS),
    (url) => {
      const m = url.pathname.match(/^\/v2\/habits\/([^/]+)\/logs$/);
      return url.host === "api.habitify.me" && m ? { body: F.LOGS[decodeURIComponent(m[1])] ?? { data: [] } } : undefined;
    },
  );
  const acct = await openHabitify(conn("habitify", "token"), { token: "hab_key" }, "Europe/London");
  const out = JSON.parse((await acct.call("habits_on", { date: "2026-11-06" })).text) as { items: Array<Record<string, unknown>> };
  const by = Object.fromEntries(out.items.map((h) => [h.name, h]));
  assert.deepEqual(Object.keys(by).sort(), ["Drink water", "No phone in bed", "No snacks after 9pm", "Read 20 pages", "Stretch"]);
  assert.equal(by["Read 20 pages"].done, true);
  assert.equal(by["Read 20 pages"].note, "20 of 20 pages");
  assert.equal(by["Drink water"].done, false);
  assert.equal(by["Drink water"].note, "3 of 5 glasses");
  assert.equal(by.Stretch.status, "skipped");
  assert.equal(by.Stretch.note, "skipped");
  assert.equal(by["No phone in bed"].status, "failed");
  assert.equal(by["No snacks after 9pm"].done, true);
  // The key goes in X-API-Key; the journal is asked for the local day.
  const journal = F.calls.find((c) => c.url.pathname === "/v2/habits/journal")!;
  assert.equal(journal.url.searchParams.get("date"), "2026-11-06");
  assert.equal((journal.init.headers as Record<string, string>)["X-API-Key"], "hab_key");
  assert.equal((journal.init.headers as Record<string, string>).Authorization, undefined);
  const logs = F.calls.find((c) => c.url.pathname.endsWith("/logs"))!;
  assert.deepEqual([logs.url.searchParams.get("startDate"), logs.url.searchParams.get("endDate")], ["2026-11-06", "2026-11-06"]);
  await assert.rejects(habitsOn({ get: async () => ({}) as never, tz: "UTC" }, "6 Nov"), /YYYY-MM-DD/);
});

test("Habitify: a refused key needs the owner (needs_auth); a 429 is retried", async () => {
  F.stub(F.at("api.habitify.me", "/v2/habits", () => F.HABITIFY_UNAUTHORISED, 401));
  const err = await openHabitify(conn("habitify", "token"), { token: "bad" }, "UTC").catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
  assert.match(directFailure(err)!.detail, /Settings → API key/);
  let n = 0;
  F.stub((url) => (url.pathname === "/v2/habits" ? (n++ === 0 ? { status: 429, body: {} } : { body: F.HABITS }) : undefined));
  await openHabitify(conn("habitify", "token"), { token: "k" }, "UTC");
  assert.equal(n, 2);
  assert.equal(progressNote({ goal: { value: 1 }, progress: { current_value: 1, target_value: 1 } }), undefined);
});

// ---------- Monzo ----------

const monzoSecrets = (extra: Record<string, unknown> = {}): ConnectorSecrets => ({
  ownClient: { client_id: "oauth2client_00009", client_secret: "mnzconf.secret" },
  tokens: { access_token: "monzo_access_1", refresh_token: "monzo_refresh_1", expires_in: 21600, obtained_at: Date.now(), ...extra },
});

test("Monzo: consent page and code exchange with the client in the body; a public client is refused", async () => {
  const url = new URL(monzoAuthorizationUrl({ clientId: "oauth2client_00009", redirectUri: "https://athena.example/api/connectors/oauth/callback", state: "s1" }));
  assert.equal(url.host, "auth.monzo.com");
  assert.equal(url.searchParams.get("response_type"), "code");
  F.stub(F.at("api.monzo.com", "/oauth2/token", F.MONZO_TOKEN));
  const t = await exchangeMonzoCode({ code: "c1", redirectUri: "https://athena.example/cb", client: { client_id: "oauth2client_00009", client_secret: "sec" } });
  assert.equal(t.refresh_token, "monzo_refresh_1");
  const body = new URLSearchParams(String(F.calls[0].init.body));
  assert.equal(body.get("client_secret"), "sec");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal((F.calls[0].init.headers as Record<string, string>).Authorization, undefined);
  await assert.rejects(exchangeMonzoCode({ code: "c1", redirectUri: "x", client: { client_id: "oauth2client_00009" } }), /Confidential/);
});

test("Monzo: until the owner approves in the app, the account asks them to; the first open notes when", async () => {
  F.stub(F.at("api.monzo.com", "/accounts", F.MONZO_NOT_APPROVED, 403));
  const err = await openMonzo(conn("monzo", "oauth"), monzoSecrets(), { tz: "UTC" }).catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
  assert.match(directFailure(err)!.detail, /approve Athena/);
  F.stub(F.at("api.monzo.com", "/accounts", F.MONZO_ACCOUNTS));
  await openMonzo(conn("monzo", "oauth"), monzoSecrets(), { tz: "UTC", now: () => 1_000 });
  assert.equal((saved[0].tokens as { approved_at: number }).approved_at, 1_000);
});

test("Monzo: spending only, in Athena's categories; pots, declines and refunds left out; paging by the last id", async () => {
  const page2 = [{ ...F.MONZO_TXNS[0], id: "tx_100", created: "2026-11-06T13:00:00.000Z" }];
  F.stub(
    F.at("api.monzo.com", "/accounts", F.MONZO_ACCOUNTS),
    F.at("api.monzo.com", "/transactions", (url) => ({ transactions: url.searchParams.get("since") === "tx_007" ? page2 : [...F.MONZO_TXNS, ...Array(93).fill(F.MONZO_TXNS[4])].slice(0, 100) })),
  );
  const acct = await openMonzo(conn("monzo", "oauth"), monzoSecrets({ approved_at: Date.now() }), { tz: "Europe/London" });
  const p1 = JSON.parse((await acct.call("transactions", { after: "2026-11-06", before: "2026-11-08" })).text);
  assert.deepEqual(p1.items.map((t: { id: string }) => t.id), ["tx_001", "tx_002", "tx_003", "tx_007"]);
  assert.equal(p1.items[2].category, "takeaway"); // Deliveroo, whatever Monzo calls it
  assert.equal(p1.items[0].amount, 1800);
  const last = F.calls.at(-1)!.url;
  assert.equal(last.searchParams.get("account_id"), "acc_00009abc");
  assert.deepEqual(last.searchParams.getAll("expand[]"), ["merchant"]);
  // 100 rows came back, so there's a next page, asked for since the last id read.
  F.stub(F.at("api.monzo.com", "/pots", F.MONZO_POTS), F.at("api.monzo.com", "/transactions", (url) => ({ transactions: url.searchParams.get("since")?.startsWith("tx_") ? page2 : Array(100).fill(F.MONZO_TXNS[0]).map((t, i) => ({ ...t, id: i === 99 ? "tx_007" : `tx_${i}` })) })));
  const a = JSON.parse((await acct.call("transactions", {})).text);
  assert.ok(a.next_cursor);
  const b = JSON.parse((await acct.call("transactions", { cursor: a.next_cursor })).text);
  assert.deepEqual(b.items.map((t: { id: string }) => t.id), ["tx_100"]);
  const pots = JSON.parse((await acct.call("pots", {})).text);
  assert.deepEqual(pots.items, [{ id: "pot_0001", name: "Holiday" }]);
  assert.ok(!JSON.stringify(pots).includes("balance"));
});

test("Monzo: the whole history within 5 minutes of approval, then 89 days at most (cut_to says so)", async () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const approvedAt = now - 60_000;
  assert.deepEqual(readableWindow({ approvedAt, now: () => now }, undefined), { after: undefined, cut: false });
  const later = { approvedAt: now - MONZO_FULL_HISTORY_MS - 1, now: () => now };
  const old = Date.parse("2025-01-01T00:00:00Z");
  const w = readableWindow(later, old);
  assert.equal(w.cut, true);
  assert.equal(new Date(w.after!).toISOString().slice(0, 10), "2026-08-10");
  assert.equal(readableWindow(later, now - 86_400_000).cut, false);

  F.stub(F.at("api.monzo.com", "/accounts", F.MONZO_ACCOUNTS), F.at("api.monzo.com", "/transactions", { transactions: [] }));
  const acct = await openMonzo(conn("monzo", "oauth"), monzoSecrets({ approved_at: approvedAt - MONZO_FULL_HISTORY_MS }), { tz: "UTC", now: () => now });
  const r = JSON.parse((await acct.call("transactions", { after: "2025-01-01" })).text);
  assert.equal(r.cut_to, "2026-08-10");
  assert.match(F.calls.at(-1)!.url.searchParams.get("since")!, /^2026-08-10/);
  // Monzo's own refusal of an old window is a one-off error back to the caller, not a sign-out.
  F.stub(F.at("api.monzo.com", "/transactions", F.MONZO_SCA, 403));
  const sca = await acct.call("transactions", {});
  assert.equal(sca.isError, true);
  assert.match(sca.text, /90 days/);
});

test("Monzo: an expired token renews once; a refused renewal (the 90-day sign-in) needs the owner", async () => {
  let n = 0;
  F.stub(
    F.at("api.monzo.com", "/oauth2/token", { ...F.MONZO_TOKEN, access_token: "monzo_access_2" }),
    (url, init) => (url.pathname === "/accounts" ? ((init.headers as Record<string, string>).Authorization === "Bearer monzo_access_2" ? { body: F.MONZO_ACCOUNTS } : (n++, { status: 400, body: F.MONZO_UNAUTH })) : undefined),
  );
  await openMonzo(conn("monzo", "oauth"), monzoSecrets({ approved_at: 1 }), { tz: "UTC" });
  assert.equal(n, 1);
  F.stub(F.at("api.monzo.com", "/oauth2/token", { error: "invalid_grant" }, 400), F.at("api.monzo.com", "/accounts", F.MONZO_UNAUTH, 400));
  const err = await openMonzo(conn("monzo", "oauth"), monzoSecrets({ approved_at: 1 }), { tz: "UTC" }).catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
  assert.match(directFailure(err)!.detail, /every 90 days/);
});

// ---------- Starling ----------

test("Starling: the feed's spending only; the window is the main account's default space", async () => {
  F.stub(F.at("api.starlingbank.com", "/api/v2/accounts", F.STARLING_ACCOUNTS), (url) => (url.pathname.includes("/transactions-between") ? { body: F.STARLING_FEED } : undefined));
  const acct = await openStarling(conn("starling", "token"), { token: "eyJ.pat" }, "Europe/London");
  const r = JSON.parse((await acct.call("feed", { date: "2026-11-06" })).text);
  assert.deepEqual(r.items.map((t: { id: string; category: string }) => [t.id, t.category]), [["f-001", "eating_out"], ["f-002", "takeaway"]]);
  const call = F.calls.at(-1)!.url;
  assert.equal(call.pathname, "/api/v2/feed/account/aaaaaaaa-1111-2222-3333-444444444444/category/cccccccc-1111-2222-3333-444444444444/transactions-between");
  assert.equal(call.searchParams.get("minTransactionTimestamp"), "2026-11-06T00:00:00.000Z");
  assert.equal((F.calls[0].init.headers as Record<string, string>).Authorization, "Bearer eyJ.pat");
  const long = await acct.call("feed", { after: "2026-01-01", before: "2026-11-01" });
  assert.equal(long.isError, true);
});

test("Starling: a token without the scopes needs the owner (403); a bad token too; 429 retried", async () => {
  F.stub(F.at("api.starlingbank.com", "/api/v2/accounts", F.STARLING_FORBIDDEN, 403));
  const e1 = await openStarling(conn("starling", "token"), { token: "t" }, "UTC").catch((e) => e);
  assert.equal(directFailure(e1)?.status, "needs_auth");
  assert.match(directFailure(e1)!.detail, /account:read and transaction:read/);
  F.stub(F.at("api.starlingbank.com", "/api/v2/accounts", F.STARLING_UNAUTH, 401));
  assert.equal(directFailure(await openStarling(conn("starling", "token"), { token: "t" }, "UTC").catch((e) => e))?.status, "needs_auth");
  let n = 0;
  F.stub((url) => (url.pathname === "/api/v2/accounts" ? (n++ < 2 ? { status: 429, body: {}, headers: { "retry-after": "0" } } : { body: F.STARLING_ACCOUNTS }) : undefined));
  await openStarling(conn("starling", "token"), { token: "t" }, "UTC");
  assert.equal(n, 3);
});

// ---------- Todoist (with a token) ----------

test("Todoist with a token: a day's routines from finished tasks and the activity, once each; a bad token needs the owner", async () => {
  assert.ok(directFor({ provider: "todoist", auth_type: "token", oauth: {} }), "token: direct");
  assert.equal(directFor({ provider: "todoist", auth_type: "oauth", oauth: {} }), undefined, "signed in: the hosted MCP server");
  F.stub(F.at("api.todoist.com", "/api/v1/tasks/completed/by_completion_date", F.TODOIST_COMPLETED), F.at("api.todoist.com", "/api/v1/activities", F.TODOIST_ACTIVITIES));
  const acct = await openTodoist(conn("todoist", "token"), { token: "todoist-token" }, "Europe/London");
  const r = JSON.parse((await acct.call("routines_on", { date: "2026-11-06" })).text);
  assert.deepEqual(r.items.map((x: { name: string; task_id: string }) => [x.name, x.task_id]), [["Stretch", "t1"], ["Water the plants", "r1"]]);
  const c = F.calls.find((x) => x.url.pathname.endsWith("/by_completion_date") && x.url.searchParams.get("limit") === "200")!;
  assert.equal(c.url.searchParams.get("since"), "2026-11-06T00:00:00.000Z");
  const a = F.calls.find((x) => x.url.pathname === "/api/v1/activities")!;
  assert.deepEqual([a.url.searchParams.get("object_type"), a.url.searchParams.get("event_type")], ["item", "completed"]);
  assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer todoist-token");
  F.stub(F.at("api.todoist.com", "/api/v1/tasks/completed/by_completion_date", F.TODOIST_UNAUTH, 401));
  const err = await openTodoist(conn("todoist", "token"), { token: "bad" }, "UTC").catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
});

// ---------- Octopus ----------

test("Octopus: the MPAN and serial become the address; anything else is refused in words", () => {
  const url = octopusAddress("1200012345678 21l1234567");
  assert.equal(url, "https://api.octopus.energy/v1/electricity-meter-points/1200012345678/meters/21L1234567/");
  assert.deepEqual(metersOf(url), { electricity: { mpan: "1200012345678", serial: "21L1234567" } });
  const gas = octopusAddress("1200012345678 21L1234567 1234567890 g4a12345678");
  assert.deepEqual(metersOf(gas).gas, { mprn: "1234567890", serial: "G4A12345678", m3: false });
  assert.deepEqual(metersOf(octopusAddress("1200012345678 21L1234567 1234567890 G4A12345678 m3")).gas, { mprn: "1234567890", serial: "G4A12345678", m3: true });
  for (const bad of ["", "12345 21L1", "1200012345678", "1200012345678 21L1234567 1234567890", JSON.stringify({ gas: { mprn: "12" } })]) assert.throws(() => octopusAddress(bad), AthenaInputError);
  assert.equal(directFor({ provider: "octopus", auth_type: "token", oauth: {} })?.checkAddress?.(JSON.stringify({ gas: { mprn: "1234567890", serial: "G4A12345678", m3: true } })), "https://api.octopus.energy/v1/gas-meter-points/1234567890/meters/G4A12345678/?units=m3");
});

/** Octopus stubbed: each meter's half hours for one day; `seen` keeps the paths asked for. */
function octopusMeters(opts: { gasPerSlot?: number; missing?: "gas" | "electricity" } = {}) {
  const seen: string[] = [];
  F.stub((url) => {
    if (url.host !== "api.octopus.energy") return undefined;
    seen.push(url.pathname);
    const gas = url.pathname.includes("/gas-meter-points/");
    if (opts.missing && url.pathname.includes(`/${opts.missing}-meter-points/`)) return { status: 404, body: F.OCTOPUS_NOT_FOUND };
    const day = gas ? F.octopusDay("2026-11-06", () => opts.gasPerSlot ?? 0.5) : F.octopusDay();
    return { body: { count: 48, next: null, results: url.searchParams.get("page_size") === "1" ? day.slice(0, 1) : day } };
  });
  return seen;
}

test("Octopus: a gas-only account reads only gas, in kWh, and gives no electricity figures at all", async () => {
  const seen = octopusMeters({ gasPerSlot: 0.5 });
  const acct = await openOctopus(conn("octopus", "token", { url: octopusAddress(JSON.stringify({ gas: { mprn: "1234567890", serial: "G4A12345678" } })) }), { token: "sk_live_x" }, "UTC");
  const r = JSON.parse((await acct.call("consumption", { date: "2026-11-06" })).text);
  assert.deepEqual(r.items, [{ date: "2026-11-06", gas_kwh: 24 }]);
  assert.ok(seen.length && seen.every((p) => p.startsWith("/v1/gas-meter-points/1234567890/meters/G4A12345678/consumption/")), "never asks for electricity");
  assert.equal(homeLine(r.items[0]), "Gas 24.0 kWh");
  const home = dayHome(r.items[0]);
  assert.deepEqual(home, { line: "Gas 24.0 kWh", gas_kwh: 24 });
  assert.equal("kwh" in home || "by_hour" in home, false, "no 0 kWh electricity row");
});

test("Octopus: an m³ gas meter is turned into kWh; with both meters each fuel is kept apart", async () => {
  octopusMeters({ gasPerSlot: 0.1 });
  const m3 = await openOctopus(conn("octopus", "token", { url: octopusAddress(JSON.stringify({ gas: { mprn: "1234567890", serial: "E6S12345", m3: true } })) }), { token: "sk_live_x" }, "UTC");
  const g = JSON.parse((await m3.call("consumption", { date: "2026-11-06" })).text).items[0];
  assert.ok(Math.abs(g.gas_kwh - 48 * 0.1 * M3_TO_KWH) < 0.01, `${g.gas_kwh}`);
  const seen = octopusMeters({ gasPerSlot: 0.5 });
  const both = await openOctopus(conn("octopus", "token", { url: octopusAddress("1200012345678 21L1234567 1234567890 G4A12345678") }), { token: "sk_live_x" }, "UTC");
  const d = JSON.parse((await both.call("consumption", { date: "2026-11-06" })).text).items[0];
  assert.equal(d.kwh, 7.3);
  assert.equal(d.gas_kwh, 24);
  assert.equal(d.half_hours.length, 48);
  assert.ok(seen.some((p) => p.includes("/electricity-meter-points/")) && seen.some((p) => p.includes("/gas-meter-points/")));
  assert.equal(homeLine(d), "7.3 kWh, mostly 18:00–22:00 · gas 24.0 kWh");
  const electric = await openOctopus(conn("octopus", "token", { url: octopusAddress("1200012345678 21L1234567") }), { token: "sk_live_x" }, "UTC");
  assert.equal(JSON.parse((await electric.call("consumption", { date: "2026-11-06" })).text).items[0].gas_kwh, undefined);
});

test("Octopus: a meter it can't find is named, gas or electricity, as something to fix", async () => {
  octopusMeters({ missing: "gas" });
  const url = octopusAddress("1200012345678 21L1234567 1234567890 G4A12345678");
  const gasErr = await openOctopus(conn("octopus", "token", { url }), { token: "sk_live_x" }, "UTC").catch((e) => e);
  assert.equal(gasErr.message, "Octopus can't find that gas meter. Check the MPRN and serial under Edit.");
  assert.equal(directFailure(gasErr)?.status, "needs_auth");
  octopusMeters({ missing: "electricity" });
  const elErr = await openOctopus(conn("octopus", "token", { url }), { token: "sk_live_x" }, "UTC").catch((e) => e);
  assert.equal(elErr.message, "Octopus can't find that electricity meter. Check the MPAN and serial under Edit.");
});

test("Octopus: Find my meters lists the current home's meters from the account number, read-only", async () => {
  const seen: Array<{ url: URL; method: string }> = [];
  F.stub((url, init) => {
    seen.push({ url, method: init.method ?? "GET" });
    return url.host === "api.octopus.energy" && url.pathname === "/v1/accounts/A-1234ABCD/" ? { body: F.OCTOPUS_ACCOUNT } : { status: 404, body: F.OCTOPUS_NOT_FOUND };
  });
  const choices = await findOctopusMeters(" a-1234abcd ", { token: "sk_live_x" });
  assert.deepEqual(choices, [
    { group: "electricity", values: { mpan: "1200012345678", serial: "21L1234567" }, label: "Electricity · 1200012345678 · 21L1234567" },
    { group: "gas", values: { mprn: "1234567890", serial: "E6S12345" }, label: "Gas · 1234567890 · E6S12345" },
    { group: "gas", values: { mprn: "1234567890", serial: "G4A12345678" }, label: "Gas · 1234567890 · G4A12345678" },
  ]);
  assert.ok(seen.every((s) => s.method === "GET"));
  assert.equal(JSON.stringify(choices).includes("New Road"), false, "the home's address is never passed on");
  await assert.rejects(findOctopusMeters("A-WRONG000", { token: "sk_live_x" }), /can't find that account number/);
  await assert.rejects(findOctopusMeters("12345", { token: "sk_live_x" }), AthenaInputError);
  await assert.rejects(findOctopusMeters("A-1234ABCD", {}), /API key first/);
  assert.equal(directFor({ provider: "octopus", auth_type: "token", oauth: {} })?.findAddress, findOctopusMeters);
});

test("Octopus: half hours by local day, following next; the line says when most was used", async () => {
  const day = F.octopusDay();
  F.stub((url) => {
    if (url.host !== "api.octopus.energy") return undefined;
    if (url.searchParams.get("page_size") === "1") return { body: { count: 1, next: null, results: day.slice(0, 1) } };
    if (url.searchParams.get("page") === "2") return { body: { count: 48, next: null, results: day.slice(24) } };
    return { body: { count: 48, next: `https://api.octopus.energy${url.pathname}?page=2`, results: day.slice(0, 24) } };
  });
  const acct = await openOctopus(conn("octopus", "token", { url: octopusAddress("1200012345678 21L1234567") }), { token: "sk_live_x" }, "Europe/London");
  const r = JSON.parse((await acct.call("consumption", { date: "2026-11-06" })).text);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].date, "2026-11-06");
  assert.equal(r.items[0].half_hours.length, 48);
  assert.equal(homeLine(r.items[0]), "7.3 kWh, mostly 18:00–22:00");
  assert.equal((F.calls[0].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("sk_live_x:").toString("base64")}`);
  F.stub(F.at("api.octopus.energy", "/v1/electricity-meter-points/1200012345678/meters/21L1234567/consumption/", F.OCTOPUS_UNAUTH, 401));
  const err = await openOctopus(conn("octopus", "token", { url: octopusAddress("1200012345678 21L1234567") }), { token: "bad" }, "UTC").catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
});

// ---------- lib/money.ts ----------

test("money days: grouped by the owner's local day across zones, one currency, transfers never spending", () => {
  const txns = [
    { id: "a", at: "2026-11-07T00:30:00Z", amount: 650, currency: "GBP", category: "transport" as const },
    { id: "b", at: "2026-11-06T12:40:00Z", amount: 1800, currency: "GBP", category: "eating_out" as const, merchant: "Dishoom" },
    { id: "b", at: "2026-11-06T12:40:00Z", amount: 1800, currency: "GBP", category: "eating_out" as const },
    { id: "c", at: "2026-11-06T13:00:00Z", amount: 500, currency: "EUR", category: "shopping" as const },
  ];
  const london = moneyDays(txns, "Europe/London");
  assert.deepEqual([...london.keys()].sort(), ["2026-11-06", "2026-11-07"]);
  assert.equal(london.get("2026-11-06")!.spent, 1800); // the same id twice counts once; euros left out
  const ny = moneyDays(txns, "America/New_York");
  assert.equal(ny.get("2026-11-06")!.spent, 2450); // 00:30 London is 19:30 the day before in New York
  assert.equal(categoryOf("monzo", "transfers"), null);
  assert.equal(categoryOf("starling", "INCOME"), null);
  assert.equal(categoryOf("monzo", "eating_out", "Uber Eats"), "takeaway");
  assert.equal(categoryOf("starling", "SOMETHING_NEW"), "general");
});

test("money and home lines read as one short sentence", () => {
  const d = mergeMoney([
    { currency: "GBP", spent: 4200, count: 2, categories: { eating_out: 1800, groceries: 2400 }, payments: [] },
    { currency: "GBP", spent: 0, count: 0, categories: {}, payments: [] },
  ])!;
  assert.equal(moneyLine(d), "£42 spent · groceries £24 · eating out £18");
  assert.equal(moneyLine({ currency: "GBP", spent: 450, count: 1, categories: { eating_out: 450 }, payments: [] }), "£4.50 spent, all eating out");
  assert.equal(eatingOut({ currency: "GBP", spent: 0, count: 0, categories: { eating_out: 1000, takeaway: 2000 }, payments: [] }), 3000);
  const flat = homeDays(F.octopusDay("2026-11-06", () => 0.1).map((r) => ({ start: r.interval_start, kwh: r.consumption })), [], "UTC").get("2026-11-06")!;
  assert.equal(homeLine(flat), "4.8 kWh");
  const h = dayHome(homeDays(F.octopusDay().map((r) => ({ start: r.interval_start, kwh: r.consumption })), [], "UTC").get("2026-11-06")!);
  assert.equal(h.by_hour?.length, 24);
  assert.ok(h.evening_share! > 0.6 && h.evening_share! < 0.7);
  // A gas-only day (null: no electricity meter) has no electricity at all, and an electricity day no gas.
  const gasOnly = homeDays(null, F.octopusDay("2026-11-06", () => 0.25).map((r) => ({ start: r.interval_start, kwh: r.consumption })), "UTC");
  assert.deepEqual(Object.fromEntries(gasOnly), { "2026-11-06": { gas_kwh: 12 } });
  assert.equal(dayHome(gasOnly.get("2026-11-06")!).kwh, undefined);
  assert.equal(h.gas_kwh, undefined);
  // The Money page's Energy months: a gas-only month has no electricity row; old electricity rows still count.
  const months = homeMonths(new Map([
    ["2026-10-31", { kwh: 8, half_hours: Array<number>(48).fill(8 / 48) }],
    ["2026-11-05", { gas_kwh: 20 }],
    ["2026-11-06", { gas_kwh: 30 }],
  ]));
  assert.deepEqual(months, [
    { month: "2026-11", gas: { kwh: 50, days: 2 } },
    { month: "2026-10", electricity: { kwh: 8, evening_share: 0.21, days: 1 } },
  ]);
  assert.ok(sameShop("AMAZON* MKTPLACE PMTS", "Amazon"));
  assert.ok(sameShop("Waitrose & Partners", "Waitrose"));
  assert.ok(!sameShop("Co", "Costa"));
});

test("Ask's money gate: spending, banks and energy questions only", () => {
  for (const q of ["What do I spend on eating out a month?", "How much did I pay at Waitrose?", "Monzo in October", "How much electricity did we use?", "what did that cost me"]) assert.ok(isMoneyQuestion(q), q);
  for (const q of ["What did I watch last week?", "How did I sleep?", "Which habits did I keep in October?", "When did I last see Priya?"]) assert.ok(!isMoneyQuestion(q), q);
});
