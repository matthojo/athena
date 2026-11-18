// Logging from a sentence on the real path: Ask's one loop (lib/answer.ts) with the real database, the real
// Anthropic client and the model stubbed at fetch. The scripted model calls log_spending, log_health,
// log_day_entry and log_meter_reading; nothing is saved until the "tap", which goes through the real /api
// function with what the app's card sends (app/src/components/ask-confirm.ts). Health typed in before stays.
// With "Let Ask read transactions" off, log_spending isn't offered and the reply says how to add it instead.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/ask-logging.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Other tests share the database: this one wipes nothing, counts on top of
// what's there, works on a day of its own, and takes out what it added.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  content?: unknown;
}
interface Req {
  tools: Array<{ name: string; input_schema?: { properties?: object } }>;
  messages: Array<{ role: string; content: string | Block[] }>;
}

const realFetch = globalThis.fetch;
const seen: Req[] = [];
let script: (req: Req) => Block[] = () => [];
const results = (req: Req) => req.messages.reduce((n, m) => n + (typeof m.content === "string" ? 0 : m.content.filter((b) => b.type === "tool_result").length), 0);

before(() => {
  if (!url) return;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.host !== "api.anthropic.com" || u.pathname !== "/v1/messages") throw new Error(`Unexpected fetch in a test: ${u.href}`);
    const body = JSON.parse(String(init.body ?? (input instanceof Request ? await input.text() : "{}"))) as Req & { stream?: boolean };
    seen.push(body);
    const content = script(body);
    const m = { id: `msg_${seen.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!body.stream) return new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/json", "request-id": "req_test" } });
    const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let out = sse("message_start", { type: "message_start", message: { ...m, content: [], stop_reason: null } });
    for (const [index, b] of content.entries()) {
      out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      out += sse("content_block_stop", { type: "content_block_stop", index });
    }
    out += sse("message_delta", { type: "message_delta", delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    out += sse("message_stop", { type: "message_stop" });
    return new Response(out, { status: 200, headers: { "Content-Type": "text/event-stream", "request-id": "req_test" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const noSources = async () => {
  const { answerSourcesWith } = await import("../netlify/lib/connectors/answer-sources");
  return answerSourcesWith({ list: async () => [], open: async () => null as never });
};

async function api() {
  const fn = (await import("../netlify/functions/api")).default;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fn(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
}

/** The answer tool's input, with needs_money when the schema asks for it. */
function answer(req: Req, text: string, needsMoney = false): Block {
  const schema = req.tools.find((t) => t.name === "answer")?.input_schema?.properties ?? {};
  return { type: "tool_use", id: "tu_answer", name: "answer", input: { text, found: false, general: false, from_today: false, sources: [], next: [], ask: { question: "", options: [], more: [] }, ...("needs_web" in schema ? { needs_web: false } : {}), ...("needs_money" in schema ? { needs_money: needsMoney } : {}) } };
}

/** Everything a log could have written: compared before and after Ask's turn. */
async function snapshot() {
  const { qRaw } = await import("./db");
  const blobs = await qRaw<{ domain: string; source: string; day: string | null; ciphertext: string }>(
    `SELECT domain, source, to_char(day, 'YYYY-MM-DD') AS day, ciphertext FROM sensitive_blobs WHERE source IN ('manual', 'readings') ORDER BY domain, source, day`,
  );
  const entries = await qRaw<{ id: string }>(`SELECT id FROM day_entries WHERE source = 'manual' ORDER BY id`);
  return JSON.stringify({ blobs, entries });
}

test("Ask logs from a sentence: four cards, nothing saved before the tap, and health typed in before stays", { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { saveAskMoney } = await import("./money");
  const { zonedToday, addDays } = await import("./dates");
  const { qRaw } = await import("./db");
  const { mergeHealth } = await import("./ask-logging");
  const call = await api();
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await saveAskMoney({ on: true });
  const today = zonedToday(new Date(), TZ);
  // A day of this test's own, a little way back: what other tests leave is on other days, or counted around.
  const day = addDays(today, -3);
  const healthBefore = (await call("GET", `/health/manual?date=${day}`)).json.figures;
  assert.equal((await call("PUT", "/health/manual", { date: day, steps: 8400, weight_kg: 72.4 })).status, 200);

  const before = await snapshot();
  seen.length = 0;
  const calls: Block[] = [
    { type: "tool_use", id: "tu_1", name: "log_spending", input: { amount: "£4", what: "Coffee", category: "eating_out", date: day } },
    { type: "tool_use", id: "tu_2", name: "log_health", input: { sleep_hours: 7, date: day } },
    { type: "tool_use", id: "tu_3", name: "log_day_entry", input: { kind: "watched", title: "Perfect Days", date: day } },
    { type: "tool_use", id: "tu_4", name: "log_meter_reading", input: { fuel: "electricity", value: 12345, date: day } },
  ];
  script = (req) => {
    const n = results(req);
    return n < calls.length ? [calls[n]] : [answer(req, "Four things are ready to save. Tap each to keep it.")];
  };
  const reply = await answerQuestion(`On ${day} I spent £4 on coffee, slept 7 hours, watched Perfect Days and the electricity meter read 12345`, { sources: await noSources() }, { tz: TZ });

  // Every tool was offered, and each answered that nothing was saved.
  const offered = seen[0].tools.map((t) => t.name);
  for (const t of ["log_spending", "log_health", "log_day_entry", "log_meter_reading"]) assert.ok(offered.includes(t), t);
  const told = seen[seen.length - 1].messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result").map((b) => String(b.content))));
  assert.equal(told.length, 4);
  for (const t of told) assert.match(t, /Nothing has been sent or saved yet/);
  assert.deepEqual(
    (reply.confirm ?? []).map((c) => c.kind),
    ["log_spending", "log_health", "log_entry", "log_reading"],
  );
  assert.equal(reply.changes?.length ?? 0, 0, "no receipts: nothing was made");
  assert.equal(reply.plan, undefined, "and no plan to Go on");
  assert.equal(await snapshot(), before, "nothing written before the tap");

  const [spend, health, entry, reading] = reply.confirm as Array<Record<string, unknown>>;
  assert.deepEqual(spend, { kind: "log_spending", date: day, amount: 400, currency: "GBP", category: "eating_out", merchant: "Coffee" });
  assert.deepEqual(health, { kind: "log_health", date: day, figures: { sleep_minutes: 420 }, keeps: ["steps", "weight"] });
  assert.deepEqual(entry, { kind: "log_entry", date: day, entry: { kind: "watched", title: "Perfect Days" } });
  assert.equal(reading.value, 12345);

  // The tap: what the app's card sends, through the manual-entry routes.
  const paid = await call("POST", "/life/spending", { date: spend.date, amount: spend.amount, currency: spend.currency, category: spend.category, merchant: spend.merchant });
  assert.equal(paid.status, 201, paid.text);
  const typed = (await call("GET", `/health/manual?date=${day}`)).json.figures;
  assert.equal((await call("PUT", "/health/manual", { date: day, ...mergeHealth(typed, (health as { figures: object }).figures) })).status, 200);
  assert.deepEqual((await call("GET", `/health/manual?date=${day}`)).json.figures, { sleep_minutes: 420, steps: 8400, weight_kg: 72.4 }, "steps and weight typed before are still there");
  const added = await call("POST", `/days/${day}/entries`, (entry as { entry: object }).entry);
  assert.equal(added.status, 201, added.text);
  const read = await call("POST", "/life/readings", { fuel: reading.fuel, date: reading.date, value: reading.value, unit: reading.unit });
  assert.equal(read.status, 201, read.text);
  assert.notEqual(await snapshot(), before);
  assert.ok((await call("GET", `/days/${day}`)).json.entries.some((e: { title: string; source: string }) => e.title === "Perfect Days" && e.source === "manual"));

  // Tidy up for the tests that share this database.
  await call("DELETE", `/life/spending?date=${day}&id=${paid.json.id}`);
  if (added.json.id) await call("DELETE", `/days/${day}/entries/${added.json.id}`);
  const mine = (read.json.readings as Array<{ id: string; fuel: string; date: string }>).find((r) => r.fuel === "electricity" && r.date === day);
  if (mine) await call("DELETE", `/life/readings?id=${mine.id}`);
  if (healthBefore) await call("PUT", "/health/manual", { date: day, ...healthBefore });
  else await call("DELETE", `/health/manual?date=${day}`);
});

test("with Let Ask read transactions off, log_spending isn't offered and the reply says how to add it", { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { saveAskMoney } = await import("./money");
  const { MONEY_LOG_OFF_TEXT } = await import("./ask-tools");
  await saveAskMoney({ on: false });
  try {
    const before = await snapshot();
    seen.length = 0;
    script = (req) => [answer(req, "I can't add spending.", true)];
    const reply = await answerQuestion("I spent £4 on coffee", { sources: await noSources() }, { tz: TZ });
    const offered = seen[0].tools.map((t) => t.name);
    assert.ok(!offered.includes("log_spending"), "not offered");
    assert.ok(offered.includes("log_health") && offered.includes("log_day_entry") && offered.includes("log_meter_reading"), "the other three still are");
    assert.equal(reply.text, MONEY_LOG_OFF_TEXT, "the fixed line: turn it on, or use the Money page");
    assert.match(reply.text, /Let Ask read transactions/);
    assert.match(reply.text, /Money page/);
    assert.deepEqual(reply.setting, { label: "Let Ask read transactions", href: "#/settings/about" });
    assert.equal(reply.confirm, undefined);
    assert.equal(await snapshot(), before);

    // Switched on: offered again.
    await saveAskMoney({ on: true });
    seen.length = 0;
    script = (req) => [answer(req, "Fine.")];
    await answerQuestion("How did I sleep?", { sources: await noSources() }, { tz: TZ });
    assert.ok(seen[0].tools.some((t) => t.name === "log_spending"));
  } finally {
    await saveAskMoney({ on: true });
  }
});
