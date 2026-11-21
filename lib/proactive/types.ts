/**
 * Athena speaks first: the shapes behind proactive nudges (lib/proactive/).
 *
 * A rule is a pure function from a snapshot of the owner's data
 * (ProactiveInput, built by lib/proactive/load.ts) to zero or more nudges.
 * The gate (gate.ts) then applies what every nudge shares: the rule's
 * switch, a mute, quiet hours, the daily cap and dedupe. Nothing here reads
 * the database, sends anything or calls a model.
 */
import type { AvatarSpec } from "../team-types";

/** team: a Team assistant ran (lib/team-run.ts), or ran one of its flows; flow: a plain flow's card (lib/flow-effects.ts); routine: one of Ask's routines ran (lib/routine-run.ts); watch_tonight: picks for a free evening (lib/watch-tonight.ts). */
export type RuleId = "meeting_prep" | "after_meeting" | "awaiting_reply" | "leave_by" | "day_plan" | "weekly_plan" | "drift" | "routine" | "watch_tonight" | "car" | "team" | "flow";
export const RULE_IDS: readonly RuleId[] = ["meeting_prep", "after_meeting", "awaiting_reply", "leave_by", "day_plan", "weekly_plan", "drift", "routine", "watch_tonight", "car", "team", "flow"];

/** How the owner gets to an event: Leave by's default (Settings → Notifications) and each event's own choice. */
export type TravelMode = "transit" | "drive" | "walk" | "cycle";
export const TRAVEL_MODES: readonly TravelMode[] = ["transit", "drive", "walk", "cycle"];
/** The start of Leave by's "why" line for a drive with no Google Maps key (the card links to Sources). */
export const NO_DRIVE_TIME = "No drive time:";

/** A person a nudge is about: a Library person, or an address that isn't one yet. */
export interface NudgePerson {
  id: string | null;
  name: string;
}

/** One thing the owner can do from the card without opening Ask. Drafts and moves only; nothing is ever sent. */
export type NudgeAction =
  /** Move an event (POST /api/scheduling/move), with the receipt's Undo. */
  | { kind: "move"; label: string; event_id: string; title: string; from: string; start: string; end?: string }
  /** Give a to-do a day this week (Weekly plan, applied one part at a time). */
  | { kind: "plan_todo"; label: string; commitment_id: string; title: string; due_on: string; was: string | null };

export interface Nudge {
  rule: RuleId;
  /** Dedupe key: the same key is never nudged twice. */
  key: string;
  /** The push's title and body, and the card's. Short; on the lock screen. */
  title: string;
  body: string;
  /** "Why am I seeing this?": plain-language evidence, one fact a line. */
  why: string[];
  /** What Ask shows above the conversation when this opens it. */
  context: string;
  /** The suggested first reply, ready in Ask's box. */
  prompt: string;
  /** What it's about, with each item's name for Ask's context chip ("Q3 review", "Tom Reed"). */
  about: Array<{ kind: "event" | "person" | "commitment" | "habit"; id: string; label?: string }>;
  actions: NudgeAction[];
  /** A routine's run: the Ask conversation it kept, which the card and push open. */
  thread_id?: string;
  /** Where the card and its push open instead of Ask: a Team run's post in Team chat (`/#/team/chat/<post>`). */
  url?: string;
  /** A Team assistant's run: who it's from, for the "From <Name>" card's avatar. */
  assistant?: { id: string; name: string; avatar: AvatarSpec };
  /** When it stops being useful (a card leaves Home, a late push isn't sent). */
  expires_at: string;
}

/** Everything a rule may read. Times are ISO instants; dates YYYY-MM-DD in the owner's zone. */
export interface ProactiveInput {
  now: Date;
  tz: string;
  today: string;
  working: { days: number[]; start: string; end: string };
  /** Timed events from yesterday to a week ahead, declined ones left out. */
  events: InputEvent[];
  /** Sent mail threads from the connected mailboxes, newest first (awaiting reply). */
  sent: SentThread[];
  /** Open to-dos, owed things and waiting-ons. */
  todos: InputTodo[];
  goals: Array<{ id: string; title: string; progress: number; period: string; due_on: string | null }>;
  /** Recent nights and today's (last night's) figures; null when Health has nothing. */
  sleep: { last_minutes: number | null; last_recovery: number | null; nights: number[]; recoveries: number[] } | null;
  /**
   * Habits with each due day's outcome, oldest first, and the habit's own line from Patterns
   * ("You sleep 40 min longer on days you go to the gym"), when it has one.
   */
  habits: Array<{ id: string; name: string; marks: Array<{ date: string; done: boolean }>; pattern?: string | null }>;
  /**
   * For drift, by date over the habits' weeks: workouts logged (Health) and timed calendar events.
   * A workout that day means a gym habit wasn't skipped; the same event on each missed day is the likely clash.
   */
  past?: Record<string, { workouts: string[]; events: Array<{ title: string; time: string }> }>;
  /**
   * Minutes of travel from where the owner is to an event's place, by event id: from a live planner
   * (netlify/lib/proactive/directions.ts: TfL in London, Google Routes elsewhere) or the distance estimate (lib/proactive/travel.ts),
   * and, by public transport, the owner's usual TfL lines that aren't on Good Service (lib/briefing-run.ts loadCommute).
   */
  travel: Record<string, { minutes: number; mode: TravelMode; from: string; disruption?: string | null; source?: "tfl" | "google" | "estimate" | "none"; rechecked?: boolean } | undefined>;
  /** Keys of things the owner closed: a dismissed nudge, a thread marked done. */
  closed: Set<string>;
  /** The car's MOT and tax dates (lib/car.ts carDues): a label and a date, never a registration. */
  cars?: import("../car").CarDue[];
  /** Something to watch tonight: whether the evening is clear, and picks from the owner's own list (lib/watch-tonight.ts). */
  tonight?: { free: boolean; picks: import("../watch-tonight").WatchPick[] };
}

export interface InputEvent {
  id: string;
  title: string;
  starts_at: string;
  /** End when known; otherwise an hour after the start. */
  ends_at: string | null;
  people: Array<NudgePerson & {
    last_contacted_at?: string | null;
    /** Latest catch-up summary ("Agreed to send the Q3 deck by Friday"). */
    last_summary?: { at: string; text: string } | null;
    /** Email and message catch-ups in the last fortnight, newest first. */
    recent_mail?: Array<{ at: string; channel: "email" | "message"; text: string }>;
  }>;
  /** A Library place it's at. */
  place: { id: string; name: string } | null;
  /** Notes about the last meeting with these people (title only). */
  last_notes?: Array<{ id: string; title: string; at: string }>;
  /** The owner's own block (Focus time, no guests). */
  solo?: boolean;
  /** Imported from history (a backfill), not something happening now. */
  backfilled?: boolean;
}

export interface InputTodo {
  id: string;
  title: string;
  kind: "todo" | "i_owe" | "waiting_on";
  due_on: string | null;
  person_id: string | null;
  person_name: string | null;
  backfilled?: boolean;
}

export interface SentThread {
  id: string;
  /** Which mailbox, for the draft. */
  connector_id: string;
  subject: string;
  to: NudgePerson & { email: string };
  /** The owner's last message in the thread. */
  sent_at: string;
  snippet: string;
  /** Nobody has written since the owner's last message. */
  unanswered: boolean;
  /** Labels on any message (CATEGORY_PROMOTIONS, …) and the recipients' addresses. */
  labels: string[];
  backfilled?: boolean;
}
