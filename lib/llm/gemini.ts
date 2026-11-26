/**
 * Google's Gemini (`generateContent` and `streamGenerateContent`) behind Anthropic's message shape.
 * Gemini 3 signs each tool call it makes and wants the signature back with that call on the
 * next request; the signatures are kept here by call id, for as long as a conversation is likely to run.
 */
import type { Anthropic } from "../ai";
import type { Adapter, Round, RoundBlock, RoundEvent } from "./round";
import { type Params, credentials, documentText, effortOf, plainTools, post, readJson, resultParts, safeId, sseData, streamError, systemText, usage, webResultText, type PlainTool } from "./shared";
import { ProviderUnavailable } from "./errors";

/** Sampling fields older models took; the SDK's types no longer list them, but a caller may still send them. */
const loose = (p: Params) => p as Params & { temperature?: number; top_p?: number; top_k?: number };

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

/** Gemini's own id and signature for each call, by the id Athena knows it by. Oldest dropped first. */
const calls = new Map<string, { gid?: string; sig?: string }>();
const KEEP = 2000;
function remember(id: string, gid: string | undefined, sig: string | undefined): void {
  if (!gid && !sig) return;
  calls.set(id, { gid, sig });
  while (calls.size > KEEP) calls.delete(calls.keys().next().value!);
}
/** For tests: forget every signature. */
export function forgetSignatures(): void {
  calls.clear();
}

/**
 * Google's documented stand-in for a signature it never gave (a conversation that started on another model, or one
 * older than this process): Gemini 3 then accepts the call without checking it.
 */
const NO_SIGNATURE = "skip_thought_signature_validator";
const generation = (model: string) => Number(/gemini-(\d+)/i.exec(model)?.[1] ?? 0);

const bareModel = (model: string) => model.replace(/^models\//, "");

function mediaPart(b: Anthropic.ContentBlockParam): Part | null {
  if (b.type === "text") return { text: b.text };
  if (b.type === "image") {
    const s = b.source;
    if (s.type === "base64") return { inlineData: { mimeType: s.media_type, data: s.data } };
    if (s.type === "url") return { text: `(A picture: ${s.url})` };
    return null;
  }
  if (b.type === "document") {
    const text = documentText(b);
    if (text !== null) return { text };
    const s = b.source as { type: string; data?: string; media_type?: string; url?: string };
    if (s.type === "base64") return { inlineData: { mimeType: s.media_type ?? "application/pdf", data: s.data } };
    if (s.type === "url") return { text: `(A file: ${s.url})` };
    return null;
  }
  if (b.type === "search_result") return { text: `${b.title} (${b.source})\n${b.content.map((c) => c.text).join("\n")}` };
  return null;
}

/** Anthropic's conversation as Gemini's contents. A web lookup's result becomes the function response to its call. */
export function geminiContents(params: Params): Content[] {
  const out: Content[] = [];
  const push = (role: Content["role"], parts: Part[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  };
  // A function response names its function: found from the call it answers.
  const names = new Map<string, string>();
  for (const m of params.messages) if (typeof m.content !== "string") for (const b of m.content) if (b.type === "tool_use" || b.type === "server_tool_use") names.set(b.id, b.name);
  const signs = generation(params.model) >= 3;
  const response = (id: string, name: string, result: string, error = false): Part => {
    const gid = calls.get(id)?.gid;
    return { functionResponse: { name, ...(gid ? { id: gid } : {}), response: error ? { error: result } : { result } } };
  };
  for (const m of params.messages) {
    // A system message mid-conversation joins the system instruction (geminiBody).
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      push(role, [{ text: m.content }]);
      continue;
    }
    if (m.role === "user") {
      const replies: Part[] = [];
      const parts: Part[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const { text, media } = resultParts(b.content);
          replies.push(response(b.tool_use_id, names.get(b.tool_use_id) ?? "tool", text || (media.length ? "(Attached below.)" : "(Nothing came back.)"), !!b.is_error));
          for (const x of media) {
            const p = mediaPart(x);
            if (p) parts.push(p);
          }
        } else {
          const p = mediaPart(b);
          if (p) parts.push(p);
        }
      }
      push("user", [...replies, ...parts]);
      continue;
    }
    let parts: Part[] = [];
    let signed = false;
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
        const kept = calls.get(b.id);
        const sig = kept?.sig ?? (signs && !signed ? NO_SIGNATURE : undefined);
        signed = true;
        parts.push({ functionCall: { name: b.name, args: (b.input as object) ?? {}, ...(kept?.gid ? { id: kept.gid } : {}) }, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") {
        push("model", parts);
        parts = [];
        signed = false;
        push("user", [response(b.tool_use_id, b.type === "web_search_tool_result" ? "web_search" : "web_fetch", webResultText(b))]);
      }
    }
    push("model", parts);
  }
  return out;
}

function toolConfig(choice: Params["tool_choice"]): Record<string, unknown> | undefined {
  if (!choice) return undefined;
  if (choice.type === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice.type === "any") return { functionCallingConfig: { mode: "ANY" } };
  if (choice.type === "tool") return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
  if (choice.type === "none") return { functionCallingConfig: { mode: "NONE" } };
  return undefined;
}

export function geminiBody(params: Params, tools: PlainTool[]): Record<string, unknown> {
  const config: Record<string, unknown> = { maxOutputTokens: params.max_tokens };
  if (loose(params).temperature !== undefined) config.temperature = loose(params).temperature;
  if (loose(params).top_p !== undefined) config.topP = loose(params).top_p;
  if (loose(params).top_k !== undefined) config.topK = loose(params).top_k;
  if (params.stop_sequences?.length) config.stopSequences = params.stop_sequences.slice(0, 5);
  const effort = effortOf(params);
  const gen = generation(params.model);
  // Gemini 3 thinks in levels; 2.5 in a budget of tokens. Older models don't think.
  if (effort && gen >= 3) config.thinkingConfig = { thinkingLevel: effort === "low" ? "low" : "high" };
  else if (effort && /gemini-2\.5/i.test(params.model)) config.thinkingConfig = { thinkingBudget: effort === "low" ? 1024 : effort === "medium" ? 4096 : 8192 };
  const system = [systemText(params.system), ...params.messages.filter((m) => m.role === "system").map((m) => systemText(m.content as Params["system"]))].filter(Boolean).join("\n\n");
  const body: Record<string, unknown> = { contents: geminiContents(params), generationConfig: config };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }];
    const tc = toolConfig(params.tool_choice);
    if (tc) body.toolConfig = tc;
  }
  return body;
}

/** A refused tool definition, named the way lib/ai.ts rejectedTool reads Anthropic's. */
export function geminiRewrite(tools: PlainTool[]): (message: string) => string {
  return (message) => {
    const i = /function_declarations\[(\d+)\]/i.exec(message)?.[1] ?? /functionDeclarations\[(\d+)\]/.exec(message)?.[1];
    const tool = i === undefined ? undefined : tools[Number(i)];
    return tool ? `tools.${tool.at}.custom.input_schema: ${message}` : message;
  };
}

const REFUSED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

function stopReason(finish: unknown, toolCalls: number, blocked: boolean): Round["stop"] {
  if (blocked || (typeof finish === "string" && REFUSED.has(finish))) return "refusal";
  if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") return "malformed";
  if (toolCalls) return "tool_use";
  if (finish === "MAX_TOKENS") return "max_tokens";
  return "end_turn";
}

function geminiUsage(u: unknown) {
  const x = (u ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  const cached = x.cachedContentTokenCount ?? 0;
  return usage(Math.max(0, (x.promptTokenCount ?? 0) - cached), (x.candidatesTokenCount ?? 0) + (x.thoughtsTokenCount ?? 0), cached);
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown; id?: string }; thoughtSignature?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: unknown;
};

/** One part of a reply as a block (a thought summary isn't one), and the call's signature kept for next time. */
function partBlock(p: NonNullable<NonNullable<NonNullable<GeminiResponse["candidates"]>[number]["content"]>["parts"]>[number]): RoundBlock | null {
  if (p.functionCall?.name) {
    const id = safeId(p.functionCall.id, "toolu");
    remember(id, p.functionCall.id, p.thoughtSignature);
    const args = p.functionCall.args;
    return { type: "tool_use", id, name: p.functionCall.name, input: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
  }
  if (typeof p.text === "string" && p.text && !p.thought) return { type: "text", text: p.text };
  return null;
}

export function geminiRound(json: unknown): Round {
  const j = json as GeminiResponse;
  const c = j?.candidates?.[0];
  const content: RoundBlock[] = [];
  for (const p of c?.content?.parts ?? []) {
    const b = partBlock(p);
    if (!b) continue;
    const last = content[content.length - 1];
    if (b.type === "text" && last?.type === "text") last.text += b.text;
    else content.push(b);
  }
  return { content, stop: stopReason(c?.finishReason, content.filter((b) => b.type === "tool_use").length, !!j?.promptFeedback?.blockReason), usage: geminiUsage(j?.usageMetadata) };
}

export function geminiAdapter(): Adapter {
  const target = (model: string, stream: boolean) => {
    const c = credentials("gemini");
    if (!c) throw new ProviderUnavailable("gemini");
    const path = `${c.base}/v1beta/models/${encodeURIComponent(bareModel(model))}`;
    return { url: stream ? `${path}:streamGenerateContent?alt=sse` : `${path}:generateContent`, headers: { "x-goog-api-key": c.key } };
  };
  return {
    async send(params, signal) {
      const t = target(params.model, false);
      const tools = plainTools(params.tools);
      const res = await post(t.url, t.headers, geminiBody(params, tools), signal, geminiRewrite(tools));
      return geminiRound(await readJson(res));
    },
    async stream(params, signal, on) {
      const t = target(params.model, true);
      const tools = plainTools(params.tools);
      const res = await post(t.url, { ...t.headers, accept: "text/event-stream" }, geminiBody(params, tools), signal, geminiRewrite(tools));
      if (!res.body) return geminiRound(await readJson(res));
      return readGeminiStream(res.body, on);
    },
  };
}

/** Gemini's stream as round events. Words arrive in pieces; a tool call arrives whole, so it's passed on in one piece. */
export async function readGeminiStream(body: ReadableStream<Uint8Array>, on: (event: RoundEvent) => void): Promise<Round> {
  const content: RoundBlock[] = [];
  let finish: unknown = null;
  let blocked = false;
  let used: unknown = null;
  let key = 0;
  for await (const data of sseData(body)) {
    let chunk: GeminiResponse & { error?: unknown };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw streamError(chunk.error);
    if (chunk.usageMetadata) used = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) blocked = true;
    const c = chunk.candidates?.[0];
    if (c?.finishReason) finish = c.finishReason;
    for (const p of c?.content?.parts ?? []) {
      const b = partBlock(p);
      if (!b) continue;
      if (b.type === "text") {
        on({ type: "text", text: b.text });
        const last = content[content.length - 1];
        if (last?.type === "text") last.text += b.text;
        else content.push(b);
      } else {
        on({ type: "tool", key, id: b.id, name: b.name });
        on({ type: "args", key, json: JSON.stringify(b.input) });
        key++;
        content.push(b);
      }
    }
  }
  return { content, stop: stopReason(finish, content.filter((b) => b.type === "tool_use").length, blocked), usage: geminiUsage(used) };
}
