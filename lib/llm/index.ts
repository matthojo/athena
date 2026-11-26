/**
 * One client shape for every gateway provider.
 *
 * `clientFor(ref)` returns an object with Anthropic's `messages.create` and
 * `messages.stream`, taking and returning Anthropic-shaped messages, tools,
 * tool_use / tool_result blocks, images, stop reasons and usage, whatever
 * provider is behind it. So every caller keeps calling
 * `createMessage(clientFor(ref), { model: ref.model, ... })` (lib/ai.ts) and
 * never learns another SDK. OpenAI, Meta and OpenRouter speak chat completions
 * (lib/llm/openai.ts); Gemini speaks generateContent (lib/llm/gemini.ts); web
 * search and web fetch are handed to Claude (lib/llm/web.ts).
 */
import { Anthropic, aiConfigured } from "../ai";
import type { ModelRef, ProviderId } from "../model-types";
import { ProviderMessages } from "./client";
import { ProviderUnavailable } from "./errors";
import { geminiAdapter } from "./gemini";
import { openAiAdapter } from "./openai";
import { credentials } from "./shared";

export { ProviderUnavailable };

/** The part of the Anthropic client Athena uses. */
export type ModelClient = Pick<Anthropic, "messages">;

/**
 * A client for this model's provider. `base` lets a test hand in a stand-in for Anthropic; for another provider it's
 * the Claude that runs web lookups. Throws ProviderUnavailable when the deploy has no key for the provider.
 */
export function clientFor(ref: ModelRef, base?: ModelClient): ModelClient {
  if (ref.provider === "anthropic") return base ?? new Anthropic();
  if (!providerConfigured(ref.provider)) throw new ProviderUnavailable(ref.provider);
  const adapter = ref.provider === "gemini" ? geminiAdapter() : openAiAdapter(ref.provider);
  const messages = new ProviderMessages(ref.provider, adapter, () => base ?? new Anthropic());
  return { messages } as unknown as ModelClient;
}

/** Can this deploy reach the provider at all (the gateway injected its variables, or you set your own key)? */
export function providerConfigured(provider: ProviderId): boolean {
  if (provider === "anthropic") return aiConfigured();
  return credentials(provider) !== null;
}
