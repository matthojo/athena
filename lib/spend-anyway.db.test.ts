// When today's AI budget can't be read (owner, 17 Nov 2026), on real Postgres with every migration. The `ai_usage`
// table is moved aside, so the budget can't be checked and no call's cost can be written, while the rest of Athena
// answers. Ask's reply offers Run anyway; that one message runs once with its token, and not again; what it cost is
// kept and written once the table is back. An assistant run waits in the queue, with no card, and runs at the next pass.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/spend-anyway.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties ai_usage and the Team's tables, and replaces the 'ai_budget' row.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const url = process.env.ATHENA_TEST_DB_URL;
const skip = !url && "set ATHENA_TEST_DB_URL";

/** A stand-in for the model: one short answer, streamed or not, with its usage. Counts the calls it gets. */
let server: Server;
let calls = 0;
const ANSWER = "Your dentist is at 3pm.";
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const message = (stop: string | null) => ({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: ANSWER }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10_000, output_tokens: 200 } });

before(async () => {
  if (!url) return;
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  delete process.env.TYPESAFE_API_KEY;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw || "{}");
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message("end_turn")));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("message_start", { type: "message_start", message: { ...message(null), content: [] } }));
      res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } }));
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } }));
      res.write(sse("message_stop", { type: "message_stop" }));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
});

after(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await away(false).catch(() => undefined);
  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`DELETE FROM settings WHERE key = 'ai_budget'`);
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_routines, ask_plans, ask_activity, nudges CASCADE`);
  (await import("./spend")).forgetBudget(true);
  server?.close();
});

/** Move `ai_usage` aside (today's spend can't be read or written), or bring it back. */
async function away(on: boolean) {
  const { qRaw } = await import("./db");
  await qRaw(on ? `ALTER TABLE ai_usage RENAME TO ai_usage_away` : `ALTER TABLE ai_usage_away RENAME TO ai_usage`);
  (await import("./spend")).forgetBudget();
}

async function ask(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const handler = (await import("../netlify/functions/api")).default;
  const res = await handler(
    new Request("https://athena.test/api/assistant", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: JSON.stringify(body) }),
    {} as never,
  );
  return { status: res.status, json: await res.json() };
}

async function setBudget(daily: number) {
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('ai_budget', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ daily, currency: "USD", assistants: {} })]);
  const { checkBudget, forgetBudget } = await import("./spend");
  forgetBudget(true);
  await checkBudget({ area: "ask" }); // read once: the budget is known
}

test("Ask: Run anyway runs that one message once, without the check, and its cost is written when the database is back", { skip }, async () => {
  const { pendingUsage, UNCHECKED_REPLY } = await import("./spend");
  const { qRaw } = await import("./db");
  await setBudget(5);
  await away(true);
  try {
    const first = await ask({ question: "When's the dentist?" });
    assert.equal(first.status, 200);
    assert.equal(first.json.text, UNCHECKED_REPLY);
    assert.equal(first.json.budget.scope, "unchecked");
    assert.equal(typeof first.json.budget.run_anyway, "string");
    assert.equal(calls, 0, "no model call without the check");

    const anyway = await ask({ question: "When's the dentist?", run_anyway: first.json.budget.run_anyway });
    assert.equal(anyway.status, 200);
    assert.equal(anyway.json.budget, undefined);
    assert.ok(anyway.json.text.includes("3pm"), anyway.json.text);
    const ran = calls;
    assert.ok(ran >= 1, "the model answered");
    const held = pendingUsage();
    assert.equal(held.count, ran, "each call's cost is kept for later");
    assert.ok(held.usd > 0);

    // The same token again: not honoured. Nor is any other message without one.
    const again = await ask({ question: "When's the dentist?", run_anyway: first.json.budget.run_anyway });
    assert.equal(again.json.budget.scope, "unchecked");
    const other = await ask({ question: "And the vet?" });
    assert.equal(other.json.budget.scope, "unchecked");
    assert.equal(calls, ran, "no more calls");
  } finally {
    await away(false);
  }
  // The next check finds the database again: what was kept is written, on today's row, as Ask.
  const { checkBudget } = await import("./spend");
  await checkBudget({ area: "ask" });
  assert.equal(pendingUsage().count, 0);
  const rows = await qRaw<{ area: string; model: string; usd: string }>(`SELECT area, model, usd FROM ai_usage ORDER BY id`);
  assert.equal(rows.length, calls);
  assert.ok(rows.every((r) => r.area === "ask" && Number(r.usd) > 0));
});

test("an assistant run waits when the budget can't be checked: back in the queue, no card, and it runs at the next pass", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runTeamRun, enqueueTeamRun, deliverTeamNudges, getTeamRun } = await import("./team-run");
  const { listLiveNudges } = await import("./proactive/store");
  const { createMessage } = await import("./ai");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_routines, ask_plans, ask_activity, nudges, nudge_mutes CASCADE`);
  const muse = await createAssistant({ name: "Muse", job: "Finds prices for gift ideas", personality: { tone: "warm", traits: [], pronoun: "she", greeting: "" }, triggers: [{ kind: "schedule", days: [1, 2, 3, 4, 5], time: "09:00" }] });
  await setBudget(5);
  const made: string[] = [];
  const client = { messages: { create: async (p: { model: string }) => (made.push(p.model), message("end_turn")) } } as never;
  const turn = async () => {
    await createMessage(client, { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "go" }] }, Date.now() + 60_000);
    return { assistant_id: muse.id, thread_id: null, text: "Two prices found.", reply: { text: "Two prices found.", found: true, changes: [] } as never };
  };
  const queued = await enqueueTeamRun(muse.id, { triggerId: muse.triggers[0].id });
  await away(true);
  let waited;
  try {
    waited = await runTeamRun(queued.id, { turn });
  } finally {
    await away(false);
  }
  assert.equal(made.length, 0, "no call was made");
  assert.equal(waited!.status, "queued", "it waits rather than failing");
  assert.equal(waited!.retried, false, "waiting isn't its one retry");
  assert.equal(waited!.error, null);
  const midday = new Date();
  midday.setUTCHours(12, 0, 0, 0);
  await deliverTeamNudges(midday, "Europe/London", { canPush: false, send: async () => undefined, quiet: null });
  assert.equal((await listLiveNudges()).length, 0, "no card");
  // The next pass hands it off again: now the budget can be read, and it runs.
  const done = await runTeamRun(queued.id, { turn });
  assert.equal(made.length, 1);
  assert.equal(done!.status, "done");
  assert.equal((await getTeamRun(queued.id))!.retried, false);
});
