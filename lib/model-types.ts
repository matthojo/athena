/**
 * Which AI model does which job: the shared types for "AI models".
 * Imported by the server and by app/src, so nothing here
 * may touch the database, the environment or Node.
 *
 * Every model is reached through Netlify AI Gateway. A model is named by its
 * gateway provider and the model id the gateway lists for it
 * (api.netlify.com/api/v1/ai-gateway/providers).
 */

/** The gateway's providers that can think or make pictures. (TypeSafe's Jev is not offered: it only answers small typed questions.) */
export const PROVIDERS = ["anthropic", "openai", "gemini", "meta", "openrouter"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** The company behind each provider, as the app names it. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
  meta: "Meta",
  openrouter: "OpenRouter",
};

/** One model on one provider, e.g. { provider: "gemini", model: "gemini-3.5-flash" }. */
export interface ModelRef {
  provider: ProviderId;
  model: string;
}

/**
 * The background jobs that use a model, each in a tier. "everyday" is quick, small work; "careful" is work where
 * quality shows. The env var is the deploy's old override, still read beneath the owner's choice.
 */
export const JOBS = {
  file_summary: { tier: "everyday", env: "ATHENA_FILE_SUMMARY_MODEL" },
  checkin_deeper: { tier: "everyday", env: "ATHENA_CHECKIN_DEEPER_MODEL" },
  team_memory: { tier: "everyday", env: "ATHENA_TEAM_MEMORY_MODEL" },
  team_questions: { tier: "everyday", env: "ATHENA_TEAM_QUESTIONS_MODEL" },
  briefing: { tier: "careful", env: "ATHENA_BRIEFING_MODEL" },
  drafts: { tier: "careful", env: "ATHENA_DRAFT_MODEL" },
  recipes: { tier: "careful", env: "ATHENA_RECIPE_MODEL" },
  team_draft: { tier: "careful", env: "ATHENA_TEAM_DRAFT_MODEL" },
  team_skill: { tier: "careful", env: "ATHENA_TEAM_SKILL_MODEL" },
  skill_draft: { tier: "careful", env: "ATHENA_ASSISTANT_MODEL" },
  profile_learner: { tier: "careful", env: "ATHENA_LEARNER_MODEL" },
  collector: { tier: "careful", env: "ATHENA_COLLECTOR_MODEL" },
} as const satisfies Record<string, { tier: Tier; env: string }>;
export type JobId = keyof typeof JOBS;
export type Tier = "everyday" | "careful";

/**
 * What a model is asked to do. "think": Ask, and each assistant's chats, runs and checks (reading, deciding, making
 * changes). "image": making or changing a picture in a chat. A job or a tier is background work.
 */
export type Role = "think" | "image" | Tier | JobId;

/** The code's own defaults, used when neither the owner nor the deploy chose. Pictures are off until the owner picks a model. */
export const DEFAULT_MODELS: { think: ModelRef; image: ModelRef | null; everyday: ModelRef; careful: ModelRef } = {
  think: { provider: "anthropic", model: "claude-sonnet-5-5" },
  image: null,
  everyday: { provider: "anthropic", model: "claude-haiku-5-5" },
  careful: { provider: "anthropic", model: "claude-sonnet-5-5" },
};

/**
 * The owner's choices, kept in one `settings` row (key `ai_models`). Missing means "the default".
 * Before the first choice on a provider other than Anthropic, the app asks once and records it in `consent`; after
 * that, anything that model's role reads may go to that provider.
 */
export interface ModelSettings {
  /** Ask's own model, and every assistant's unless the assistant has its own. */
  think?: ModelRef;
  /** The picture model for Ask, and every assistant's unless it has its own. null: pictures are off. */
  image?: ModelRef | null;
  everyday?: ModelRef;
  careful?: ModelRef;
  /** Advanced: one background job on its own model, over its tier. */
  jobs?: Partial<Record<JobId, ModelRef>>;
  /** When the owner agreed to send data to each provider (ISO instant). Anthropic needs none. */
  consent?: Partial<Record<Exclude<ProviderId, "anthropic">, string>>;
}

/** One assistant's own models (team_assistants.models). A missing key, or null for think, means "the same as Ask". */
export interface AssistantModels {
  think?: ModelRef | null;
  /** A model of its own; null: no pictures for this assistant; missing: the same as Ask. */
  image?: ModelRef | null;
}

/** What a model can do, as far as Athena knows. "unknown" for a gateway model with no notes of ours. */
export interface ModelAbilities {
  /** It can call Athena's tools (needed to think: read, plan, change). */
  tools: boolean | "unknown";
  /** It can look at photos and PDFs pages sent to it. */
  vision: boolean | "unknown";
  /** It makes pictures. */
  images: boolean;
  /** How web lookups work for it: on the model's own side, or handed to Claude. */
  web: "native" | "handoff";
}

/** One model in the catalogue the app shows (GET /api/models). */
export interface CatalogueModel {
  ref: ModelRef;
  /** "Claude Sonnet 5.5". The model id when there are no notes of ours. */
  name: string;
  /** One line in the owner's words: what it's good at. Null for a model with no notes of ours. */
  blurb: string | null;
  /** Relative, in words the app shows: quick, balanced or slow. Null when unknown. */
  speed: "quick" | "balanced" | "slow" | null;
  /** Relative cost, 1 (cheapest) to 4. Null when unknown. */
  cost: 1 | 2 | 3 | 4 | null;
  abilities: ModelAbilities;
  /** Always false: Athena doesn't recommend models. Kept so the shape doesn't change. */
  recommended: boolean;
  /** Its id says preview or experimental (the gateway's list has no such mark). */
  preview: boolean;
}

/** A role's model as it will actually run, and where that choice came from. */
export interface ResolvedModel {
  ref: ModelRef;
  from: "assistant" | "owner" | "job" | "tier" | "env" | "default";
  /** A newer version in the same family is listed. The choice stays; the app offers this one. (GET /api/models only.) */
  newer?: ModelRef;
  /**
   * The chosen model, which the gateway no longer lists; `ref` is what runs instead. For pictures nothing else runs,
   * so `ref` is the same model and pictures fail until another is chosen. (GET /api/models only.)
   */
  withdrawn?: ModelRef;
}

/** "gemini/gemini-3.5-flash". OpenRouter ids carry their own slash ("openrouter/deepseek/deepseek-v4-pro"). */
export function refKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/** The ModelRef for a key from refKey, or null for anything else. */
export function parseRefKey(key: unknown): ModelRef | null {
  if (typeof key !== "string") return null;
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const provider = key.slice(0, slash);
  const model = key.slice(slash + 1);
  if (!(PROVIDERS as readonly string[]).includes(provider) || !model || model.length > 200) return null;
  return { provider: provider as ProviderId, model };
}

export function isModelRef(raw: unknown): raw is ModelRef {
  const r = raw as ModelRef | null;
  return !!r && typeof r === "object" && (PROVIDERS as readonly string[]).includes(r.provider) && typeof r.model === "string" && r.model.length > 0 && r.model.length <= 200;
}

export function sameRef(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/** Does sending to this provider need the owner's one-time agreement? */
export function needsConsent(provider: ProviderId): provider is Exclude<ProviderId, "anthropic"> {
  return provider !== "anthropic";
}
