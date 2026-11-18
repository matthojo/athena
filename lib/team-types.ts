/**
 * Team: the shared types and constants (docs/team.md). Imported by the
 * server (lib/team.ts, netlify/lib/team-routes.ts) and the app
 * (app/src/db/team.ts, app/src/team/avatar.ts). Types and constants only,
 * so either side can import it without pulling in the other.
 */
import type { TeamAnswer, TeamQuestion } from "./team-skill";
import type { AssistantModels, ModelRef } from "./model-types";

export const MAX_ASSISTANTS = 12;
/** Triggers one assistant can have. */
export const MAX_TRIGGERS = 8;
/** An assistant's rolling memory: a summary this long at most… */
export const MAX_MEMORY_SUMMARY = 2000;
/** …and at most this many facts. */
export const MAX_MEMORY_FACTS = 30;
export const MAX_NAME = 40;
export const MAX_JOB = 140;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_GREETING = 160;
export const MAX_TRAITS = 5;

// ---------- the character ----------

export const SPECIES = ["cat", "bear", "fox", "bunny", "monster"] as const;
export type Species = (typeof SPECIES)[number];

export const EYES = ["round", "sparkle", "sleepy", "happy"] as const;
export type Eyes = (typeof EYES)[number];

/** The 12 on the mouth sheet (docs/team-art/mouths-sheet.svg), left to right, top to bottom. */
export const MOUTH_IDS = ["small-smile", "big-laugh", "wavy-frown", "cat-w", "buck-teeth", "fang-grin", "surprised-o", "smirk", "tongue-out", "button-nose", "triangle-nose", "heart-nose"] as const;
export type MouthId = (typeof MOUTH_IDS)[number];

export const OUTFITS = ["tee", "hoodie", "polo", "overalls", "blazer", "vest", "collar"] as const;
export type Outfit = (typeof OUTFITS)[number];

export type AccessorySlot = "head" | "face" | "neck";
/** Each accessory and where it sits: an avatar wears at most one per slot. */
export const ACCESSORY_IDS = {
  beanie: "head",
  "party-hat": "head",
  bow: "head",
  flowers: "head",
  headphones: "head",
  crown: "head",
  glasses: "face",
  "eye-patch": "face",
  scarf: "neck",
  "heart-necklace": "neck",
} as const satisfies Record<string, AccessorySlot>;
export type AccessoryId = keyof typeof ACCESSORY_IDS;
export const ACCESSORY_LIST = Object.keys(ACCESSORY_IDS) as AccessoryId[];

/**
 * Palette keys for fur, accent and outfit colour. The colours themselves
 * (light and dark) live in the avatar module; specs store only the key.
 */
export const FUR_KEYS = ["charcoal", "cocoa", "honey", "ginger", "snow", "cream", "mint", "lilac", "sky", "blush", "slate", "butter"] as const;
export const ACCENT_KEYS = ["rose", "pink", "peach", "coral", "butter", "lilac", "mint", "sky"] as const;
export const OUTFIT_COLOR_KEYS = ["cobalt", "periwinkle", "teal", "leaf", "mustard", "orange", "tomato", "berry", "pink", "plum", "oat"] as const;
export type FurKey = (typeof FUR_KEYS)[number];
export type AccentKey = (typeof ACCENT_KEYS)[number];
export type OutfitColorKey = (typeof OUTFIT_COLOR_KEYS)[number];
/** Every palette key, for the avatar module's colour table. */
export const PALETTE_KEYS = [...new Set<string>([...FUR_KEYS, ...ACCENT_KEYS, ...OUTFIT_COLOR_KEYS])] as Array<FurKey | AccentKey | OutfitColorKey>;
export type PaletteKey = FurKey | AccentKey | OutfitColorKey;

export interface AvatarSpec {
  v: 1;
  seed: string;
  species: Species;
  /** Palette keys, see the avatar module. */
  fur: string;
  accent: string;
  eyes: Eyes;
  mouth: MouthId;
  outfit: Outfit;
  outfitColor: string;
  /** At most one head, one face and one neck. */
  accessories: AccessoryId[];
}

export const TONES = ["warm", "crisp", "playful", "calm", "wry"] as const;
export type Tone = (typeof TONES)[number];
export const PRONOUNS = ["she", "he", "they"] as const;
export type Pronoun = (typeof PRONOUNS)[number];

export interface Personality {
  tone: Tone;
  traits: string[];
  pronoun: Pronoun;
  /** What it says when you meet it: "Hi! I'll keep an eye on prices." */
  greeting: string;
}

// ---------- when it runs ----------

/** What arrived in Athena: a collected item, something saved, a note with a tag. */
export type EventSource = "collected" | "saved" | "note";
export const EVENT_SOURCES: EventSource[] = ["collected", "saved", "note"];

export interface EventFilter {
  source: EventSource;
  /** A collected item's connector ("linear", "gmail"). */
  connector?: string;
  /**
   * The item's kind ("issue", "email", "event", "gift"). From email: "delivery" (an order moved on), "booking" (booked, changed or
   * cancelled), "appointment", "deadline", "renewal", "alert" and "todo"; "email" matches all of those as well as a kept email.
   */
  kind?: string;
  /** What was done to a saved item ("saved", "gift-idea"). */
  savedAction?: string;
  /** A note's tag, without the #. */
  tag?: string;
  /** Case-insensitive substring of the title. */
  match?: string;
}

/** 0 = Sunday … 6 = Saturday, as Date.getUTCDay. */
export type TeamWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TeamTrigger {
  id: string;
  assistant_id: string;
  kind: "schedule" | "event";
  /** schedule: which weekdays. Empty for an event trigger. */
  days: TeamWeekday[];
  /** schedule: HH:MM in the owner's zone (the `at_time` column). Null for an event trigger. */
  time: string | null;
  /** event: what it waits for. Null for a schedule trigger. */
  event: EventFilter | null;
  paused: boolean;
  last_slot: string | null;
  last_fired_at: string | null;
  created_at: string;
}

/** A trigger as the app sends it: with `id` to keep an existing one (and its last slot). */
export interface TeamTriggerInput {
  id?: string;
  kind: "schedule" | "event";
  days?: Array<number | string> | string;
  time?: string;
  event?: EventFilter;
  paused?: boolean;
}

// ---------- the assistant ----------

export interface AssistantMemory {
  /** At most MAX_MEMORY_SUMMARY characters. */
  summary: string;
  /** At most MAX_MEMORY_FACTS. */
  facts: string[];
}

export interface TeamAssistant {
  id: string;
  name: string;
  /** One sentence: "Finds good prices for gift ideas". */
  job: string;
  instructions: string;
  personality: Personality;
  avatar: AvatarSpec;
  /** Assistant tool names it may run without asking. Empty: it asks first. */
  allow: string[];
  /**
   * It may look things up online in its runs, checks and chats: search the web and read a page it found, while
   * "Let Ask search the web" is on too (docs/team-notes/web-runs.md). Off unless the owner turned it on. Missing on older servers.
   */
  web?: boolean;
  /** Its own thinking and picture models (docs/ai-models.md). Missing or empty: the same as Ask. Missing on older servers. */
  models?: AssistantModels;
  paused: boolean;
  /** The routine it was made from, if any. */
  routine_id: string | null;
  memory: AssistantMemory;
  memory_updated_at: string | null;
  last_run_at: string | null;
  triggers: TeamTrigger[];
  created_at: string;
  updated_at: string;
}

/**
 * POST /api/team and PATCH /api/team/:id. On create, `job` is required and
 * anything else missing comes from a fresh seed. On PATCH, `triggers` (when
 * given) replaces the whole set: an entry with an `id` keeps that trigger.
 */
export interface TeamAssistantInput {
  name?: string;
  job?: string;
  instructions?: string;
  personality?: Personality;
  avatar?: AvatarSpec;
  allow?: string[];
  /** Let it look things up online (TeamAssistant.web). */
  web?: boolean;
  /** Its own models (TeamAssistant.models), the whole set. PATCH without it keeps them. think missing or null: the same as Ask; image missing: the same as Ask, null: no pictures. */
  models?: AssistantModels;
  paused?: boolean;
  triggers?: TeamTriggerInput[];
}

export type TeamRunStatus = "queued" | "running" | "done" | "failed";

export interface TeamRun {
  id: string;
  assistant_id: string;
  trigger_id: string | null;
  /** team_events.id, a bigint, as a string: the first event that fired it. */
  event_id: string | null;
  /** Every event in the run, oldest first: one assistant's matches in one pass. Empty or missing for a schedule or Run now. */
  event_ids?: string[];
  status: TeamRunStatus;
  /** The Ask conversation the run kept. */
  thread_id: string | null;
  /** What it did, in words. */
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** What set it off, in words ("New gift idea: “Lego Ferrari”", "Every Friday at 17:00", "Run now"). Missing on older servers. */
  label?: string | null;
  /** While it's queued or working: what it's doing right now, in its own words ("Checking prices"). Null or missing when the server has nothing to say. */
  step?: string | null;
  /** It found nothing to do: kept in Recent runs, but it sent no "From <Name>" card. Missing on older servers. */
  quiet?: boolean;
  /** How many changes from this run wait for Go: its plan's steps, until Go runs it. 0 when none. Missing on older servers. */
  waiting?: number;
  /** A second try: the first failed before anything ran, so it's queued again for the next pass. Missing on older servers. */
  retried?: boolean;
  /** The model it thought with (docs/ai-models.md). Missing while it works, for a failed run, and on older servers. */
  model?: ModelRef;
  /** The chosen model failed before answering, so the default ran it. */
  fell_back?: boolean;
  /** With fell_back: the model that didn't answer. */
  tried?: ModelRef;
}

/** POST /api/team/draft: what setup proposes from the owner's one sentence. */
export interface TeamDraft {
  /** Null: the app names it with nameFromSeed(seed, taken). */
  name: string | null;
  job: string;
  instructions: string;
  triggers: TeamTriggerInput[];
  allow: string[];
  /** Suggested: true only when the job clearly needs something online (a price, news, opening hours). The owner decides. Missing on older servers. */
  web?: boolean;
  /** Feeds avatarFromSeed, personalityFromSeed and nameFromSeed. */
  seed: string;
}

/** What an assistant answered when main Ask checked with it (check_with_assistant): "Checked with Muse". */
export interface CheckedAssistant {
  assistant_id: string;
  name: string;
  question: string;
  answer: string;
}

// ---------- response shapes (netlify/lib/team-routes.ts) ----------

export interface TeamListResponse {
  assistants: TeamAssistant[];
  max: number;
}
export interface TeamDraftResponse {
  draft: TeamDraft;
}
export interface TeamRunsResponse {
  runs: TeamRun[];
}
/** GET /api/team/activity: the whole team's recent runs, newest first, queued and working ones included. */
export interface TeamActivityResponse {
  runs: TeamRun[];
}
export interface TeamRunResponse {
  run: TeamRun;
}
export interface TeamMemoryResponse {
  memory: AssistantMemory;
}

// ---------- an assistant's own skill (lib/team-skill.ts, docs/team.md "Skills") ----------

export type { TeamAnswer, TeamQuestion };

/** POST /api/team/questions. `fallback`: the model couldn't help, so there are none and setup skips the step. */
export interface TeamQuestionsResponse {
  questions: TeamQuestion[];
  fallback?: true;
}

/** An assistant's skill, as its page shows it. */
export interface TeamSkillView {
  id: string;
  name: string;
  description: string;
  body: string;
  /** One or two plain sentences Athena wrote with it ("" for an old one). */
  summary: string;
  /** The first few steps of its instructions, as plain lines. */
  gist: string[];
  answers: TeamAnswer[];
  updated_at: string;
}

/** GET /api/team/<id>/skill. `stale`: the job or instructions changed since it was written. `edited`: the owner changed its text. */
export interface TeamSkillInfo {
  skill: TeamSkillView | null;
  stale: boolean;
  edited: boolean;
}

/** POST /api/team/<id>/skill with `preview`: what Athena would write now. Nothing is saved. */
export interface TeamSkillPreviewResponse {
  preview: { name: string; description: string; body: string; summary: string; gist: string[] };
}
