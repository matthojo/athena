// AI spend's pure parts: prices and the dearest-known stand-in (lib/model-prices.ts), exchange rates read and
// aged (lib/fx.ts), money in words and the Allow more step (lib/spend-types.ts), and a guard that every function
// that can reach a model loads lib/spend.ts, so its hook in lib/ai.ts is in place.
// Run: npx tsx --test lib/spend.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { picturePrice, providerOf, tokenCost, tokenPrice, TOKEN_PRICES } from "./model-prices";
import { due, rateFrom, readRates, STALE_MS } from "./fx";
import { allowStep, areaName, budgetReplyText, budgetState, money, spentWords } from "./spend-types";
import { failCode, failLine } from "./team-run";

test("prices: published ones are used, a dated id is its model, and an unknown model is the company's dearest, marked", () => {
  assert.deepEqual(tokenPrice("anthropic", "claude-sonnet-5-5"), { price: [2, 10, 0.1], estimated: false });
  assert.deepEqual(tokenPrice("anthropic", "claude-haiku-4-5-20251001").price.slice(0, 2), [1, 5]);
  const unknown = tokenPrice("gemini", "gemini-9-ultra");
  assert.equal(unknown.estimated, true);
  const known = Object.values(TOKEN_PRICES.gemini);
  assert.equal(unknown.price[0], Math.max(...known.map((p) => p[0])));
  assert.equal(unknown.price[1], Math.max(...known.map((p) => p[1])));
  assert.deepEqual(tokenPrice("typesafe", "jev").price.slice(0, 2), [0.04, 0]);
  // Every gateway company has prices to fall back on.
  for (const p of ["anthropic", "openai", "gemini", "meta", "openrouter"] as const) assert.ok(Object.keys(TOKEN_PRICES[p]).length > 3, p);
});

test("cost: input, output, cache reads and writes (Anthropic's at 1.25×) and audio", () => {
  const c = tokenCost("anthropic", "claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 100_000 });
  assert.equal(Math.round(c.price * 1e6) / 1e6, 4 + 2 + 0.2 + 0.5);
  assert.equal(tokenCost("anthropic", "claude-opus-5-5", { input_tokens: -5, output_tokens: Number.NaN }).price, 0);
  // Gemini 3.5 Flash: $1.50 text in, $3 audio in.
  assert.equal(tokenCost("gemini", "gemini-3.5-flash", { input_tokens: 0, audio_input_tokens: 1_000_000 }).price, 3);
  assert.deepEqual(picturePrice("gemini", "gemini-3-pro-image"), { price: 0.134, estimated: false });
  assert.equal(picturePrice("openai", "gpt-image-2").estimated, true);
});

test("which company a model id belongs to", () => {
  assert.equal(providerOf("claude-sonnet-5-5"), "anthropic");
  assert.equal(providerOf("gemini-3.5-flash"), "gemini");
  assert.equal(providerOf("gpt-5.4-mini"), "openai");
  assert.equal(providerOf("o3"), "openai");
  assert.equal(providerOf("muse-spark-1.3"), "meta");
  assert.equal(providerOf("deepseek/deepseek-v4-pro"), "openrouter");
});

test("exchange rates: only well-formed answers, fetched once a UTC day, a failure waits an hour, stale after two days", () => {
  assert.equal(readRates({ result: "error" }), null);
  assert.equal(readRates({ result: "success", base_code: "EUR", rates: { USD: 1 } }), null);
  assert.deepEqual(readRates({ result: "success", base_code: "USD", rates: { USD: 1, GBP: 0.79, gbp: 2, XYZ: "1", JPY: 0, EUR: 0.9 } }), { USD: 1, GBP: 0.79, EUR: 0.9 });
  const now = new Date("2026-11-17T12:00:00Z");
  assert.equal(due(null, now), true);
  assert.equal(due({ rates: { USD: 1 }, fetched_at: "2026-11-17T00:10:00Z" }, now), false);
  assert.equal(due({ rates: { USD: 1 }, fetched_at: "2026-11-16T23:50:00Z" }, now), true);
  assert.equal(due({ rates: { USD: 1 }, fetched_at: "2026-11-16T23:50:00Z", failed_at: "2026-11-17T11:30:00Z" }, now), false);
  assert.equal(due({ rates: { USD: 1 }, fetched_at: "2026-11-16T23:50:00Z", failed_at: "2026-11-17T10:30:00Z" }, now), true);
  const row = { rates: { USD: 1, GBP: 0.8 }, fetched_at: new Date(now.getTime() - STALE_MS - 1).toISOString() };
  assert.equal(rateFrom(row, "GBP", now)?.stale, true);
  assert.equal(rateFrom(row, "CHF", now), null);
  assert.equal(rateFrom(null, "USD", now)?.value, 1);
});

test("money in words", () => {
  assert.equal(money(3, "GBP", "en-GB"), "£3");
  assert.equal(money(1.2, "GBP", "en-GB"), "£1.20");
  assert.equal(money(0.5, "USD", "en-GB"), "$0.50");
  assert.equal(money(150, "JPY", "ja-JP"), "￥150");
  assert.equal(spentWords(0.001, "GBP", "en-GB"), "Less than £0.01");
  assert.equal(spentWords(0, "GBP", "en-GB"), "£0.00");
  assert.equal(budgetState(1, null), "none");
  assert.equal(budgetState(2.39, 3), "under");
  assert.equal(budgetState(2.4, 3), "near");
  assert.equal(budgetState(3, 3), "reached");
  assert.equal(allowStep(0.79), 1);
  assert.equal(allowStep(3.6), 5);
  assert.equal(allowStep(84), 100);
  assert.equal(allowStep(150), 100);
  assert.equal(allowStep(1350), 1000);
  assert.equal(areaName({ area: "assistant", name: null }), "A deleted assistant");
  assert.equal(
    budgetReplyText({ scope: "assistant", name: "Muse", currency: "GBP", locale: "en-GB", limit: 0.5, step: 1, resets_at: "" }),
    "Muse has used today's £0.50, so it has stopped until midnight. The rest of Athena carries on.",
  );
});

test("a run stopped by the budget or its cap has a code of its own, read back from its line", () => {
  for (const c of ["budget", "cap"] as const) assert.equal(failCode(failLine(c)), c, c);
  assert.equal(failCode(Object.assign(new Error("x"), { code: "budget_reached", notice: { scope: "assistant" } })), "cap");
  assert.equal(failCode(Object.assign(new Error("x"), { code: "budget_reached", notice: { scope: "all" } })), "budget");
});

test("every function that can reach a model loads lib/spend.ts, so the budget is checked there", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "netlify/functions");
  // None of these calls a model.
  const none = new Set(["backfill-content-links.ts", "encrypt-data.ts", "link-previews-sweep.ts"]);
  // These load it through another file that does.
  const through: Record<string, string> = { "voice.ts": "./api", "api.ts": "../../lib/spend", "team-run.ts": "../../lib/team-run" };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !none.has(n))) {
    const text = readFileSync(join(dir, f), "utf8");
    const via = through[f] ?? "../../lib/spend";
    assert.ok(text.includes(`"${via}"`), `${f} should import ${via}`);
  }
  assert.ok(readFileSync(join(root, "lib/team-run.ts"), "utf8").includes('from "./spend"'));
  assert.ok(readFileSync(join(root, "netlify/server/routes/assistant.ts"), "utf8").includes('from "../../functions/api"'));
});

test("nothing reaches a model without the budget: every direct call checks it first and records what it cost", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(path);
    }
  };
  walk("lib");
  walk("netlify");
  // A call that goes straight to a provider: Anthropic's SDK, Jev, Gemini's generateContent, OpenAI's endpoints.
  const direct = /\.messages\.(create|stream)\(|\.systemOne\(|:generateContent|\/v1\/images\/|\/chat\/completions/;
  // lib/ai.ts is the hook itself; lib/llm/** are the provider clients createMessage calls, so the hook covers them.
  const covered = (f: string) => f === "lib/ai.ts" || f.startsWith("lib/llm/");
  const callers = files.filter((f) => !covered(f) && direct.test(readFileSync(join(root, f), "utf8")));
  assert.ok(callers.length >= 3, `found ${callers.join(", ")}`);
  for (const f of callers) {
    const text = readFileSync(join(root, f), "utf8");
    assert.ok(/\bcheckBudget\(/.test(text), `${f} calls a model directly: check the budget first (lib/spend.ts checkBudget)`);
    assert.ok(/\brecordUsage\(/.test(text), `${f} calls a model directly: record what it cost (lib/spend.ts recordUsage)`);
  }
});


test("Run anyway: a token is honoured once, and never when it's forged, changed or past its time", async () => {
  const { mintRunAnyway, takeRunAnyway, RUN_ANYWAY_MS, uncheckedReply, UNCHECKED_REPLY } = await import("./spend");
  const now = Date.now();
  const token = mintRunAnyway(now);
  assert.equal(takeRunAnyway(token, now + 1_000), true);
  assert.equal(takeRunAnyway(token, now + 2_000), false, "not reused");
  const [exp, nonce, mac] = mintRunAnyway(now).split(".");
  assert.equal(takeRunAnyway(`${exp}.${nonce}x.${mac}`, now), false, "changed");
  assert.equal(takeRunAnyway(`${(now + RUN_ANYWAY_MS * 10).toString(36)}.${nonce}.${mac}`, now), false, "a later time");
  assert.equal(takeRunAnyway(mintRunAnyway(now), now + RUN_ANYWAY_MS + 1), false, "past its time");
  for (const junk of [undefined, null, true, 1, "", "a.b", "a.b.c", "x".repeat(500)]) assert.equal(takeRunAnyway(junk, now), false);
  const reply = uncheckedReply(now);
  assert.equal(reply.text, UNCHECKED_REPLY);
  assert.equal(reply.budget.scope, "unchecked");
  assert.equal(takeRunAnyway(reply.budget.run_anyway, now), true);
});

test("a run stopped partway because the budget couldn't be checked reads as stopped", () => {
  assert.equal(failCode(Object.assign(new Error("Athena couldn't check today's AI budget, so it didn't run that. Try again in a minute."), { code: "budget_unchecked" })), "stopped");
});
