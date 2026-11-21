// AI spend on real Postgres with every migration (0079, lib/spend.ts, netlify/lib/spend-routes.ts): calls through
// lib/ai.ts's createMessage recorded at published prices under their scope; today's spend starting again at
// midnight in the owner's zone; the daily budget and an assistant's own cap stopping calls before they're made;
// Allow more for today only; a model with no price counted at the dearest from its company and marked; the
// exchange rate kept when the service fails, and marked stale; Ask's reply at the budget; a team run stopped by its
// cap, not retried, with one card; and the routes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/spend.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties ai_usage, and replaces the 'ai_budget', 'fx_rate' and 'timezone'
// settings rows and the owner's own facts.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  // A key so Ask runs; the budget stops it before anything leaves the machine.
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const MOSS = "00000000-0000-4000-8000-00000000a001";
const DOT = "00000000-0000-4000-8000-00000000a002";

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** A stand-in for the Anthropic client: answers at once with the usage given, and counts its calls. */
function stub(usage: Usage) {
  const calls: string[] = [];
  const client = {
    messages: {
      create: async (p: { model: string }) => {
        calls.push(p.model);
        return { id: "msg_test", type: "message", role: "assistant", model: p.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage };
      },
    },
  };
  return { client: client as never, calls };
}

async function call(model: string, usage: Usage) {
  const { createMessage } = await import("./ai");
  const s = stub(usage);
  await createMessage(s.client, { model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, Date.now() + 60_000);
  return s.calls.length;
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const handler = (await import("../netlify/functions/api")).default;
  const res = await handler(
    new Request(`https://athena.test/api/${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    {} as never,
  );
  return { status: res.status, json: await res.json() };
}

/** Rates fetched just now, so nothing goes to the network. */
async function freshRates(rates: Record<string, number> = { USD: 1, GBP: 0.8, JPY: 150 }, at = new Date()) {
  const { qRaw } = await import("./db");
  const { forgetRates } = await import("./fx");
  await qRaw(`INSERT INTO settings (key, value) VALUES ('fx_rate', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ rates, fetched_at: at.toISOString() })]);
  forgetRates();
}

async function zone(tz: string) {
  const { qRaw } = await import("./db");
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(tz)]);
  (await import("./spend")).forgetBudget();
}

async function budget(row: Record<string, unknown>) {
  const { qRaw } = await import("./db");
  await qRaw(`INSERT INTO settings (key, value) VALUES ('ai_budget', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ currency: "USD", assistants: {}, ...row })]);
  (await import("./spend")).forgetBudget();
}

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`DELETE FROM settings WHERE key IN ('ai_budget', 'fx_rate')`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'spend:%'`);
  await qRaw(`DELETE FROM facts WHERE subject_kind = 'me'`);
  await zone("Europe/London");
  await freshRates();
});

after(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`DELETE FROM settings WHERE key IN ('ai_budget', 'fx_rate')`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'spend:%'`);
  await zone("Europe/London");
});

test("each call through createMessage is kept at the published price, under the scope it ran in", { skip }, async () => {
  const { withSpendScope } = await import("./spend");
  const { qRaw } = await import("./db");
  await call("claude-haiku-5-5", { input_tokens: 2_000, output_tokens: 1_000 });
  await withSpendScope({ area: "ask" }, () => call("claude-sonnet-5-5", { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000 }));
  await withSpendScope({ area: "assistant", assistantId: MOSS }, () => call("claude-opus-5-5", { input_tokens: 100_000, output_tokens: 10_000 }));
  const rows = await qRaw<{ area: string; assistant_id: string | null; job: string | null; provider: string; model: string; usd: string; estimated: boolean; cached_tokens: number }>(`SELECT * FROM ai_usage ORDER BY id`);
  assert.deepEqual(
    rows.map((r) => [r.area, r.assistant_id, r.provider, r.model, Number(r.usd), r.estimated]),
    // (to eight places, as kept)
    [
      // No scope: background work. Haiku 5.5: $0.10 in, $0.50 out.
      ["background", null, "anthropic", "claude-haiku-5-5", 0.0007, false],
      // Sonnet 5.5: $2 in, $10 out, $0.10 cached, cache writes at $2 × 1.25.
      ["ask", null, "anthropic", "claude-sonnet-5-5", 0.013, false],
      // Opus 5.5: $4 in, $20 out.
      ["assistant", MOSS, "anthropic", "claude-opus-5-5", 0.6, false],
    ],
  );
  assert.equal(rows[1].cached_tokens, 10_000);

  // The view: the split in a fixed order, today and the week, in dollars with no Region.
  const view = await api("GET", "spend");
  assert.equal(view.status, 200);
  assert.equal(view.json.currency, "USD");
  assert.equal(view.json.rate, null);
  assert.equal(view.json.budget.state, "none");
  assert.equal(view.json.budget.limit, null);
  assert.deepEqual(view.json.today.lines.map((l: any) => [l.area, l.assistant_id ?? null, l.spent]), [["ask", null, 0.013], ["assistant", MOSS, 0.6], ["background", null, 0.0007]]);
  assert.equal(view.json.today.spent, 0.6137);
  assert.equal(view.json.week.days.length, 7);
  assert.equal(view.json.week.days.at(-1).day, view.json.today.day);
  assert.equal(view.json.week.spent, 0.6137);
});

test("a model with no published price counts at the dearest from its company, and says so", { skip }, async () => {
  const { tokenPrice } = await import("./model-prices");
  const { recordUsage, withSpendScope } = await import("./spend");
  // The dearest Anthropic model Athena knows: Fable 5 and 5.1 at $10 in and $50 out.
  assert.deepEqual(tokenPrice("anthropic", "claude-something-new").price.slice(0, 2), [10, 50]);
  assert.equal(tokenPrice("openai", "gpt-5-2025-08-07").estimated, false, "a dated id is priced as the model it dates");
  await call("claude-something-new", { input_tokens: 1_000, output_tokens: 1_000 });
  // A picture from a model with no picture price: the dearest from that company (Gemini 3 Pro Image, $0.134).
  await withSpendScope({ area: "pictures" }, () => recordUsage({ provider: "gemini", model: "gemini-nano-banana-2.1", images: 2 }));
  const view = (await api("GET", "spend")).json;
  const bg = view.today.lines.find((l: any) => l.area === "background");
  assert.equal(bg.spent, 0.06);
  assert.equal(bg.estimated, true);
  const pics = view.today.lines.find((l: any) => l.area === "pictures");
  assert.equal(pics.spent, 0.268);
  assert.equal(pics.estimated, true);
  assert.equal(view.today.estimated, true);
  assert.deepEqual(view.estimated_models, ["claude-something-new", "gemini-nano-banana-2.1"]);
});

test("at the budget every call stops before it's made, until midnight in the owner's zone", { skip }, async () => {
  const { checkBudget, recordUsage, BudgetReached, withSpendScope } = await import("./spend");
  await zone("America/New_York");
  await budget({ daily: 1 });
  // 23:30 in New York on 17 Nov is 04:30 UTC on 18 Nov: the row is New York's 17th.
  const late = new Date("2026-11-18T04:30:00Z");
  await recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 250_000, output_tokens: 0 } }, { now: late });
  const { qRaw } = await import("./db");
  const [row] = await qRaw<{ day: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM ai_usage`);
  assert.equal(row.day, "2026-11-17", "kept on the owner's day, not UTC's");

  const stopped = await checkBudget({ area: "ask" }, { now: new Date("2026-11-18T04:45:00Z") }).catch((e) => e);
  assert.ok(stopped instanceof BudgetReached, "23:45 in New York: today's $1 is used");
  assert.equal(stopped.notice.scope, "all");
  assert.equal(stopped.notice.limit, 1);
  assert.equal(stopped.notice.step, 1);
  assert.equal(stopped.notice.resets_at, "2026-11-18T05:00:00.000Z", "midnight in New York");
  assert.equal(stopped.message, "That's today's AI budget of $1 used, so Athena has stopped until midnight, Ask included.");

  // Through createMessage: the client is never called.
  const { createMessage } = await import("./ai");
  const s = stub({ input_tokens: 1, output_tokens: 1 });
  // createMessage's hook reads the real clock: move the row onto today in New York for this part.
  await qRaw(`UPDATE ai_usage SET day = $1::date`, [(await import("./dates")).zonedToday(new Date(), "America/New_York")]);
  await assert.rejects(withSpendScope({ area: "ask" }, () => createMessage(s.client, { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, Date.now() + 60_000)), BudgetReached);
  assert.equal(s.calls.length, 0, "stopped before the call");

  // Five past midnight in New York: a new day, nothing spent.
  await qRaw(`UPDATE ai_usage SET day = '2026-11-17'`);
  await checkBudget({ area: "ask" }, { now: new Date("2026-11-18T05:05:00Z") });
});

test("an assistant past its own cap stops; Ask and the other assistants carry on", { skip }, async () => {
  const { checkBudget, recordUsage, BudgetReached } = await import("./spend");
  await budget({ daily: 5, assistants: { [MOSS]: 0.5 } });
  await recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 125_000, output_tokens: 0 }, scope: { area: "assistant", assistantId: MOSS } });
  const stopped = await checkBudget({ area: "assistant", assistantId: MOSS }).catch((e) => e);
  assert.ok(stopped instanceof BudgetReached);
  assert.equal(stopped.notice.scope, "assistant");
  assert.equal(stopped.notice.assistant_id, MOSS);
  assert.equal(stopped.notice.limit, 0.5);
  assert.match(stopped.message, /has used today's \$0\.50, so it has stopped until midnight\. The rest of Athena carries on\./);
  await checkBudget({ area: "assistant", assistantId: DOT });
  await checkBudget({ area: "ask" });
  // Its pictures count toward its cap too.
  await budget({ daily: 5, assistants: { [DOT]: 0.1 } });
  await recordUsage({ provider: "gemini", model: "gemini-3-pro-image", images: 1, scope: { area: "pictures", assistantId: DOT } });
  await assert.rejects(checkBudget({ area: "assistant", assistantId: DOT }), BudgetReached);
});

test("Allow more raises today only, one step in the owner's currency", { skip }, async () => {
  const { checkBudget, recordUsage, BudgetReached } = await import("./spend");
  const { saveOwnerProfile } = await import("./profile");
  await saveOwnerProfile([{ key: "Region", value: "United Kingdom, GBP, English" }]);
  // £2 a day; $2.50 spent is £2 at 0.8.
  const set = await api("PATCH", "spend/budget", { daily: 2 });
  assert.equal(set.status, 200);
  assert.equal(set.json.currency, "GBP");
  assert.equal(set.json.locale, "en-GB");
  assert.equal(set.json.budget.daily, 2);
  assert.equal(set.json.budget.step, 1);
  await recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 625_000, output_tokens: 0 } });
  await assert.rejects(checkBudget({ area: "ask" }), BudgetReached);
  const view = (await api("GET", "spend")).json;
  assert.equal(view.today.spent, 2);
  assert.equal(view.budget.state, "reached");

  const more = await api("POST", "spend/allow-more", {});
  assert.equal(more.status, 200);
  assert.equal(more.json.budget.extra, 1);
  assert.equal(more.json.budget.limit, 3);
  assert.equal(more.json.budget.state, "under", "£2 of £3");
  await checkBudget({ area: "ask" });
});

test("Allow more: under, near and reached, and tomorrow starts from the budget again", { skip }, async () => {
  const { checkBudget, recordUsage, BudgetReached, forgetBudget } = await import("./spend");
  await budget({ daily: 1 });
  await recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 250_000, output_tokens: 0 } });
  await assert.rejects(checkBudget({ area: "ask" }), BudgetReached);
  const more = await api("POST", "spend/allow-more", {});
  assert.equal(more.json.budget.limit, 2);
  assert.equal(more.json.budget.state, "under", "$1 of $2");
  await checkBudget({ area: "ask" });
  // Tomorrow: the extra was for today.
  forgetBudget();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const { qRaw } = await import("./db");
  await qRaw(`UPDATE ai_usage SET day = day + 1`);
  await assert.rejects(checkBudget({ area: "ask" }, { now: tomorrow }), BudgetReached);
  // With no budget, there's nothing to raise.
  await qRaw(`DELETE FROM settings WHERE key = 'ai_budget'`);
  forgetBudget();
  assert.equal((await api("POST", "spend/allow-more", {})).status, 400);
  // An assistant's cap is raised on its own.
  await budget({ daily: null, assistants: { [MOSS]: 0.25 } });
  const mine = await api("POST", "spend/allow-more", { assistant_id: MOSS });
  assert.equal(mine.status, 200);
  assert.equal((await api("POST", "spend/allow-more", { assistant_id: "nope" })).status, 400);
});

test("the budget and caps: set, cleared, and refused in words when they're not amounts", { skip }, async () => {
  let r = await api("PATCH", "spend/budget", { daily: 3, assistants: { [MOSS]: 0.5 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.budget.daily, 3);
  assert.equal(r.json.budget.state, "under");
  r = await api("PATCH", "spend/budget", { daily: -1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "The daily budget needs to be an amount above zero, or left empty for none.");
  assert.equal((await api("PATCH", "spend/budget", {})).status, 400);
  assert.equal((await api("PATCH", "spend/budget", { assistants: { "not-an-id": 1 } })).status, 400);
  r = await api("PATCH", "spend/budget", { daily: null, assistants: { [MOSS]: null } });
  assert.equal(r.json.budget.daily, null);
  assert.equal(r.json.budget.state, "none");
  const { qRaw } = await import("./db");
  const [row] = await qRaw<{ value: any }>(`SELECT value FROM settings WHERE key = 'ai_budget'`);
  assert.deepEqual(row.value.assistants, {});
  assert.equal((await api("PUT", "spend/budget", { daily: 1 })).status, 405);
});

test("the exchange rate: fetched once a day; when the service fails the last one is kept, and marked stale after two days", { skip }, async () => {
  const { loadRate, forgetRates, due } = await import("./fx");
  const { spendView, recordUsage } = await import("./spend");
  const { saveOwnerProfile } = await import("./profile");
  const { qRaw } = await import("./db");
  await saveOwnerProfile([{ key: "Region", value: "Japan" }]);
  const now = new Date("2026-11-17T12:00:00Z");
  await freshRates({ USD: 1, JPY: 140, GBP: 0.8 }, new Date("2026-11-14T09:00:00Z"));
  assert.equal(due((await qRaw<{ value: any }>(`SELECT value FROM settings WHERE key = 'fx_rate'`))[0].value, now), true);

  let asked = 0;
  const down = (async () => {
    asked++;
    throw new Error("offline");
  }) as typeof fetch;
  const rate = await loadRate("JPY", { now, fetch: down });
  assert.equal(asked, 1);
  assert.deepEqual(rate, { currency: "JPY", value: 140, as_of: "2026-11-14T09:00:00.000Z", stale: true });
  const [kept] = await qRaw<{ value: any }>(`SELECT value FROM settings WHERE key = 'fx_rate'`);
  assert.equal(kept.value.failed_at, now.toISOString(), "the failure is noted");
  assert.equal(kept.value.rates.JPY, 140, "the last rates are kept");
  // Within the hour it isn't asked again.
  forgetRates();
  await loadRate("JPY", { now: new Date(now.getTime() + 30 * 60_000), fetch: down });
  assert.equal(asked, 1);

  // The view shows yen, at the kept rate, marked stale; Allow more is a round ¥100.
  await recordUsage({ model: "claude-haiku-5-5", usage: { input_tokens: 0, output_tokens: 1_000_000 } }, { now });
  const view = await spendView({ now: new Date(now.getTime() + 30 * 60_000), fetch: down });
  assert.equal(view.currency, "JPY");
  assert.deepEqual(view.rate, { value: 140, as_of: "2026-11-14T09:00:00.000Z", stale: true });
  assert.equal(view.today.spent, 70);
  assert.equal(view.budget.step, 100);

  // An hour on, the service answers: today's rate replaces it.
  forgetRates();
  const up = (async () => new Response(JSON.stringify({ result: "success", base_code: "USD", rates: { USD: 1, JPY: 150, GBP: 0.79, bad: 3, EUR: -1 } }))) as typeof fetch;
  const later = new Date(now.getTime() + 2 * 3_600_000);
  const fresh = await loadRate("JPY", { now: later, fetch: up });
  assert.deepEqual(fresh, { currency: "JPY", value: 150, as_of: later.toISOString(), stale: false });
  const [row] = await qRaw<{ value: any }>(`SELECT value FROM settings WHERE key = 'fx_rate'`);
  assert.deepEqual(Object.keys(row.value.rates).sort(), ["GBP", "JPY", "USD"], "only well-formed rates are kept");
  assert.equal(row.value.failed_at, undefined);
});

test("a budget can't be set in a currency Athena has no rate for", { skip }, async () => {
  const { saveOwnerProfile } = await import("./profile");
  await saveOwnerProfile([{ key: "Region", value: "Switzerland" }]);
  // Today's rates, but none for francs, so nothing is fetched and none is found.
  const view = (await api("GET", "spend")).json;
  assert.equal(view.currency, "USD", "figures fall back to dollars");
  assert.equal(view.rate_missing, true);
  const r = await api("PATCH", "spend/budget", { daily: 3 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /exchange rate/);
});

test("Ask at the budget answers in words with the notice block, and makes no model call", { skip }, async () => {
  await budget({ daily: 0.01 });
  const { recordUsage } = await import("./spend");
  await recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 10_000, output_tokens: 0 } });
  const before = Number((await (await import("./db")).qRaw<{ n: string }>(`SELECT count(*) AS n FROM ai_usage`))[0].n);
  const r = await api("POST", "assistant", { question: "What's on today?" });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, "That's today's AI budget of $0.01 used, so Athena has stopped until midnight, Ask included.");
  assert.equal(r.json.budget.scope, "all");
  assert.equal(r.json.budget.step, 1);
  const afterCount = Number((await (await import("./db")).qRaw<{ n: string }>(`SELECT count(*) AS n FROM ai_usage`))[0].n);
  assert.equal(afterCount, before, "nothing was spent");
  // Another route that needs a model answers 402 in the same words.
  const d = await api("POST", "assistant/skill-draft", { messages: [{ role: "user", text: "Every Monday, plan my week from my calendar" }, { role: "assistant", text: "Here's your week." }] });
  assert.equal(d.status, 402);
  assert.equal(d.json.code, "budget_reached");
});

test("a triggered run stopped by its cap isn't tried again, and sends one card that says why", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runTeamRun, enqueueTeamRun, deliverTeamNudges } = await import("./team-run");
  const { listLiveNudges } = await import("./proactive/store");
  const { createMessage } = await import("./ai");
  const { recordUsage } = await import("./spend");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_routines, ask_plans, ask_activity, nudges, nudge_mutes CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas", personality: { tone: "warm", traits: [], pronoun: "she", greeting: "" }, triggers: [{ kind: "schedule", days: [1, 2, 3, 4, 5], time: "09:00" }] });
  await budget({ daily: null, assistants: { [moss.id]: 0.05 } });
  await recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: 12_500, output_tokens: 0 }, scope: { area: "assistant", assistantId: moss.id } });
  const s = stub({ input_tokens: 1, output_tokens: 1 });
  const queued = await enqueueTeamRun(moss.id, { triggerId: moss.triggers[0].id });
  const run = await runTeamRun(queued.id, {
    turn: async () => {
      await createMessage(s.client, { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "go" }] }, Date.now() + 60_000);
      throw new Error("unreachable");
    },
  });
  assert.equal(s.calls.length, 0, "no call was made");
  assert.equal(run!.status, "failed", "not put back in the queue");
  assert.equal(run!.retried, false);
  assert.equal(run!.error, "Its own cap for today was used. Allow more in Settings → AI spend, or use Run now after midnight.");
  const midday = new Date();
  midday.setUTCHours(12, 0, 0, 0);
  const deps = { canPush: false, send: async () => undefined, quiet: null };
  await deliverTeamNudges(midday, "Europe/London", deps);
  await deliverTeamNudges(midday, "Europe/London", deps);
  const cards = await listLiveNudges();
  assert.equal(cards.length, 1, "one card");
  assert.equal(cards[0].body, "Sorry, I couldn't finish. I reached my own cap for today, so I stopped. Allow more in Settings → AI spend, or use Run now on my page after midnight.");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_routines, ask_plans, ask_activity, nudges CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
});

test("the pushes at 80% and at the budget go once a day each, in words, and wait out quiet hours", { skip }, async () => {
  const { recordUsage } = await import("./spend");
  const { qRaw } = await import("./db");
  await budget({ daily: 1 });
  // Midday in London, outside quiet hours.
  const at = new Date();
  at.setUTCHours(12, 0, 0, 0);
  const day = (await import("./dates")).zonedToday(at, "Europe/London");
  const sent: Array<{ title: string; body: string; url: string }> = [];
  const send = async (p: { title: string; body: string; url: string }) => void sent.push(p);
  const claims = async () => (await qRaw<{ key: string }>(`SELECT key FROM reminder_log WHERE key LIKE 'spend:%' ORDER BY key`)).map((r) => r.key);
  const spend = (tokens: number, now = at) => recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: tokens, output_tokens: 0 } }, { now, send });
  await spend(150_000); // $0.60
  assert.deepEqual(sent, []);
  await spend(75_000); // $0.90: past 80%
  assert.deepEqual(sent, [{ title: "80% of today's AI budget used", body: "$0.90 of $1. Athena stops at $1 until midnight.", url: "/#/settings/spend", tag: "spend" }]);
  await spend(5_000); // still near: nothing more
  assert.equal(sent.length, 1);
  await spend(20_000); // $1.00: the budget
  assert.deepEqual(sent[1], { title: "Today's AI budget is used", body: "$1 of $1. Athena has stopped until midnight. Open AI spend to allow more.", url: "/#/settings/spend", tag: "spend" });
  await spend(1_000);
  assert.equal(sent.length, 2, "once each a day");
  assert.deepEqual(await claims(), [`spend:cap:${day}`, `spend:near:${day}`]);

  // In the owner's quiet hours nothing is sent or claimed.
  const { saveNotificationPrefs } = await import("./push");
  await saveNotificationPrefs({ quiet: { from: "22:00", to: "07:00" } });
  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'spend:%'`);
  const night = new Date(at);
  night.setUTCHours(23, 30, 0, 0);
  await spend(250_000, night);
  assert.equal(sent.length, 2);
  assert.deepEqual(await claims(), []);
  await qRaw(`DELETE FROM settings WHERE key = 'notifications'`);
});

test("with a budget set, a call isn't made when today's spend can't be read; with none known it goes ahead", { skip }, async () => {
  const { checkBudget, forgetBudget, BudgetUnchecked } = await import("./spend");
  await budget({ daily: 5 });
  await checkBudget({ area: "ask" }); // read once: the budget is known
  const good = process.env.NETLIFY_DB_URL;
  process.env.NETLIFY_DB_URL = "postgres://nobody@127.0.0.1:1/none";
  try {
    forgetBudget();
    const err = await checkBudget({ area: "ask" }).catch((e) => e);
    assert.ok(err instanceof BudgetUnchecked);
    assert.equal(err.message, "Athena couldn't check today's AI budget, so it didn't run that. Try again in a minute.");
    // A new instance that has never read a budget lets the call go on: it needs the database anyway.
    forgetBudget(true);
    await checkBudget({ area: "ask" });
  } finally {
    process.env.NETLIFY_DB_URL = good;
    forgetBudget(true);
  }
});

test("the week and the split, from real rows: each assistant by name, a deleted one kept, days with nothing shown", { skip }, async () => {
  const { createAssistant, deleteAssistant } = await import("./team");
  const { recordUsage } = await import("./spend");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_routines, ask_plans, ask_activity CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas" });
  const dot = await createAssistant({ name: "Dot", job: "Linear issues to to-dos" });
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const opus = (tokens: number, scope: { area: "ask" | "assistant" | "background" | "pictures"; assistantId?: string; job?: string }, at: Date) => recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: tokens, output_tokens: 0 }, scope }, { now: at });
  await opus(100_000, { area: "ask" }, now); // $0.40
  await opus(50_000, { area: "assistant", assistantId: moss.id }, now); // $0.20
  await opus(25_000, { area: "background", job: "briefing" }, now); // $0.10
  await recordUsage({ provider: "gemini", model: "gemini-3-pro-image", images: 1, scope: { area: "pictures", assistantId: dot.id } }, { now }); // $0.134
  await opus(250_000, { area: "assistant", assistantId: dot.id }, ago(3)); // $1.00, three days ago
  await opus(500_000, { area: "ask" }, ago(6)); // $2.00, six days ago
  await opus(500_000, { area: "ask" }, ago(8)); // outside the week
  await deleteAssistant(dot.id);

  const v = (await api("GET", "spend")).json;
  assert.deepEqual(v.today.lines.map((l: any) => [l.area, l.name ?? null, l.spent]), [["ask", null, 0.4], ["assistant", "Moss", 0.2], ["background", null, 0.1], ["pictures", null, 0.134]]);
  assert.equal(v.today.spent, 0.834);
  assert.deepEqual(v.week.days.map((d: any) => d.spent), [2, 0, 0, 1, 0, 0, 0.834]);
  assert.equal(v.week.spent, 3.834);
  assert.deepEqual(v.week.lines.map((l: any) => [l.area, l.name ?? null, l.spent]), [["ask", null, 2.4], ["assistant", null, 1], ["assistant", "Moss", 0.2], ["background", null, 0.1], ["pictures", null, 0.134]]);
  assert.deepEqual(v.assistants.map((a: any) => [a.name, a.spent, a.cap]), [["Moss", 0.2, null]]);
  await qRaw(`TRUNCATE team_assistants CASCADE`);
});

test("routes: only for the full key, and unknown paths fall through", { skip }, async () => {
  const handler = (await import("../netlify/functions/api")).default;
  const res = await handler(new Request("https://athena.test/api/spend"), {} as never);
  assert.equal(res.status, 401);
  assert.equal((await api("GET", "spend/nope")).status, 404);
});
