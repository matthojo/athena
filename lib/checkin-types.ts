/**
 * Check-ins: a short morning preparation and an evening reflection, one
 * question per screen, both optional and both the owner's to shape (which
 * questions, how many a day, in what order, plus questions of their own).
 *
 * Owner's decisions, 17 Nov 2026:
 *  - Storage: answers live in their own sealed store (health tier, refused
 *    without the key). Some answers are also copied out ("mirrored"): the
 *    mood scale sets the day's mood, written answers go into the day's
 *    journal, energy and stress go to Health (source "athena_checkin"), the
 *    emotions go to Health's mood_labels. See CheckinMirror.
 *  - Daily pick: pinned questions are asked every day; the rest take turns,
 *    least recently asked first, until the day's count is reached.
 *  - AI: "Go deeper" on a written answer only. Athena asks one follow-up
 *    question; the owner answers it or skips it. No mentor styles.
 *  - Nudges: a morning push at a time the owner sets; the evening push opens
 *    the reflection; the morning's focus and intention go into the briefing.
 *
 * Both routines are off until the owner turns one on.
 *
 * The contract between the server (lib/checkins*.ts, netlify/lib/checkins/,
 * the MCP tools), the app (app/src/db/checkins.ts and the check-in flow) and
 * the nudges (lib/nudges.ts, the reminders function, the briefing). Imports
 * nothing, so both sides can use it. Types and the preset questions only: no
 * logic here.
 *
 * API (all behind the bearer token):
 *   GET  /api/checkins/settings                         → CheckinSettingsView
 *   PUT  /api/checkins/settings        CheckinSettings  → CheckinSettingsView
 *   GET  /api/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD    → CheckinSummary[] (at most 400 days)
 *   GET  /api/checkins/:date/:kind                      → Checkin
 *        Works out the day's plan the first time it is read and keeps it, so
 *        a settings change shows up from the next day that has no plan yet.
 *        A routine that is off returns a Checkin with an empty plan.
 *   PUT  /api/checkins/:date/:kind/answers/:question_id  CheckinValue → Checkin
 *        Idempotent (the app's offline outbox may send it twice). Applies the
 *        question's mirror.
 *   DELETE /api/checkins/:date/:kind/answers/:question_id → Checkin (takes the mirror back out)
 *   POST /api/checkins/:date/:kind/done                 → Checkin
 *   POST /api/checkins/:date/:kind/deeper   DeeperRequest → DeeperReply
 *   PUT  /api/checkins/sets/:id        { paused }       → CheckinSettingsView   (switch an added set off or on)
 *   DELETE /api/checkins/sets/:id                       → CheckinSettingsView   (remove a set and its questions)
 *   POST /api/checkins/share  { question_ids, edits?, fine?, download? } → CheckinExport, or with download the zip
 *        (409 with what's still flagged). lib/checkin-share.ts, lib/checkin-sets.ts.
 *
 * App deep links (the pushes open these):
 *   #/checkin/morning            today's morning preparation
 *   #/checkin/evening            today's evening reflection
 *   #/checkin/<kind>/<date>      a given day's
 *   #/settings/checkins          the check-ins section of Settings
 *
 * Server read used by the nudges and the briefing (lib/checkins.ts):
 *   loadCheckin(date: string, kind: CheckinKind): Promise<Checkin | null>
 *   (null when the routine is off or nothing has been planned for that day)
 */

export const CHECKIN_KINDS = ["morning", "evening"] as const;
export type CheckinKind = (typeof CHECKIN_KINDS)[number];

/**
 * How a question is answered:
 *  - scale: a 1 to 5 slider, shown with a sentence ("Today I feel" + "quite energised")
 *  - choices: pick any number of words (emotions), some behind "Show more"
 *  - areas: pick any number of life areas from a grid with icons
 *  - text: write something; may offer "Go deeper"
 */
export type QuestionType = "scale" | "choices" | "areas" | "text";

/** Where else an answer is written. null: only in the check-in. */
export type CheckinMirror =
  | "day_mood" //          scale 1-5 → the day's mood 1-5
  | "health_energy" //     scale 1-5 → Health energy (source athena_checkin)
  | "health_stress" //     scale 1-5 → Health stress (source athena_checkin)
  | "health_mood_labels" // choices → Health mood_labels (source athena_checkin)
  | "day_journal" //       text → the day's journal, in a section Athena keeps for this check-in
  | "briefing" //          areas or text → the morning briefing (read, not copied)
  | null;

export type ScaleValue = 1 | 2 | 3 | 4 | 5;

export interface CheckinQuestion {
  /** A preset's id ("energy"), or "own_" + a random id for the owner's own. */
  id: string;
  type: QuestionType;
  /** The question on screen: "How much energy do you have?" */
  prompt: string;
  /** Which routines it can be added to. */
  kinds: CheckinKind[];
  /** scale: the slider's two ends, "Not at all" and "Very". */
  low?: string;
  high?: string;
  /** scale: the start of the sentence, "Today I feel". */
  lead?: string;
  /** scale: the end of the sentence for 1 to 5, "drained" … "full of energy". */
  levels?: [string, string, string, string, string];
  /** choices and areas: shown first. */
  options?: string[];
  /** choices and areas: behind "Show more". */
  more?: string[];
  /** text: the hint in the empty box. */
  placeholder?: string;
  /** text: whether "Go deeper" is offered. */
  deeper?: boolean;
  mirror: CheckinMirror;
  /** true for Athena's presets, false for the owner's own. */
  preset: boolean;
  /**
   * The owner's own only: the set of check-in questions it was added from (CheckinSet.id), when it came from a file
   * someone else shared (lib/checkin-share.ts). Absent for a question the owner wrote.
   */
  set?: string;
}

/** One routine's set-up. */
export interface RoutineSettings {
  enabled: boolean;
  /** Questions a day, 1 to 10. */
  per_day: number;
  /** The questions in this routine, in the order they're asked. */
  questions: { id: string; pinned: boolean }[];
}

/** What the owner saves. The push times live with the other notifications (lib/nudges.ts: morning_at, evening_at). */
export interface CheckinSettings {
  morning: RoutineSettings;
  evening: RoutineSettings;
  /** The owner's own questions (preset: false). Presets are never stored here. */
  own: CheckinQuestion[];
}

/**
 * A set of check-in questions added from a file someone shared or from Community (lib/checkin-share.ts). Its
 * questions are among the owner's own, each naming it in `set`. Switched off (`paused`), they aren't asked until the
 * owner switches it back on; Athena switches a set off once when Community takes its listing down.
 */
export interface CheckinSet {
  id: string;
  name: string;
  summary: string;
  author: string | null;
  version: string | null;
  paused: boolean;
  /** The Community listing it came from, or null for a file or a link. */
  catalogue_id: string | null;
  added_at: string;
}

/** What GET /api/checkins/settings returns: the settings plus every question that can be picked, and the sets added. */
export interface CheckinSettingsView extends CheckinSettings {
  library: CheckinQuestion[];
  sets: CheckinSet[];
}

/** An answer. Exactly one shape per question type; `skipped` for any type. */
export type CheckinValue =
  | { scale: ScaleValue }
  | { picks: string[] }
  | { text: string; deeper?: { question: string; text?: string } }
  | { skipped: true };

export interface CheckinAnswer {
  question_id: string;
  value: CheckinValue;
  answered_at: string;
}

export interface Checkin {
  date: string;
  kind: CheckinKind;
  /** The day's questions, in order, as they were when the plan was made (so an edited or removed question still reads right). */
  plan: CheckinQuestion[];
  answers: Record<string, CheckinAnswer>;
  status: "open" | "done";
  done_at?: string;
}

/** One day in a range: enough for a calendar dot or a streak. */
export interface CheckinSummary {
  date: string;
  morning?: "open" | "done";
  evening?: "open" | "done";
}

export interface DeeperRequest {
  question_id: string;
  /** What the owner has written so far. */
  text: string;
}

/** question is null when the model isn't set up or didn't answer in time; the app then hides the button. */
export interface DeeperReply {
  question: string | null;
}

export const MAX_PER_DAY = 10;
export const MAX_OWN_QUESTIONS = 40;
export const MAX_ANSWER_CHARS = 4000;

const SCALE = { low: "Not at all", high: "Very" } as const;

/** Life areas, for "What's your main focus today?" and "What's affecting how you feel?". */
export const AREAS = ["Work", "Self-care", "Learning", "Nature", "Health", "Family", "Friends", "Fitness", "Creativity", "Rest", "Home", "Money"];
export const MORE_AREAS = ["Partner", "Travel", "Music", "Spirituality", "Food", "Sleep", "Community", "Hobbies"];

export const EMOTIONS = ["Calm", "Happy", "Grateful", "Motivated", "Relaxed", "Proud", "Loved", "Excited", "Tired", "Stressed"];
export const MORE_EMOTIONS = ["Anxious", "Frustrated", "Sad", "Lonely", "Overwhelmed", "Bored", "Hopeful", "Content", "Irritable", "Restless", "Focused", "Inspired", "Brave", "Satisfied"];

/** Athena's ready-made questions. Ids are stable: stored answers and settings refer to them. */
export const PRESET_QUESTIONS: CheckinQuestion[] = [
  { id: "mood", type: "scale", prompt: "How are you feeling?", kinds: ["morning", "evening"], low: "Low", high: "Great", lead: "I'm feeling", levels: ["low", "a bit flat", "okay", "good", "great"], mirror: "day_mood", preset: true },
  { id: "energy", type: "scale", prompt: "How much energy do you have?", kinds: ["morning", "evening"], ...SCALE, lead: "Right now I feel", levels: ["drained", "a bit low", "fairly energised", "energised", "full of energy"], mirror: "health_energy", preset: true },
  { id: "rested", type: "scale", prompt: "How rested do you feel?", kinds: ["morning"], ...SCALE, lead: "This morning I feel", levels: ["exhausted", "a bit tired", "fairly rested", "well rested", "fully rested"], mirror: null, preset: true },
  { id: "stress", type: "scale", prompt: "How stressed do you feel?", kinds: ["morning", "evening"], ...SCALE, lead: "My stress is", levels: ["not there at all", "low", "noticeable", "high", "very high"], mirror: "health_stress", preset: true },
  { id: "productive", type: "scale", prompt: "How productive was today?", kinds: ["evening"], ...SCALE, lead: "Today was", levels: ["not productive", "a little productive", "fairly productive", "productive", "very productive"], mirror: null, preset: true },
  { id: "emotions", type: "choices", prompt: "Which words fit how you feel?", kinds: ["morning", "evening"], options: EMOTIONS, more: MORE_EMOTIONS, mirror: "health_mood_labels", preset: true },
  { id: "influences", type: "areas", prompt: "What's affecting how you feel today?", kinds: ["morning", "evening"], options: AREAS, more: MORE_AREAS, mirror: null, preset: true },
  { id: "focus", type: "areas", prompt: "What's your main focus today?", kinds: ["morning"], options: AREAS, more: MORE_AREAS, mirror: "briefing", preset: true },
  { id: "intention", type: "text", prompt: "What would make today a good day?", kinds: ["morning"], placeholder: "A few words is enough, or skip this one.", deeper: true, mirror: "briefing", preset: true },
  { id: "why", type: "text", prompt: "Why do you think you feel this way?", kinds: ["morning", "evening"], placeholder: "A few words is enough, or skip this one.", deeper: true, mirror: "day_journal", preset: true },
  { id: "grateful", type: "text", prompt: "What are you grateful for?", kinds: ["morning", "evening"], placeholder: "Something small counts.", deeper: false, mirror: "day_journal", preset: true },
  { id: "went_well", type: "text", prompt: "What went well today?", kinds: ["evening"], placeholder: "A few words is enough, or skip this one.", deeper: true, mirror: "day_journal", preset: true },
  { id: "learned", type: "text", prompt: "What did you learn today?", kinds: ["evening"], placeholder: "A few words is enough, or skip this one.", deeper: true, mirror: "day_journal", preset: true },
  { id: "tomorrow", type: "text", prompt: "What do you want to carry into tomorrow?", kinds: ["evening"], placeholder: "Or what you'd like to leave behind.", deeper: true, mirror: "day_journal", preset: true },
];

/**
 * Where answers to a question that isn't one of Athena's go: the owner's own and one from a shared set alike
 * (owner, 25 Nov 2026). The day's journal when Athena's own questions of that type go there (written answers),
 * otherwise nowhere. Athena decides by type: never the day's mood, Health or the briefing, whatever a file or a
 * settings request says. A day's plan keeps each question as it was asked, so a day planned before this rule keeps
 * its answers where they were. Pure.
 */
export function ownMirror(type: QuestionType): CheckinMirror {
  return PRESET_QUESTIONS.some((q) => q.type === type && q.mirror === "day_journal") ? "day_journal" : null;
}

/** The settings before the owner changes anything: both routines off, with a short starting set ready for when they turn one on. */
export const DEFAULT_CHECKIN_SETTINGS: CheckinSettings = {
  morning: {
    enabled: false,
    per_day: 4,
    questions: [
      { id: "mood", pinned: true },
      { id: "rested", pinned: false },
      { id: "focus", pinned: true },
      { id: "intention", pinned: false },
      { id: "energy", pinned: false },
      { id: "grateful", pinned: false },
    ],
  },
  evening: {
    enabled: false,
    per_day: 4,
    questions: [
      { id: "mood", pinned: true },
      { id: "stress", pinned: false },
      { id: "emotions", pinned: false },
      { id: "went_well", pinned: true },
      { id: "productive", pinned: false },
      { id: "why", pinned: false },
      { id: "tomorrow", pinned: false },
    ],
  },
  own: [],
};
