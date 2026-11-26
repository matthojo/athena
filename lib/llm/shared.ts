/**
 * What every provider adapter shares (lib/llm/index.ts): the environment, errors shaped like the
 * Anthropic SDK's, tool ids, tool input that arrives as broken JSON, and reading a server-sent event stream.
 * Nothing here logs a key, a prompt or a reply.
 */
import { Anthropic } from "../ai";
import type { ProviderId } from "../model-types";

export type Params = Anthropic.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Message;
export type StreamEvent = Anthropic.MessageStreamEvent;
export type Usage = Anthropic.Usage;

export function env(name: string): string | undefined {
  return (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name) ?? process.env[name];
}

/** Where each provider's key and address are injected by the gateway, and where to go with your own key and no address. */
export const PROVIDER_ENV: Record<Exclude<ProviderId, "anthropic">, { key: string[]; base: string; fallback: string }> = {
  openai: { key: ["OPENAI_API_KEY"], base: "OPENAI_BASE_URL", fallback: "https://api.openai.com/v1" },
  meta: { key: ["META_API_KEY"], base: "META_BASE_URL", fallback: "https://api.llama.com/compat/v1" },
  openrouter: { key: ["OPENROUTER_API_KEY"], base: "OPENROUTER_BASE_URL", fallback: "https://openrouter.ai/api/v1" },
  gemini: { key: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], base: "GOOGLE_GEMINI_BASE_URL", fallback: "https://generativelanguage.googleapis.com" },
};

/** The key and address as they are now. Read on every call: the platform rewrites them while a process lives (lib/ai.ts). */
export function credentials(provider: Exclude<ProviderId, "anthropic">): { key: string; base: string } | null {
  const e = PROVIDER_ENV[provider];
  const key = e.key.map(env).find(Boolean);
  if (!key) return null;
  return { key, base: (env(e.base) || e.fallback).replace(/\/+$/, "") };
}

// ---------- errors ----------

/** The provider's own words for a failure, from whichever shape it answered in. Never the request. */
function providerMessage(body: unknown): string | undefined {
  const b = (Array.isArray(body) ? body[0] : body) as { error?: unknown; message?: unknown } | null | undefined;
  if (!b || typeof b !== "object") return undefined;
  const e = b.error as { message?: unknown; metadata?: { raw?: unknown } } | string | undefined;
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  if (typeof b.message === "string") return b.message;
  return undefined;
}

/**
 * A failed response as the Anthropic SDK would throw it: the same classes (RateLimitError for 429, so lib/ai.ts waits
 * it out), `status`, `headers`, and `error` holding the parsed body. A body that's empty stays undefined, so a bare
 * 403 reads to gatewayDenied exactly as the gateway's own refusal of a Claude call does.
 */
export async function errorFrom(res: Response, rewrite?: (message: string, body: unknown) => string): Promise<InstanceType<typeof Anthropic.APIError>> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  let body: unknown = undefined;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 500) } };
    }
  }
  let message = providerMessage(body);
  if (message && rewrite) message = rewrite(message, body);
  return withMessage(Anthropic.APIError.generate(res.status, body as object | undefined, message, res.headers), message);
}

/** The SDK writes a body it doesn't know as JSON into `message`; the provider's own words read better (and rejectedTool reads them). */
function withMessage<E extends Error & { status?: number }>(error: E, message: string | undefined): E {
  if (message) error.message = `${error.status ?? ""} ${message}`.trim();
  return error;
}

/** An error the stream itself carried (OpenRouter sends one as a data line), with the status it named or 500. */
export function streamError(error: unknown): InstanceType<typeof Anthropic.APIError> {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof e.code === "number" ? e.code : typeof e.status === "number" ? e.status : Number(e.code) || 500;
  const message = typeof e.message === "string" ? e.message : undefined;
  return withMessage(Anthropic.APIError.generate(code, { error }, message, new Headers()), message);
}

/** The request couldn't be sent or the answer didn't arrive: the SDK's own connection error (or its abort). */
export function connectionError(error: unknown): Error {
  if (error instanceof Anthropic.APIError) return error;
  if (error instanceof Error && error.name === "AbortError") return new Anthropic.APIUserAbortError();
  return new Anthropic.APIConnectionError({ message: "Couldn't reach the model.", cause: error instanceof Error ? error : undefined });
}

/** Words a provider uses when the model can't take tools at all. */
const NO_TOOLS = /(does not|doesn't|do not) support (tools|tool use|tool calling|function calling)|tools? (is|are) not supported|tool use is not supported|no endpoints found that support tool use|function calling is not (enabled|supported)/i;

/** That failure, in words Athena's owner can read, with `status` kept and `error.error.type` "tools_unsupported". */
export function toolsUnsupported(error: unknown): InstanceType<typeof Anthropic.APIError> | null {
  const e = error as { status?: unknown; message?: unknown; headers?: Headers } | null;
  if (!(e instanceof Anthropic.APIError) || (e.status !== 400 && e.status !== 404 && e.status !== 422) || !NO_TOOLS.test(String(e.message))) return null;
  const message = "This model can't look things up, so it can't think for Athena.";
  return withMessage(Anthropic.APIError.generate(e.status, { type: "error", error: { type: "tools_unsupported", message } }, message, e.headers), message);
}

/** Words a provider uses when the model can't read pictures or PDFs. */
const NO_MEDIA = /image|vision|multimodal|modalit|file input|\bpdf\b|document|inline_?data|attachment/i;
export function refusedMedia(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown } | null;
  return e instanceof Anthropic.APIError && (e.status === 400 || e.status === 404 || e.status === 415 || e.status === 422) && NO_MEDIA.test(String(e.message));
}

// ---------- ids and tool input ----------

/** A tool id any provider and Anthropic will take back: letters, digits, _ and -. */
export function newId(prefix = "toolu"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
export function safeId(id: unknown, prefix = "toolu"): string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId(prefix);
}

/**
 * A tool call's arguments as an object. Models sometimes send them wrapped in a code fence, with words around them,
 * or cut short; what can be read is kept, and anything else is an empty object (the tool then says what's missing).
 */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  const tries = [raw, raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(raw.slice(start, end + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
      // Some models send the arguments as a JSON string inside a string.
      if (typeof v === "string") return parseArgs(v);
    } catch {
      /* the next try */
    }
  }
  const closed = closeJson(raw.slice(Math.max(0, start)));
  try {
    const v = JSON.parse(closed);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* nothing readable */
  }
  return {};
}

/** JSON cut short, closed: an open string ended, open objects and arrays shut. */
function closeJson(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = s.replace(/\\$/, "");
  if (inString) out += '"';
  out = out.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
  return out + stack.reverse().join("");
}

// ---------- usage ----------

export function usage(input = 0, output = 0, cacheRead = 0): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: cacheRead || null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

// ---------- server-sent events ----------

/** Each `data:` payload of a server-sent event stream, as text. Comments (OpenRouter's keep-alives) are skipped. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer[nl] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    if (data.length) yield data.join("\n");
  } finally {
    reader.releaseLock();
  }
}

// ---------- the request, read the same way by every adapter ----------

export type Block = Anthropic.ContentBlockParam | Anthropic.ContentBlock;

/** The system prompt as one piece of text (cache_control and other markers dropped). */
export function systemText(system: Params["system"]): string {
  if (!system) return "";
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
}

/** A tool's place: an ordinary tool, Anthropic's web search or web fetch (offered as ordinary tools elsewhere), or one that can't go. */
export type ToolKind = "custom" | "web_search" | "web_fetch" | "other";
export function toolKind(tool: Anthropic.ToolUnion): ToolKind {
  const type = (tool as { type?: string }).type;
  if (typeof type === "string" && /^web_search_\d/.test(type)) return "web_search";
  if (typeof type === "string" && /^web_fetch_\d/.test(type)) return "web_fetch";
  if ("input_schema" in tool && tool.input_schema) return "custom";
  return "other";
}

/** A tool as a provider is offered it: name, words and JSON Schema. */
export interface PlainTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** Its place in the list the caller sent, for errors that point at one (lib/ai.ts rejectedTool). */
  at: number;
}

export const WEB_SEARCH_PLAIN = {
  description: "Search the web. Gives the top results with their links, and what they say about the question.",
  schema: { type: "object", properties: { query: { type: "string", description: "What to search for, in a few words." } }, required: ["query"] },
};
export const WEB_FETCH_PLAIN = {
  description: "Open a web page by its link and read it. Only a link already in this conversation: the owner's message, a search result, or what a tool gave.",
  schema: { type: "object", properties: { url: { type: "string", description: "The page's full link, exactly as it was given." } }, required: ["url"] },
};

export function plainTools(tools: Params["tools"]): PlainTool[] {
  const out: PlainTool[] = [];
  for (const [at, t] of (tools ?? []).entries()) {
    const kind = toolKind(t);
    if (kind === "custom") {
      const c = t as Anthropic.Tool;
      out.push({ name: c.name, description: c.description ?? "", schema: cleanSchema(c.input_schema as Record<string, unknown>), at });
    } else if (kind === "web_search") out.push({ name: "web_search", ...WEB_SEARCH_PLAIN, at });
    else if (kind === "web_fetch") out.push({ name: "web_fetch", ...WEB_FETCH_PLAIN, at });
  }
  return out;
}

/** A tool's schema, always an object, with Anthropic's own markers taken off. */
function cleanSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const s = { ...(schema ?? {}) };
  delete s.cache_control;
  if (s.type !== "object") s.type = "object";
  if (!s.properties || typeof s.properties !== "object") s.properties = {};
  return s;
}

/** The server tools the caller offered, by name, with their settings (max_uses, user_location, url_sources…). */
export function serverTools(tools: Params["tools"]): { web_search?: Anthropic.ToolUnion; web_fetch?: Anthropic.ToolUnion } {
  const out: { web_search?: Anthropic.ToolUnion; web_fetch?: Anthropic.ToolUnion } = {};
  for (const t of tools ?? []) {
    const kind = toolKind(t);
    if (kind === "web_search" || kind === "web_fetch") out[kind] = t;
  }
  return out;
}

/** How hard to think, from output_config.effort or thinking, or undefined when the caller didn't say. */
export function effortOf(params: Params): "low" | "medium" | "high" | undefined {
  const effort = (params as { output_config?: { effort?: string | null } }).output_config?.effort;
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  const thinking = (params as { thinking?: { type?: string; budget_tokens?: number } }).thinking;
  if (thinking?.type === "enabled") return (thinking.budget_tokens ?? 0) >= 8000 ? "high" : (thinking.budget_tokens ?? 0) >= 2000 ? "medium" : "low";
  if (thinking?.type === "adaptive") return "medium";
  return undefined;
}

/** A tool_result's content as text, and any pictures or PDFs in it (a provider takes those on a user turn, not a tool's). */
export function resultParts(content: Anthropic.ToolResultBlockParam["content"]): { text: string; media: Array<Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam> } {
  if (content === undefined) return { text: "", media: [] };
  if (typeof content === "string") return { text: content, media: [] };
  const text: string[] = [];
  const media: Array<Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam> = [];
  for (const b of content) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "image") media.push(b);
    else if (b.type === "document") {
      const t = documentText(b);
      if (t !== null) text.push(t);
      else media.push(b);
    } else if (b.type === "search_result") text.push(`${b.title} (${b.source})\n${b.content.map((c) => c.text).join("\n")}`);
  }
  return { text: text.join("\n\n"), media };
}

/** A document that is really text (a note, a page read), as text; null for a PDF or a link, which go as a file. */
export function documentText(b: Anthropic.DocumentBlockParam | Anthropic.DocumentBlock): string | null {
  const src = b.source as { type: string; data?: string; content?: unknown };
  const title = "title" in b && b.title ? `${b.title}\n` : "";
  if (src.type === "text") return `${title}${src.data ?? ""}`;
  if (src.type === "content") {
    const c = src.content;
    if (typeof c === "string") return `${title}${c}`;
    if (Array.isArray(c)) return `${title}${c.map((x: { type: string; text?: string }) => (x.type === "text" ? (x.text ?? "") : "")).join("\n")}`;
  }
  return null;
}

/** The request with every picture and PDF replaced by a line saying one was there: for a model that can't read them. */
export function withoutMedia(params: Params): { params: Params; had: boolean } {
  let had = false;
  const note = (b: Anthropic.ContentBlockParam): Anthropic.ContentBlockParam => {
    if (b.type === "image") {
      had = true;
      return { type: "text", text: "(A picture was attached here. This model can't see pictures, so say so if it matters.)" };
    }
    if (b.type === "document" && documentText(b) === null) {
      had = true;
      return { type: "text", text: `(A file${b.title ? `, ${b.title},` : ""} was attached here. This model can't open files, so say so if it matters.)` };
    }
    if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map((c) => note(c as Anthropic.ContentBlockParam)) as Anthropic.ToolResultBlockParam["content"] };
    return b;
  };
  const messages = params.messages.map((m) => (typeof m.content === "string" ? m : { ...m, content: (m.content as Anthropic.ContentBlockParam[]).map(note) })) as Anthropic.MessageParam[];
  return { params: { ...params, messages }, had };
}

/** Does the request carry a picture or a PDF anywhere? */
export function hasMedia(params: Params): boolean {
  return withoutMedia(params).had;
}

/**
 * What a provider was told a web lookup returned, kept beside the result block it belongs to so the model reads the
 * same words on every later round. A block cloned or rebuilt loses it, and the words are made again from the block.
 */
export const handedText = new WeakMap<object, string>();

/** A web result block as words for a model that isn't Claude. */
export function webResultText(block: Anthropic.WebSearchToolResultBlockParam | Anthropic.WebFetchToolResultBlockParam | Anthropic.ContentBlock): string {
  const kept = handedText.get(block);
  if (kept) return kept;
  if (block.type === "web_search_tool_result") {
    const c = block.content;
    if (!Array.isArray(c)) return `The search didn't work (${(c as { error_code?: string }).error_code ?? "unavailable"}).`;
    return c.length ? c.map((r, i) => `${i + 1}. ${r.title} — ${r.url}${r.page_age ? ` (${r.page_age})` : ""}`).join("\n") : "No results.";
  }
  if (block.type === "web_fetch_tool_result") {
    const c = block.content as { type: string; error_code?: string; url?: string; content?: Anthropic.DocumentBlockParam };
    if (c.type !== "web_fetch_result") return `The page didn't open (${c.error_code ?? "unavailable"}).`;
    const doc = c.content;
    const text = doc ? (documentText(doc) ?? "(The page is a file this model can't read.)") : "";
    return `Page: ${c.url ?? ""}\n\n${text}`;
  }
  return "";
}

/** A tool id as it's sent to a provider: the same id gives the same answer, so a call and its result still pair up. */
export function idOut(id: string): string {
  const s = String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s || "toolu_none";
}

/** POST a JSON body (the gateway refuses anything else). A failure comes back as the SDK's error, with `status`. */
export async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, rewrite?: (message: string, body: unknown) => string): Promise<Response> {
  let res: Response;
  try {
    res = await globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (error) {
    throw connectionError(error);
  }
  if (!res.ok) throw await errorFrom(res, rewrite);
  return res;
}

/** The body of a successful answer as JSON; one that isn't is a 502, as a gateway would say. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw Anthropic.APIError.generate(502, { error: { message: "The model's answer wasn't readable." } }, "The model's answer wasn't readable.", res.headers);
  }
}
