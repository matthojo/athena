/**
 * Assignments and Team chat, in words (docs/team.md "Assignments"): what a
 * stage and an assignment say about themselves, the lineup card's presets
 * and edits, what a post weighs in What waits for you, and how the channel
 * groups into threads. Pure, so every screen and the tests share it.
 */
import { ASSIGNMENT_LIMITS, type Assignment, type AssignmentStage, type Checkpoint, type CheckpointPreset, type DocumentFile, type Lineup, type LineupStage, type RoleKey, type StageAnswer, type StageQuestion, type StageWho, type PostWaits, type TeamPost } from "../../../lib/assignment-types";

export const ROLE_NAME: Record<RoleKey, string> = {
  engineer: "Engineer",
  seo: "SEO",
  editor: "Editor",
  reviewer: "Reviewer",
  "product-manager": "Product manager",
  cfo: "CFO",
  legal: "Legal",
  researcher: "Researcher",
  designer: "Designer",
  custom: "Custom role",
};

/** What a role is for, when the lineup gave a stage no job of its own. */
export const ROLE_JOB: Record<RoleKey, string> = {
  engineer: "Writes the spec or a first draft",
  seo: "Makes it easy to find",
  editor: "Tightens the writing",
  reviewer: "Reads it with fresh eyes",
  "product-manager": "Shapes what it should do and why",
  cfo: "Checks the numbers",
  legal: "Checks the claims and the terms",
  researcher: "Finds what's known",
  designer: "Plans how it looks and reads",
  custom: "",
};

/** A change or an approval waits for Go; a question waits for an answer; a run that didn't finish waits to be dismissed. */
export const WAITS_WORD: Record<PostWaits, string> = { go: "Needs your Go", answer: "Needs your answer", approval: "Needs your Go", dismiss: "Didn't finish" };

/** Under a guest's name: "Guest", with its role when there is one. */
export function guestLine(who: Pick<StageWho, "guest" | "role" | "job">): string {
  if (!who.guest) return who.job;
  return who.role && who.role !== "custom" ? `Guest · ${ROLE_NAME[who.role]}` : "Guest";
}

/** A stage's badge: the Team page's words for working and waiting, plus "Needs your answer". Null: nothing to say yet. */
export function stageBadge(s: Pick<AssignmentStage, "status" | "waits_for">): string | null {
  if (s.status === "running") return "Working";
  if (s.status === "waiting") return WAITS_WORD[s.waits_for ?? "go"];
  if (s.status === "failed") return "Didn't finish";
  if (s.status === "done") return "Done";
  if (s.status === "skipped") return "Skipped";
  return null;
}

/** What a working stage is doing: its step, else "Getting it done". */
export const stageStep = (s: Pick<AssignmentStage, "step">): string => s.step?.trim() || "Getting it done";

/** The stage the assignment is on: working or waiting, else the one that didn't finish, else the first that hasn't run. */
export function currentStage(a: Pick<Assignment, "stages">): AssignmentStage | null {
  return a.stages.find((s) => s.status === "running" || s.status === "waiting") ?? a.stages.find((s) => s.status === "failed") ?? a.stages.find((s) => s.status === "pending") ?? null;
}

/** One line on where an assignment is: "Piper needs your answer", "Otto is working", "Done". */
export function assignmentLine(a: Pick<Assignment, "status" | "stages">): string {
  const s = currentStage(a);
  if (a.status === "done") return "Done";
  if (a.status === "stopped") return "Stopped";
  if (a.status === "failed") return s ? `${s.who.name} didn't finish` : "Didn't finish";
  if (a.status === "draft" || !s) return "Not started";
  if (s.status === "waiting") return `${s.who.name} ${s.waits_for === "answer" ? "needs your answer" : "needs your Go"}`;
  if (s.status === "running") return `${s.who.name} is working`;
  return `${s.who.name} is about to start`;
}

/** "Stage 2 of 3". */
export const stageOf = (a: Pick<Assignment, "stages">, s: Pick<AssignmentStage, "position">): string => `Stage ${s.position + 1} of ${a.stages.length}`;

// ---------- What waits for you ----------

/** "3 things wait for you", for Team chat's strip and Home's card. */
export const thingsWait = (n: number): string => (n === 1 ? "1 thing waits for you" : `${n} things wait for you`);

/** A waiting post's line in the strip: "Piper needs your answer". */
export function waitTitle(p: Pick<TeamPost, "kind" | "who" | "waits_for">): string {
  const name = p.who?.name ?? "Ask";
  if (p.kind === "failed") return `${name} didn't finish`;
  return `${name} ${p.waits_for === "answer" ? "needs your answer" : "needs your Go"}`;
}

/**
 * What waits, oldest first: the chat's `waiting` list, one row a post. Its
 * length is the one count (the strip, the sidebar, Home, phone Home's Team
 * button): a plan is 1 whatever it holds, as is a question, an approval and
 * a run that didn't finish.
 */
export function waitingPosts(chat: { waiting: readonly TeamPost[] }): TeamPost[] {
  return chat.waiting.filter((p) => !p.settled_at).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
}

// ---------- threads ----------

export interface ChatThread {
  /** The assignment's id, or `post:<id>` for a post that stands alone. */
  key: string;
  assignment_id: string | null;
  title: string | null;
  posts: TeamPost[];
  /** How many of its posts wait. */
  waits: number;
  /** When its latest post was made. */
  at: string;
}

/** The channel as threads: one per assignment (its lineup first), and each other post alone. Oldest first by latest post. */
export function threadsOf(posts: readonly TeamPost[]): ChatThread[] {
  const out = new Map<string, ChatThread>();
  for (const p of [...posts].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)) {
    const key = p.assignment_id ?? `post:${p.id}`;
    const t = out.get(key) ?? { key, assignment_id: p.assignment_id, title: p.assignment_title, posts: [], waits: 0, at: p.created_at };
    t.posts.push(p);
    t.title ??= p.assignment_title;
    if (p.waits_for && !p.settled_at) t.waits++;
    t.at = p.created_at;
    out.set(key, t);
  }
  return [...out.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** A folded thread's count: "4 posts · 1 waits". */
export function threadCount(t: Pick<ChatThread, "posts" | "waits">): string {
  const posts = t.posts.length === 1 ? "1 post" : `${t.posts.length} posts`;
  return t.waits ? `${posts} · ${t.waits === 1 ? "1 waits" : `${t.waits} wait`}` : posts;
}

// ---------- questions ----------

/** An answer's source in the trail. */
export const answerBy = (a: Pick<StageAnswer, "by">): string => (a.by === "suggested" ? "Suggested, taken for you" : "Your answer");

/** Every question answered as suggested. */
export function suggestedAnswers(questions: readonly StageQuestion[]): StageAnswer[] {
  return questions.map((q) => ({ id: q.id, question: q.question, answer: q.choices[q.suggested] ?? q.choices[0] ?? "", by: "suggested" as const }));
}

/** The owner's picks as answers; null while one is still missing. A pick that is the suggestion is still the owner's. */
export function ownerAnswers(questions: readonly StageQuestion[], picked: ReadonlyArray<string | undefined>): StageAnswer[] | null {
  const out: StageAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const answer = picked[i]?.trim();
    if (!answer) return null;
    out.push({ id: q.id, question: q.question, answer, by: "owner" });
  }
  return out;
}

// ---------- the lineup card ----------

export const PRESETS: ReadonlyArray<{ key: CheckpointPreset; label: string }> = [
  { key: "auto", label: "Run straight through" },
  { key: "each", label: "Check with me after each stage" },
  { key: "last", label: "Check with me before the last stage" },
];

export const CHECKPOINT_WORD: Record<Checkpoint, string> = { auto: "Carries on", approve: "Checks with you" };

/** The last stage's result always comes to you, so its checkpoint isn't a choice. */
export const LAST_STAGE_NOTE = "Comes to you when it's done";

/** Each stage's checkpoint under a preset. The last stage is left to carry on: its result comes to the owner anyway. */
export function applyPreset(l: Lineup, preset: CheckpointPreset): Lineup {
  const last = l.stages.length - 1;
  const at = (i: number): Checkpoint => (i === last ? "auto" : preset === "each" ? "approve" : preset === "last" && i === last - 1 ? "approve" : "auto");
  return { ...l, checkpoint: preset === "each" ? "approve" : "auto", stages: l.stages.map((s, i) => ({ ...s, checkpoint: at(i) })) };
}

/** Which preset the stages match, or null once the owner has set them one by one. */
export function presetOf(l: Pick<Lineup, "stages">): CheckpointPreset | null {
  const got = l.stages.slice(0, -1).map((s) => s.checkpoint).join(",");
  for (const { key } of PRESETS) {
    const want = applyPreset({ title: "", brief: "", checkpoint: "auto", suggestions: "ask", stages: l.stages }, key).stages.slice(0, -1).map((s) => s.checkpoint).join(",");
    if (want === got) return key;
  }
  return null;
}

export function moveStage(l: Lineup, from: number, to: number): Lineup {
  if (from === to || from < 0 || to < 0 || from >= l.stages.length || to >= l.stages.length) return l;
  const stages = [...l.stages];
  const [s] = stages.splice(from, 1);
  stages.splice(to, 0, s);
  // The stage now last carries on, as the last one always does.
  return { ...l, stages: stages.map((x, i) => (i === stages.length - 1 ? { ...x, checkpoint: "auto" as const } : x)) };
}

export const canRemove = (l: Pick<Lineup, "stages">): boolean => l.stages.length > ASSIGNMENT_LIMITS.minStages;

export function removeStage(l: Lineup, i: number): Lineup {
  if (!canRemove(l) || !l.stages[i]) return l;
  const stages = l.stages.filter((_, n) => n !== i);
  return { ...l, stages: stages.map((x, n) => (n === stages.length - 1 ? { ...x, checkpoint: "auto" as const } : x)) };
}

/** Swap who does a stage: another role's guest, or a standing assistant. Its task and checkpoint stay. */
export function swapStage(l: Lineup, i: number, to: { role: RoleKey } | { assistant_id: string; name: string; job: string }): Lineup {
  const was = l.stages[i];
  if (!was) return l;
  const next: LineupStage =
    "assistant_id" in to
      ? { role: was.role, assistant_id: to.assistant_id, name: to.name, job: to.job, task: was.task, checkpoint: was.checkpoint }
      : { role: to.role, task: was.task, checkpoint: was.checkpoint, ...(was.web ? { web: true } : {}) };
  return { ...l, stages: l.stages.map((s, n) => (n === i ? next : s)) };
}

export function setCheckpoint(l: Lineup, i: number, checkpoint: Checkpoint): Lineup {
  return { ...l, stages: l.stages.map((s, n) => (n === i ? { ...s, checkpoint } : s)) };
}

/** Why Go can't be tapped yet, or null when the lineup can start. */
export function lineupProblem(l: Pick<Lineup, "stages" | "title">): string | null {
  if (l.stages.length < ASSIGNMENT_LIMITS.minStages) return `A lineup needs at least ${ASSIGNMENT_LIMITS.minStages} stages.`;
  if (l.stages.length > ASSIGNMENT_LIMITS.maxStages) return `A lineup has ${ASSIGNMENT_LIMITS.maxStages} stages at most.`;
  if (l.stages.some((s) => !s.task.trim())) return "Each stage needs a task.";
  return null;
}

/** Who a proposed stage is, before it exists: its name (the role's when it has none) and the line under it. */
export function lineupWho(s: LineupStage): { name: string; line: string } {
  const role = ROLE_NAME[s.role];
  if (s.assistant_id) return { name: s.name ?? "Assistant", line: s.job ?? "" };
  return { name: s.name?.trim() || role, line: s.name?.trim() && s.role !== "custom" ? `Guest · ${role}` : "Guest" };
}

/** The seed a guest's character is drawn from before the server has made it. */
export const guestSeed = (s: Pick<LineupStage, "role" | "name">): string => `guest:${s.role}:${(s.name ?? "").trim().toLowerCase()}`;

// ---------- keeping a guest, documents ----------

/** The server's 409 when the team is full, said the same way in sample mode. */
export const teamFull = (name: string): string => `Your team is full. Remove an assistant to keep ${name}.`;

export const FORMAT_NAME: Record<DocumentFile["format"], string> = { md: "Markdown", docx: "Word" };

/** "12 KB", "1.4 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
