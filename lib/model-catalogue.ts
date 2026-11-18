/**
 * The models the owner can choose from (docs/ai-models.md): Netlify AI
 * Gateway's public list, joined with Athena's own notes on the models it
 * knows.
 *
 * The list is `api.netlify.com/api/v1/ai-gateway/providers` (no key, nothing
 * of the owner's is sent). It's kept for a day in memory and in the `settings`
 * row `ai_gateway_models`, and when it can't be read Athena uses the last copy
 * it has, else the snapshot committed beside this file.
 *
 * Owner, 17 Nov 2026: only the newest version of each model family is
 * offered (familyOf, shownModels); "newest only", which replaced an earlier
 * "newest and the one before". Dated snapshots and
 * aliases are hidden, and on OpenRouter only a short list of well-known makers
 * is offered. A hidden model the owner already chose stays valid: `listed`
 * reads the whole list, not the shown part.
 *
 * Owner, 17 Nov 2026: a family whose newest version is itself old is hidden
 * by name (HIDDEN, each with its reason).
 *
 * Notes are written by hand, one per exact model id. A model with no notes
 * gets a plain name from its id (plainName: "Gemini 3.8 Flash") and "unknown"
 * abilities, with no blurb, speed or cost: the app says "Not tested with
 * Athena" rather than guessing, and a newer model never borrows an older
 * one's notes. Nothing is recommended.
 * The one ability read from an id is the providers' own naming for picture
 * models (`gpt-image-*`, Gemini's `*-image` and Nano Banana).
 */
import snapshot from "./model-catalogue-snapshot.json";
import { PROVIDERS, refKey, sameRef, type CatalogueModel, type ModelAbilities, type ModelRef } from "./model-types";

interface Note {
  name: string;
  blurb: string | null;
  speed: CatalogueModel["speed"];
  cost: CatalogueModel["cost"];
  tools: boolean;
  vision: boolean;
  images?: boolean;
}

/** The gateway's list as Athena keeps it: model ids per provider. */
export interface GatewayList {
  fetched_at: string;
  providers: Partial<Record<string, { models: string[] }>>;
}

const GATEWAY_URL = "https://api.netlify.com/api/v1/ai-gateway/providers";
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW = "ai_gateway_models";

// Cost is relative, from list prices per million input tokens (pictures: per picture) in Nov 2026:
// 1 under $0.50, 2 $0.50 to under $2, 3 $2 to under $5, 4 $5 and up. Null where Athena has no price.
const claude = (name: string, speed: Note["speed"], cost: Note["cost"], blurb: string | null = null): Note => ({ name, blurb, speed, cost, tools: true, vision: true });

const NOTES: Record<string, Note> = {
  "anthropic/claude-fable-5-2": claude("Claude Fable 5.2", null, null, "Anthropic's most capable model."),
  "anthropic/claude-fable-5-1": claude("Claude Fable 5.1", null, null),
  "anthropic/claude-fable-5": claude("Claude Fable 5", null, null),
  "anthropic/claude-opus-5-5": claude("Claude Opus 5.5", "slow", 4, "Slower and costs more. For hard questions and long plans."),
  "anthropic/claude-opus-5": claude("Claude Opus 5", "slow", 4),
  "anthropic/claude-opus-4-8": claude("Claude Opus 4.8", "slow", 4),
  "anthropic/claude-opus-4-7": claude("Claude Opus 4.7", "slow", 4),
  "anthropic/claude-opus-4-6": claude("Claude Opus 4.6", "slow", 4),
  "anthropic/claude-opus-4-5": claude("Claude Opus 4.5", "slow", 4),
  "anthropic/claude-opus-4-5-20251101": claude("Claude Opus 4.5", "slow", 4),
  "anthropic/claude-sonnet-5-5": claude("Claude Sonnet 5.5", "balanced", 3, "Athena's usual. Good with tools, and quick enough to chat."),
  "anthropic/claude-sonnet-5": claude("Claude Sonnet 5", "balanced", 3),
  "anthropic/claude-sonnet-4-6": claude("Claude Sonnet 4.6", "balanced", 3),
  "anthropic/claude-sonnet-4-5": claude("Claude Sonnet 4.5", "balanced", 3),
  "anthropic/claude-sonnet-4-5-20250929": claude("Claude Sonnet 4.5", "balanced", 3),
  "anthropic/claude-haiku-5-5": claude("Claude Haiku 5.5", "quick", 2, "Quick and cheap. Good for summaries and small checks."),
  "anthropic/claude-haiku-4-5": claude("Claude Haiku 4.5", "quick", 2),
  "anthropic/claude-haiku-4-5-20251001": claude("Claude Haiku 4.5", "quick", 2),

  "openai/gpt-5.2": { name: "GPT-5.2", blurb: "OpenAI's main model. Good with tools and photos.", speed: "balanced", cost: 2, tools: true, vision: true },
  "openai/gpt-5.2-2025-12-11": { name: "GPT-5.2", blurb: null, speed: "balanced", cost: 2, tools: true, vision: true },
  "openai/gpt-5.1": { name: "GPT-5.1", blurb: null, speed: "balanced", cost: 2, tools: true, vision: true },
  "openai/gpt-5": { name: "GPT-5", blurb: null, speed: "balanced", cost: 2, tools: true, vision: true },
  "openai/gpt-5-mini": { name: "GPT-5 mini", blurb: null, speed: "quick", cost: 1, tools: true, vision: true },
  "openai/gpt-5-nano": { name: "GPT-5 nano", blurb: null, speed: "quick", cost: 1, tools: true, vision: true },
  "openai/gpt-4.1": { name: "GPT-4.1", blurb: null, speed: "balanced", cost: 3, tools: true, vision: true },
  "openai/gpt-4.1-mini": { name: "GPT-4.1 mini", blurb: null, speed: "quick", cost: 1, tools: true, vision: true },
  "openai/gpt-4o": { name: "GPT-4o", blurb: null, speed: "balanced", cost: 3, tools: true, vision: true },
  "openai/gpt-4o-mini": { name: "GPT-4o mini", blurb: null, speed: "quick", cost: 1, tools: true, vision: true },
  "openai/gpt-image-1.5": { name: "GPT Image 1.5", blurb: "Makes pictures. Can't change one you already have.", speed: "slow", cost: 3, tools: false, vision: false, images: true },

  "gemini/gemini-3.1-pro-preview": { name: "Gemini 3.1 Pro", blurb: "Slower, and good with long documents.", speed: "slow", cost: 3, tools: true, vision: true },
  "gemini/gemini-3-flash-preview": { name: "Gemini 3 Flash", blurb: "Quick and cheap, and sees photos.", speed: "quick", cost: 2, tools: true, vision: true },
  "gemini/gemini-3-pro-image": { name: "Nano Banana Pro", blurb: "Makes and changes pictures. Best when a picture needs words in it.", speed: "slow", cost: 3, tools: false, vision: true, images: true },
  "gemini/gemini-2.5-flash-image": { name: "Nano Banana", blurb: "Quick pictures, and quick changes to your photos.", speed: "quick", cost: 2, tools: false, vision: true, images: true },

  "openrouter/deepseek/deepseek-v3.2": { name: "DeepSeek V3.2", blurb: "Cheap, and good at writing. Reads text only, not photos.", speed: "balanced", cost: 1, tools: true, vision: false },
  "openrouter/moonshotai/kimi-k2.5": { name: "Kimi K2.5", blurb: "Good with tools for the price, and sees photos.", speed: "balanced", cost: 2, tools: true, vision: true },
  "openrouter/qwen/qwen3-235b-a22b-2507": { name: "Qwen3 235B", blurb: null, speed: "balanced", cost: 1, tools: true, vision: false },
  "openrouter/gryphe/mythomax-l2-13b": { name: "MythoMax 13B", blurb: "Writes stories. Can't use Athena's tools.", speed: "quick", cost: 1, tools: false, vision: false },
  "openrouter/meta-llama/llama-4-maverick": { name: "Llama 4 Maverick", blurb: null, speed: "quick", cost: 1, tools: true, vision: true },
};

/** The providers' own names for picture models: OpenAI's gpt-image, Gemini's -image models and Nano Banana. */
function picturesByName(ref: ModelRef): boolean {
  if (ref.provider === "openai") return /^gpt-image-/.test(ref.model);
  if (ref.provider === "gemini") return /-image(-|$)/.test(ref.model) || /nano-banana/.test(ref.model);
  return false;
}

/** What Athena knows a model can do, from its notes alone (no network). */
export function abilitiesOf(ref: ModelRef): ModelAbilities {
  const n = NOTES[refKey(ref)];
  const web = ref.provider === "anthropic" ? "native" : "handoff";
  if (n) return { tools: n.tools, vision: n.vision, images: n.images === true, web };
  if (ref.provider === "anthropic") return { tools: true, vision: true, images: false, web };
  return { tools: "unknown", vision: "unknown", images: picturesByName(ref), web };
}

// ---------- plain names ----------

/** Words spelled the maker's way. */
const SPELLED: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  glm: "GLM",
  oss: "OSS",
  vl: "VL",
  gpt: "GPT",
  customtools: "Custom Tools",
  multi: "Multi",
};
/** Words that say nothing to the owner: instruction tuning, and preview (the catalogue marks that itself). */
const UNSAID = new Set(["instruct", "it", "preview", "exp", "experimental"]);

/** One word of an id as it reads in a name: "27b" is 27B, "qwen3.8" is Qwen3.8, "4-5" pairs are joined before this. */
function plainWord(w: string): string {
  if (SPELLED[w]) return SPELLED[w];
  if (/^a?\d+(\.\d+)?[bt]$/.test(w) || /^\d+x\d+b$/.test(w)) return w.toUpperCase().replace("X", "x"); // 27B, A3B, 8x22B
  if (/^\d+(\.\d+)*[a-z]$/.test(w)) return w.slice(0, -1) + (w.endsWith("o") ? "o" : w.slice(-1).toUpperCase()); // 4.6V; GPT's 4o
  if (/^o\d/.test(w)) return w; // OpenAI's o3
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * A name read from a model's id, for a model with no notes (owner, 17 Nov 2026): "gemini-3.8-flash" is "Gemini 3.8
 * Flash", "qwen/qwen3.8-27b" is "Qwen3.8 27B", "claude-opus-4-5" is "Claude Opus 4.5". Only the name: no blurb, speed
 * or cost is read from an id.
 */
export function plainName(ref: ModelRef): string {
  let id = ref.model.replace(/^~/, "");
  if (ref.provider === "openrouter" && id.includes("/")) id = id.slice(id.indexOf("/") + 1);
  const [base, variant] = id.split(":");
  const full = /-((?:19|20)\d\d)-?(\d\d)-?(\d\d)$/.exec(base);
  const body = full ? base.slice(0, full.index) : base;
  const words: string[] = [];
  for (const tok of body.split(/[-_\s]+/).filter(Boolean)) {
    const prev = words[words.length - 1];
    // Anthropic's and Mistral's versions are split by a dash: claude-opus-4-5 is Opus 4.5.
    if (/^\d{1,2}$/.test(tok) && prev && /^\d{1,2}$/.test(prev)) {
      words[words.length - 1] = `${prev}.${tok}`;
      continue;
    }
    if (!UNSAID.has(tok)) words.push(tok);
  }
  // Mistral's date-named releases whose number Athena knows (DATED): mistral-small-2603 is Mistral Small 4.
  const known = DATED[refKey(ref)];
  if (known && /^\d{4}$/.test(words[words.length - 1] ?? "")) words.splice(words.length - 1, 1);
  if (known) {
    const size = words.findIndex((w) => SIZE.test(w));
    words.splice(size < 0 ? words.length : size, 0, known.join("."));
  }
  let name = words.map(plainWord).join(" ");
  name = name.replace(/^GPT (?=\d)/, "GPT-").replace(/^GPT OSS/, "GPT-OSS").replace(/Multi Agent/, "Multi-Agent");
  // OpenAI writes its small sizes in lower case: GPT-5.4 mini.
  if (name.startsWith("GPT-")) name = name.replace(/ (Mini|Nano)\b/, (m) => m.toLowerCase());
  if (full) name += ` (${full[1]}-${full[2]}-${full[3]})`;
  if (variant) name += ` (${variant})`;
  return name || ref.model;
}

/** One catalogue entry for a model the gateway lists. Notes only from this exact id; nothing is recommended. */
export function describe(ref: ModelRef): CatalogueModel {
  const n = NOTES[refKey(ref)];
  return {
    ref,
    name: n?.name ?? plainName(ref),
    blurb: n?.blurb ?? null,
    speed: n?.speed ?? null,
    cost: n?.cost ?? null,
    abilities: abilitiesOf(ref),
    recommended: false,
    preview: /(^|[-.:])(preview|exp|experimental)([-.:]|$)/.test(ref.model),
  };
}

// ---------- families: which models are shown ----------

/** One model id read as a family and a version: "claude-sonnet-4-5" is family claude-sonnet, version 4.5. */
export interface Family {
  /** Provider, maker and the id's words without version, size, date or preview: "anthropic:claude-sonnet". */
  key: string;
  /** [4, 5]. Empty when the id has no number. */
  version: number[];
  /** A date in the id (YYYYMMDD, YYYY-MM-DD, or Mistral's and DeepSeek's four digits), digits only. */
  date: string | null;
  /** Named only by its date ("mistral-small-2603"): ranked by date, above the numbered ones, unless DATED knows its number. */
  dateOnly: boolean;
}

/** Words in an id that don't make a different model: instruction tuning, a preview, the word chat. */
const NOISE = new Set(["instruct", "it", "chat", "preview", "exp", "experimental"]);
/** Sizes: 27b, 2.4t, a22b (active parameters), 8x22b. A size is the same model, so it doesn't split a family. */
const SIZE = /^(a?\d+(\.\d+)?[bt]|\d+x\d+b)$/;
/** An alias for whatever is newest: hidden, since the version it points at is listed itself. */
const ALIAS = /(^~|(^|[-/])latest$|^openrouter\/)/;
/** OpenRouter's routing variants ("model:free"). */
const VARIANT = /:/;
/** Safety classifiers: they label text, they don't answer. */
const NOT_FOR_CHAT = /(^|-)(guard|safeguard|content-safety)(-|$)/;

/**
 * OpenRouter's makers Athena offers, each with the lines it offers (null: all of them). Owner, 17 Nov 2026: well-known
 * makers only. The brief's list (DeepSeek, Qwen, Mistral, Moonshot's Kimi, Google's Gemma, Cohere, Meta's Llama) plus
 * xAI's Grok, Z.ai's GLM, MiniMax and OpenAI's open-weight gpt-oss: large labs whose models are widely used with
 * tools. Gemini, GPT and Meta's Muse are offered through their own providers, so not again here.
 */
export const OPENROUTER_MAKERS: Readonly<Record<string, RegExp | null>> = {
  deepseek: null,
  qwen: null,
  mistralai: null,
  moonshotai: null,
  google: /^gemma-/,
  cohere: null,
  "meta-llama": null,
  "x-ai": null,
  "z-ai": null,
  minimax: null,
  openai: /^gpt-oss-/,
};

/**
 * Families whose newest version is itself old, hidden by name (owner, 17 Nov 2026). The gateway gives no release dates,
 * so each is one the snapshot itself shows a newer model for. Still runs if already chosen: `listed` reads every id.
 */
export const HIDDEN: Readonly<Record<string, string>> = {
  "openrouter/mistralai/mistral-nemo": "An older Mistral line; Mistral Small 4 and Ministral 14B are listed.",
  "openrouter/mistralai/mixtral-8x22b-instruct": "An older Mistral line; Mistral Large 4 and Medium 3.5 are listed.",
  "openrouter/z-ai/glm-4.5-air": "GLM 5.3 and GLM 5.3 Flash are listed.",
  "openrouter/qwen/qwen3-next-80b-a3b-instruct": "A Qwen3 trial; Qwen3.8 and Qwen3.6 are listed.",
  "openrouter/qwen/qwen3-235b-a22b-thinking-2507": "Qwen3 from July 2025 (the 2507 in its id); Qwen3.8 is listed.",
  "openrouter/deepseek/deepseek-r1-0528": "DeepSeek R1 from May 2025 (the 0528 in its id); DeepSeek V4 Pro is listed.",
  "openrouter/moonshotai/kimi-k2-thinking": "Kimi K2's thinking build; Kimi K3 and K2.6 are listed.",
  // Owner, 17 Nov 2026 (Q8): alone in their line and old by their ids or age, hidden although nothing newer in the line is listed.
  "openai/o3": "OpenAI's o3 reasoning model; GPT-5.5 and GPT-5.5 Pro succeed it.",
  "openrouter/mistralai/mistral-saba": "An early regional Mistral model; Mistral Small 4 and Large 4 are listed.",
  "openrouter/mistralai/codestral-2508": "Codestral from August 2025 (the 2508 in its id).",
  "openrouter/mistralai/voxtral-small-24b-2507": "Voxtral Small from July 2025 (the 2507 in its id).",
};

/** Mistral's ids named by date, and the release number each one is. */
const DATED: Readonly<Record<string, number[]>> = {
  "openrouter/mistralai/mistral-large-2407": [2],
  "openrouter/mistralai/mistral-large-2512": [3],
  "openrouter/mistralai/mistral-small-24b-instruct-2501": [3],
  "openrouter/mistralai/mistral-small-2603": [4],
};

/** A model id as a family and version. Null for an alias or a routing variant, which are never a family's own model. */
export function familyOf(ref: ModelRef): Family | null {
  if (ALIAS.test(ref.model) || VARIANT.test(ref.model) || ref.model === "chat-latest") return null;
  let maker = "";
  let rest = ref.model;
  if (ref.provider === "openrouter") {
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    maker = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  let date: string | null = null;
  const full = /-(\d{4})-?(\d{2})-?(\d{2})$/.exec(rest);
  const short = /-(\d{4})$/.exec(rest);
  if (full && /^(19|20)\d\d$/.test(full[1])) {
    date = full[1] + full[2] + full[3];
    rest = rest.slice(0, full.index);
  } else if (short) {
    date = short[1];
    rest = rest.slice(0, short.index);
  }
  const words: string[] = [];
  let version: number[] | null = null;
  let open = false;
  for (const tok of rest.split("-")) {
    if (open && /^\d{1,2}$/.test(tok)) {
      version!.push(Number(tok)); // claude-opus-4-5, mistral-large-4-0
      continue;
    }
    open = false;
    if (NOISE.has(tok) || SIZE.test(tok)) continue;
    const m: RegExpExecArray | null = version ? null : /^([a-z]*)(\d+(?:\.\d+)*)([a-z]*)$/.exec(tok);
    if (m) {
      version = m[2].split(".").map(Number);
      open = !m[2].includes(".");
      if (m[1] && m[1] !== "v") words.push(m[1]); // qwen3 → qwen; v4 → 4; kimi-k2 keeps its k
      if (m[3] && m[3] !== "o") words.push(m[3]); // gpt-4o is a GPT; glm-4.5v is GLM's vision line
      continue;
    }
    if (tok) words.push(tok);
  }
  const known = DATED[refKey(ref)];
  return {
    key: `${ref.provider}:${maker ? maker + "/" : ""}${words.join("-")}`,
    version: known ?? version ?? [],
    date,
    dateOnly: !known && !version && !!date,
  };
}

/** Newer first: a higher number; an id named only by date above numbered ones; then the later date. */
function compareVersions(a: Family, b: Family): number {
  if (a.dateOnly !== b.dateOnly) return a.dateOnly ? -1 : 1;
  if (!a.dateOnly) {
    if (!a.version.length !== !b.version.length) return a.version.length ? -1 : 1;
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      // The minor number reads as a decimal: Grok 4.20 is 4.2, before 4.3.
      const at = (v: number[]) => (i === 1 ? Number(`0.${v[i] ?? 0}`) : (v[i] ?? 0));
      const d = at(b.version) - at(a.version);
      if (d) return d;
    }
  }
  return (b.date ?? "").localeCompare(a.date ?? "");
}

/** The step a model is on in its family. Sizes of one version share a step; ids named by date are a step each. */
const stepOf = (f: Family) => (f.dateOnly ? `@${f.date}` : f.version.join("."));

interface Ranked {
  ref: ModelRef;
  family: Family;
}

/** Every listed model that could be shown, by family, newest first. Aliases, snapshots, and makers not offered left out. */
function families(list: GatewayList): Map<string, Ranked[]> {
  const out = new Map<string, Ranked[]>();
  for (const provider of PROVIDERS) {
    const ids = list.providers[provider]?.models;
    if (!Array.isArray(ids)) continue;
    const all = new Set(ids);
    for (const model of all) {
      const ref = { provider, model };
      if (!offered(ref) || Object.hasOwn(HIDDEN, refKey(ref))) continue;
      const family = familyOf(ref);
      if (!family) continue;
      // A dated snapshot of an id that's listed without its date.
      if (family.date && (/\d{8}$|\d{4}-\d{2}-\d{2}$/.test(model) || all.has(model.replace(/-\d{4}$/, "")))) continue;
      const group = out.get(family.key) ?? [];
      group.push({ ref, family });
      out.set(family.key, group);
    }
  }
  for (const group of out.values()) group.sort((a, b) => compareVersions(a.family, b.family) || a.ref.model.localeCompare(b.ref.model));
  return out;
}

/** OpenRouter: a maker Athena offers, and a line it offers. Safety classifiers aren't offered anywhere. */
function offered(ref: ModelRef): boolean {
  if (ref.provider !== "openrouter") return !NOT_FOR_CHAT.test(ref.model);
  const slash = ref.model.indexOf("/");
  const maker = ref.model.slice(0, slash);
  const line = ref.model.slice(slash + 1);
  if (slash <= 0 || !Object.hasOwn(OPENROUTER_MAKERS, maker)) return false;
  const only = OPENROUTER_MAKERS[maker];
  return (!only || only.test(line)) && !NOT_FOR_CHAT.test(line);
}

/** The models the catalogue shows: in each family, the newest version only (every size of it). Owner, 17 Nov 2026. */
export function shownModels(list: GatewayList): ModelRef[] {
  const out: ModelRef[] = [];
  for (const group of families(list).values()) {
    const steps: string[] = [];
    for (const m of group) {
      const step = stepOf(m.family);
      if (!steps.includes(step)) steps.push(step);
      if (steps.length > 1) break;
      out.push(m.ref);
    }
  }
  return out;
}

/** The newest shown model in this model's family, when it's newer than this one. Null when it's the newest, or has no family. */
export function newerVersion(ref: ModelRef, list: GatewayList): ModelRef | null {
  const family = familyOf(ref);
  if (!family) return null;
  const top = families(list).get(family.key)?.[0];
  return top && compareVersions(top.family, family) < 0 && !sameRef(top.ref, ref) ? top.ref : null;
}

/** Is this model on this copy of the gateway's list (shown or not)? */
export function onList(ref: ModelRef, list: GatewayList): boolean {
  return !!list.providers[ref.provider]?.models.includes(ref.model);
}

/**
 * The catalogue: the shown models, plus any in `include` that the gateway still lists (the owner's hidden choices, so
 * the app can name them). By provider, then family, newest first.
 */
export function joinCatalogue(list: GatewayList, include: ModelRef[] = []): CatalogueModel[] {
  const refs = shownModels(list);
  for (const ref of include) if (onList(ref, list) && !refs.some((r) => sameRef(r, ref))) refs.push(ref);
  const order = (m: CatalogueModel) => PROVIDERS.indexOf(m.ref.provider);
  const fam = new Map(refs.map((r) => [refKey(r), familyOf(r)]));
  return refs
    .map(describe)
    .sort((a, b) => {
      const fa = fam.get(refKey(a.ref));
      const fb = fam.get(refKey(b.ref));
      return order(a) - order(b) || (fa?.key ?? a.ref.model).localeCompare(fb?.key ?? b.ref.model) || (fa && fb ? compareVersions(fa, fb) : 0) || a.ref.model.localeCompare(b.ref.model);
    });
}

/** The list as the gateway gives it, checked: a providers object with arrays of model ids. Null for anything else. */
export function readGatewayList(raw: unknown, fetchedAt: string): GatewayList | null {
  const providers = (raw as { providers?: unknown } | null)?.providers;
  if (!providers || typeof providers !== "object") return null;
  const out: GatewayList["providers"] = {};
  for (const p of PROVIDERS) {
    const models = (providers as Record<string, { models?: unknown }>)[p]?.models;
    if (Array.isArray(models)) out[p] = { models: models.filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= 200) };
  }
  return Object.keys(out).length ? { fetched_at: fetchedAt, providers: out } : null;
}

export const SNAPSHOT: GatewayList = snapshot as GatewayList;

let memory: GatewayList | null = null;

/** For tests: forget the copy held in memory, or hold this one. */
export function forgetCatalogue(list: GatewayList | null = null): void {
  memory = list;
}

export interface Catalogue {
  models: CatalogueModel[];
  updated_at: string;
  /** Where the list came from: fresh from the gateway, a copy from the last day (or an older one when the gateway can't be read), or the snapshot. */
  source: "gateway" | "kept" | "snapshot";
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function readKept(): Promise<GatewayList | null> {
  try {
    const { qRaw } = await import("./db");
    const [row] = await qRaw<{ value: GatewayList }>(`SELECT value FROM settings WHERE key = $1`, [ROW]);
    return row?.value ? readGatewayList(row.value, row.value.fetched_at) : null;
  } catch {
    return null;
  }
}

async function keep(list: GatewayList): Promise<void> {
  try {
    const { qRaw } = await import("./db");
    await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ROW, JSON.stringify(list)]);
  } catch {
    // Not kept: the next request reads the gateway again.
  }
}

const fresh = (l: GatewayList, now: number): boolean => now - Date.parse(l.fetched_at) < DAY_MS;

/** The gateway's list, at most a day old where it can be read. */
export async function gatewayList(opts: { fetch?: Fetch; now?: Date } = {}): Promise<{ list: GatewayList; source: Catalogue["source"] }> {
  const now = (opts.now ?? new Date()).getTime();
  if (memory && fresh(memory, now)) return { list: memory, source: "kept" };
  const kept = await readKept();
  if (kept && fresh(kept, now)) {
    memory = kept;
    return { list: kept, source: "kept" };
  }
  try {
    const res = await (opts.fetch ?? fetch)(GATEWAY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`gateway list: ${res.status}`);
    const list = readGatewayList(await res.json(), new Date(now).toISOString());
    if (!list) throw new Error("gateway list: unexpected shape");
    memory = list;
    await keep(list);
    return { list, source: "gateway" };
  } catch (error) {
    console.warn("Athena models: couldn't read the gateway's list", (error as Error).message?.slice(0, 120));
    // An older copy is still newer than the snapshot.
    if (kept && Date.parse(kept.fetched_at) > Date.parse(SNAPSHOT.fetched_at)) return { list: kept, source: "kept" };
    return { list: SNAPSHOT, source: "snapshot" };
  }
}

/** The catalogue; `include` adds models the owner chose that are listed but not shown (see joinCatalogue). */
export async function getCatalogue(opts: { fetch?: Fetch; now?: Date; include?: ModelRef[] } = {}): Promise<Catalogue> {
  const { list, source } = await gatewayList(opts);
  return { models: joinCatalogue(list, opts.include), updated_at: list.fetched_at, source };
}

/** Is this model on the gateway's list? */
export async function listed(ref: ModelRef, opts: { fetch?: Fetch; now?: Date } = {}): Promise<boolean> {
  const { list } = await gatewayList(opts);
  return onList(ref, list);
}
