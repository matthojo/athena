// Ask's real loop (lib/answer.ts runAsk) on each provider other than Anthropic, through clientFor and a fake gateway
// that answers in the provider's own wire format: two lookups, then the answer streamed as it's written, with its
// citation checked against what the tools gave. And a web search handed to Claude, cited the same way.
// Run: npx tsx --test lib/llm/ask-providers.test.ts
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestion, type AnswerDeps, type SourceAccount } from "../answer";
import { clientFor } from "./index";
import { REFUSAL_WAITS_MS } from "./client";
import { PROVIDERS, callsAndResults, fakeClaude, fakeGateway, injectGateway, keyFor, removeGateway, type Provider } from "./testing";
import { forgetRefused } from "../ask-tool-pick";

process.env.ANTHROPIC_API_KEY ??= "test";
// Short waits after the gateway's refusal, for the test.
REFUSAL_WAITS_MS.splice(0, REFUSAL_WAITS_MS.length, 1, 1, 1);

const MODELS: Record<Provider, string> = { openai: "gpt-5.2", meta: "Llama-4-Maverick-17B-128E-Instruct-FP8", openrouter: "moonshotai/kimi-k2", gemini: "gemini-3.5-flash" };
const NOW = new Date("2026-11-17T10:00:00Z");
const opts = { now: NOW, tz: "Europe/London" };
const mail = "https://mail.example/t/1";
const meeting = "https://calendar.example/e/7";

const gmail: SourceAccount = { key: "gmail", name: "Gmail", kind: "email", tools: [{ name: "search_threads", description: "Search email", input_schema: { type: "object", properties: { query: { type: "string" } } } }], call: async () => ({ text: `Flight TP1351 to Lisbon, 19 Nov ${mail}`, isError: false, links: [mail] }) };
const calendar: SourceAccount = { key: "calendar", name: "Calendar", kind: "event", tools: [{ name: "list_events", description: "List events", input_schema: { type: "object", properties: { day: { type: "string" } } } }], call: async () => ({ text: `Airport run with Sam, 19 Nov 06:00 ${meeting}`, isError: false, links: [meeting] }) };
const sources: AnswerDeps["sources"] = { open: async () => ({ accounts: [gmail, calendar], skipped: [], close: async () => undefined }) };

const ANSWER_TEXT = "You fly TP1351 to Lisbon on the 19th [1], and Sam is driving you to the airport at 06:00 [2].";
const answerArgs = { text: ANSWER_TEXT, found: true, general: false, from_today: false, sources: [{ ref: mail, title: "Your booking", date: "2026-11-01" }, { ref: meeting, title: "Airport run", date: "2026-11-19" }], next: [], ask: { question: "", options: [], more: [] } };

before(injectGateway);
after(removeGateway);
afterEach(() => forgetRefused());

for (const provider of PROVIDERS) {
  test(`${provider}: Ask finishes a turn with two lookups and a streamed answer`, async () => {
    process.env.ATHENA_ANSWER_MODEL = MODELS[provider];
    // The gateway's bare 403 on the first request, with Claude configured: waited out on this provider, never sent to Claude.
    let refused = false;
    const gw = fakeGateway((req) => {
      if (!refused) {
        refused = true;
        return { error: { status: 403 } };
      }
      const { results } = callsAndResults(req);
      if (results.length === 0) return { text: "Checking your email.", calls: [{ name: "gmail__search_threads", args: { query: "flight" } }] };
      if (results.length === 1) return { calls: [{ name: "calendar__list_events", args: { day: "2026-11-19" } }] };
      return { calls: [{ name: "answer", args: answerArgs }] };
    });
    try {
      const claude = fakeClaude([]);
      const words: string[] = [];
      const reply = await answerQuestion("When do I fly, and how am I getting to the airport?", { sources, client: clientFor({ provider, model: MODELS[provider] }, claude.client) as never, web: async () => false, mentions: async () => ({ found: [], missing: [] }) }, { ...opts, onText: (e) => void words.push(JSON.stringify(e)) });

      assert.equal(gw.seen.length, 4, "a refusal, then three rounds: two lookups and the answer");
      assert.ok(gw.seen.every((r) => r.stream), "Ask streams every round");
      assert.equal(reply.text.replace(/\s*\[\d\]/g, ""), ANSWER_TEXT.replace(/\s*\[\d\]/g, ""));
      assert.deepEqual(reply.sources.map((s) => s.kind).sort(), ["email", "event"]);
      assert.ok(words.length >= 1, "the answer streamed");
      if (provider !== "gemini") assert.ok(words.length > 3, "chat completions stream the answer's text in pieces");

      // Each call's id comes back with its result, and the model is sent its tools, the system prompt and the key.
      const last = callsAndResults(gw.seen[3]);
      assert.deepEqual(last.calls.map((c) => c.name), ["gmail__search_threads", "calendar__list_events"]);
      assert.deepEqual(last.results.map((r) => r.id), last.calls.map((c) => c.id));
      assert.match(last.results[0].text, /TP1351/);
      const first = gw.seen[1];
      if (provider === "gemini") {
        assert.equal(first.headers["x-goog-api-key"], keyFor(provider));
        assert.match(first.url, new RegExp(`/v1beta/models/${MODELS.gemini}:streamGenerateContent\\?alt=sse$`));
        assert.ok((first.body.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text.length > 100);
        const names = (first.body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0].functionDeclarations.map((t) => t.name);
        assert.ok(names.includes("answer") && names.includes("gmail__search_threads"));
        // Gemini 3's signature on its call goes back with it.
        const model = (gw.seen[3].body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>).filter((c) => c.role === "model");
        assert.equal(model[0].parts.find((p) => p.functionCall)?.thoughtSignature, "sig-2");
      } else {
        assert.equal(first.headers.authorization, `Bearer ${keyFor(provider)}`);
        assert.match(first.url, new RegExp(`/${provider}/chat/completions$`));
        assert.equal((first.body.messages as Array<{ role: string }>)[0].role, "system");
        assert.ok((first.body.tools as Array<{ function: { name: string } }>).some((t) => t.function.name === "answer"));
        assert.equal(first.body.model, MODELS[provider]);
      }
    } finally {
      gw.restore();
      delete process.env.ATHENA_ANSWER_MODEL;
    }
  });

  test(`${provider}: a web search is handed to Claude and its page can be cited`, async () => {
    const page = { url: "https://www.gov.uk/renew-adult-passport", title: "Renew or replace your adult passport" };
    const gw = fakeGateway((req) => {
      const { results } = callsAndResults(req);
      if (!results.length) return { calls: [{ name: "web_search", args: { query: "UK passport renewal time" } }] };
      assert.match(results[0].text, /gov\.uk\/renew-adult-passport/);
      return { calls: [{ name: "answer", args: { ...answerArgs, text: "About three weeks [1].", general: true, sources: [{ ref: page.url, title: page.title, date: "" }] } }] };
    });
    try {
      const claude = fakeClaude([page]);
      const steps: string[] = [];
      const reply = await answerQuestion("How long does a UK passport renewal take right now?", { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, client: clientFor({ provider, model: MODELS[provider] }, claude.client) as never, web: async () => true, mentions: async () => ({ found: [], missing: [] }) }, { ...opts, onText: () => undefined, onStep: (s) => void steps.push(s.text) });
      assert.equal(claude.sent.length, 1, "one small Claude call ran the search");
      assert.equal(claude.sent[0].messages[0].content, "Search the web for: UK passport renewal time");
      assert.match(JSON.stringify(claude.sent[0].tools), /web_search_20250305/);
      assert.equal(reply.sources[0].url, page.url);
      assert.ok(steps.some((s) => /Searched the web for UK passport renewal time/.test(s)));
      // The provider never sees Anthropic's server tool, only a plain one.
      assert.doesNotMatch(JSON.stringify(gw.seen[0].body), /web_search_20250305/);
    } finally {
      gw.restore();
    }
  });
}
