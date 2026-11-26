// lib/llm: every provider behind Anthropic's message shape. Fixtures in the providers' documented shapes, a fake
// gateway on fetch, and a real local HTTP server for streams cut at awkward places.
// Run: npx tsx --test lib/llm/llm.test.ts
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Anthropic, RateLimited, createMessage, gatewayDenied, rejectedTool, streamMessage } from "../ai";
import { ProviderUnavailable, clientFor, providerConfigured } from "./index";
import { chatRound, chatBody, readChatStream } from "./openai";
import { forgetSignatures, geminiBody, geminiRound, readGeminiStream } from "./gemini";
import { parseArgs, plainTools } from "./shared";
import { REFUSAL_WAITS_MS } from "./client";
import { SeenLinks } from "./web";
import { PROVIDERS, callsAndResults, fakeClaude, fakeGateway, injectGateway, keyFor, removeGateway, type Provider } from "./testing";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const body = (s: string) => new Response(s).body!;
const MODEL: Record<Provider, string> = { openai: "gpt-5.2", meta: "Llama-4-Maverick", openrouter: "openai/gpt-5.2", gemini: "gemini-3.5-flash" };
const ref = (provider: Provider) => ({ provider, model: MODEL[provider] });
const tool = (name: string): Anthropic.Tool => ({ name, description: `The ${name} tool`, input_schema: { type: "object", properties: { q: { type: "string" } } } });
const params = (provider: Provider, extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Anthropic.MessageCreateParamsNonStreaming => ({ model: MODEL[provider], max_tokens: 500, system: "You are Athena.", messages: [{ role: "user", content: "When do I fly?" }], tools: [tool("search_athena"), tool("list_todos")], ...extra });
const far = () => Date.now() + 120_000;

let savedAnthropic: Record<string, string | undefined> = {};
before(() => {
  injectGateway();
  savedAnthropic = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
  // With Claude unconfigured, lib/ai.ts keeps the client it was given after a refusal (see the notes).
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});
after(() => {
  removeGateway();
  if (savedAnthropic.key) process.env.ANTHROPIC_API_KEY = savedAnthropic.key;
});
afterEach(() => forgetSignatures());

// ---------- the fixtures ----------

test("a chat completion with two tool calls reads as Anthropic's tool_use blocks, ids and usage kept", () => {
  const r = chatRound(JSON.parse(fixture("openai-chat-tool-calls.json")));
  assert.equal(r.stop, "tool_use");
  assert.deepEqual(r.content, [
    { type: "tool_use", id: "call_62136354", name: "search_athena", input: { query: "Lisbon trip" } },
    { type: "tool_use", id: "call_62136355", name: "list_todos", input: { due: "this week" } },
  ]);
  // Anthropic counts cached input apart.
  assert.equal(r.usage.input_tokens, 93);
  assert.equal(r.usage.cache_read_input_tokens, 1024);
  assert.equal(r.usage.output_tokens, 46);
});

test("a chat completions stream gives the answer tool's input in pieces", async () => {
  const events: unknown[] = [];
  const r = await readChatStream(body(fixture("openai-stream.txt")), (e) => events.push(e));
  assert.deepEqual(events[0], { type: "tool", key: 0, id: "call_DdmO9pD3xa9XTPNJ32zg2hcA", name: "answer" });
  assert.deepEqual(events.slice(1).map((e) => (e as { json: string }).json), ['{"te', 'xt":"Yes, ', 'on Friday."}']);
  assert.deepEqual(r.content, [{ type: "tool_use", id: "call_DdmO9pD3xa9XTPNJ32zg2hcA", name: "answer", input: { text: "Yes, on Friday." } }]);
  assert.equal(r.usage.input_tokens, 812);
});

test("Gemini's reply reads the same: words, calls with fresh ids, thoughts counted as output, signatures kept", () => {
  const r = geminiRound(JSON.parse(fixture("gemini-function-call.json")));
  assert.equal(r.stop, "tool_use");
  assert.equal(r.content[0].type, "text");
  const [a, b] = r.content.slice(1) as Array<{ id: string; name: string; input: unknown }>;
  assert.equal(a.name, "search_athena");
  assert.deepEqual(b.input, { due: "this week" });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^toolu_[a-f0-9]{24}$/);
  assert.equal(r.usage.input_tokens, 117);
  assert.equal(r.usage.output_tokens, 183);
  // The next request carries the signature back on the call that had it, and Google's stand-in on none.
  const next = geminiBody({ ...params("gemini"), messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: r.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "tool_use", id: c.id, name: c.name, input: c.input })) }, { role: "user", content: [{ type: "tool_result", tool_use_id: a.id, content: "found" }, { type: "tool_result", tool_use_id: b.id, content: "none" }] }] }, plainTools(params("gemini").tools));
  const contents = next.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(contents[1].parts[1].thoughtSignature, "CiQBVKhc7mVYb2a1bbgGqqbsDC0WEazmbXkxzQzB3eWAt+0XXf0K");
  assert.equal(contents[1].parts[2].thoughtSignature, undefined);
  assert.deepEqual(contents[2].parts.map((p) => (p.functionResponse as { name: string }).name), ["search_athena", "list_todos"]);
});

test("a Gemini call from a conversation it never signed gets Google's stand-in signature", () => {
  const b = geminiBody({ ...params("gemini"), messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: [{ type: "tool_use", id: "toolu_from_claude", name: "search_athena", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_from_claude", content: "x" }] }] }, []);
  assert.equal((b.contents as Array<{ parts: Array<Record<string, unknown>> }>)[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  // Gemini 2.5 needs none.
  const old = geminiBody({ ...params("gemini"), model: "gemini-2.5-flash", messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }] }, []);
  assert.equal((old.contents as Array<{ parts: Array<Record<string, unknown>> }>)[1].parts[0].thoughtSignature, undefined);
});

test("Gemini's stream: words in pieces, the call whole", async () => {
  const events: Array<{ type: string; text?: string; json?: string }> = [];
  const r = await readGeminiStream(body(fixture("gemini-stream.txt")), (e) => events.push(e));
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["Your flight is", " on the 19th."]);
  assert.deepEqual(JSON.parse(events.find((e) => e.type === "args")!.json!), { text: "Your flight is on the 19th.", found: true });
  assert.equal(r.stop, "tool_use");
  assert.equal(r.usage.output_tokens, 31);
});

// ---------- the request ----------

test("the request: system, tools, tool choice, effort and media in each provider's words", () => {
  const p = params("openai", {
    tool_choice: { type: "tool", name: "answer", disable_parallel_tool_use: true },
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }, { type: "document", title: "Receipt", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } }, { type: "text", text: "What's this?", cache_control: { type: "ephemeral" } }] },
    ],
  } as Partial<Anthropic.MessageCreateParamsNonStreaming>);
  const o = chatBody("openai", p, plainTools(p.tools), false);
  assert.equal(o.reasoning_effort, "medium");
  assert.equal(o.max_completion_tokens, 500);
  assert.deepEqual(o.tool_choice, { type: "function", function: { name: "answer" } });
  assert.equal(o.parallel_tool_calls, false);
  assert.equal(JSON.stringify(o).includes("cache_control"), false);
  const parts = (o.messages as Array<{ content: Array<Record<string, unknown>> }>)[1].content;
  assert.deepEqual(parts.map((x) => x.type), ["image_url", "file", "text"]);
  assert.equal((parts[0].image_url as { url: string }).url, "data:image/png;base64,iVBOR");
  // Meta has no effort and takes max_tokens; OpenRouter says it its own way.
  const m = chatBody("meta", { ...p, model: MODEL.meta }, [], false);
  assert.equal(m.reasoning_effort, undefined);
  assert.equal(m.max_tokens, 500);
  assert.deepEqual(chatBody("openrouter", { ...p, model: MODEL.openrouter }, [], false).reasoning, { effort: "medium" });
  // Gemini: a level for 3, a budget for 2.5, pictures and PDFs inline, the choice as a mode.
  const g = geminiBody({ ...p, model: MODEL.gemini }, plainTools(p.tools));
  assert.deepEqual((g.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingLevel: "high" });
  assert.deepEqual(g.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["answer"] } });
  const gp = (g.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
  assert.deepEqual(gp.map((x) => Object.keys(x)[0]), ["inlineData", "inlineData", "text"]);
  assert.deepEqual((geminiBody({ ...p, model: "gemini-2.5-pro" }, []).generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 4096 });
});

test("web search and web fetch are offered to another provider as plain tools", () => {
  const p = params("openai", { tools: [tool("answer"), { type: "web_search_20250305", name: "web_search", max_uses: 3 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2 } as Anthropic.ToolUnion] });
  const tools = (chatBody("openai", p, plainTools(p.tools), false).tools as Array<{ function: { name: string; parameters: { required: string[] } } }>).map((t) => [t.function.name, t.function.parameters.required]);
  assert.deepEqual(tools, [["answer", undefined], ["web_search", ["query"]], ["web_fetch", ["url"]]]);
});

// ---------- the client, end to end ----------

for (const provider of PROVIDERS) {
  test(`${provider}: a three-turn tool loop through createMessage keeps every id paired`, async () => {
    const gw = fakeGateway((req) => {
      const n = callsAndResults(req).results.length;
      if (n === 0) return { calls: [{ name: "search_athena", args: { q: "flight" }, id: provider === "gemini" ? undefined : "call_odd:id/1" }] };
      if (n === 1) return { text: "One more look.", calls: [{ name: "list_todos", args: { q: "packing" } }] };
      return { text: "You fly on the 19th." };
    });
    try {
      const client = clientFor(ref(provider)) as Anthropic;
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: "When do I fly?" }];
      for (let turn = 0; turn < 3; turn++) {
        const reply = await createMessage(client, params(provider, { messages }), far());
        messages.push({ role: "assistant", content: reply.content });
        const calls = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (turn < 2) {
          assert.equal(reply.stop_reason, "tool_use");
          assert.equal(calls.length, 1);
          assert.match(calls[0].id, /^[A-Za-z0-9_-]+$/, "an id Anthropic would take back too");
          messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: `${c.name} result` })) });
        } else {
          assert.equal(reply.stop_reason, "end_turn");
          assert.deepEqual(reply.content, [{ type: "text", text: "You fly on the 19th.", citations: null }]);
          assert.equal(reply.usage.input_tokens > 0, true);
          assert.equal(reply.model, MODEL[provider]);
        }
      }
      const last = callsAndResults(gw.seen[2]);
      assert.deepEqual(last.calls.map((c) => c.name), ["search_athena", "list_todos"]);
      assert.deepEqual(last.results.map((r) => r.text), ["search_athena result", "list_todos result"]);
      assert.deepEqual(last.results.map((r) => r.id), last.calls.map((c) => c.id));
    } finally {
      gw.restore();
    }
  });

  test(`${provider}: messages.stream gives the SDK's events and finalMessage`, async () => {
    const gw = fakeGateway(() => ({ text: "Checking.", calls: [{ name: "answer", args: { text: "You fly on the 19th.", found: true } }] }));
    try {
      const events: Anthropic.MessageStreamEvent[] = [];
      const final = await streamMessage(clientFor(ref(provider)) as Anthropic, params(provider), far(), (e) => events.push(e));
      const kinds = events.map((e) => e.type);
      assert.equal(kinds[0], "message_start");
      assert.deepEqual(kinds.slice(-2), ["message_delta", "message_stop"]);
      const starts = events.filter((e): e is Anthropic.RawContentBlockStartEvent => e.type === "content_block_start");
      assert.deepEqual(starts.map((s) => [s.index, s.content_block.type]), [[0, "text"], [1, "tool_use"]]);
      const text = events.filter((e) => e.type === "content_block_delta" && e.index === 0).map((e) => ((e as Anthropic.RawContentBlockDeltaEvent).delta as { text: string }).text).join("");
      const json = events.filter((e) => e.type === "content_block_delta" && e.index === 1).map((e) => ((e as Anthropic.RawContentBlockDeltaEvent).delta as { partial_json: string }).partial_json).join("");
      assert.equal(text, "Checking.");
      assert.deepEqual(JSON.parse(json), { text: "You fly on the 19th.", found: true });
      assert.equal(final.stop_reason, "tool_use");
      assert.deepEqual((final.content[1] as Anthropic.ToolUseBlock).input, { text: "You fly on the 19th.", found: true });
      assert.equal((events.at(-2) as Anthropic.RawMessageDeltaEvent).delta.stop_reason, "tool_use");
    } finally {
      gw.restore();
    }
  });

  test(`${provider}: a 429 is the SDK's RateLimitError, and lib/ai.ts waits it out`, async () => {
    let n = 0;
    const gw = fakeGateway(() => (++n === 1 ? { error: { status: 429, body: JSON.stringify({ error: { message: "Rate limit reached", type: "requests" } }), headers: { "retry-after": "1" } } } : { text: "Done." }));
    try {
      const client = clientFor(ref(provider)) as Anthropic;
      const got = await createMessage(client, params(provider), far());
      assert.equal(got.content[0].type, "text");
      assert.equal(gw.seen.length, 2);
      // Past the deadline it's RateLimited, as for Claude.
      n = 0;
      await assert.rejects(createMessage(client, params(provider), Date.now() + 500), RateLimited);
      n = 0;
      await assert.rejects(client.messages.create(params(provider)), (e: unknown) => e instanceof Anthropic.RateLimitError && e.status === 429 && e.headers?.get("retry-after") === "1");
    } finally {
      gw.restore();
    }
  });

  test(`${provider}: the gateway's bare 403 is waited out on this provider, never swapped for Claude`, async () => {
    let n = 0;
    const gw = fakeGateway(() => (++n === 1 || n < 0 ? { error: { status: 403 } } : { text: "Done." }));
    // Claude configured: lib/ai.ts's own retry would build a Claude client. Nothing may reach Anthropic.
    process.env.ANTHROPIC_API_KEY = "claude-key";
    const waits = REFUSAL_WAITS_MS.splice(0, REFUSAL_WAITS_MS.length, 1, 1);
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const client = clientFor(ref(provider)) as Anthropic;
      const asked: number[] = [];
      const got = await createMessage(client, params(provider), far(), (ms) => asked.push(ms));
      assert.equal(got.content[0].type, "text");
      assert.equal(gw.seen.length, 2, "asked again on the same provider");
      assert.deepEqual(asked, [], "lib/ai.ts never saw the refusal");
      assert.ok(gw.seen.every((r) => r.url.includes(`/${provider}`)));
      assert.match(logged.join("\n"), new RegExp(`Athena gateway 403 .*"provider":"${provider}"`));
      // Streamed too.
      n = 0;
      const final = await streamMessage(client, params(provider), far(), () => undefined);
      assert.equal(final.content[0].type, "text");
      // Still refused after every wait: a 403 that says so, which lib/ai.ts hands to the caller as it is.
      n = -100;
      const error = await createMessage(client, params(provider), far()).catch((e: unknown) => e);
      assert.ok(error instanceof Anthropic.PermissionDeniedError);
      assert.equal(gatewayDenied(error), false);
      assert.match((error as Error).message, /turned the request away/);
      // A 403 that says why is the provider's own, passed straight on.
      const g2 = fakeGateway(() => ({ error: { status: 403, body: JSON.stringify({ error: { message: "Country not supported" } }) } }));
      try {
        const said = await client.messages.create(params(provider)).catch((e: unknown) => e);
        assert.match((said as Error).message, /Country not supported/);
      } finally {
        g2.restore();
      }
      assert.doesNotMatch(logged.join("\n"), new RegExp(keyFor(provider)));
    } finally {
      console.warn = warn;
      REFUSAL_WAITS_MS.splice(0, REFUSAL_WAITS_MS.length, ...waits);
      delete process.env.ANTHROPIC_API_KEY;
      gw.restore();
    }
  });

  test(`${provider}: a model that can't take tools fails before answering, in words, with its status`, async () => {
    const message = provider === "openrouter" ? "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing" : provider === "gemini" ? "Function calling is not enabled for models/gemma-3" : "This model does not support tools.";
    const gw = fakeGateway(() => ({ error: { status: provider === "openrouter" ? 404 : 400, body: JSON.stringify({ error: { message, code: 400 } }) } }));
    try {
      const error = (await clientFor(ref(provider)).messages.create(params(provider)).catch((e: unknown) => e)) as InstanceType<typeof Anthropic.APIError>;
      assert.ok(error instanceof Anthropic.APIError);
      assert.equal(error.status, provider === "openrouter" ? 404 : 400);
      assert.match(error.message, /can't look things up, so it can't think for Athena/);
      assert.equal((error.error as { error: { type: string } }).error.type, "tools_unsupported");
      assert.equal(rejectedTool(error), null);
    } finally {
      gw.restore();
    }
  });

  test(`${provider}: a tool definition the provider refuses is named the way rejectedTool reads`, async () => {
    const msg = provider === "gemini" ? "Invalid JSON payload received. Unknown name \"$defs\" at 'tools[0].function_declarations[1].parameters_json_schema': Cannot find field." : "Invalid schema for function 'list_todos': In context=(), 'additionalProperties' is required to be supplied and to be false.";
    const gw = fakeGateway(() => ({ error: { status: 400, body: JSON.stringify({ error: { message: msg, param: provider === "gemini" ? undefined : "tools[1].function.parameters", code: 400 } }) } }));
    try {
      const error = await clientFor(ref(provider)).messages.create(params(provider)).catch((e: unknown) => e);
      assert.equal(rejectedTool(error), 1);
    } finally {
      gw.restore();
    }
  });

  test(`${provider}: a model that can't see pictures is asked again with a line saying one was there`, async () => {
    let n = 0;
    const gw = fakeGateway(() => (++n === 1 ? { error: { status: 400, body: JSON.stringify({ error: { message: "This model does not support image input." } }) } } : { text: "I can't see the picture, but…" }));
    try {
      const p = params(provider, { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }, { type: "text", text: "What's this?" }] }] });
      const got = await clientFor(ref(provider)).messages.create(p);
      assert.equal((got.content[0] as Anthropic.TextBlock).text, "I can't see the picture, but…");
      assert.match(JSON.stringify(gw.seen[1].body), /This model can't see pictures/);
      assert.doesNotMatch(JSON.stringify(gw.seen[1].body), /\/9j\//);
    } finally {
      gw.restore();
    }
  });

  test(`${provider}: a call whose arguments are broken JSON is read as far as it goes`, async () => {
    const gw = fakeGateway(() => (provider === "gemini" ? { finish: "MALFORMED_FUNCTION_CALL" } : { calls: [{ name: "search_athena", args: '```json\n{"q": "Lisbon"}\n```' }] }));
    try {
      const got = await clientFor(ref(provider)).messages.create(params(provider));
      if (provider === "gemini") {
        // Gemini says so itself: asked once more, then the turn ends without a call.
        assert.equal(gw.seen.length, 2);
        assert.equal(got.stop_reason, "end_turn");
        assert.deepEqual(got.content, []);
      } else assert.deepEqual((got.content[0] as Anthropic.ToolUseBlock).input, { q: "Lisbon" });
    } finally {
      gw.restore();
    }
  });
}

test("broken arguments: fenced, wrapped, cut short, or a string inside a string", () => {
  assert.deepEqual(parseArgs('{"q":"a"}'), { q: "a" });
  assert.deepEqual(parseArgs('Here you go: {"q":"a"} hope that helps'), { q: "a" });
  assert.deepEqual(parseArgs('{"q":"a","sources":[{"ref":"note:1"'), { q: "a", sources: [{ ref: "note:1" }] });
  assert.deepEqual(parseArgs('"{\\"q\\":\\"a\\"}"'), { q: "a" });
  assert.deepEqual(parseArgs("not json"), {});
  assert.deepEqual(parseArgs(""), {});
});

test("a Gemini call that was malformed and then right goes through", async () => {
  let n = 0;
  const gw = fakeGateway(() => (++n === 1 ? { finish: "MALFORMED_FUNCTION_CALL" } : { calls: [{ name: "search_athena", args: { q: "Lisbon" } }] }));
  try {
    const got = await clientFor(ref("gemini")).messages.create(params("gemini"));
    assert.equal(got.stop_reason, "tool_use");
    assert.equal((got.content[0] as Anthropic.ToolUseBlock).name, "search_athena");
  } finally {
    gw.restore();
  }
});

test("a refusal and a safety stop are Anthropic's refusal", async () => {
  const gw = fakeGateway((req) => ({ text: "I can't help with that.", finish: req.provider === "gemini" ? "SAFETY" : "content_filter" }));
  try {
    for (const provider of PROVIDERS) assert.equal((await clientFor(ref(provider)).messages.create(params(provider))).stop_reason, "refusal");
  } finally {
    gw.restore();
  }
});

// ---------- web lookups ----------

test("web_search runs as one small Claude call, its result blocks come back as Claude's would, and the model carries on", async () => {
  const page = { url: "https://www.gov.uk/renew-adult-passport", title: "Renew your passport" };
  const claude = fakeClaude([page]);
  const gw = fakeGateway((req) => (callsAndResults(req).results.length ? { text: "About three weeks." } : { calls: [{ name: "web_search", args: { query: "passport renewal time" }, id: "call_ws" }] }));
  try {
    const p = params("openai", { tools: [tool("answer"), { type: "web_search_20250305", name: "web_search", max_uses: 2, user_location: { type: "approximate", city: "Leeds", country: "GB" } }] });
    const got = await clientFor(ref("openai"), claude.client).messages.create(p);
    assert.deepEqual(got.content.map((b) => b.type), ["server_tool_use", "web_search_tool_result", "text"]);
    assert.deepEqual((got.content[0] as Anthropic.ServerToolUseBlock).input, { query: "passport renewal time" });
    assert.equal((got.content[1] as Anthropic.WebSearchToolResultBlock).tool_use_id, "call_ws");
    assert.equal(((got.content[1] as Anthropic.WebSearchToolResultBlock).content as Anthropic.WebSearchResultBlock[])[0].url, page.url);
    assert.equal(got.stop_reason, "end_turn");
    assert.deepEqual(got.usage.server_tool_use, { web_search_requests: 1, web_fetch_requests: 0 });
    // Claude got the query and the owner's place, never the conversation.
    assert.equal(claude.sent.length, 1);
    assert.equal(claude.sent[0].model, "claude-haiku-5-5");
    assert.deepEqual(claude.sent[0].messages, [{ role: "user", content: "Search the web for: passport renewal time" }]);
    assert.deepEqual((claude.sent[0].tools![0] as Anthropic.WebSearchTool20250305).user_location, { type: "approximate", city: "Leeds", country: "GB" });
    assert.equal((claude.sent[0].tools![0] as Anthropic.WebSearchTool20250305).max_uses, 1);
    // The model read the results and what they say, with links to cite.
    const told = callsAndResults(gw.seen[1]).results[0].text;
    assert.match(told, /1\. Renew your passport — https:\/\/www\.gov\.uk\/renew-adult-passport/);
    assert.match(told, /three weeks \(https:\/\/www\.gov\.uk\/renew-adult-passport\)\./);
    // The next turn, from Ask's own messages, tells it the same.
    const again = chatBody("openai", { ...p, messages: [...p.messages, { role: "assistant", content: got.content }, { role: "user", content: "And for a child?" }] }, plainTools(p.tools), false);
    assert.equal((again.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!.content, told);
  } finally {
    gw.restore();
  }
});

test("past max_uses, a search isn't run and the model is told", async () => {
  const claude = fakeClaude([{ url: "https://a.example", title: "A" }]);
  const gw = fakeGateway((req) => (callsAndResults(req).results.length ? { text: "Done." } : { calls: [{ name: "web_search", args: { query: "one" } }, { name: "web_search", args: { query: "two" } }] }));
  try {
    const got = await clientFor(ref("meta"), claude.client).messages.create(params("meta", { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] }));
    const results = got.content.filter((b): b is Anthropic.WebSearchToolResultBlock => b.type === "web_search_tool_result");
    assert.equal(results.length, 2);
    assert.deepEqual(results[1].content, { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" });
    assert.equal(claude.sent.length, 1);
  } finally {
    gw.restore();
  }
});

test("web_fetch opens only a link already in the conversation, from the sources the tool allows", async () => {
  const claude = fakeClaude([], "Price: £39.99");
  const fetchTool = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3, max_content_tokens: 1000, url_sources: { user_input: { type: "all" }, server_tool_results: { type: "all" }, client_tool_results: { type: "only", tools: [{ type: "tool_reference", name: "find_saved" }] } } } as unknown as Anthropic.ToolUnion;
  const urls = ["https://shop.example/kettle", "https://evil.example/?leak=secret", "https://saved.example/item", "https://email.example/link"];
  const gw = fakeGateway((req) => (callsAndResults(req).calls.some((c) => c.name === "web_fetch") ? { text: "Done." } : { calls: urls.map((url) => ({ name: "web_fetch", args: { url } })) }));
  try {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "How much is https://shop.example/kettle ?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "find_saved", input: {} }, { type: "tool_use", id: "t2", name: "gmail__search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Saved: https://saved.example/item" }, { type: "tool_result", tool_use_id: "t2", content: "Email says open https://email.example/link" }] },
    ];
    const got = await clientFor(ref("openrouter"), claude.client).messages.create(params("openrouter", { tools: [fetchTool], messages }));
    const results = got.content.filter((b): b is Anthropic.WebFetchToolResultBlock => b.type === "web_fetch_tool_result");
    assert.deepEqual(results.map((r) => r.content.type === "web_fetch_result" ? "read" : (r.content as { error_code: string }).error_code), ["read", "url_not_in_prior_context", "read", "url_not_in_prior_context"]);
    assert.equal(claude.sent.length, 2, "only the allowed pages were opened");
    assert.match(callsAndResults(gw.seen[1]).results[2].text, /Price: £39\.99/);
    assert.match(callsAndResults(gw.seen[1]).results[3].text, /didn't open \(url_not_in_prior_context\)/);
    assert.doesNotMatch(JSON.stringify(claude.sent), /evil|email\.example/);
  } finally {
    gw.restore();
  }
});

test("web_fetch's sources by tool: every web result but web_fetch's is web_search's alone", () => {
  const messages = [
    { role: "user", content: "Check the kettle" },
    {
      role: "assistant",
      content: [
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://shop.example/kettle", title: "Kettle", encrypted_content: "x" }] },
        { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://shop.example/kettle", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "Next: https://evil.example/?leak=1" } } } },
      ],
    },
  ] as unknown as Anthropic.MessageParam[];
  const seen = new SeenLinks(messages);
  const run = { user_input: { type: "all" as const }, server_tool_results: { type: "except" as const, tools: [{ name: "web_fetch" }] }, client_tool_results: { type: "none" as const } };
  assert.equal(seen.allows("https://shop.example/kettle", run), true, "a search result");
  assert.equal(seen.allows("https://evil.example/?leak=1", run), false, "a link on a page it opened");
  const chat = { ...run, server_tool_results: { type: "all" as const } };
  assert.equal(seen.allows("https://evil.example/?leak=1", chat), true, "in a chat it may follow one");
  assert.equal(seen.allows("https://evil.example/?leak=1", { ...run, server_tool_results: { type: "only" as const, tools: [{ name: "web_search" }] } }), false);
});

test("a lookup Claude can't run comes back as the tool's own error, not a failed turn", async () => {
  const claude = { messages: { create: async () => Promise.reject(Anthropic.APIError.generate(500, { error: { message: "down" } }, "down", new Headers())) } } as unknown as Anthropic;
  const gw = fakeGateway((req) => (callsAndResults(req).results.length ? { text: "I couldn't check online." } : { calls: [{ name: "web_search", args: { query: "news" } }] }));
  try {
    const got = await clientFor(ref("gemini"), claude).messages.create(params("gemini", { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] }));
    assert.deepEqual((got.content[1] as Anthropic.WebSearchToolResultBlock).content, { type: "web_search_tool_result_error", error_code: "unavailable" });
    assert.equal((got.content[2] as Anthropic.TextBlock).text, "I couldn't check online.");
  } finally {
    gw.restore();
  }
});

test("streamed, a web search shows as server_tool_use the moment it starts, then its result, then the answer", async () => {
  const claude = fakeClaude([{ url: "https://a.example", title: "A" }]);
  const gw = fakeGateway((req) => (callsAndResults(req).results.length ? { text: "Found it." } : { text: "Let me check.", calls: [{ name: "web_search", args: { query: "q" } }] }));
  try {
    const events: Anthropic.MessageStreamEvent[] = [];
    const final = await streamMessage(clientFor(ref("openai"), claude.client) as Anthropic, params("openai", { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] }), far(), (e) => events.push(e));
    const starts = events.filter((e): e is Anthropic.RawContentBlockStartEvent => e.type === "content_block_start").map((e) => [e.index, e.content_block.type]);
    assert.deepEqual(starts, [[0, "text"], [1, "server_tool_use"], [2, "web_search_tool_result"], [3, "text"]]);
    assert.equal(events.filter((e) => e.type === "message_start").length, 1);
    assert.deepEqual(final.content.map((b) => b.type), ["text", "server_tool_use", "web_search_tool_result", "text"]);
    // No tool_use named web_search ever reaches the caller.
    assert.doesNotMatch(JSON.stringify(events), /"type":"tool_use","id":"[^"]+","name":"web_search"/);
  } finally {
    gw.restore();
  }
});

// ---------- configuration and secrets ----------

test("providerConfigured follows the injected variables, read fresh; clientFor won't build one that isn't", () => {
  for (const p of PROVIDERS) assert.equal(providerConfigured(p), true);
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(providerConfigured("gemini"), false);
    assert.throws(() => clientFor(ref("gemini")), (e: unknown) => e instanceof ProviderUnavailable && e.provider === "gemini");
    // Your own key with no gateway works too.
    process.env.GOOGLE_API_KEY = "own";
    assert.equal(providerConfigured("gemini"), true);
  } finally {
    process.env.GEMINI_API_KEY = key;
    delete process.env.GOOGLE_API_KEY;
  }
  assert.equal(providerConfigured("anthropic"), false);
});

test("a key rewritten while the process lives is the one the next call sends", async () => {
  const gw = fakeGateway(() => ({ text: "ok" }));
  try {
    const client = clientFor(ref("openai"));
    await client.messages.create(params("openai"));
    process.env.OPENAI_API_KEY = "key-openai-rotated";
    await client.messages.create(params("openai"));
    assert.deepEqual(gw.seen.map((s) => s.headers.authorization), [`Bearer ${keyFor("openai")}`, "Bearer key-openai-rotated"]);
  } finally {
    process.env.OPENAI_API_KEY = keyFor("openai");
    gw.restore();
  }
});

test("no error carries a key or the prompt", async () => {
  const gw = fakeGateway(() => ({ error: { status: 500, body: JSON.stringify({ error: { message: "Internal error" } }) } }));
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    for (const provider of PROVIDERS) {
      const e = await clientFor(ref(provider)).messages.create(params(provider, { messages: [{ role: "user", content: "my secret diagnosis" }] })).catch((x: unknown) => x);
      const seen = JSON.stringify({ m: (e as Error).message, e, s: (e as Error).stack }) + logged.join("\n");
      assert.equal((e as { status?: number }).status, 500);
      assert.doesNotMatch(seen, new RegExp(keyFor(provider)));
      assert.doesNotMatch(seen, /secret diagnosis/);
    }
  } finally {
    console.warn = warn;
    gw.restore();
  }
});

test("a real HTTP stream cut at every byte still reads the same", async () => {
  const stream = fixture("openai-stream.txt");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(stream);
    let i = 0;
    const next = () => {
      if (i >= bytes.length) return res.end();
      res.write(bytes.subarray(i, i + 3));
      i += 3;
      setImmediate(next);
    };
    req.resume();
    next();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const events: Anthropic.MessageStreamEvent[] = [];
    const final = await streamMessage(clientFor(ref("openai")) as Anthropic, params("openai"), far(), (e) => events.push(e));
    assert.deepEqual((final.content[0] as Anthropic.ToolUseBlock).input, { text: "Yes, on Friday." });
    assert.equal(events.filter((e) => e.type === "content_block_delta").length, 3);
  } finally {
    process.env.OPENAI_BASE_URL = base;
    await new Promise((resolve) => server.close(resolve));
  }
});
