/**
 * AI models (docs/ai-models.md, lib/models.ts):
 *
 *   GET    /api/models                     → { catalogue, updated_at, settings, effective, configured }
 *                                           effective: each role and each assistant with its own models, with newer / withdrawn
 *   PATCH  /api/models                     partial ModelSettings (no consent) → { settings, effective }
 *   POST   /api/models/consent             { provider } → { settings }
 *   DELETE /api/models/consent/<provider>  → { settings, effective }: every choice on it goes back to the default
 *   POST   /api/models/test                { ref, role: "think" | "image" } → { ok: true, ms, reply } | { ok: false, error }
 *
 * A choice on a provider the owner hasn't agreed to is 409 { error, code: "consent_needed", provider }; an unknown
 * model, or one that can't do the role, is 400 with a code. Behind the same bearer token as the rest of the API.
 */
import { Anthropic, createMessage, RateLimited } from "../../lib/ai";
import { clientFor, providerConfigured, ProviderUnavailable } from "../../lib/llm";
import { getCatalogue } from "../../lib/model-catalogue";
import { checkChoice, effectiveModels, effectiveRefs, grantConsent, loadModelSettings, ModelChoiceError, revokeConsent, updateModelSettings } from "../../lib/models";
import { isModelRef, parseRefKey, PROVIDERS, type ModelRef, type ProviderId } from "../../lib/model-types";

type Json = (data: unknown, status?: number) => Response;

/** A ModelChoiceError as the app reads it; null for any other error. */
export function modelChoiceResponse(error: unknown, json: Json): Response | null {
  if (!(error instanceof ModelChoiceError)) return null;
  return json({ error: error.message, code: error.code, ...(error.provider ? { provider: error.provider } : {}) }, error.status);
}

const TEST_MS = 20_000;

/** Why a test call failed, in the owner's words. */
export function testError(error: unknown): string {
  if (error instanceof ProviderUnavailable) return error.message;
  if (error instanceof RateLimited) return "Athena's AI is busy. Try again in a minute.";
  const e = error as { status?: unknown; name?: unknown } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.name === "APIConnectionTimeoutError") return "It took too long to answer.";
  if (e?.status === 404) return "The gateway doesn't have that model right now.";
  if (e?.status === 401 || e?.status === 403) return "The gateway turned the request away.";
  if (e?.status === 429) return "Athena's AI is busy. Try again in a minute.";
  return "It didn't answer. Try again, or pick another model.";
}

/** One small call on a model, to see that it answers and how quickly. */
async function tryModel(ref: ModelRef, client?: Anthropic): Promise<{ ok: true; ms: number; reply: string } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const message = await createMessage(
      clientFor(ref, client) as Anthropic,
      { model: ref.model, max_tokens: 60, messages: [{ role: "user", content: "Say hello in five words or fewer." }] },
      started + TEST_MS,
    );
    const reply = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return { ok: true, ms: Date.now() - started, reply };
  } catch (error) {
    console.warn(`Athena models: a test of ${ref.provider}/${ref.model} failed`, (error as Error)?.message?.slice(0, 120));
    return { ok: false, error: testError(error) };
  }
}

const configured = () => Object.fromEntries(PROVIDERS.map((p) => [p, providerConfigured(p)])) as Record<ProviderId, boolean>;

export async function handleModelsRoutes(
  req: Request,
  segments: string[],
  body: () => Promise<Record<string, unknown> | null>,
  json: Json,
  deps: { client?: Anthropic } = {},
): Promise<Response | null> {
  const [first, second, third] = segments;
  if (first !== "models" || segments.length > 3) return null;
  const nope = () => json({ error: "Method not allowed" }, 405);
  try {
    if (!second) {
      if (req.method === "GET") {
        const settings = await loadModelSettings();
        const effective = await effectiveModels(settings);
        // A chosen model the catalogue doesn't show (an older version, a snapshot) is still listed with it, so the app can name it.
        const catalogue = await getCatalogue({ include: effectiveRefs(effective) });
        return json({ catalogue: catalogue.models, updated_at: catalogue.updated_at, settings, effective, configured: configured() });
      }
      if (req.method === "PATCH") {
        const settings = await updateModelSettings(await body());
        return json({ settings, effective: await effectiveModels(settings) });
      }
      return nope();
    }
    if (second === "consent") {
      if (!third && req.method === "POST") return json({ settings: await grantConsent(((await body()) ?? {}).provider) });
      if (third && req.method === "DELETE") {
        const settings = await revokeConsent(third);
        return json({ settings, effective: await effectiveModels(settings) });
      }
      return nope();
    }
    if (second === "test" && !third) {
      if (req.method !== "POST") return nope();
      const b = (await body()) ?? {};
      const ref = typeof b.ref === "string" ? parseRefKey(b.ref) : isModelRef(b.ref) ? { provider: b.ref.provider, model: b.ref.model } : null;
      if (!ref) return json({ error: "ref: give a model as { provider, model }", code: "bad_input" }, 400);
      if (b.role !== "think" && b.role !== "image") return json({ error: "role: think or image", code: "bad_input" }, 400);
      const { consent = {} } = await loadModelSettings();
      await checkChoice(b.role, ref, consent);
      // Pictures are tried through lib/images.ts (models-ask) once it lands; until then a picture model isn't called here.
      if (b.role === "image") return json({ ok: false, error: "Pictures can't be tried from here yet." });
      return json(await tryModel(ref, deps.client));
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const r = modelChoiceResponse(error, json);
    if (r) return r;
    throw error;
  }
}
