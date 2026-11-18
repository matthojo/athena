/**
 * A fake Netlify AI Gateway for tests: OpenAI, Meta, OpenRouter and Gemini, answering in each provider's documented
 * JSON and server-sent event shapes (fixtures/ holds one recorded-style reply of each). A script decides each turn
 * from the request the provider was sent. Nothing here reaches a network.
 */
import { Anthropic } from "../ai";
import type { ProviderId } from "../model-types";

export type Provider = Exclude<ProviderId, "anthropic">;
export const PROVIDERS: Provider[] = ["openai", "meta", "openrouter", "gemini"];
export const BASE = "https://gw.test";

/** What the model does next. `args` as a string is sent as is (a malformed call). */
export interface Turn {
  text?: string;
  calls?: Array<{ id?: string; name: string; args: Record<string, unknown> | string }>;
  /** The provider's own finish word, when a test needs one (e.g. "MALFORMED_FUNCTION_CALL", "content_filter"). */
  finish?: string;
  /** Fail instead: a status, a body (none for a bare 403) and headers. */
  error?: { status: number; body?: string; headers?: Record<string, string> };
}

export interface Seen {
  provider: Provider;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  stream: boolean;
}

const KEY_ENV: Record<Provider, [string, string]> = {
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  meta: ["META_API_KEY", "META_BASE_URL"],
  openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
};
export const keyFor = (p: Provider) => `key-${p}-0123456789`;

/** The gateway's injected variables, for every provider. */
export function injectGateway(): void {
  for (const p of PROVIDERS) {
    process.env[KEY_ENV[p][0]] = keyFor(p);
    process.env[KEY_ENV[p][1]] = `${BASE}/${p}`;
  }
}
export function removeGateway(): void {
  for (const p of PROVIDERS) for (const name of KEY_ENV[p]) delete process.env[name];
  delete process.env.GOOGLE_API_KEY;
}

const pieces = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) ?? [];
const sse = (lines: unknown[], comment = false) => (comment ? ": OPENROUTER PROCESSING\n\n" : "") + lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("");
const argsText = (a: Record<string, unknown> | string) => (typeof a === "string" ? a : JSON.stringify(a));

function chatReply(turn: Turn, model: string, n: number) {
  const calls = (turn.calls ?? []).map((c, i) => ({ id: c.id ?? `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: argsText(c.args) } }));
  return {
    id: `chatcmpl-${n}`,
    object: "chat.completion",
    created: 1763380000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: turn.text ?? null, ...(calls.length ? { tool_calls: calls } : {}), refusal: null }, finish_reason: turn.finish ?? (calls.length ? "tool_calls" : "stop") }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } },
  };
}

function chatStream(turn: Turn, model: string, n: number, provider: Provider): string {
  const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1763380000, model };
  const out: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }];
  for (const p of pieces(turn.text ?? "", 5)) out.push({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
  for (const [i, c] of (turn.calls ?? []).entries()) {
    out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id ?? `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: "" } }] }, finish_reason: null }] });
    for (const p of pieces(argsText(c.args), 7)) out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: p } }] }, finish_reason: null }] });
  }
  out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.finish ?? (turn.calls?.length ? "tool_calls" : "stop") }] });
  out.push({ ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
  out.push("[DONE]");
  return sse(out, provider === "openrouter");
}

function geminiParts(turn: Turn, n: number) {
  const parts: unknown[] = [];
  if (turn.text) parts.push({ text: turn.text });
  for (const [i, c] of (turn.calls ?? []).entries()) parts.push({ functionCall: { name: c.name, args: typeof c.args === "string" ? {} : c.args, ...(c.id ? { id: c.id } : {}) }, ...(i === 0 ? { thoughtSignature: `sig-${n}` } : {}) });
  return parts;
}
const geminiUsage = { promptTokenCount: 120, candidatesTokenCount: 25, thoughtsTokenCount: 5, totalTokenCount: 150 };

function geminiReply(turn: Turn, model: string, n: number) {
  return { candidates: [{ content: { role: "model", parts: geminiParts(turn, n) }, finishReason: turn.finish ?? "STOP", index: 0 }], usageMetadata: geminiUsage, modelVersion: model, responseId: `resp-${n}` };
}

function geminiStream(turn: Turn, model: string, n: number): string {
  const out: unknown[] = [];
  for (const p of pieces(turn.text ?? "", 5)) out.push({ candidates: [{ content: { role: "model", parts: [{ text: p }] }, index: 0 }], modelVersion: model });
  const calls = geminiParts({ calls: turn.calls }, n);
  out.push({ candidates: [{ content: { role: "model", parts: calls }, finishReason: turn.finish ?? "STOP", index: 0 }], usageMetadata: geminiUsage, modelVersion: model });
  return sse(out);
}

/** Installs the fake gateway on fetch. Each request goes to `script`; what it was sent is kept in `seen`. */
export function fakeGateway(script: (req: Seen, n: number) => Turn): { seen: Seen[]; restore: () => void } {
  const real = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${BASE}/`)) throw new Error(`Unexpected fetch in a test: ${url}`);
    const provider = url.slice(BASE.length + 1).split("/")[0] as Provider;
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const stream = provider === "gemini" ? url.includes(":streamGenerateContent") : body.stream === true;
    const req: Seen = { provider, url, headers, body, stream };
    seen.push(req);
    const turn = script(req, seen.length);
    if (turn.error) return new Response(turn.error.body ?? null, { status: turn.error.status, headers: turn.error.headers });
    const model = provider === "gemini" ? decodeURIComponent(/models\/([^:]+):/.exec(url)?.[1] ?? "") : String(body.model);
    if (stream) return new Response(provider === "gemini" ? geminiStream(turn, model, seen.length) : chatStream(turn, model, seen.length, provider), { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(provider === "gemini" ? geminiReply(turn, model, seen.length) : chatReply(turn, model, seen.length)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

/** The tool calls a provider request carries back, and the results answering them, by id: so a test sees ids round-trip. */
export function callsAndResults(req: Seen): { calls: Array<{ id: string; name: string }>; results: Array<{ id: string; text: string }> } {
  const calls: Array<{ id: string; name: string }> = [];
  const results: Array<{ id: string; text: string }> = [];
  if (req.provider === "gemini") {
    for (const c of req.body.contents as Array<{ parts: Array<Record<string, { name: string; id?: string; response?: { result?: string; error?: string } }>> }>)
      for (const p of c.parts) {
        if (p.functionCall) calls.push({ id: p.functionCall.id ?? p.functionCall.name, name: p.functionCall.name });
        if (p.functionResponse) results.push({ id: p.functionResponse.id ?? p.functionResponse.name, text: String(p.functionResponse.response?.result ?? p.functionResponse.response?.error ?? "") });
      }
  } else {
    for (const m of req.body.messages as Array<{ role: string; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string; content?: unknown }>) {
      for (const c of m.tool_calls ?? []) calls.push({ id: c.id, name: c.function.name });
      if (m.role === "tool") results.push({ id: m.tool_call_id!, text: String(m.content) });
    }
  }
  return { calls, results };
}

/** A Claude stand-in for the web hand-offs: a search finds `pages`; a fetch reads the page with `text`. */
export function fakeClaude(pages: Array<{ url: string; title: string }>, text = "The page's text.") {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        sent.push(params);
        const fetching = (params.tools ?? []).some((t) => (t as { name?: string }).name === "web_fetch");
        const asked = String(params.messages[0].content);
        const content = fetching
          ? [
              { type: "server_tool_use", id: "srvtoolu_f", name: "web_fetch", input: { url: asked.replace(/^.*?: /, "") } },
              { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_f", content: { type: "web_fetch_result", url: asked.replace(/^.*?: /, ""), retrieved_at: null, content: { type: "document", title: "A page", citations: null, source: { type: "text", media_type: "text/plain", data: text } } } },
              { type: "text", text: "Done.", citations: null },
            ]
          : [
              { type: "server_tool_use", id: "srvtoolu_s", name: "web_search", input: { query: asked } },
              { type: "web_search_tool_result", tool_use_id: "srvtoolu_s", content: pages.map((p) => ({ type: "web_search_result", ...p, encrypted_content: "enc", page_age: null })) },
              { type: "text", text: "Renewals take about three weeks.", citations: pages.slice(0, 1).map((p) => ({ type: "web_search_result_location", url: p.url, title: p.title, cited_text: "three weeks", encrypted_index: "x" })) },
            ];
        return { id: "msg_claude", type: "message", role: "assistant", model: params.model, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}
