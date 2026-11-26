/**
 * Sample mode for AI models: the gateway's catalogue as it
 * might read on 17 Nov 2026, Athena's notes on the models it knows, and the
 * owner's choices, all on this device. Every route in the contract is answered
 * here the way the server would: consent is checked, taking an agreement back
 * puts each choice on that provider (the owner's and each assistant's) back to
 * the default, and Try it waits a believable moment.
 */
import { DEFAULT_MODELS, JOBS, PROVIDERS, needsConsent, refKey, sameRef, type AssistantModels, type CatalogueModel, type JobId, type ModelRef, type ModelSettings, type ProviderId, type ResolvedModel } from "../../../lib/model-types";

/** GET /api/models, as the contract shapes it. */
export interface ModelsResponse {
  catalogue: CatalogueModel[];
  updated_at: string;
  settings: ModelSettings;
  effective: Effective;
  configured: Record<ProviderId, boolean>;
}

/** A resolved model with what GET /api/models adds: a newer version, or a chosen model the gateway no longer lists. */
export type Resolved = ResolvedModel & { newer?: ModelRef; withdrawn?: ModelRef };

export interface Effective {
  think: Resolved;
  image: Resolved | null;
  everyday: Resolved;
  careful: Resolved;
  jobs: Record<JobId, Resolved>;
  /** Every assistant with models of its own. */
  assistants?: Record<string, { think: Resolved; image: Resolved | null }>;
}

export type TestResult = { ok: true; ms: number; reply: string } | { ok: false; error: string };

// ---------- the catalogue ----------

type Notes = Omit<CatalogueModel, "ref" | "preview"> & { preview?: boolean };

const known = (name: string, blurb: string, speed: CatalogueModel["speed"], cost: CatalogueModel["cost"], abilities: Partial<CatalogueModel["abilities"]>, recommended = false): Notes => ({
  name,
  blurb,
  speed,
  cost,
  abilities: { tools: true, vision: true, images: false, web: "handoff", ...abilities },
  // Athena doesn't recommend models. The flag stays in the shape, always false.
  recommended: recommended && false,
});

/** Athena's notes, by refKey. Everything else on the gateway's list is "Not tested with Athena". */
const NOTES: Record<string, Notes> = {
  "anthropic/claude-opus-5-5": known("Claude Opus 5.5", "The most thorough. Best for long or tricky questions.", "slow", 4, { web: "native" }, true),
  "anthropic/claude-sonnet-5-5": known("Claude Sonnet 5.5", "Careful, and quick enough for every day.", "balanced", 3, { web: "native" }, true),
  "anthropic/claude-haiku-5-5": known("Claude Haiku 5.5", "Quick and cheap, good for summaries and small checks.", "quick", 1, { web: "native" }, true),
  "anthropic/claude-opus-4-8": known("Claude Opus 4.8", "The last Opus. Thorough, and slower than 5.5.", "slow", 4, { web: "native" }),
  "anthropic/claude-sonnet-4-6": known("Claude Sonnet 4.6", "The last Sonnet. Still good for every day.", "balanced", 3, { web: "native" }),
  "anthropic/claude-haiku-4-5": known("Claude Haiku 4.5", "The last Haiku. Quick and cheap.", "quick", 1, { web: "native" }),
  "openai/gpt-5.5": known("GPT-5.5", "Careful, and good at planning and writing.", "balanced", 3, {}, true),
  "openai/gpt-5.5-mini": known("GPT-5.5 mini", "Quick and cheap, good for short writing.", "quick", 1, {}, true),
  "openai/gpt-5.5-nano": known("GPT-5.5 nano", "The cheapest OpenAI model. Fine for very small jobs.", "quick", 1, { vision: false }),
  "openai/gpt-5.4": known("GPT-5.4", "The last GPT. Careful, a little slower.", "balanced", 3, {}),
  "openai/gpt-image-2": known("GPT Image 2", "Makes detailed pictures. It can't change one you add.", "slow", 3, { tools: false, vision: true, images: true }, true),
  "openai/gpt-image-1.5": known("GPT Image 1.5", "Makes pictures. It can't change one you add.", "slow", 2, { tools: false, vision: true, images: true }),
  "gemini/gemini-3.5-pro": known("Gemini 3.5 Pro", "Careful, and strong with long documents and photos.", "balanced", 3, { web: "native" }, true),
  "gemini/gemini-3.5-flash": known("Gemini 3.5 Flash", "Quick and cheap, and good with photos.", "quick", 1, { web: "native" }, true),
  "gemini/gemini-3.1-pro": known("Gemini 3.1 Pro", "The last Gemini Pro. Careful, a little slower.", "slow", 3, { web: "native" }),
  "gemini/gemini-3.1-flash": known("Gemini 3.1 Flash", "The last Flash. Quick and cheap.", "quick", 1, { web: "native" }),
  "gemini/gemini-3.5-flash-lite": known("Gemini 3.5 Flash-Lite", "The cheapest Gemini. Fine for very small jobs.", "quick", 1, { web: "native" }),
  "gemini/gemini-3-pro-image": known("Gemini 3 Pro Image", "Makes pictures, and changes ones you add.", "slow", 3, { tools: false, images: true, web: "native" }, true),
  "gemini/gemini-3.5-flash-image": known("Gemini 3.5 Flash Image", "Quick pictures, and quick changes to ones you add.", "quick", 2, { tools: false, images: true, web: "native" }, true),
  "meta/llama-4-maverick": known("Llama 4 Maverick", "Meta's open model. Fine for plain questions.", "quick", 1, {}),
  "meta/llama-4-scout": known("Llama 4 Scout", "Meta's small open model. Fine for short summaries.", "quick", 1, {}),
  "meta/llama-3.2-3b-instruct": known("Llama 3.2 3B", "A tiny open model. It can't use Athena's tools.", "quick", 1, { tools: false, vision: false }),
  "openrouter/deepseek/deepseek-v4-pro": known("DeepSeek V4 Pro", "Careful and cheap. Runs through OpenRouter.", "slow", 2, { vision: false }),
};

// The gateway's list (well-known makers only on OpenRouter). Ids only: the gateway gives no names. The catalogue shows
// only the newest version in each family; an older one stays valid, and is
// listed, while it's chosen.
const GATEWAY: Record<ProviderId, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-haiku-4-5"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.5-mini", "gpt-5.4-mini", "gpt-5.5-nano", "gpt-5.4-nano", "gpt-5.5-pro", "gpt-5.4-pro", "gpt-image-2", "gpt-image-1.5"],
  gemini: ["gemini-4-pro-preview", "gemini-3.5-pro", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.1-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash-image", "gemini-3-pro-image"],
  meta: ["llama-4-maverick", "llama-4-scout", "llama-3.3-70b-instruct", "llama-3.2-3b-instruct"],
  openrouter: [
    "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v3.2",
    "qwen/qwen3.5-max", "qwen/qwen3.5-flash", "qwen/qwen3-max",
    "mistralai/mistral-large-3", "mistralai/mistral-medium-3.2", "mistralai/mistral-small-3.2-24b-instruct",
    "moonshotai/kimi-k3", "moonshotai/kimi-k2.5",
    "x-ai/grok-5", "x-ai/grok-4.1",
    "z-ai/glm-5", "z-ai/glm-4.7",
    "minimax/minimax-m3", "minimax/minimax-m2.1",
    "cohere/command-a", "cohere/command-a-reasoning",
    "google/gemma-4-31b-it", "google/gemma-3-27b-it",
    "openai/gpt-oss-120b", "openai/gpt-oss-20b",
  ],
};

const PREVIEW = /preview|-exp\b|-exp-/;
/** Ids that answer Try it with a failure, so the error can be seen in sample mode. */
const FAILS = /minimax-m2\.1|gemma-3-27b/;

/** Every model on the gateway's list, with Athena's notes: what a choice is checked and timed against. */
function allModels(): CatalogueModel[] {
  return PROVIDERS.flatMap((provider) =>
    GATEWAY[provider].map((model): CatalogueModel => {
      const ref = { provider, model };
      const n = NOTES[refKey(ref)];
      const preview = PREVIEW.test(model);
      if (n) return { ref, ...n, preview: n.preview ?? preview };
      const images = /image/.test(model);
      return { ref, name: model, blurb: null, speed: null, cost: null, abilities: { tools: images ? false : "unknown", vision: images ? true : "unknown", images, web: "handoff" }, recommended: false, preview };
    })
  );
}

// ---------- the owner's choices, on this device ----------

const state: { settings: ModelSettings; assistants: Map<string, AssistantModels>; catalogue: CatalogueModel[] | null } = {
  // A believable start: Google agreed a few days ago. Everyday work on a Gemini Flash the gateway no longer lists (so it
  // runs on the default), Careful work still on the last Sonnet (so Sonnet 5.5 shows as newer), the briefing on Opus,
  // and recipes on an Opus that's gone (so Careful work's model runs).
  settings: {
    everyday: { provider: "gemini", model: "gemini-3-flash" },
    careful: { provider: "anthropic", model: "claude-sonnet-4-6" },
    jobs: { briefing: { provider: "anthropic", model: "claude-opus-5-5" }, recipes: { provider: "anthropic", model: "claude-3-opus-20240229" } },
    consent: { gemini: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  },
  // Wren thinks with the last Opus, so her page offers Opus 5.5 (sample-team's id for Wren).
  assistants: new Map([["5a3e0000-0000-4000-8000-0000000e0003", { think: { provider: "anthropic", model: "claude-opus-4-8" } }]]),
  catalogue: null,
};

const CONFIGURED: Record<ProviderId, boolean> = { anthropic: true, openai: true, gemini: true, meta: true, openrouter: true };

/** Every model the owner or an assistant has chosen. */
function chosen(): ModelRef[] {
  const s = state.settings;
  const own = [...state.assistants.values()].flatMap((m) => [m.think, m.image]);
  return [s.think, s.image, s.everyday, s.careful, ...Object.values(s.jobs ?? {}), ...own].filter((r): r is ModelRef => !!r);
}

/** What the picker lists: the newest in each family, plus any older one that's chosen (the server's trim). */
export function sampleCatalogue(): CatalogueModel[] {
  const all = (state.catalogue ??= allModels());
  const picked = chosen();
  return all.filter((m) => !NEWER[refKey(m.ref)] || picked.some((r) => sameRef(r, m.ref)));
}

/** The newer version in a model's family, as the server's family rules would find it (sample: by hand). */
const NEWER: Record<string, string> = {
  "anthropic/claude-opus-4-8": "claude-opus-5-5",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-5-5",
  "anthropic/claude-haiku-4-5": "claude-haiku-5-5",
  "openai/gpt-5.4": "gpt-5.5",
  "openai/gpt-5.4-mini": "gpt-5.5-mini",
  "openai/gpt-5.4-nano": "gpt-5.5-nano",
  "openai/gpt-5.4-pro": "gpt-5.5-pro",
  "openai/gpt-image-1.5": "gpt-image-2",
  "gemini/gemini-3.1-pro": "gemini-3.5-pro",
  "gemini/gemini-3.1-flash": "gemini-3.5-flash",
  "gemini/gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
  "openrouter/moonshotai/kimi-k2.5": "moonshotai/kimi-k3",
  "openrouter/x-ai/grok-4.1": "x-ai/grok-5",
  "openrouter/z-ai/glm-4.7": "z-ai/glm-5",
  "openrouter/minimax/minimax-m2.1": "minimax/minimax-m3",
  "openrouter/google/gemma-3-27b-it": "google/gemma-4-31b-it",
};

/** A choice as it will run: newer when there's a newer one; withdrawn (and what runs instead) when it's gone. */
function resolve(chosen: ModelRef, from: Resolved["from"], instead: Resolved | null): Resolved {
  if (!inCatalogue(chosen)) return instead ? { ref: instead.ref, from: instead.from, withdrawn: chosen } : { ref: chosen, from, withdrawn: chosen };
  const n = NEWER[refKey(chosen)];
  return { ref: chosen, from, ...(n ? { newer: { provider: chosen.provider, model: n } } : {}) };
}

function effective(s: ModelSettings): Effective {
  const tier = (t: "everyday" | "careful"): Resolved => {
    const d: Resolved = { ref: DEFAULT_MODELS[t], from: "default" };
    return s[t] ? resolve(s[t]!, "owner", d) : d;
  };
  const jobs = Object.fromEntries(
    (Object.keys(JOBS) as JobId[]).map((j) => {
      const t = tier(JOBS[j].tier);
      const follow: Resolved = { ref: t.ref, from: t.from === "default" ? "default" : "tier" };
      const own = s.jobs?.[j];
      return [j, own ? resolve(own, "job", follow) : follow];
    })
  ) as Record<JobId, Resolved>;
  const think = s.think ? resolve(s.think, "owner", { ref: DEFAULT_MODELS.think, from: "default" }) : { ref: DEFAULT_MODELS.think, from: "default" as const };
  const image = s.image ? resolve(s.image, "owner", null) : null;
  const assistants: Effective["assistants"] = {};
  for (const [id, m] of state.assistants) {
    if (!m.think && m.image === undefined) continue;
    assistants[id] = {
      think: m.think ? resolve(m.think, "assistant", think) : think,
      image: m.image === null ? null : m.image ? resolve(m.image, "assistant", null) : image,
    };
  }
  return { think, image, everyday: tier("everyday"), careful: tier("careful"), jobs, assistants };
}

const clone = <T>(v: T): T => structuredClone(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The error the server sends, with the code the contract names. */
export class SampleRefusal extends Error {
  constructor(message: string, public status: number, public code?: string, public provider?: ProviderId) {
    super(message);
  }
}

/** On the gateway's list at all, shown or not: what keeps a choice valid (the server's `listed`). */
const inCatalogue = (ref: ModelRef) => (state.catalogue ??= allModels()).some((m) => sameRef(m.ref, ref));
const agreed = (p: ProviderId) => !needsConsent(p) || !!state.settings.consent?.[p];

function check(ref: ModelRef | null | undefined, role: string): void {
  if (!ref) return;
  if (!inCatalogue(ref)) throw new SampleRefusal("That model isn't on the gateway's list any more.", 400);
  if (!agreed(ref.provider)) throw new SampleRefusal("Agree to send data to this company first.", 409, "consent_needed", ref.provider);
  const m = (state.catalogue ??= allModels()).find((x) => sameRef(x.ref, ref))!;
  if (role === "think" && m.abilities.tools === false) throw new SampleRefusal("That model can't use Athena's tools, so it can't think for Ask.", 400);
  if (role === "image" && !m.abilities.images) throw new SampleRefusal("That model doesn't make pictures.", 400);
}

export async function sampleGet(): Promise<ModelsResponse> {
  await wait(120);
  return { catalogue: clone(sampleCatalogue()), updated_at: new Date(Date.now() - 5 * 3_600_000).toISOString(), settings: clone(state.settings), effective: effective(state.settings), configured: { ...CONFIGURED } };
}

export async function samplePatch(patch: Partial<ModelSettings>): Promise<{ settings: ModelSettings; effective: Effective }> {
  await wait(260);
  const next: ModelSettings = clone(state.settings);
  for (const key of ["think", "image", "everyday", "careful"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    check(v, key);
    if (v == null) delete next[key];
    else next[key] = v as ModelRef;
  }
  if (patch.jobs) {
    const jobs = { ...next.jobs };
    for (const [j, v] of Object.entries(patch.jobs) as Array<[JobId, ModelRef | null]>) {
      if (!(j in JOBS)) throw new SampleRefusal("There's no job by that name.", 400);
      check(v, j);
      if (v == null) delete jobs[j];
      else jobs[j] = v;
    }
    next.jobs = jobs;
  }
  state.settings = next;
  return { settings: clone(next), effective: effective(next) };
}

export async function sampleConsent(provider: ProviderId): Promise<{ settings: ModelSettings }> {
  await wait(200);
  if (needsConsent(provider)) state.settings.consent = { ...state.settings.consent, [provider]: new Date().toISOString() };
  return { settings: clone(state.settings) };
}

/** DELETE /api/models/consent/:provider: every choice on it, the owner's and each assistant's, goes back to the default. */
export async function sampleTakeBack(provider: ProviderId): Promise<{ settings: ModelSettings; effective: Effective }> {
  await wait(260);
  const s = clone(state.settings);
  if (needsConsent(provider) && s.consent) delete s.consent[provider];
  for (const key of ["think", "image", "everyday", "careful"] as const) if (s[key]?.provider === provider) delete s[key];
  if (s.jobs) for (const j of Object.keys(s.jobs) as JobId[]) if (s.jobs[j]?.provider === provider) delete s.jobs[j];
  for (const [id, m] of state.assistants) {
    const next = { ...m };
    if (next.think?.provider === provider) delete next.think;
    if (next.image?.provider === provider) delete next.image;
    state.assistants.set(id, next);
  }
  state.settings = s;
  return { settings: clone(s), effective: effective(s) };
}

export async function sampleTest(ref: ModelRef, role: "think" | "image"): Promise<TestResult> {
  check(ref, role);
  const m = (state.catalogue ??= allModels()).find((x) => sameRef(x.ref, ref))!;
  const base = role === "image" ? 3800 : m.speed === "quick" ? 650 : m.speed === "slow" ? 2300 : 1200;
  const ms = Math.round(base * (0.8 + Math.random() * 0.4));
  await wait(Math.min(ms, 2600));
  if (FAILS.test(ref.model)) return { ok: false, error: "The gateway didn't answer for this model. Try again later, or pick another." };
  return { ok: true, ms, reply: role === "image" ? "sample-file-picture" : `Hello. This is ${m.blurb ? m.name : ref.model}, ready when you are.` };
}

// ---------- each assistant's own models ----------

/** An assistant's models in sample mode (sample-team has no `models`), kept here so take back can reach them. */
export function sampleAssistantModels(id: string, fallback?: AssistantModels): AssistantModels {
  return clone(state.assistants.get(id) ?? fallback ?? {});
}

export async function sampleSaveAssistantModels(id: string, models: AssistantModels): Promise<AssistantModels> {
  await wait(220);
  check(models.think, "think");
  check(models.image, "image");
  state.assistants.set(id, clone(models));
  return clone(models);
}
