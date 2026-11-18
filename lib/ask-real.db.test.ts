// Ask on the real path: answerQuestion with Athena's real database (money and health days sealed the way
// collections save them), the real Anthropic client from lib/ai.ts, and the model stubbed at fetch. The
// scripted model calls the shared read tools (lib/ask-tools.ts), then answers citing what they returned;
// the answer's citations are checked by lib/answer.ts against what the tools really gave.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/ask-real.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties money, health, days and events first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}
interface Req {
  system: string;
  tools: Array<{ name: string }>;
  messages: Array<{ role: string; content: string | Block[] }>;
}

const realFetch = globalThis.fetch;
const seen: Req[] = [];
/** The model's next turn, given the request so far. */
let script: (req: Req) => Block[] = () => [];

function message(content: Block[]) {
  const usesTool = content.some((b) => b.type === "tool_use");
  return {
    id: `msg_${seen.length}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: usesTool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** The last tool result the model was sent, parsed. */
function lastResult(req: Req): Record<string, unknown> {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const c = req.messages[i].content;
    if (typeof c === "string") continue;
    const r = c.find((b) => b.type === "tool_result");
    if (r) return JSON.parse(String(r.content));
  }
  throw new Error("no tool result yet");
}
const hasResult = (req: Req) => req.messages.some((m) => typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result"));

before(() => {
  if (!url) return;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") {
      const body = JSON.parse(String(init.body ?? (input instanceof Request ? await input.text() : "{}"))) as Omit<Req, "system"> & { system: string | Array<{ text: string }> };
      const req: Req = { ...body, system: typeof body.system === "string" ? body.system : body.system.map((s) => s.text).join("") };
      seen.push(req);
      const m = message(script(req));
      if (!(body as { stream?: boolean }).stream) return new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/json", "request-id": "req_test" } });
      // The streamed path (ask-polish's streamMessage): the same turn as server-sent events, tool input in pieces.
      const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      let out = sse("message_start", { type: "message_start", message: { ...m, content: [], stop_reason: null } });
      for (const [index, b] of m.content.entries()) {
        if (b.type === "text") {
          out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          for (const piece of String(b.text).match(/[\s\S]{1,6}/g) ?? []) out += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
        } else {
          out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          for (const piece of JSON.stringify(b.input).match(/[\s\S]{1,8}/g) ?? []) out += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } });
        }
        out += sse("content_block_stop", { type: "content_block_stop", index });
      }
      out += sse("message_delta", { type: "message_delta", delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
      out += sse("message_stop", { type: "message_stop" });
      return new Response(out, { status: 200, headers: { "Content-Type": "text/event-stream", "request-id": "req_test" } });
    }
    throw new Error(`Unexpected fetch in a test: ${u.href}`);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function seed() {
  const { qRaw } = await import("./db");
  const { zonedToday, addDays, zonedToInstant } = await import("./dates");
  const { moneyDays, saveMoneyDays } = await import("./money");
  const { saveHealthDay } = await import("./health");
  const { clearAskContextCache } = await import("./ask-context");
  const { saveAskMoney } = await import("./money");
  await saveAskMoney({ on: true });
  for (const t of ["day_entries", "days", "events", "commitments", "reminders", "trip_bookings", "trips", "ask_threads"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('health', 'location', 'money', 'home')`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  clearAskContextCache();

  const today = zonedToday(new Date(), TZ);
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const at = (date: string, time: string) => zonedToInstant(date, time, TZ).toISOString();
  await saveMoneyDays(
    "monzo",
    moneyDays(
      [
        { id: "m1", at: at(`${lastMonth}-03`, "08:10"), amount: 425, currency: "GBP", category: "groceries", merchant: "Tesco Express" },
        { id: "m2", at: at(`${lastMonth}-17`, "18:02"), amount: 5_230, currency: "GBP", category: "groceries", merchant: "TESCO STORES 2041" },
        { id: "m3", at: at(`${lastMonth}-17`, "12:30"), amount: 650, currency: "GBP", category: "eating_out", merchant: "Pret A Manger" },
        // This month's Tesco isn't last month's.
        { id: "m4", at: at(today, "07:45"), amount: 1_200, currency: "GBP", category: "groceries", merchant: "Tesco" },
      ],
      TZ,
    ),
    { tz: TZ },
  );
  // The last seven nights: on a Monday, "this week" is the week just gone.
  const monday = addDays(today, -6);
  const week: string[] = [];
  for (let d = monday; d <= today; d = addDays(d, 1)) week.push(d);
  for (const [i, date] of week.entries()) {
    await saveHealthDay({ date, source: "oura", sleep_minutes: 420 + i * 10, sleep_stages: { deep: 75 + i }, resting_hr: 53 - (i % 2) }, { tz: TZ });
    await saveHealthDay({ date, source: "whoop", recovery: 60 + i }, { tz: TZ });
  }
  return { today, lastMonth, monday, week };
}

const noSources = async () => {
  const { answerSourcesWith } = await import("../netlify/lib/connectors/answer-sources");
  return answerSourcesWith({ list: async () => [], open: async () => null as never });
};

test('"how much did I spend at Tesco last month" answers with the total and cites the days', { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { lastMonth } = await seed();
  const { addDays } = await import("./dates");
  const end = addDays(`${lastMonth}-28`, 4).slice(0, 7) === lastMonth ? addDays(`${lastMonth}-28`, 4) : addDays(`${addDays(`${lastMonth}-28`, 4).slice(0, 7)}-01`, -1);
  seen.length = 0;
  script = (req) => {
    if (!hasResult(req)) return [{ type: "tool_use", id: "tu_1", name: "money", input: { merchant: "tesco", from: `${lastMonth}-01`, to: end } }];
    const r = lastResult(req) as { total: string; payments: Array<{ ref: string; date: string; merchant: string }> };
    return [
      {
        type: "tool_use",
        id: "tu_2",
        name: "answer",
        input: {
          text: `You spent ${r.total} at Tesco last month, over ${r.payments.length} payments [1][2].`,
          found: true,
          sources: r.payments.map((p) => ({ ref: p.ref, title: p.merchant, date: p.date })),
        },
      },
    ];
  };

  const reply = await answerQuestion("How much did I spend at Tesco last month?", { sources: await noSources() }, { tz: TZ });

  assert.equal(reply.found, true, reply.text);
  assert.equal(reply.text, "You spent £56.55 at Tesco last month, over 2 payments [1][2].");
  assert.equal(reply.searched, "Searched your transactions", "the footer names what was read");
  assert.deepEqual(reply.sources.map((s) => [s.kind, s.id]), [["day", `${lastMonth}-17`], ["day", `${lastMonth}-03`]]);
  assert.ok(reply.sources.every((s) => s.url === null && s.account === null));
  // The money tool was offered without a keyword gate, next to the rest; today's context went in the system prompt.
  assert.ok(seen[0].tools.some((t) => t.name === "money") && seen[0].tools.some((t) => t.name === "goals"));
  assert.match(seen[0].system, /<today>\nNow: /);
  assert.doesNotMatch(seen[0].system.slice(seen[0].system.indexOf("<today>")), /£|Tesco/, "no money in today's context");
});

test('"how did I sleep this week" answers from the health tool and cites the nights', { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { hoursMinutes } = await import("./health-line");
  const { monday, today, week } = await seed();
  seen.length = 0;
  script = (req) => {
    if (!hasResult(req)) return [{ type: "tool_use", id: "tu_1", name: "health", input: { from: monday, to: today } }];
    const r = lastResult(req) as { days: Array<{ ref: string; date: string }>; averages: { sleep: string; recovery: string } };
    const best = r.days[r.days.length - 1];
    return [
      {
        type: "tool_use",
        id: "tu_2",
        name: "answer",
        input: {
          text: `You averaged ${r.averages.sleep} a night this week [1], with recovery around ${r.averages.recovery}; last night was your longest [2].`,
          found: true,
          sources: [
            { ref: r.days[0].ref, title: "Monday", date: r.days[0].date },
            { ref: best.ref, title: "Last night", date: best.date },
            // Made up: never returned by a tool, so it's dropped.
            { ref: "day:1999-01-01", title: "Invented", date: "1999-01-01" },
          ],
        },
      },
    ];
  };

  const reply = await answerQuestion("How did I sleep this week?", { sources: await noSources() }, { tz: TZ });

  assert.equal(reply.found, true, reply.text);
  const avg = Math.round(week.reduce((s, _, i) => s + 420 + i * 10, 0) / week.length);
  assert.equal(week.length, 7);
  assert.equal(reply.text, `You averaged ${hoursMinutes(avg)} a night this week [1], with recovery around 63%; last night was your longest [2].`);
  assert.deepEqual(reply.sources.map((s) => `${s.kind}:${s.id}`), [`day:${monday}`, `day:${today}`]);
  assert.ok(!reply.sources.some((s) => s.id === "1999-01-01"), "an invented source is dropped");
  assert.equal(reply.searched, "Searched your health figures");
  // Today's context already carried last night's sleep.
  assert.match(seen[0].system, /Last night: \d+h( \d+m)? asleep/);
});

test('"what\'s first tomorrow?" answers from today\'s context with no lookup, and a sourceless answer without it is refused', { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { qRaw } = await import("./db");
  const { addDays, zonedToInstant } = await import("./dates");
  const { today } = await seed();
  const tomorrow = addDays(today, 1);
  await qRaw(`INSERT INTO events (title, kind, date, starts_at) VALUES ('Design review', 'other', $1::date, $2::timestamptz)`, [tomorrow, zonedToInstant(tomorrow, "09:30", TZ).toISOString()]);
  seen.length = 0;
  script = (req) => {
    const said = /- 09:30 Design review/.test(req.system.slice(req.system.indexOf("Tomorrow")));
    return [{ type: "tool_use", id: "tu_1", name: "answer", input: { text: said ? "Design review at 09:30 is first tomorrow." : "No idea.", found: said, from_today: true, sources: [] } }];
  };
  const reply = await answerQuestion("What's first tomorrow?", { sources: await noSources() }, { tz: TZ });
  assert.equal(reply.found, true);
  assert.equal(reply.text, "Design review at 09:30 is first tomorrow.");
  assert.deepEqual(reply.sources, []);
  assert.equal(reply.searched, "From your day in Athena");
  assert.equal(seen.length, 1, "no lookup needed");

  // Claiming an answer with no sources and not from today's block: not shown.
  script = () => [{ type: "tool_use", id: "tu_1", name: "answer", input: { text: "You spent £900 on shoes.", found: true, from_today: false, sources: [] } }];
  const made = await answerQuestion("How much did I spend on shoes?", { sources: await noSources() }, { tz: TZ });
  assert.equal(made.found, false);
  assert.equal(made.text, "I couldn't find anything about that.");
});

test("money search off: a spending question gets the switch, said by the one loop, and money tools aren't offered", { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { saveAskMoney } = await import("./money");
  await seed();
  await saveAskMoney({ on: false });
  seen.length = 0;
  // Nothing in front of the loop guesses: the model reads the message and says it asked about spending.
  script = (req) => [{ type: "tool_use", id: "tu_1", name: "answer", input: { text: "I can't see your spending.", found: false, general: false, from_today: false, sources: [], next: [], ask: { question: "", options: [], more: [] }, needs_web: false, needs_money: "needs_money" in ((req.tools.find((t) => t.name === "answer") as { input_schema?: { properties?: object } }).input_schema?.properties ?? {}) } }];
  const off = await answerQuestion("How much did I spend at Tesco last month?", { sources: await noSources() }, { tz: TZ });
  assert.equal(off.text, "Money search is off. Turn on Let Ask read transactions in Settings to ask about your spending.", "the fixed line, not the model's words");
  assert.deepEqual(off.setting, { label: "Let Ask read transactions", href: "#/settings/about" });
  assert.equal(off.searched, "Money search is off");
  assert.equal(seen.length, 1, "one model call, like any message");
  assert.ok(!seen[0].tools.some((t) => /^(money|regular_payments)$/.test(t.name)), "and it couldn't have read a payment");
  seen.length = 0;
  // Any other question: the money tools aren't offered at all.
  await answerQuestion("How did I sleep this week?", { sources: await noSources() }, { tz: TZ });
  const offered = seen[0].tools.map((t) => t.name);
  assert.ok(offered.includes("health"));
  assert.ok(!offered.includes("money") && !offered.includes("regular_payments"));
  await saveAskMoney({ on: true });
});

test("the streamed path: today's context, the shared tools and checked citations all hold while the words stream", { skip }, async () => {
  const { answerQuestion } = await import("./answer");
  const { lastMonth } = await seed();
  seen.length = 0;
  script = (req) => {
    if (!hasResult(req)) return [{ type: "tool_use", id: "tu_1", name: "money", input: { merchant: "tesco", from: `${lastMonth}-01`, to: `${lastMonth}-28` } }];
    const r = lastResult(req) as { total: string; payments: Array<{ ref: string; date: string; merchant: string }> };
    return [{ type: "tool_use", id: "tu_2", name: "answer", input: { text: `You spent ${r.total} at Tesco last month [1][2].`, found: true, from_today: false, sources: r.payments.map((p) => ({ ref: p.ref, title: p.merchant, date: p.date })), next: [] } }];
  };
  const words: string[] = [];
  const reply = await answerQuestion("How much did I spend at Tesco last month?", { sources: await noSources() }, { tz: TZ, onText: (e) => void ("delta" in e && e.delta && words.push(e.delta)) });
  assert.equal(reply.text, "You spent £56.55 at Tesco last month [1][2].");
  assert.equal(reply.sources.length, 2);
  assert.ok(reply.sources.every((s) => s.kind === "day"));
  assert.ok(words.length > 1, "the answer's words arrived in pieces");
  assert.match(words.join(""), /You spent £56\.55 at Tesco/);
  assert.match(seen[0].system, /<today>\nNow: /);
  assert.ok(seen[0].tools.some((t) => t.name === "money") && seen[0].tools.some((t) => t.name === "health"));

  // One loop: the same request carries the tools that change things, beside the ones that read.
  assert.ok(seen[0].tools.some((t) => t.name === "add_todo") && seen[0].tools.some((t) => t.name === "days"));
  assert.ok(!seen[0].tools.some((t) => t.name === "hand_off"));
});
