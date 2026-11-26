/**
 * Assignments, guests and Team chat: the shared types and limits
 * (migration 0076). Imported by the server and
 * the app. Types and constants only.
 */
import type { AvatarSpec, TeamAssistant } from "./team-types";

export const ASSIGNMENT_LIMITS = {
  minStages: 2,
  maxStages: 6,
  /** Questions a stage may ask in one stop. */
  questions: 3,
  /** Times work may be sent back to an earlier stage, per assignment. */
  sendBacks: 1,
  /** Assignments running or waiting at once. */
  running: 3,
  handoff: 2000,
  title: 80,
  brief: 4000,
  task: 200,
  why: 160,
  /** Days a post outside an assignment is kept. */
  postDays: 90,
} as const;

export type Checkpoint = "auto" | "approve";
/** `take`: answer a stage's questions as suggested, without stopping. Never gives Go for a change. */
export type Suggestions = "ask" | "take";
export type AssignmentStatus = "draft" | "running" | "waiting" | "done" | "stopped" | "failed";
export type StageStatus = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";
/** `go`: a change outside the allowlist. `answer`: a question. `approval`: an `approve` checkpoint. */
export type WaitsFor = "go" | "answer" | "approval";
/** A post may also wait to be dismissed: a run that didn't finish stays in the strip until then. */
export type PostWaits = WaitsFor | "dismiss";
/** The lineup card's three defaults. */
export type CheckpointPreset = "auto" | "each" | "last";

/** Keys of the role library (lib/team-roles.ts). `custom`: written for this assignment. */
export const ROLE_KEYS = ["engineer", "seo", "editor", "reviewer", "product-manager", "cfo", "legal", "researcher", "designer", "custom"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** A question a stage asks. Always has a suggestion, so there is always a way on. */
export interface StageQuestion {
  id: string;
  question: string;
  /** 2–5. */
  choices: string[];
  allowOther: boolean;
  /** Index into `choices`. */
  suggested: number;
  /** One line: why that one. */
  why: string;
}

export interface StageAnswer {
  id: string;
  question: string;
  answer: string;
  by: "owner" | "suggested";
}

export interface Handoff {
  did: string;
  open: string;
  next: string;
}

/** What `team_stages.words` seals. */
export interface StageWords {
  task: string;
  handoff: Handoff | null;
  questions: StageQuestion[];
  answers: StageAnswer[];
  /** The owner's note with a send-back or an approval. */
  note?: string;
}

/** Who a stage is, as lists draw it. */
export interface StageWho {
  id: string;
  name: string;
  avatar: AvatarSpec;
  job: string;
  role: RoleKey | null;
  guest: boolean;
}

export interface AssignmentStage extends StageWords {
  id: string;
  position: number;
  who: StageWho;
  checkpoint: Checkpoint;
  status: StageStatus;
  waits_for: WaitsFor | null;
  run_id: string | null;
  /** The run's conversation, where its plan card lives. */
  thread_id: string | null;
  /** Changes its plan holds for Go. */
  waiting: number;
  /** While running: the line it's on (as TeamRun.step). */
  step: string | null;
  note_version: string | null;
  sent_back_from: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface Assignment {
  id: string;
  title: string;
  brief: string;
  status: AssignmentStatus;
  checkpoint: Checkpoint;
  suggestions: Suggestions;
  sent_back: boolean;
  note_id: string | null;
  thread_id: string | null;
  stages: AssignmentStage[];
  /** Files made from its note (make_document). */
  documents: DocumentFile[];
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** A proposed stage: a guest from the library (or `custom`), or a standing assistant. */
export interface LineupStage {
  role: RoleKey;
  /** Set to use a standing assistant instead of a guest. */
  assistant_id?: string;
  /** The guest's character seed (lib/team-seed.ts), so the lineup card draws the guest that will be made. */
  seed?: string;
  /** A guest's name and job; filled from the role when missing. */
  name?: string;
  job?: string;
  /** `custom` only. */
  instructions?: string;
  task: string;
  checkpoint: Checkpoint;
  web?: boolean;
}

export interface Lineup {
  title: string;
  brief: string;
  checkpoint: Checkpoint;
  suggestions: Suggestions;
  stages: LineupStage[];
}

/** Ask's start_assignment card on a reply: the proposed lineup, kept as a draft (`id`) until the owner's Go. */
export interface AskLineup {
  lineup: Lineup;
  /** The draft assignment this lineup is kept as: Go replaces its lineup and starts it. */
  id?: string;
  /** The plain lineup, when the model's didn't check out. */
  fallback?: boolean;
}

// ---------- Team chat ----------

export type PostKind = "lineup" | "update" | "handoff" | "question" | "plan" | "approval" | "done" | "failed" | "said" | "reply";

export interface TeamPost {
  id: number;
  kind: PostKind;
  /** Null: the owner (`said`) or Ask. */
  who: StageWho | null;
  from: "assistant" | "ask" | "owner";
  text: string;
  assignment_id: string | null;
  /** The assignment's title, for a thread's heading. */
  assignment_title: string | null;
  stage_id: string | null;
  run_id: string | null;
  /** The conversation a `plan` post's card lives in: its run's, or an "@Name" reply's own. */
  thread_id: string | null;
  waits_for: PostWaits | null;
  settled_at: string | null;
  /** `question` posts. */
  questions?: StageQuestion[];
  answers?: StageAnswer[];
  /** `handoff` posts. */
  handoff?: Handoff;
  /** `done` posts. */
  documents?: DocumentFile[];
  note_id?: string | null;
  created_at: string;
}

/** GET /api/team/chat. `waiting`: unsettled posts that wait, oldest first. */
export interface TeamChat {
  posts: TeamPost[];
  waiting: TeamPost[];
  /** Pass as `before` for older posts; null at the start. */
  before: number | null;
}

/** What the runner and Team runs call to post (lib/team-posts.ts). */
export interface PostInput {
  kind: PostKind;
  text: string;
  assistant_id?: string | null;
  assignment_id?: string | null;
  stage_id?: string | null;
  run_id?: string | null;
  /** Set on a `reply` that holds a plan, so the chat draws its card with Go. */
  thread_id?: string | null;
  waits_for?: PostWaits | null;
}

// ---------- documents ----------

export const DOCUMENT_FORMATS = ["md", "docx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DocumentFile {
  file_id: string;
  note_id: string;
  format: DocumentFormat;
  name: string;
  size: number;
  created_at: string;
}

/** POST /api/team/:id/keep answers this, or 409 `{ error }` when the team is full. */
export interface KeptAssistant {
  assistant: TeamAssistant;
}
