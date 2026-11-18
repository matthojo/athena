/**
 * Which model runs each role (docs/ai-models.md), and the owner's choices
 * behind it.
 *
 * The owner's choices are one `settings` row, key `ai_models` (ModelSettings,
 * plain: model names aren't sensitive). Each assistant's own models are
 * `team_assistants.models` (migration 0077). Both are checked when written
 * (checkChoice) and again when read: a choice on a provider the owner hasn't
 * agreed to is ignored, whatever the row says.
 *
 * Precedence, highest first: the assistant's own choice, the owner's choice
 * (a job's own model, then its tier), the deploy's env var, the code default.
 * Each resolver reads at most the settings row and one assistant row.
 */
import { Anthropic, createMessage } from "./ai";
import { AthenaInputError, qRaw } from "./db";
import { clientFor } from "./llm";
import { abilitiesOf, gatewayList, listed, newerVersion, onList, type GatewayList } from "./model-catalogue";
import {
  DEFAULT_MODELS,
  JOBS,
  PROVIDER_NAMES,
  PROVIDERS,
  isModelRef,
  needsConsent,
  parseRefKey,
  sameRef,
  type AssistantModels,
  type JobId,
  type ModelRef,
  type ModelSettings,
  type ProviderId,
  type ResolvedModel,
  type Tier,
} from "./model-types";

const ROW = "ai_models";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_IDS = Object.keys(JOBS) as JobId[];
type Consent = NonNullable<ModelSettings["consent"]>;

function env(name: string): string | undefined {
  return (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name) ?? process.env[name];
}

function fromEnv(name: string, fallback: ModelRef): ResolvedModel {
  const id = env(name);
  return id ? { ref: { provider: "anthropic", model: id }, from: "env" } : { ref: fallback, from: "default" };
}

/** A choice that can't be kept. `code` and `provider` go to the app (409 consent_needed, else 400). */
export class ModelChoiceError extends Error {
  constructor(
    message: string,
    readonly code: "consent_needed" | "unknown_model" | "cant_think" | "no_pictures" | "pictures_only" | "bad_input",
    readonly provider?: ProviderId,
  ) {
    super(message);
    this.name = "ModelChoiceError";
  }
  get status(): 400 | 409 {
    return this.code === "consent_needed" ? 409 : 400;
  }
}

// ---------- the settings row ----------

/** A ref from the app or the row: { provider, model } or "provider/model". */
function readRef(raw: unknown): ModelRef | null {
  if (typeof raw === "string") return parseRefKey(raw);
  return isModelRef(raw) ? { provider: raw.provider, model: raw.model } : null;
}

const agreed = (consent: Consent, ref: ModelRef) => !needsConsent(ref.provider) || !!consent[ref.provider];

/** The row as kept, checked: unknown keys and bad refs dropped, and any choice on a provider not agreed to. Pure. */
export function cleanSettings(raw: unknown): ModelSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const consent: Consent = {};
  const c = r.consent && typeof r.consent === "object" ? (r.consent as Record<string, unknown>) : {};
  for (const p of PROVIDERS) if (needsConsent(p) && typeof c[p] === "string" && !Number.isNaN(Date.parse(c[p] as string))) consent[p] = c[p] as string;
  const ok = (v: unknown) => {
    const ref = readRef(v);
    return ref && agreed(consent, ref) ? ref : undefined;
  };
  const out: ModelSettings = {};
  for (const key of ["think", "image", "everyday", "careful"] as const) {
    const ref = ok(r[key]);
    if (ref) out[key] = ref;
  }
  const jobs = r.jobs && typeof r.jobs === "object" ? (r.jobs as Record<string, unknown>) : {};
  for (const j of JOB_IDS) {
    const ref = ok(jobs[j]);
    if (ref) (out.jobs ??= {})[j] = ref;
  }
  if (Object.keys(consent).length) out.consent = consent;
  return out;
}

export async function loadModelSettings(): Promise<ModelSettings> {
  try {
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [ROW]);
    return cleanSettings(row?.value);
  } catch (error) {
    // No database (a unit test, a script): the env vars and defaults still answer.
    console.warn("Athena models: couldn't read the owner's choices", (error as Error).message?.slice(0, 120));
    return {};
  }
}

async function storeModelSettings(s: ModelSettings): Promise<void> {
  if (!Object.keys(s).length) {
    await qRaw(`DELETE FROM settings WHERE key = $1`, [ROW]);
    return;
  }
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ROW, JSON.stringify(s)]);
}

// ---------- checking a choice ----------

export type ChoiceRole = "think" | "image" | Tier | JobId;

/**
 * May this model take this role? The owner has agreed to its provider, the gateway lists it, and it can do the work:
 * thinking needs tools (refused only when Athena knows it has none), pictures need a picture model, and background work
 * needs words, not a picture model. Throws ModelChoiceError.
 */
export async function checkChoice(role: ChoiceRole, ref: ModelRef, consent: Consent): Promise<void> {
  if (!agreed(consent, ref)) {
    throw new ModelChoiceError(`Athena needs your OK before it sends anything to ${PROVIDER_NAMES[ref.provider]}.`, "consent_needed", ref.provider);
  }
  if (!(await listed(ref))) throw new ModelChoiceError("Netlify AI Gateway doesn't offer that model.", "unknown_model", ref.provider);
  const can = abilitiesOf(ref);
  if (role === "image") {
    if (!can.images) throw new ModelChoiceError("That model doesn't make pictures.", "no_pictures", ref.provider);
    return;
  }
  if (can.images) throw new ModelChoiceError("That model only makes pictures.", "pictures_only", ref.provider);
  if (role === "think" && can.tools === false) throw new ModelChoiceError("That model can't use Athena's tools, so it can't do this.", "cant_think", ref.provider);
}

function refOrNull(raw: unknown, what: string): ModelRef | null {
  if (raw === null) return null;
  const ref = readRef(raw);
  if (!ref) throw new ModelChoiceError(`${what}: give a model as { provider, model }, or null for the default`, "bad_input");
  return ref;
}

/**
 * The owner changes some choices (PATCH /api/models). A key set to null goes back to the default (`image: null`
 * turns pictures off); keys left out stay as they were. Each choice is checked; nothing is kept if one fails.
 */
export async function updateModelSettings(patch: unknown): Promise<ModelSettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ModelChoiceError("Send the choices to change", "bad_input");
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (k === "consent") throw new ModelChoiceError("consent: agree or take it back with /api/models/consent", "bad_input");
    if (!["think", "image", "everyday", "careful", "jobs"].includes(k)) throw new ModelChoiceError(`${k}: not a role Athena knows`, "bad_input");
  }
  const s = await loadModelSettings();
  const consent = s.consent ?? {};
  const next: ModelSettings = { ...s, jobs: { ...s.jobs } };
  for (const key of ["think", "image", "everyday", "careful"] as const) {
    if (!(key in p)) continue;
    const ref = refOrNull(p[key], key);
    if (ref) {
      await checkChoice(key, ref, consent);
      next[key] = ref;
    } else delete next[key];
  }
  if ("jobs" in p) {
    const jobs = p.jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new ModelChoiceError("jobs: give each job's model, or null for its tier", "bad_input");
    for (const [j, raw] of Object.entries(jobs as Record<string, unknown>)) {
      if (!(JOB_IDS as string[]).includes(j)) throw new ModelChoiceError(`jobs.${j}: not a job Athena knows`, "bad_input");
      const ref = refOrNull(raw, `jobs.${j}`);
      if (ref) {
        await checkChoice(j as JobId, ref, consent);
        next.jobs![j as JobId] = ref;
      } else delete next.jobs![j as JobId];
    }
  }
  if (!Object.keys(next.jobs ?? {}).length) delete next.jobs;
  await storeModelSettings(next);
  return next;
}

/** The owner agrees to send to a provider (POST /api/models/consent). Kept the first time; agreeing again changes nothing. */
export async function grantConsent(provider: unknown): Promise<ModelSettings> {
  if (typeof provider !== "string" || !(PROVIDERS as readonly string[]).includes(provider)) throw new ModelChoiceError("provider: one of openai, gemini, meta or openrouter", "bad_input");
  const p = provider as ProviderId;
  if (!needsConsent(p)) throw new ModelChoiceError("Anthropic needs no agreement", "bad_input");
  const s = await loadModelSettings();
  if (s.consent?.[p]) return s;
  const next = { ...s, consent: { ...s.consent, [p]: new Date().toISOString() } };
  await storeModelSettings(next);
  return next;
}

/**
 * The owner takes an agreement back (DELETE /api/models/consent/:provider). Every choice on that provider, the owner's
 * and each assistant's, goes back to its default.
 */
export async function revokeConsent(provider: unknown): Promise<ModelSettings> {
  if (typeof provider !== "string" || !(PROVIDERS as readonly string[]).includes(provider) || !needsConsent(provider as ProviderId)) {
    throw new ModelChoiceError("provider: one of openai, gemini, meta or openrouter", "bad_input");
  }
  const p = provider as Exclude<ProviderId, "anthropic">;
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [ROW]);
  // Read with the agreement still in place, so the choices on it are seen and dropped below.
  const s = cleanSettings(row?.value);
  const on = (ref: ModelRef | null | undefined) => !!ref && ref.provider === p;
  const next: ModelSettings = {};
  for (const key of ["think", "image", "everyday", "careful"] as const) if (s[key] && !on(s[key])) next[key] = s[key];
  for (const j of JOB_IDS) if (s.jobs?.[j] && !on(s.jobs[j])) (next.jobs ??= {})[j] = s.jobs[j];
  const consent = { ...s.consent };
  delete consent[p];
  if (Object.keys(consent).length) next.consent = consent;
  await storeModelSettings(next);
  await qRaw(
    `UPDATE team_assistants SET models = models
       - (CASE WHEN models->'think'->>'provider' = $1 THEN 'think' ELSE '' END)
       - (CASE WHEN models->'image'->>'provider' = $1 THEN 'image' ELSE '' END)
     WHERE models->'think'->>'provider' = $1 OR models->'image'->>'provider' = $1`,
    [p],
  );
  return next;
}

// ---------- an assistant's own models ----------

/** An assistant's models as kept, checked like the owner's row. Pure. */
export function cleanAssistantModels(raw: unknown, consent: Consent): AssistantModels {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: AssistantModels = {};
  const think = readRef(r.think);
  if (think && agreed(consent, think)) out.think = think;
  if (r.image === null) out.image = null;
  else {
    const image = readRef(r.image);
    if (image && agreed(consent, image)) out.image = image;
  }
  return out;
}

/**
 * An assistant's models from POST or PATCH /api/team, the whole set: think missing or null is the same as Ask; image
 * missing is the same as Ask, null is no pictures for it. Checked like the owner's choices.
 */
export async function checkAssistantModels(raw: unknown): Promise<AssistantModels> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ModelChoiceError("models: { think?, image? }", "bad_input");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "think" && k !== "image") throw new ModelChoiceError(`models.${k}: an assistant has think and image`, "bad_input");
  const { consent = {} } = await loadModelSettings();
  const next: AssistantModels = {};
  const think = r.think === undefined ? null : refOrNull(r.think, "models.think");
  if (think) {
    await checkChoice("think", think, consent);
    next.think = think;
  }
  if (r.image !== undefined) {
    const image = refOrNull(r.image, "models.image");
    if (image) await checkChoice("image", image, consent);
    next.image = image;
  }
  return next;
}

async function assistantModels(id: string | null | undefined, consent: Consent): Promise<AssistantModels> {
  if (!id || !UUID.test(id)) return {};
  try {
    const [row] = await qRaw<{ models: unknown }>(`SELECT models FROM team_assistants WHERE id = $1::uuid`, [id]);
    return cleanAssistantModels(row?.models, consent);
  } catch (error) {
    // Before migration 0077, or no database: the assistant has no models of its own.
    console.warn("Athena models: couldn't read an assistant's models", (error as Error).message?.slice(0, 120));
    return {};
  }
}

// ---------- the resolvers ----------

function thinkFrom(s: ModelSettings, envName: string): ResolvedModel {
  return s.think ? { ref: s.think, from: "owner" } : fromEnv(envName, DEFAULT_MODELS.think);
}

function imageFrom(s: ModelSettings): ResolvedModel | null {
  if (s.image) return { ref: s.image, from: "owner" };
  return DEFAULT_MODELS.image ? { ref: DEFAULT_MODELS.image, from: "default" } : null;
}

function jobFrom(s: ModelSettings, job: JobId): ResolvedModel {
  const tier: Tier = JOBS[job].tier;
  const own = s.jobs?.[job];
  if (own) return { ref: own, from: "job" };
  if (s[tier]) return { ref: s[tier]!, from: "tier" };
  return fromEnv(JOBS[job].env, DEFAULT_MODELS[tier]);
}

function tierFrom(s: ModelSettings, tier: Tier): ResolvedModel {
  return s[tier] ? { ref: s[tier]!, from: "owner" } : { ref: DEFAULT_MODELS[tier], from: "default" };
}

/** The model Ask, or one assistant (by id), thinks with. `envName` is the caller's old override (ATHENA_ANSWER_MODEL or ATHENA_ASSISTANT_MODEL). */
export async function resolveThinkModel(opts: { assistantId?: string | null; envName?: string } = {}): Promise<ResolvedModel> {
  const s = await loadModelSettings();
  if (opts.assistantId) {
    const own = await assistantModels(opts.assistantId, s.consent ?? {});
    if (own.think) return { ref: own.think, from: "assistant" };
  }
  return thinkFrom(s, opts.envName ?? "ATHENA_ANSWER_MODEL");
}

/** The picture model for Ask, or one assistant. Null: pictures are off for it. */
export async function resolveImageModel(opts: { assistantId?: string | null } = {}): Promise<ResolvedModel | null> {
  const s = await loadModelSettings();
  if (opts.assistantId) {
    const own = await assistantModels(opts.assistantId, s.consent ?? {});
    if (own.image === null) return null;
    if (own.image) return { ref: own.image, from: "assistant" };
  }
  return imageFrom(s);
}

/** The model one background job runs on. */
export async function resolveJobModel(job: JobId): Promise<ResolvedModel> {
  return jobFrom(await loadModelSettings(), job);
}

export interface EffectiveModels {
  think: ResolvedModel;
  image: ResolvedModel | null;
  everyday: ResolvedModel;
  careful: ResolvedModel;
  jobs: Record<JobId, ResolvedModel>;
  /** Every assistant with models of its own, by id: what it thinks and makes pictures with. */
  assistants: Record<string, { think: ResolvedModel; image: ResolvedModel | null }>;
}

/** The assistants that have models of their own, checked like the owner's row. */
async function assistantsWithModels(consent: Consent): Promise<Array<{ id: string; models: AssistantModels }>> {
  try {
    const rows = await qRaw<{ id: string; models: unknown }>(`SELECT id::text AS id, models FROM team_assistants WHERE models <> '{}'::jsonb ORDER BY created_at, id`);
    return rows.map((r) => ({ id: r.id, models: cleanAssistantModels(r.models, consent) })).filter((r) => "think" in r.models || "image" in r.models);
  } catch (error) {
    console.warn("Athena models: couldn't read the assistants' models", (error as Error).message?.slice(0, 120));
    return [];
  }
}

/**
 * A resolved model with what the gateway's list says about it: `newer` when its family has a newer version, and
 * `withdrawn` when the list no longer has it, with `ref` set to what runs instead (fallbackTarget; pictures have none).
 * `trustGaps` is false when the list is the committed snapshot, which can't say a model has gone.
 */
export function annotate(r: ResolvedModel, role: ChoiceRole, list: GatewayList, trustGaps = true, envName?: string): ResolvedModel {
  const newer = newerVersion(r.ref, list);
  const out: ResolvedModel = newer ? { ...r, newer } : { ...r };
  if (trustGaps && !onList(r.ref, list)) {
    out.withdrawn = r.ref;
    if (role !== "image") out.ref = fallbackTarget(role, r.ref, envName) ?? r.ref;
  }
  return out;
}

/** What each role, and each assistant with its own models, runs on now (GET /api/models), from one read of the settings. */
export async function effectiveModels(s?: ModelSettings): Promise<EffectiveModels> {
  const settings = s ?? (await loadModelSettings());
  const [{ list, source }, own] = await Promise.all([gatewayList(), assistantsWithModels(settings.consent ?? {})]);
  const mark = (r: ResolvedModel, role: ChoiceRole) => annotate(r, role, list, source !== "snapshot");
  const image = imageFrom(settings);
  const assistants: EffectiveModels["assistants"] = {};
  for (const { id, models } of own) {
    const pictures = models.image === null ? null : models.image ? { ref: models.image, from: "assistant" as const } : image;
    assistants[id] = {
      think: mark(models.think ? { ref: models.think, from: "assistant" } : thinkFrom(settings, "ATHENA_ANSWER_MODEL"), "think"),
      image: pictures && mark(pictures, "image"),
    };
  }
  return {
    think: mark(thinkFrom(settings, "ATHENA_ANSWER_MODEL"), "think"),
    image: image && mark(image, "image"),
    everyday: mark(tierFrom(settings, "everyday"), "everyday"),
    careful: mark(tierFrom(settings, "careful"), "careful"),
    jobs: Object.fromEntries(JOB_IDS.map((j) => [j, mark(jobFrom(settings, j), j)])) as Record<JobId, ResolvedModel>,
    assistants,
  };
}

/** Every model `effective` names that may run, so the catalogue can name a chosen model it doesn't show. */
export function effectiveRefs(e: EffectiveModels): ModelRef[] {
  const all = [e.think, e.image, e.everyday, e.careful, ...Object.values(e.jobs), ...Object.values(e.assistants).flatMap((a) => [a.think, a.image])];
  return all.filter((r): r is ResolvedModel => !!r).map((r) => r.ref);
}

/**
 * A model for one message only: Ask's and an assistant chat's request may name one (`model`), when the owner picks "Use
 * Claude Sonnet for this message" because the chosen model can't see a photo. The same checks as a choice (agreement,
 * listed, can think); nothing is stored, so the next message is back on the chosen model. Null when none is named.
 */
export async function messageModel(raw: unknown): Promise<ResolvedModel | null> {
  if (raw === undefined || raw === null) return null;
  const ref = readRef(raw);
  if (!ref) throw new ModelChoiceError("model: give a model as { provider, model }", "bad_input");
  await checkChoice("think", ref, (await loadModelSettings()).consent ?? {});
  return { ref, from: "owner" };
}

// ---------- when a chosen model fails ----------

/** The code's own model for a role. */
export function defaultFor(role: "think" | Tier | JobId): ModelRef {
  if (role === "think") return DEFAULT_MODELS.think;
  return DEFAULT_MODELS[role === "everyday" || role === "careful" ? role : JOBS[role].tier];
}

/**
 * The model a failed choice is tried on once: the deploy's default (its env model), unless that's what failed, then the
 * code default. Null when both are the failed model. `envName` is the caller's env var for think (ATHENA_ANSWER_MODEL by
 * default); a job uses its own; a tier has none.
 */
export function fallbackTarget(role: "think" | Tier | JobId, failed: ModelRef, envName?: string): ModelRef | null {
  const name = role === "think" ? (envName ?? "ATHENA_ANSWER_MODEL") : role === "everyday" || role === "careful" ? undefined : JOBS[role].env;
  const id = name ? env(name) : undefined;
  const deploy: ModelRef | null = id ? { provider: "anthropic", model: id } : null;
  if (deploy && !sameRef(deploy, failed)) return deploy;
  const code = defaultFor(role);
  return sameRef(code, failed) ? null : code;
}

/** Worth trying another model after: anything but the gateway's spending limit, a caller's own mistake, or running out of time. */
function worthFallingBack(error: unknown): boolean {
  const e = error as { name?: string; constructor?: { name?: string } } | null;
  const name = e?.constructor?.name ?? e?.name ?? "";
  if (name === "RateLimited" || name === "AthenaInputError" || name === "AbortError" || name === "APIUserAbortError") return false;
  return !(error instanceof AthenaInputError);
}

/** The model to try next after `error` on `resolved` (fallbackTarget), or null when there's none or the error isn't one to retry. */
export function fallbackRef(resolved: ResolvedModel, role: "think" | JobId, error: unknown, envName?: string): ModelRef | null {
  if (!worthFallingBack(error)) return null;
  const fallback = fallbackTarget(role, resolved.ref, envName);
  if (!fallback) return null;
  console.warn(`Athena models: ${resolved.ref.provider}/${resolved.ref.model} failed for ${role}; trying ${fallback.model}`, (error as Error)?.message?.slice(0, 120));
  return fallback;
}

/**
 * Run a call on the resolved model; if it fails before answering, run it once more on the fallback (fallbackTarget) and
 * say so. `run` gets the model to use. A call already on the last fallback isn't tried twice.
 */
export async function withFallback<T>(resolved: ResolvedModel, role: "think" | JobId, run: (ref: ModelRef) => Promise<T>, envName?: string): Promise<{ value: T; ref: ModelRef; fell_back: boolean; tried?: ModelRef }> {
  try {
    return { value: await run(resolved.ref), ref: resolved.ref, fell_back: false };
  } catch (error) {
    const fallback = fallbackRef(resolved, role, error, envName);
    if (!fallback) throw error;
    return { value: await run(fallback), ref: fallback, fell_back: true, tried: resolved.ref };
  }
}

/**
 * One background job's model call: `createMessage` on the model the owner chose for it (resolveJobModel), tried once
 * on the fallback (fallbackTarget) if it fails. `client` is the Anthropic client (or a test's stand-in) for Claude models.
 */
export async function jobMessage(
  job: JobId,
  client: Anthropic | undefined,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
  deadline: number,
): Promise<Anthropic.Message> {
  const resolved = await resolveJobModel(job);
  const { value } = await withFallback(resolved, job, (ref) => createMessage(clientFor(ref, client) as Anthropic, { ...params, model: ref.model }, deadline));
  return value;
}
