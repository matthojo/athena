/**
 * A provider behind Anthropic's `messages.create` and `messages.stream` (docs/ai-models.md). Each call is one or
 * more rounds with the provider: when the model calls web_search or web_fetch, the lookup is handed to Claude
 * (lib/llm/web.ts), its result goes back to the model, and the model carries on, all inside the one call, the way
 * Anthropic runs its server tools. What comes back is one Anthropic message: words, tool_use blocks, and the
 * server_tool_use and result blocks of each lookup.
 */
import { Anthropic, gatewayDenied } from "../ai";
import type { ProviderId } from "../model-types";
import type { Adapter, Round, RoundBlock, RoundEvent } from "./round";
import { type Message, type Params, type StreamEvent, hasMedia, refusedMedia, serverTools, toolsUnsupported, usage, withoutMedia, newId } from "./shared";
import { SeenLinks, handOffFetch, handOffSearch, type ModelClientLike } from "./web";

/**
 * Waits after the gateway's bare 403, in ms: 15 s in all. Shorter than lib/ai.ts's minute, since this layer doesn't know
 * the caller's deadline. Refusal bursts have run up to a minute (docs/notes/ask-gateway-403.md). Tests shorten them.
 */
export const REFUSAL_WAITS_MS: number[] = [1_000, 4_000, 10_000];

/** Rounds of lookups in one call before it hands back with pause_turn, as Anthropic does (lib/answer.ts carries on). */
const MAX_ROUNDS = 5;

type Out = Anthropic.ContentBlock;

/** Raw stream events, as the SDK's MessageStream would give them. */
type Emit = (event: StreamEvent) => void;

const direct = { type: "direct" as const };

function asBlock(b: RoundBlock): Out {
  return b.type === "text" ? { type: "text", text: b.text, citations: null } : { type: "tool_use", id: b.id, name: b.name, input: b.input, caller: direct };
}

function addUsage(a: Anthropic.Usage, b: Anthropic.Usage): Anthropic.Usage {
  return { ...a, input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0) || null };
}

export class ProviderMessages {
  constructor(
    private provider: Exclude<ProviderId, "anthropic">,
    private adapter: Adapter,
    /** Claude, for the web lookups. */
    private claude: () => ModelClientLike,
  ) {}

  create(params: Params): Promise<Message> {
    const controller = new AbortController();
    return this.run(params, controller.signal);
  }

  stream(params: Params): ProviderStream {
    const controller = new AbortController();
    return new ProviderStream((emit) => this.run(params, controller.signal, emit), controller);
  }

  /** One round, with the provider's refusals made readable: no tools at all, or no pictures (asked again without them). */
  private async round(params: Params, signal: AbortSignal, on?: (e: RoundEvent) => void): Promise<Round> {
    const once = (p: Params) => this.refusalsWaited(() => (on ? this.adapter.stream(p, signal, on) : this.adapter.send(p, signal)), signal);
    try {
      return await once(params);
    } catch (error) {
      const noTools = toolsUnsupported(error);
      if (noTools) throw noTools;
      if (refusedMedia(error) && hasMedia(params)) {
        console.warn(`Athena llm: ${this.provider} refused a picture or file, asked again without`);
        return once(withoutMedia(params).params);
      }
      throw error;
    }
  }

  /**
   * The gateway's bare 403 (lib/ai.ts gatewayDenied), waited out here rather than in lib/ai.ts: its retry builds a new
   * Claude client, which would send this provider's model to Anthropic. The key is read fresh on each try, so asking
   * again is all a retry needs. Still refused, it's thrown as a 403 that says so, which lib/ai.ts passes to the caller.
   * Before anything streams only: a refusal comes as the response's status, before its body.
   */
  private async refusalsWaited<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await call();
      } catch (error) {
        if (!gatewayDenied(error)) throw error;
        const wait = REFUSAL_WAITS_MS[n];
        console.warn(`Athena gateway 403 ${JSON.stringify({ provider: this.provider, refusals: n + 1, next: wait === undefined ? "stop" : `wait-${wait / 1000}s` })}`);
        if (wait === undefined) {
          const message = "The AI gateway turned the request away. Try again in a minute.";
          const e = error as InstanceType<typeof Anthropic.APIError>;
          const refused = Anthropic.APIError.generate(403, { type: "error", error: { type: "gateway_refused", message } }, message, e.headers);
          refused.message = `403 ${message}`;
          throw refused;
        }
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal.addEventListener("abort", () => (clearTimeout(t), reject(new Anthropic.APIUserAbortError())), { once: true });
        });
      }
    }
  }

  private async run(params: Params, signal: AbortSignal, emit?: Emit): Promise<Message> {
    const servers = serverTools(params.tools);
    const seen = new SeenLinks(params.messages);
    const content: Out[] = [];
    let total = usage();
    let stop: Anthropic.StopReason = "end_turn";
    let searches = 0;
    let pages = 0;
    const message: Message = {
      id: `msg_${this.provider}_${newId("").slice(1)}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: total,
    } as Message;
    emit?.({ type: "message_start", message: { ...message, content: [] } });

    // What each content block is, as it's streamed: its place in the message.
    let open = -1;
    const close = () => {
      if (open >= 0) emit?.({ type: "content_block_stop", index: open });
      open = -1;
    };
    const start = (block: Out): number => {
      close();
      content.push(block);
      open = content.length - 1;
      const shown = block.type === "tool_use" || block.type === "server_tool_use" ? { ...block, input: {} } : block.type === "text" ? { ...block, text: "" } : block;
      emit?.({ type: "content_block_start", index: open, content_block: shown } as unknown as StreamEvent);
      return open;
    };

    for (let r = 0, malformed = 0; ; r++) {
      const turn: Params = r === 0 ? params : { ...params, messages: [...params.messages, { role: "assistant", content: content as Anthropic.ContentBlockParam[] }] };
      // Live, a tool call's place in this round maps to its block; a web lookup is held back until it runs.
      const live = new Map<number, number | "held">();
      let textAt = -1;
      const on = emit
        ? (e: RoundEvent) => {
            if (e.type === "text") {
              if (textAt < 0 || open !== textAt) textAt = start({ type: "text", text: "", citations: null });
              emit({ type: "content_block_delta", index: textAt, delta: { type: "text_delta", text: e.text } });
            } else if (e.type === "tool") {
              if (servers[e.name as "web_search" | "web_fetch"]) live.set(e.key, "held");
              else live.set(e.key, start({ type: "tool_use", id: e.id, name: e.name, input: {}, caller: direct }));
              textAt = -1;
            } else {
              const at = live.get(e.key);
              if (typeof at === "number") emit({ type: "content_block_delta", index: at, delta: { type: "input_json_delta", partial_json: e.json } });
            }
          }
        : undefined;
      const before = content.length;
      const got = await this.round(turn, signal, on);
      total = addUsage(total, got.usage);
      if (got.stop === "malformed" && malformed < 1) {
        // The call couldn't be read: whatever streamed of it goes, and the model is asked once more.
        malformed++;
        close();
        content.length = before;
        r--;
        continue;
      }
      // The round's blocks, final: streamed ones get their finished input; the rest are added now.
      const lookups: Array<{ block: Extract<RoundBlock, { type: "tool_use" }> }> = [];
      if (emit) {
        let streamed = before;
        for (const b of got.content) {
          if (b.type === "tool_use" && servers[b.name as "web_search" | "web_fetch"]) {
            lookups.push({ block: b });
            continue;
          }
          // Match the streamed block in order; anything not streamed (a provider that didn't stream it) is added.
          const i = content.findIndex((c, k) => k >= streamed && c.type === b.type && (b.type === "text" || (c as Anthropic.ToolUseBlock).id === b.id));
          if (i >= 0) {
            content[i] = asBlock(b);
            streamed = i + 1;
          } else {
            const at = start(asBlock(b));
            if (b.type === "text") emit({ type: "content_block_delta", index: at, delta: { type: "text_delta", text: b.text } });
            else emit({ type: "content_block_delta", index: at, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
          }
        }
      } else {
        for (const b of got.content) {
          if (b.type === "tool_use" && servers[b.name as "web_search" | "web_fetch"]) lookups.push({ block: b });
          else content.push(asBlock(b));
        }
      }
      stop = got.stop === "malformed" ? "end_turn" : got.stop;
      if (!lookups.length) break;

      // The lookups, one after another, each shown as it starts and as it comes back.
      const claude = this.claude();
      for (const { block } of lookups) {
        const kind = block.name as "web_search" | "web_fetch";
        const def = servers[kind]!;
        const max = (def as { max_uses?: number | null }).max_uses ?? Infinity;
        const used = kind === "web_search" ? searches : pages;
        const at = start({ type: "server_tool_use", id: block.id, name: kind, input: block.input, caller: direct });
        emit?.({ type: "content_block_delta", index: at, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        close();
        let pair: { use: Anthropic.ServerToolUseBlock; result: Anthropic.WebSearchToolResultBlock | Anthropic.WebFetchToolResultBlock; ran?: boolean };
        if (used >= max) {
          pair = {
            use: content[at] as Anthropic.ServerToolUseBlock,
            result:
              kind === "web_search"
                ? { type: "web_search_tool_result", tool_use_id: block.id, caller: direct, content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }
                : { type: "web_fetch_tool_result", tool_use_id: block.id, caller: direct, content: { type: "web_fetch_tool_result_error", error_code: "max_uses_exceeded" } },
          };
        } else {
          pair = kind === "web_search" ? await handOffSearch(block.id, block.input, def, claude) : await handOffFetch(block.id, block.input, def, claude, seen);
          // A lookup refused before it ran (no query, a link not in the conversation) uses none of the budget.
          if (pair.ran && kind === "web_search") searches++;
          else if (pair.ran) pages++;
        }
        content[at] = pair.use;
        seen.add(pair.result);
        start(pair.result);
        close();
      }
      // Other tools called beside the lookups are the caller's to run: it hands back now, as Claude would.
      if (got.content.some((b) => b.type === "tool_use" && !servers[b.name as "web_search" | "web_fetch"])) {
        stop = "tool_use";
        break;
      }
      if (r + 1 >= MAX_ROUNDS) {
        stop = "pause_turn";
        break;
      }
      if (signal.aborted) throw new Anthropic.APIUserAbortError();
    }
    close();
    if (searches || pages) total = { ...total, server_tool_use: { web_search_requests: searches, web_fetch_requests: pages } as Anthropic.ServerToolUsage };
    message.stop_reason = stop;
    message.usage = total;
    emit?.({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, stop_details: null, container: null }, usage: { ...total } } as StreamEvent);
    emit?.({ type: "message_stop" });
    return message;
  }
}

/**
 * What `messages.stream` hands back, as far as Athena uses the SDK's MessageStream (lib/ai.ts streamMessage):
 * its events as an async iterator, `finalMessage()`, `finalText()`, `done()` and `abort()`.
 */
export class ProviderStream {
  private queue: StreamEvent[] = [];
  private waiting: Array<() => void> = [];
  private finished = false;
  private failure: unknown = undefined;
  private result: Promise<Message>;

  constructor(
    run: (emit: Emit) => Promise<Message>,
    public controller: AbortController,
  ) {
    this.result = run((event) => {
      this.queue.push(event);
      this.wake();
    });
    this.result.then(
      () => {
        this.finished = true;
        this.wake();
      },
      (error) => {
        this.failure = error;
        this.finished = true;
        this.wake();
      },
    );
  }

  private wake(): void {
    for (const w of this.waiting.splice(0)) w();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.finished) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  finalMessage(): Promise<Message> {
    return this.result;
  }

  async finalText(): Promise<string> {
    const m = await this.result;
    return m.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ");
  }

  async done(): Promise<void> {
    await this.result;
  }

  abort(): void {
    this.controller.abort();
  }
}
