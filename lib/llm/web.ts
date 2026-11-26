/**
 * Web search and web fetch for a model that isn't Claude. They're Anthropic's server tools, so
 * another provider is offered them as ordinary tools, and each call is handed to one small Claude call that runs the
 * real tool. Its own result block comes back, so Ask's steps, leak checks and citations (lib/answer.ts noteWeb)
 * see exactly what they'd see from Claude. Only the query or the link goes to Claude, never the conversation.
 */
import { Anthropic, createMessage } from "../ai";
import { DEFAULT_MODELS } from "../model-types";
import { handedText, type Block } from "./shared";

export type ModelClientLike = Pick<Anthropic, "messages">;

/** The small Claude that runs each lookup: the everyday default, quick and cheap. */
export const HANDOFF_MODEL = DEFAULT_MODELS.everyday.model;
/** One lookup's time, at most. Ask's own deadline still holds around the whole call. */
const HANDOFF_MS = 45_000;
/** A page as the other model reads it, at most (about 10,000 tokens unless the tool says less). */
const PAGE_CHARS = 40_000;

export type ServerUse = Anthropic.ServerToolUseBlock;
export type ServerResult = Anthropic.WebSearchToolResultBlock | Anthropic.WebFetchToolResultBlock;

const direct = { type: "direct" as const };

function searchError(id: string, code: Anthropic.WebSearchToolResultErrorCode): Anthropic.WebSearchToolResultBlock {
  return { type: "web_search_tool_result", tool_use_id: id, caller: direct, content: { type: "web_search_tool_result_error", error_code: code } };
}
function fetchError(id: string, code: Anthropic.WebFetchToolResultErrorCode): Anthropic.WebFetchToolResultBlock {
  return { type: "web_fetch_tool_result", tool_use_id: id, caller: direct, content: { type: "web_fetch_tool_result_error", error_code: code } };
}
const codeFor = (error: unknown): "too_many_requests" | "unavailable" => ((error as { status?: unknown } | null)?.status === 429 ? "too_many_requests" : "unavailable");

/** A tool's settings, without what the hand-off sets itself. */
function toolFor<T extends Anthropic.ToolUnion>(def: T): T {
  const t = { ...(def as unknown as Record<string, unknown>) };
  delete t.cache_control;
  delete t.url_sources;
  delete t.defer_loading;
  delete t.allowed_callers;
  t.max_uses = 1;
  return t as unknown as T;
}

/** Claude's words about the results, each sentence with the pages it came from. */
function citedText(content: Anthropic.ContentBlock[]): string {
  const out: string[] = [];
  for (const b of content) {
    if (b.type !== "text" || !b.text.trim()) continue;
    const urls = [...new Set((b.citations ?? []).map((c) => (c as { url?: string }).url).filter((u): u is string => !!u))];
    const said = b.text.trim();
    // The pages go inside the sentence's full stop: "about three weeks (https://…)."
    out.push(urls.length ? said.replace(/([.!?]*)$/, ` (${urls.join(", ")})$1`) : said);
  }
  return out.join(" ").trim();
}

export async function handOffSearch(id: string, input: Record<string, unknown>, def: Anthropic.ToolUnion, claude: ModelClientLike): Promise<{ use: ServerUse; result: ServerResult; ran?: boolean }> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const use: ServerUse = { type: "server_tool_use", id, name: "web_search", input: { query }, caller: direct };
  if (!query) return { use, result: searchError(id, "invalid_tool_input") };
  if (query.length > 400) return { use, result: searchError(id, "query_too_long") };
  try {
    const reply = await createMessage(
      claude as Anthropic,
      {
        model: HANDOFF_MODEL,
        max_tokens: 1024,
        system: "You search the web for another assistant. Search once for exactly the query given. Then say what the results show that bears on it, in a few plain sentences, citing the pages. No preamble.",
        tools: [toolFor(def)],
        messages: [{ role: "user", content: `Search the web for: ${query}` }],
      },
      Date.now() + HANDOFF_MS,
    );
    const found = reply.content.find((b): b is Anthropic.WebSearchToolResultBlock => b.type === "web_search_tool_result");
    if (!found) return { use, result: searchError(id, "unavailable") };
    const result: Anthropic.WebSearchToolResultBlock = { ...found, tool_use_id: id, caller: direct };
    const pages = Array.isArray(result.content) ? result.content : [];
    const said = citedText(reply.content);
    const list = pages.length ? pages.map((r, i) => `${i + 1}. ${r.title} — ${r.url}${r.page_age ? ` (${r.page_age})` : ""}`).join("\n") : "No results.";
    handedText.set(result, `Results for “${query}”:\n${list}${said ? `\n\nWhat they say: ${said}` : ""}\n\nCite a page by its link, exactly as shown.`);
    return { use, result, ran: true };
  } catch (error) {
    console.warn(`Athena llm: a web search hand-off failed (${(error as { status?: unknown } | null)?.status ?? "no status"})`);
    return { use, result: searchError(id, codeFor(error)), ran: true };
  }
}

export async function handOffFetch(id: string, input: Record<string, unknown>, def: Anthropic.ToolUnion, claude: ModelClientLike, seen: SeenLinks): Promise<{ use: ServerUse; result: ServerResult; ran?: boolean }> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const use: ServerUse = { type: "server_tool_use", id, name: "web_fetch", input: { url }, caller: direct };
  if (!/^https?:\/\/\S+$/i.test(url)) return { use, result: fetchError(id, "invalid_tool_input") };
  if (url.length > 2000) return { use, result: fetchError(id, "url_too_long") };
  // Anthropic opens only a link already in the conversation, from the sources the tool allows. So does this.
  if (!seen.allows(url, (def as { url_sources?: UrlSources }).url_sources)) return { use, result: fetchError(id, "url_not_in_prior_context") };
  try {
    const reply = await createMessage(
      claude as Anthropic,
      {
        model: HANDOFF_MODEL,
        max_tokens: 64,
        system: "You open a web page for another assistant. Open exactly the link given with web_fetch, once. Then reply only: Done.",
        tools: [toolFor(def)],
        messages: [{ role: "user", content: `Open this page: ${url}` }],
      },
      Date.now() + HANDOFF_MS,
    );
    const found = reply.content.find((b): b is Anthropic.WebFetchToolResultBlock => b.type === "web_fetch_tool_result");
    if (!found) return { use, result: fetchError(id, "unavailable") };
    const result: Anthropic.WebFetchToolResultBlock = { ...found, tool_use_id: id, caller: direct };
    const c = result.content;
    if (c.type === "web_fetch_result") {
      const src = c.content.source as { type: string; data?: string };
      const limit = Math.min(PAGE_CHARS, ((def as { max_content_tokens?: number | null }).max_content_tokens ?? 10_000) * 4);
      const text = src.type === "text" ? String(src.data ?? "").slice(0, limit) : "(The page is a file this model can't read.)";
      const title = c.content.title ? `${c.content.title}\n` : "";
      handedText.set(result, `${title}Page: ${c.url}\n\n${text}`);
    }
    return { use, result, ran: true };
  } catch (error) {
    console.warn(`Athena llm: a web fetch hand-off failed (${(error as { status?: unknown } | null)?.status ?? "no status"})`);
    return { use, result: fetchError(id, codeFor(error)), ran: true };
  }
}

type Source = { type: "all" } | { type: "none" } | { type: "only" | "except"; tools: Array<{ name: string }> };
export type UrlSources = { user_input?: Source; server_tool_results?: Source; client_tool_results?: Source };

/** Does a result of `tool` count, under `s`? `fallback` when the source isn't given. Pure. */
function counts(s: Source | undefined, fallback: boolean, tool: string): boolean {
  if (!s) return fallback;
  if (s.type === "all" || s.type === "none") return s.type === "all";
  const named = s.tools.some((t) => t.name === tool);
  return s.type === "only" ? named : !named;
}

/** Every link in the conversation, by where it came from: the owner's words, a web search or page (by tool), or a named tool's result. */
export class SeenLinks {
  private user: string[] = [];
  private server: Array<{ tool: "web_search" | "web_fetch"; text: string }> = [];
  private client: Array<{ tool: string; text: string }> = [];

  constructor(messages: Anthropic.MessageParam[]) {
    const names = new Map<string, string>();
    for (const m of messages) {
      if (typeof m.content === "string") {
        if (m.role === "user") this.user.push(m.content);
        continue;
      }
      for (const b of m.content) {
        if (b.type === "tool_use") names.set(b.id, b.name);
        if (m.role === "user" && b.type === "text") this.user.push(b.text);
        else if (b.type === "tool_result") this.client.push({ tool: names.get(b.tool_use_id) ?? "", text: JSON.stringify(b.content ?? "") });
        else this.add(b);
      }
    }
  }

  /** A web result this call has had so far counts as soon as it's in. */
  add(b: Block): void {
    if (b.type === "web_search_tool_result") this.server.push({ tool: "web_search", text: JSON.stringify(b.content) });
    else if (b.type === "web_fetch_tool_result") this.server.push({ tool: "web_fetch", text: JSON.stringify(b.content) });
  }

  allows(url: string, sources?: UrlSources): boolean {
    const forms = [url, url.replace(/\/+$/, ""), url.replace(/\/+$/, "") + "/"];
    const has = (texts: string[]) => texts.some((t) => forms.some((f) => t.includes(f) || t.includes(JSON.stringify(f).slice(1, -1))));
    // With no url_sources, as Anthropic: any link already in the conversation.
    if (counts(sources?.user_input, true, "") && has(this.user)) return true;
    if (has(this.server.filter((r) => counts(sources?.server_tool_results, true, r.tool)).map((r) => r.text))) return true;
    if (has(this.client.filter((c) => counts(sources?.client_tool_results, !sources, c.tool)).map((c) => c.text))) return true;
    return false;
  }
}
