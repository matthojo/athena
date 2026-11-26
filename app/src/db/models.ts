/**
 * AI models, for the app. One read of
 * GET /api/models is kept for the page; every change answers with fresh
 * settings and effective models, which replace it. Sample mode answers on the
 * device (db/sample-models.ts).
 *
 * A choice on a company the owner hasn't agreed to comes back as
 * ConsentNeeded, so the picker can ask and try again.
 */
import { ApiError, isSampleMode, request } from "./api";
import { getAssistant, updateAssistant, type TeamAssistant } from "./team";
import { sampleConsent, sampleGet, samplePatch, sampleSaveAssistantModels, sampleAssistantModels, sampleTakeBack, sampleTest, SampleRefusal, type Effective, type ModelsResponse, type TestResult } from "./sample-models";
import type { AssistantModels, ModelRef, ModelSettings, ProviderId } from "../../../lib/model-types";

export type { Effective, ModelsResponse, TestResult };

/** The server refused a choice: that company needs the owner's agreement first. */
export class ConsentNeeded extends Error {
  constructor(public provider: ProviderId) {
    super("consent_needed");
  }
}

let cached: ModelsResponse | null = null;
let loading: Promise<ModelsResponse> | null = null;
const listeners = new Set<(m: ModelsResponse) => void>();

/** Called with the fresh state after every change, wherever it was made (Settings, an assistant's page). */
export function onModelsChange(fn: (m: ModelsResponse) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function update(next: Partial<ModelsResponse>): ModelsResponse {
  if (!cached) throw new Error("Models aren't loaded");
  cached = { ...cached, ...next };
  const now = cached;
  listeners.forEach((fn) => fn(now));
  return now;
}

/** What a refusal means for the owner: ConsentNeeded, or an error that says what to do. */
function refusal(e: unknown, provider?: ProviderId): Error {
  const status = e instanceof ApiError || e instanceof SampleRefusal ? e.status : undefined;
  if (status === 409 && provider) return new ConsentNeeded((e as SampleRefusal).provider ?? provider);
  if (!(e instanceof ApiError) && !(e instanceof SampleRefusal)) return new Error("Couldn't reach Athena. Check you're online and try again.");
  return e instanceof Error && e.message ? e : new Error("That didn't save. Try again.");
}

/** GET /api/models, once per page unless `fresh`. */
export async function loadModels(opts: { fresh?: boolean } = {}): Promise<ModelsResponse> {
  if (cached && !opts.fresh) return cached;
  loading ??= (isSampleMode() ? sampleGet() : request<ModelsResponse>("/models"))
    .then((m) => {
      cached = m;
      return m;
    })
    .finally(() => (loading = null));
  return loading;
}

export const modelsNow = (): ModelsResponse | null => cached;

/** PATCH /api/models. A key set to null goes back to the default (`image: null` turns pictures off). */
export async function saveModels(patch: Partial<Omit<ModelSettings, "consent">>, provider?: ProviderId): Promise<ModelsResponse> {
  try {
    const r = isSampleMode() ? await samplePatch(patch) : await request<{ settings: ModelSettings; effective: Effective }>("/models", { method: "PATCH", body: JSON.stringify(patch) });
    return update(r);
  } catch (e) {
    throw refusal(e, provider);
  }
}

/** POST /api/models/consent: the owner agreed to send data to this company. */
export async function agreeTo(provider: ProviderId): Promise<ModelsResponse> {
  try {
    const r = isSampleMode() ? await sampleConsent(provider) : await request<{ settings: ModelSettings }>("/models/consent", { method: "POST", body: JSON.stringify({ provider }) });
    return update({ settings: r.settings });
  } catch (e) {
    throw refusal(e);
  }
}

/** DELETE /api/models/consent/:provider: every choice on that company goes back to the default. */
export async function takeBack(provider: ProviderId): Promise<ModelsResponse> {
  try {
    const r = isSampleMode() ? await sampleTakeBack(provider) : await request<{ settings: ModelSettings; effective: Effective }>(`/models/consent/${encodeURIComponent(provider)}`, { method: "DELETE" });
    return update(r);
  } catch (e) {
    throw refusal(e);
  }
}

/** POST /api/models/test: one small call, so a model can be checked before it's used. */
export async function tryModel(ref: ModelRef, role: "think" | "image"): Promise<TestResult> {
  try {
    return isSampleMode() ? await sampleTest(ref, role) : await request<TestResult>("/models/test", { method: "POST", body: JSON.stringify({ ref, role }) });
  } catch (e) {
    const r = refusal(e, ref.provider);
    if (r instanceof ConsentNeeded) throw r;
    return { ok: false, error: r.message };
  }
}

// ---------- an assistant's own models ----------

/** An assistant's own models. In sample mode they're kept with the sample models, so take back reaches them. */
export function assistantModels(a: Pick<TeamAssistant, "id" | "models">): AssistantModels {
  return isSampleMode() ? sampleAssistantModels(a.id, a.models) : { ...a.models };
}

/** An assistant's own models as the server has them now: after taking an agreement back, say. */
export async function freshAssistantModels(a: Pick<TeamAssistant, "id" | "models">): Promise<AssistantModels> {
  if (isSampleMode()) return sampleAssistantModels(a.id, a.models);
  const next = await getAssistant(a.id);
  return { ...(next ?? a).models };
}

/** PATCH /api/team/:id with `models`: the whole object (a missing key is "the same as Ask"). */
export async function saveAssistantModels(a: Pick<TeamAssistant, "id">, models: AssistantModels, provider?: ProviderId): Promise<AssistantModels> {
  try {
    if (isSampleMode()) return await sampleSaveAssistantModels(a.id, models);
    const next = await updateAssistant(a.id, { models });
    return { ...next.models };
  } catch (e) {
    throw refusal(e, provider);
  }
}
