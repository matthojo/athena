// Real path for money, home and habits: the real /api function, a real Life log run (executeRun) that reads Monzo, Starling and
// Octopus without Claude, Ask with a scripted model, and Postgres with every migration (0035 included). Banks and the meter are stubbed.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/life/life.db.test.ts
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

test("Money, home and habits: sealed by a model-free sync, opt-in on Days, read by Ask only through its tools", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { handleConnectorRoutes } = await import("../connectors/routes");
  const { executeRun } = await import("../connectors/runner");
  const { q, qRaw } = await import("../../../lib/db");
  const C = await import("../../../lib/connectors");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { getDay, readEntry, writeEntries } = await import("../../../lib/days");
  const { createPurchase } = await import("../../../lib/trips");
  const { answerQuestion } = await import("../../../lib/answer");
  const { answerSourcesWith } = await import("../connectors/answer-sources");
  const { lifeRetryWaits } = await import("../connectors/lifelog-b-http");
  const F = await import("../connectors/fixtures/life-recorded");
  lifeRetryWaits.ms = [1, 1];
  const TZ = "Europe/London";

  for (const t of ["collected_items", "collection_runs", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM purchases`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('money', 'home')`);
  await qRaw(`DELETE FROM settings WHERE key IN ('money_backfill', 'days_money_home')`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  // "Let Ask read transactions" on, for Ask's money below (off is in lib/ask-real.db.test.ts).
  await (await import("../../../lib/money")).saveAskMoney({ on: true });

  const today = zonedToday(new Date(), TZ);
  const day = addDays(today, -1);
  const at = (hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();

  // ---- the database refuses money and home that isn't sealed ----
  await assert.rejects(qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext, day, source) VALUES ('money', 'Money', '{"spent":4200}', '2026-11-02', 'monzo')`));
  await assert.rejects(qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext) VALUES ('home', 'Home', 'enc:v1:abc:def')`), "a home row always has a day");
  await assert.rejects(qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext, day, source) VALUES ('money', 'Spent £42.00', 'enc:v1:abc:def', '2026-11-02', 'monzo')`), "no amount in a label");
  // A habit can be not done (count 0); nothing else can.
  await assert.rejects(qRaw(`INSERT INTO day_entries (date, kind, source, title, count) VALUES ('2026-11-02', 'watched', 'trakt', 'x', 0)`));

  // ---- a purchase that day, so the Waitrose payment links to it ----
  const { purchase } = await createPurchase({ retailer: "Waitrose", items: ["Groceries"], ordered_on: day } as never);

  // ---- the banks and the meter, stubbed ----
  const realFetch = globalThis.fetch;
  const seen: URL[] = [];
  const txns = [
    { ...F.MONZO_TXNS[0], created: at("12:40") },
    { ...F.MONZO_TXNS[1], created: at("17:55") },
    { ...F.MONZO_TXNS[2], created: at("20:15") },
    { ...F.MONZO_TXNS[3], created: at("09:00") },
  ];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    seen.push(u);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.host === "api.monzo.com" && u.pathname === "/accounts") return reply(F.MONZO_ACCOUNTS);
    if (u.host === "api.monzo.com" && u.pathname === "/transactions") {
      const since = u.searchParams.get("since");
      const before = Date.parse(u.searchParams.get("before") ?? "") || Infinity;
      return reply({ transactions: txns.filter((t) => (!since || since.startsWith("tx_") || Date.parse(t.created) >= Date.parse(since)) && Date.parse(t.created) < before) });
    }
    if (u.host === "api.octopus.energy") return reply({ count: 48, next: null, results: u.searchParams.get("page_size") === "1" ? [] : F.octopusDay(day) });
    throw new Error(`unexpected fetch ${u.host}${u.pathname} ${init.method ?? "GET"}`);
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
  const logged: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));

  try {
    const monzo = await routes("POST", "/connectors", { provider: "monzo", name: "Monzo", account_label: "personal", client_id: "oauth2client_00009", client_secret: "mnzconf.secret" });
    assert.ok(monzo.id, JSON.stringify(monzo));
    await C.updateConnectorSecrets(monzo.id, (s) => {
      s.tokens = { access_token: "monzo_access_1", refresh_token: "monzo_refresh_1", expires_in: 21600, obtained_at: Date.now() };
    });
    const octopus = await routes("POST", "/connectors", { provider: "octopus", name: "Octopus Energy", account_label: "home", url: "1200012345678 21L1234567", token: "sk_live_x" });
    assert.ok(octopus.id, JSON.stringify(octopus));
    assert.equal((await C.getConnector(octopus.id))!.url, "https://api.octopus.energy/v1/electricity-meter-points/1200012345678/meters/21L1234567/");

    // ---- a Life log run with only the bank and the meter: no Claude, sealed days, counts-only summary ----
    const life = await routes("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [monzo.id, octopus.id], schedule: "daily", run_at: "23:30" });
    const run = await C.queueRun(life.id, "manual");
    await executeRun(run.id, new Date());
    // Run summaries are sealed at rest: q() opens them.
    const [done] = await q<{ status: string; error: string | null; summary: string | null }>(`SELECT status, error, summary FROM collection_runs WHERE id = $1`, [run.id]);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.match(done.summary ?? "", /Monzo: \d+ days? updated/);
    assert.match(done.summary ?? "", /Octopus Energy: \d+ days? updated/);
    assert.doesNotMatch(done.summary ?? "", /£|\d+\.\d|Dishoom|Waitrose|kWh/);
    assert.ok(seen.every((u) => ["api.monzo.com", "api.octopus.energy"].includes(u.host)), "no model, no other host");
    // Approved in the app this minute, so the run read Monzo's whole history: a transactions call with no since.
    assert.ok(seen.some((u) => u.pathname === "/transactions" && !u.searchParams.get("since")));

    const rows = await qRaw<{ domain: string; source: string; label: string; ciphertext: string }>(`SELECT domain, source, label, ciphertext FROM sensitive_blobs WHERE domain IN ('money', 'home') ORDER BY domain`);
    // The sync also refreshes the sealed list of regular payments (lib/money.ts, source 'recurring').
    assert.deepEqual([...new Set(rows.map((r) => `${r.domain}/${r.source}`))].sort(), ["home/octopus", "money/monzo", "money/recurring"]);
    for (const r of rows.filter((x) => x.source !== "recurring")) {
      assert.match(r.ciphertext, /^enc:v1:/);
      assert.match(r.label, /^(Money|Home) · \d{4}-\d{2}-\d{2} · (Monzo|Octopus Energy)$/);
      assert.ok(!/Dishoom|Waitrose|1800|kwh/i.test(r.label));
    }

    // ---- Days: nothing until the owner turns each on ----
    assert.equal((await getDay(day, { tz: TZ }))!.money, undefined, "off unless asked");
    let r = await call("GET", `/days/${day}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.money, undefined);
    assert.equal(r.json.home, undefined);
    assert.deepEqual((await call("GET", "/life/prefs")).json, { money: false, home: false });
    assert.equal((await call("PUT", "/life/prefs", { money: "yes" })).status, 400);
    assert.deepEqual((await call("PUT", "/life/prefs", { money: true })).json, { money: true, home: false });
    r = await call("GET", `/days/${day}`);
    assert.equal(r.json.money.line, "£64 spent · groceries £24 · takeaway £22");
    assert.equal(r.json.home, undefined, "Home stays off");
    await call("PUT", "/life/prefs", { home: true });
    r = await call("GET", `/days/${day}`);
    assert.equal(r.json.home.line, "7.3 kWh, mostly 18:00–22:00");
    assert.equal(r.json.home.by_hour.length, 24);

    // The Waitrose payment is linked to the purchase; the purchase itself gets no amount.
    const [blob] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'money' AND day = $1::date`, [day]);
    const { openStrict } = await import("../../../lib/data-box");
    const figures = JSON.parse(openStrict(blob.ciphertext)) as { payments: Array<{ merchant?: string; purchase_id?: string }> };
    assert.equal(figures.payments.find((p) => p.merchant?.startsWith("Waitrose"))?.purchase_id, purchase.id);
    const p = await call("GET", `/purchases/${purchase.id}`);
    assert.doesNotMatch(p.text, /24\.00|2400|£/);

    // ---- the Library's Money page: months by category and merchant, never a balance ----
    const m = await call("GET", `/life/money?from=${addDays(today, -30)}&to=${today}`);
    assert.equal(m.status, 200, m.text);
    assert.equal(m.json.months[0].merchants[0].name, "Waitrose & Partners");
    assert.equal(m.json.home, undefined, "energy is on House now");
    const house = await call("GET", "/life/house");
    assert.equal(house.status, 200, house.text);
    assert.deepEqual(house.json.energy.fuels, ["electricity"], "no gas meter, no gas");
    assert.equal(house.json.energy.months.at(-1).electricity.days >= 1, true);
    assert.equal(house.json.energy.months.at(-1).gas, undefined);
    assert.equal(house.json.costs, "no_account");
    assert.doesNotMatch(m.text, /balance/);
    assert.equal((await call("GET", "/life/money?from=2020-01-01&to=2026-11-01")).status, 400);

    // ---- habits: done and not done, a streak, the weekday split ----
    // Through readEntry, as the runner's athena_day_entry does: a habit's count 0 is kept.
    const habit = (date: string, id: string, title: string, count: number, note?: string) => ({ date, entry: readEntry({ kind: "habit", source: "habitify", external_id: `${id}:${date}`, title, count, ...(note ? { note } : {}) }) });
    await writeEntries([habit(day, "read", "Read 20 pages", 1), habit(day, "water", "Drink water", 0, "3 of 5 glasses"), habit(addDays(day, -1), "read", "Read 20 pages", 1)]);
    const hb = await call("GET", "/life/habits");
    assert.equal(hb.status, 200, hb.text);
    const read = hb.json.habits.find((x: { name: string }) => x.name === "Read 20 pages");
    assert.equal(read.streak, 2);
    const water = hb.json.habits.find((x: { name: string }) => x.name === "Drink water");
    assert.deepEqual(water.days, [{ date: day, done: false, note: "3 of 5 glasses" }]);
    const dayEntries = (await getDay(day, { tz: TZ }))!.entries.filter((e) => e.kind === "habit");
    assert.deepEqual(dayEntries.map((e) => [e.title, e.count ?? 1]).sort(), [["Drink water", 0], ["Read 20 pages", 1]]);

    // ---- Ask: money only when a tool that reads it is called (a day in full, or money), never in a range of days ----
    const ask = async (question: string, calls: Array<{ tool?: string } & Record<string, unknown>>) => {
      const seenByModel: string[] = [];
      let round = 0;
      const client = {
        messages: {
          async create(params: { messages: unknown }) {
            const base = { id: `m${round}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
            seenByModel.push(JSON.stringify(params.messages));
            if (round++ === 0) return { ...base, stop_reason: "tool_use", content: calls.map(({ tool = "days", ...input }, i) => ({ type: "tool_use", id: `t${i}`, name: tool, input })) };
            return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "done", name: "answer", input: { found: true, text: "Done [1].", sources: [{ ref: `day:${day}`, title: "Day", date: day }] } }] };
          },
        },
      };
      await answerQuestion(question, { sources: answerSourcesWith({ list: async () => [], open: async () => null as never }), client: client as never }, { tz: TZ });
      return seenByModel.join("\n");
    };
    const films = await ask("What did I watch yesterday?", [{ from: addDays(day, -3), to: day }]);
    assert.doesNotMatch(films, /£|Waitrose|kWh|spent/, "no money in a range of days");
    const spend = await ask("What did I spend on takeaways yesterday?", [{ date: day }, { tool: "money", from: day, to: day, group_by: "category" }]);
    assert.match(spend, /£64 spent/, "a day in full has its spending line");
    assert.match(spend, /takeaway[^£]{0,40}£21\.50/, "the money tool totals by category, to the penny");
    assert.match(spend, /eating out[^£]{0,40}£18\.00/);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, orig);
  }
  assert.ok(!logged.some((l) => /£|Dishoom|Waitrose|\d+\.\d+ ?kWh|monzo_access|sk_live/i.test(l)), `logged: ${logged.join(" | ")}`);
});
