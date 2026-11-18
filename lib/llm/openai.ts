/**
 * OpenAI's chat completions, which OpenAI, Meta (Llama API's compatible endpoint) and OpenRouter all speak, behind
 * Anthropic's message shape (docs/ai-models.md). Requests and replies are JSON; a stream is server-sent events.
 */
import type { Anthropic } from "../ai";
import type { ProviderId } from "../model-types";
import type { Adapter, Round, RoundBlock, RoundEvent } from "./round";
import {
  type Params,
  credentials,
  documentText,
  effortOf,
  idOut,
  newId,
  parseArgs,
  plainTools,
  post,
  readJson,
  resultParts,
  safeId,
  sseData,
  streamError,
  systemText,
  usage,
  webResultText,
  type PlainTool,
} from "./shared";
import { ProviderUnavailable } from "./errors";

/** Sampling fields older models took; the SDK's types no longer list them, but a caller may still send them. */
const loose = (p: Params) => p as Params & { temperature?: number; top_p?: number; top_k?: number };

type Compat = Extract<ProviderId, "openai" | "meta" | "openrouter">;
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } } | { type: "file"; file: { filename: string; file_data: string } };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Part[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** The model's own name, without the provider in front ("openai/gpt-5.2" on OpenRouter). */
const bare = (model: string) => model.replace(/^[\w.-]+\//, "");
/** OpenAI's reasoning models: they take reasoning_effort and max_completion_tokens, and refuse a temperature. */
const reasons = (model: string) => /^(o\d|gpt-5)/i.test(bare(model));

function userPart(b: Anthropic.ContentBlockParam): Part | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "image") {
    const s = b.source;
    if (s.type === "base64") return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
    if (s.type === "url") return { type: "image_url", image_url: { url: s.url } };
    return null;
  }
  if (b.type === "document") {
    const text = documentText(b);
    if (text !== null) return { type: "text", text };
    const s = b.source as { type: string; data?: string; media_type?: string; url?: string };
    if (s.type === "base64") return { type: "file", file: { filename: b.title || "document.pdf", file_data: `data:${s.media_type ?? "application/pdf"};base64,${s.data}` } };
    if (s.type === "url") return { type: "text", text: `(A file: ${s.url})` };
    return null;
  }
  if (b.type === "search_result") return { type: "text", text: `${b.title} (${b.source})\n${b.content.map((c) => c.text).join("\n")}` };
  return null;
}

/** Anthropic's conversation as chat messages. A web lookup's result becomes the tool message answering its call. */
export function chatMessages(params: Params): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = systemText(params.system);
  if (system) out.push({ role: "system", content: system });
  for (const m of params.messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: systemText(m.content) });
      continue;
    }
    if (typeof m.content === "string") {
      out.push(m.role === "assistant" ? { role: "assistant", content: m.content } : { role: "user", content: m.content });
      continue;
    }
    if (m.role === "user") {
      const parts: Part[] = [];
      const fromTools: Part[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const { text, media } = resultParts(b.content);
          out.push({ role: "tool", tool_call_id: idOut(b.tool_use_id), content: `${b.is_error ? "Error: " : ""}${text || (media.length ? "(Attached below.)" : "(Nothing came back.)")}` });
          for (const x of media) {
            const p = userPart(x);
            if (p) fromTools.push(p);
          }
        } else {
          const p = userPart(b);
          if (p) parts.push(p);
        }
      }
      if (fromTools.length) parts.unshift({ type: "text", text: "What the tools above attached:" }, ...fromTools);
      if (parts.length) out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts });
      continue;
    }
    // The assistant's turn, split wherever a web lookup's result sits, so each result follows its own call.
    let text: string[] = [];
    let calls: ToolCall[] = [];
    const unanswered = new Set<string>();
    const flush = () => {
      if (text.length || calls.length) out.push({ role: "assistant", content: text.join("") || null, ...(calls.length ? { tool_calls: calls } : {}) });
      text = [];
      calls = [];
    };
    for (const b of m.content) {
      if (b.type === "text") text.push(b.text);
      else if (b.type === "tool_use" || b.type === "server_tool_use") {
        calls.push({ id: idOut(b.id), type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        if (b.type === "server_tool_use") unanswered.add(idOut(b.id));
      } else if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") {
        flush();
        unanswered.delete(idOut(b.tool_use_id));
        out.push({ role: "tool", tool_call_id: idOut(b.tool_use_id), content: webResultText(b) });
      }
      // Thinking, and other server tools' blocks, stay with Anthropic.
    }
    flush();
    for (const id of unanswered) out.push({ role: "tool", tool_call_id: id, content: "(No result.)" });
  }
  return out;
}

function toolChoice(choice: Params["tool_choice"]): { tool_choice?: unknown; parallel_tool_calls?: boolean } {
  if (!choice) return {};
  const parallel = (choice as { disable_parallel_tool_use?: boolean }).disable_parallel_tool_use ? { parallel_tool_calls: false } : {};
  if (choice.type === "auto") return { tool_choice: "auto", ...parallel };
  if (choice.type === "any") return { tool_choice: "required", ...parallel };
  if (choice.type === "tool") return { tool_choice: { type: "function", function: { name: choice.name } }, ...parallel };
  if (choice.type === "none") return { tool_choice: "none" };
  return {};
}

export function chatBody(provider: Compat, params: Params, tools: PlainTool[], stream: boolean): Record<string, unknown> {
  const model = params.model;
  const effort = effortOf(params);
  const reasoning = provider === "openai" && reasons(model);
  const body: Record<string, unknown> = { model, messages: chatMessages(params) };
  body[provider === "openai" ? "max_completion_tokens" : "max_tokens"] = params.max_tokens;
  if (!reasoning) {
    if (loose(params).temperature !== undefined) body.temperature = loose(params).temperature;
    if (loose(params).top_p !== undefined) body.top_p = loose(params).top_p;
  }
  if (params.stop_sequences?.length) body.stop = params.stop_sequences.slice(0, 4);
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    Object.assign(body, toolChoice(params.tool_choice));
  }
  // Effort, where there's a word for it. Meta has none.
  if (effort && reasoning) body.reasoning_effort = effort;
  if (effort && provider === "openrouter") body.reasoning = { effort };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

/** A refused tool definition, named the way lib/ai.ts rejectedTool reads Anthropic's: "tools.<place>.custom.input_schema". */
export function schemaRewrite(tools: PlainTool[]): (message: string, body: unknown) => string {
  return (message, body) => {
    const param = String((body as { error?: { param?: unknown } } | null)?.error?.param ?? "");
    let i = /tools\[(\d+)\]/.exec(param)?.[1] ?? /tools\[(\d+)\]/.exec(message)?.[1];
    if (i === undefined) {
      const named = /(?:function|tool)\s+['"`]([\w.-]+)['"`]/i.exec(message)?.[1];
      const at = named ? tools.findIndex((t) => t.name === named) : -1;
      if (at >= 0 && /schema|parameters/i.test(message)) i = String(at);
    }
    const tool = i === undefined ? undefined : tools[Number(i)];
    return tool && /schema|parameters|invalid/i.test(message) ? `tools.${tool.at}.custom.input_schema: ${message}` : message;
  };
}

function stopReason(finish: unknown, calls: number, refused: boolean): Round["stop"] {
  if (refused || finish === "content_filter") return "refusal";
  if (calls) return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

function chatUsage(u: unknown) {
  const x = (u ?? {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  const cached = x.prompt_tokens_details?.cached_tokens ?? 0;
  return usage(Math.max(0, (x.prompt_tokens ?? 0) - cached), x.completion_tokens ?? 0, cached);
}

export function chatRound(json: unknown): Round {
  const j = json as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>; refusal?: unknown }; finish_reason?: unknown }>; usage?: unknown; error?: unknown };
  if (j?.error) throw streamError(j.error);
  const choice = j?.choices?.[0];
  const msg = choice?.message ?? {};
  const content: RoundBlock[] = [];
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: { text?: string }) => p.text ?? "").join("") : "";
  const refusal = typeof msg.refusal === "string" && msg.refusal ? msg.refusal : "";
  if (text || refusal) content.push({ type: "text", text: text || refusal });
  for (const c of msg.tool_calls ?? []) if (c.function?.name) content.push({ type: "tool_use", id: safeId(c.id), name: c.function.name, input: parseArgs(c.function.arguments) });
  return { content, stop: stopReason(choice?.finish_reason, content.filter((b) => b.type === "tool_use").length, !!refusal), usage: chatUsage(j?.usage) };
}

export function openAiAdapter(provider: Compat): Adapter {
  const target = () => {
    const c = credentials(provider);
    if (!c) throw new ProviderUnavailable(provider);
    return { url: `${c.base}/chat/completions`, headers: { authorization: `Bearer ${c.key}` } };
  };
  return {
    async send(params, signal) {
      const t = target();
      const tools = plainTools(params.tools);
      const res = await post(t.url, t.headers, chatBody(provider, params, tools, false), signal, schemaRewrite(tools));
      return chatRound(await readJson(res));
    },
    async stream(params, signal, on) {
      const t = target();
      const tools = plainTools(params.tools);
      const res = await post(t.url, { ...t.headers, accept: "text/event-stream" }, chatBody(provider, params, tools, true), signal, schemaRewrite(tools));
      if (!res.body) return chatRound(await readJson(res));
      return readChatStream(res.body, on);
    },
  };
}

/** A chat completions stream as round events, and the round it adds up to. */
export async function readChatStream(body: ReadableStream<Uint8Array>, on: (event: RoundEvent) => void): Promise<Round> {
  let text = "";
  let refusal = "";
  let finish: unknown = null;
  let used: unknown = null;
  /** Each tool call by its place in the stream: started once its name is known, its arguments as they come. */
  const calls: Array<{ id: string; name: string; args: string; started: boolean }> = [];
  for await (const data of sseData(body)) {
    if (data.trim() === "[DONE]") break;
    let chunk: { choices?: Array<{ delta?: { content?: unknown; refusal?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: unknown }>; usage?: unknown; error?: unknown };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw streamError(chunk.error);
    if (chunk.usage) used = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      text += d.content;
      on({ type: "text", text: d.content });
    }
    if (typeof d.refusal === "string" && d.refusal) refusal += d.refusal;
    for (const tc of d.tool_calls ?? []) {
      // Some providers leave out the index: a new id is a new call, otherwise it's the last one.
      const key = typeof tc.index === "number" ? tc.index : tc.id && !calls.some((c) => c.id === tc.id) ? calls.length : Math.max(0, calls.length - 1);
      const call = (calls[key] ??= { id: "", name: "", args: "", started: false });
      if (tc.id && !call.id) call.id = safeId(tc.id);
      if (tc.function?.name) call.name += call.started ? "" : tc.function.name;
      const piece = tc.function?.arguments ?? "";
      if (!call.started && call.name) {
        call.started = true;
        call.id ||= newId();
        on({ type: "tool", key, id: call.id, name: call.name });
        if (call.args) on({ type: "args", key, json: call.args });
      }
      call.args += piece;
      if (call.started && piece) on({ type: "args", key, json: piece });
    }
  }
  const content: RoundBlock[] = [];
  if (text || refusal) content.push({ type: "text", text: text || refusal });
  const tools = calls.filter((c) => c && c.name);
  for (const c of tools) content.push({ type: "tool_use", id: c.id || newId(), name: c.name, input: parseArgs(c.args) });
  return { content, stop: stopReason(finish, tools.length, !!refusal), usage: chatUsage(used) };
}
