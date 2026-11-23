/**
 * Sample mode's assignments and Team chat (docs/team.md "Assignments"): one
 * data set both read. A finished assignment with its document, one waiting
 * on a question, one waiting for Go, and the standing assistants' posts,
 * which come from the same runs the Team page shows (db/sample-team.ts).
 *
 * The fakes move the work on by the clock, as the runner would: a stage
 * works for a few seconds, hands off, and the next one starts. Nothing here
 * touches the page or a server, so the tests drive it with their own clock.
 */
import { ASSIGNMENT_LIMITS, type Assignment, type AssignmentStage, type Checkpoint, type DocumentFile, type Handoff, type Lineup, type LineupStage, type PostKind, type RoleKey, type StageAnswer, type StageQuestion, type StageWho, type Suggestions, type TeamChat, type TeamPost } from "../../../lib/assignment-types";
import type { TeamAssistant, TeamRun } from "../../../lib/team-types";
import { avatarFromSeed } from "../../../lib/team-seed";
import { guestSeed, ROLE_JOB, ROLE_NAME, suggestedAnswers } from "../team/assign-words";
import { splitReport } from "../lib/team-report";

const MIN = 60_000;
/** How long a sample stage works before it hands off. */
export const STAGE_MS = 6_000;
const STEPS = ["Reading the brief", "Reading the handoff", "Working on the document", "Writing the handoff"];

const uid = (n: number) => `5a3e0000-0000-4000-8000-0000000a${String(n).padStart(4, "0")}`;
export const SAMPLE_ASSIGNMENT_IDS = { pricing: uid(1), launch: uid(2), offsite: uid(3) } as const;

/** The guest each role gets in sample mode. */
const GUEST_NAME: Record<RoleKey, string> = { engineer: "Ada", seo: "Piper", editor: "Quill", reviewer: "Rook", "product-manager": "Fern", cfo: "Otto", legal: "Lex", researcher: "Nell", designer: "Iris", custom: "Kit" };

const ROLE_TASK: Record<RoleKey, string> = {
  engineer: "Outline how it works, in plain words",
  seo: "Choose the search terms and write the headline",
  editor: "Tighten the writing and keep one voice",
  reviewer: "Read it as a newcomer and flag anything unclear",
  "product-manager": "Say what it's for and what it needs",
  cfo: "Cost it and flag anything over budget",
  legal: "Check the claims and the terms",
  researcher: "Find what's already known and list the sources",
  designer: "Plan the layout and what goes where",
  custom: "Do your part",
};

function guest(id: string, role: RoleKey, name = GUEST_NAME[role], job = ROLE_JOB[role]): StageWho {
  return { id, name, avatar: avatarFromSeed(guestSeed({ role, name })), job, role, guest: true };
}

const blank = { checkpoint: "auto" as Checkpoint, status: "pending" as const, waits_for: null, run_id: null, thread_id: null, waiting: 0, step: null, note_version: null, sent_back_from: null, started_at: null, finished_at: null, handoff: null, questions: [], answers: [] };

/** The question a new sample assignment's second stage asks, once. */
function sampleQuestion(stageId: string): StageQuestion {
  return { id: `${stageId}-q1`, question: "Who is this mainly for?", choices: ["People new to it", "People who already use it", "Both, with a short intro for newcomers"], allowOther: true, suggested: 2, why: "The brief doesn't say, and this covers both without making it longer." };
}

function sampleHandoff(s: AssignmentStage, next: AssignmentStage | undefined): Handoff {
  return {
    did: `${s.task.replace(/\.$/, "")}. It's in the document.`,
    open: "Nothing open.",
    next: next ? `${next.who.name}: start from the top section, which changed most.` : "",
  };
}

export interface SampleAssignments {
  list(now?: number): Assignment[];
  get(id: string, now?: number): Assignment | null;
  draft(text: string): { lineup: Lineup; fallback?: boolean };
  start(lineup: Lineup, team?: ReadonlyArray<Pick<TeamAssistant, "id" | "name" | "avatar" | "job">>, now?: number): Assignment;
  patch(id: string, p: { checkpoint?: Checkpoint; suggestions?: Suggestions }): Assignment;
  patchStage(id: string, n: number, p: { checkpoint: Checkpoint }): Assignment;
  go(id: string, now?: number): Assignment;
  answer(id: string, input: StageAnswer[] | { use: "suggested"; from_here?: boolean }, now?: number): Assignment;
  sendBack(id: string, input: { to: number; note: string }, now?: number): Assignment;
  stop(id: string, now?: number): Assignment;
  remove(id: string): void;
  /** A guest kept on the team: no longer a guest on its assignment's trail. `as`: its id as a standing assistant. */
  kept(guestId: string, as?: string): StageWho | null;
  guestOf(id: string): StageWho | null;
  /** The assignments' posts, oldest first. */
  posts(now?: number): TeamPost[];
  say(text: string, assignmentId?: string | null, team?: ReadonlyArray<Pick<TeamAssistant, "id" | "name" | "avatar" | "job">>, now?: number): TeamPost[];
}

export function makeSampleAssignments(t0 = Date.now()): SampleAssignments {
  const all: Assignment[] = [];
  const posts: TeamPost[] = [];
  /** When each working stage hands off. */
  const due = new Map<string, number>();
  /** New assignments' stages that have asked their question. */
  const asked = new Set<string>();
  let seq = 0;
  let made = 100;
  const iso = (ms: number) => new Date(ms).toISOString();

  function post(kind: PostKind, a: Assignment, s: AssignmentStage | null, text: string, at: number, more: Partial<TeamPost> = {}): TeamPost {
    const p: TeamPost = { id: ++seq, kind, who: s?.who ?? null, from: s ? "assistant" : "ask", text, assignment_id: a.id, assignment_title: a.title, stage_id: s?.id ?? null, run_id: s?.run_id ?? null, thread_id: s?.thread_id ?? null, waits_for: null, settled_at: null, created_at: iso(at), ...more };
    posts.push(p);
    return p;
  }

  const lineupWords = (a: Assignment) => `Lineup: ${a.stages.map((s) => s.who.name).join(", then ")}. ${a.suggestions === "take" ? "Questions take the suggested answer." : "Each stage asks when it needs to."}`;

  function assignment(id: string, title: string, brief: string, at: number, stages: Array<[StageWho, string, Partial<AssignmentStage>?]>, more: Partial<Assignment> = {}): Assignment {
    const a: Assignment = { id, title, brief, status: "running", checkpoint: "auto", suggestions: "ask", sent_back: false, note_id: `${id.slice(0, -4)}f${id.slice(-3)}`, thread_id: null, stages: [], documents: [], created_at: iso(at), updated_at: iso(at), finished_at: null, ...more };
    a.stages = stages.map(([who, task, p], position) => ({ ...blank, id: `${id.slice(0, -5)}${position + 1}${id.slice(-4)}`, position, who, task, ...p }));
    all.push(a);
    return a;
  }

  function documents(a: Assignment, at: number): DocumentFile[] {
    const base = { note_id: a.note_id!, created_at: iso(at) };
    return [
      { ...base, file_id: `${a.id.slice(0, -4)}d${a.id.slice(-3)}`, format: "md", name: `${a.title}.md`, size: 3_180 },
      { ...base, file_id: `${a.id.slice(0, -4)}e${a.id.slice(-3)}`, format: "docx", name: `${a.title}.docx`, size: 14_336 },
    ];
  }

  // ----- the three it starts with -----

  {
    // Finished yesterday, with its document.
    const at = t0 - 26 * 60 * MIN;
    const juno = guest(uid(11), "product-manager", "Juno");
    const quill = guest(uid(12), "editor");
    const sage = guest(uid(13), "reviewer", "Sage");
    const q: StageQuestion = { id: "pricing-q1", question: "Lead with the monthly or the yearly price?", choices: ["Monthly", "Yearly, with monthly beside it"], allowOther: false, suggested: 1, why: "Most visitors compare on the yearly price." };
    const a = assignment(SAMPLE_ASSIGNMENT_IDS.pricing, "Pricing page rewrite", "Rewrite the pricing page so the three plans are easier to compare. Keep it under 400 words.", at, [
      [juno, "Say what each plan is for and who it suits", { status: "done", started_at: iso(at), finished_at: iso(at + 3 * MIN), note_version: "v1", questions: [q], answers: [{ id: q.id, question: q.question, answer: q.choices[1], by: "suggested" }], handoff: { did: "Wrote one line per plan on who it's for, and cut the feature grid from 14 rows to 6.", open: "The Team plan's seat minimum isn't stated anywhere.", next: "Check the plan names read the same in every section." } }],
      [quill, "Tighten the copy to under 400 words", { status: "done", started_at: iso(at + 3 * MIN), finished_at: iso(at + 5 * MIN), note_version: "v2", handoff: { did: "Cut it to 380 words and made the plan names the same throughout.", open: "Nothing open.", next: "Read the comparison table for anything a new visitor wouldn't follow." } }],
      [sage, "Read it as a new visitor and flag anything unclear", { status: "done", started_at: iso(at + 5 * MIN), finished_at: iso(at + 7 * MIN), note_version: "v3", handoff: { did: "Read it as a new visitor. Moved the seat minimum into the Team plan's first line.", open: "Nothing open.", next: "" } }],
    ], { status: "done", suggestions: "take", finished_at: iso(at + 7 * MIN), updated_at: iso(at + 7 * MIN) });
    a.documents = documents(a, at + 7 * MIN);
    const [s1, s2, s3] = a.stages;
    post("lineup", a, null, lineupWords(a), at);
    post("handoff", a, s1, s1.handoff!.did, at + 3 * MIN, { handoff: s1.handoff! });
    post("handoff", a, s2, s2.handoff!.did, at + 5 * MIN, { handoff: s2.handoff! });
    post("done", a, s3, "Finished. The pricing page is 380 words, and the document is ready.", at + 7 * MIN, { documents: a.documents, note_id: a.note_id });
  }
  {
    // Waiting for Go: the CFO's stage stops for approval.
    const at = t0 - 190 * MIN;
    const fern = guest(uid(31), "product-manager");
    const otto = guest(uid(32), "cfo");
    const lex = guest(uid(33), "legal");
    const a = assignment(SAMPLE_ASSIGNMENT_IDS.offsite, "Offsite budget for March", "Work out what the March offsite will cost for 14 people, against a budget of £7,500.", at, [
      [fern, "List what the offsite needs and for how many", { status: "done", started_at: iso(at), finished_at: iso(at + 2 * MIN), note_version: "v1", handoff: { did: "Listed venue, travel, food and one evening out, for 14 people over two days.", open: "Whether partners are invited to the evening.", next: "Cost each line, and say which ones are estimates." } }],
      [otto, "Cost it and flag anything over budget", { checkpoint: "approve", status: "waiting", waits_for: "approval", started_at: iso(at + 2 * MIN), finished_at: iso(at + 5 * MIN), note_version: "v2", handoff: { did: "Costed venue, travel and food for 14 people: £6,820 against £7,500.", open: "Train fares are today's prices and may rise by March.", next: "Check the venue's cancellation terms before anything is booked." } }],
      [lex, "Read the venue's terms for cancellation costs"],
    ], { status: "waiting", checkpoint: "auto", updated_at: iso(at + 5 * MIN) });
    const [s1, s2] = a.stages;
    post("lineup", a, null, lineupWords(a), at);
    post("handoff", a, s1, s1.handoff!.did, at + 2 * MIN, { handoff: s1.handoff! });
    post("approval", a, s2, "The costing is done: £6,820 against £7,500. Have a look before Lex reads the venue's terms.", at + 5 * MIN, { waits_for: "approval", handoff: s2.handoff! });
  }
  {
    // Waiting on a question: the SEO stage has two.
    const at = t0 - 48 * MIN;
    const ada = guest(uid(21), "engineer");
    const piper = guest(uid(22), "seo");
    const rook = guest(uid(23), "reviewer");
    const questions: StageQuestion[] = [
      { id: "launch-q1", question: "Which search term should the headline lead with?", choices: ["offline notes app", "notes that work without wifi", "second brain offline"], allowOther: true, suggested: 0, why: "It has the most searches of the three and the least competition." },
      { id: "launch-q2", question: "Mention the 50 MB attachment limit in the post?", choices: ["Yes, in a footnote", "No, leave it for the docs"], allowOther: false, suggested: 1, why: "Ada left it open, and it would pull attention from the launch." },
    ];
    const a = assignment(SAMPLE_ASSIGNMENT_IDS.launch, "Launch post for offline mode", "Write the launch post for offline mode: what works without a connection, in plain words, about 600 words.", at, [
      [ada, "Outline how offline mode works, in plain words", { status: "done", started_at: iso(at), finished_at: iso(at + 3 * MIN), note_version: "v1", handoff: { did: "Outlined the three things that work offline (capture, search, Ask's history) and what waits for a connection.", open: "Whether to mention the 50 MB attachment limit.", next: "Pick the search terms before the headline is written." } }],
      [piper, "Choose the search terms and write the headline", { status: "waiting", waits_for: "answer", started_at: iso(at + 3 * MIN), questions }],
      [rook, "Check every claim against the outline"],
    ], { status: "waiting", updated_at: iso(at + 4 * MIN) });
    const [s1, s2] = a.stages;
    post("lineup", a, null, lineupWords(a), at);
    post("handoff", a, s1, s1.handoff!.did, at + 3 * MIN, { handoff: s1.handoff! });
    post("question", a, s2, "Two things before I write the headline.", at + 4 * MIN, { waits_for: "answer", questions });
  }

  // ----- the runner, by the clock -----

  const find = (id: string): Assignment => {
    const a = all.find((x) => x.id === id);
    if (!a) throw new Error("That assignment isn't there any more");
    return a;
  };
  const waitingStage = (a: Assignment) => a.stages.find((s) => s.status === "waiting") ?? null;
  const settle = (a: Assignment, s: AssignmentStage, at: number, more: Partial<TeamPost> = {}) => {
    for (const p of posts) if (p.assignment_id === a.id && p.stage_id === s.id && p.waits_for && !p.settled_at) Object.assign(p, { settled_at: iso(at) }, more);
  };

  function startStage(a: Assignment, s: AssignmentStage, at: number, words?: string) {
    Object.assign(s, { status: "running", waits_for: null, step: STEPS[0], started_at: s.started_at ?? iso(at), finished_at: null });
    a.status = "running";
    a.updated_at = iso(at);
    due.set(s.id, at + STAGE_MS);
    post("update", a, s, words ?? `Starting: ${s.task.charAt(0).toLowerCase()}${s.task.slice(1)}.`, at);
  }

  function finishStage(a: Assignment, s: AssignmentStage, at: number) {
    due.delete(s.id);
    // A new assignment's second stage asks once, unless questions take the suggestion.
    if (s.position === 1 && !asked.has(s.id) && a.created_at >= iso(t0)) {
      asked.add(s.id);
      const q = sampleQuestion(s.id);
      s.questions = [q];
      if (a.suggestions === "take") s.answers = suggestedAnswers([q]);
      else {
        Object.assign(s, { status: "waiting", waits_for: "answer", step: null });
        a.status = "waiting";
        a.updated_at = iso(at);
        post("question", a, s, "One thing before I carry on.", at, { waits_for: "answer", questions: [q] });
        return;
      }
    }
    const next = a.stages[s.position + 1];
    Object.assign(s, { status: "done", step: null, finished_at: iso(at), note_version: `v${s.position + 1}`, handoff: s.handoff ?? sampleHandoff(s, next) });
    a.updated_at = iso(at);
    if (!next) {
      Object.assign(a, { status: "done", finished_at: iso(at), documents: documents(a, at) });
      post("done", a, s, "Finished. The document is ready.", at, { documents: a.documents, note_id: a.note_id });
    } else if (s.checkpoint === "approve") {
      Object.assign(s, { status: "waiting", waits_for: "approval" });
      a.status = "waiting";
      post("approval", a, s, `My part is done. Have a look before ${next.who.name} starts.`, at, { waits_for: "approval", handoff: s.handoff! });
    } else {
      post("handoff", a, s, s.handoff!.did, at, { handoff: s.handoff! });
      startStage(a, next, at);
    }
  }

  function tick(now: number) {
    // One stage can finish and start the next, which may be due too after a long gap.
    for (let i = 0; i < 12; i++) {
      const ready = all.flatMap((a) => a.stages.filter((s) => s.status === "running" && (due.get(s.id) ?? Infinity) <= now).map((s) => [a, s] as const));
      if (!ready.length) break;
      for (const [a, s] of ready) finishStage(a, s, due.get(s.id)!);
    }
    for (const a of all) for (const s of a.stages) if (s.status === "running") s.step = STEPS[Math.min(STEPS.length - 1, Math.floor(((now - (due.get(s.id)! - STAGE_MS)) / STAGE_MS) * STEPS.length))];
  }

  const out = (a: Assignment) => structuredClone(a);
  const active = () => all.filter((a) => a.status === "running" || a.status === "waiting").length;

  return {
    list(now = Date.now()) {
      tick(now);
      return [...all].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map(out);
    },
    get(id, now = Date.now()) {
      tick(now);
      const a = all.find((x) => x.id === id);
      return a ? out(a) : null;
    },
    draft(text) {
      const brief = text.replace(/\s+/g, " ").trim().slice(0, ASSIGNMENT_LIMITS.brief);
      const roles: RoleKey[] = /\b(budget|cost|costs|price|prices|pricing|spend|£|\$)/i.test(brief) ? ["product-manager", "cfo", "reviewer"] : /\b(post|blog|launch|article|headline|seo|landing)\b/i.test(brief) ? ["engineer", "seo", "editor"] : /\b(contract|terms|policy|legal|privacy)\b/i.test(brief) ? ["researcher", "legal", "reviewer"] : ["researcher", "editor", "reviewer"];
      const words = brief.replace(/[.?!].*$/, "").split(" ").slice(0, 7).join(" ").replace(/[\s,;:]+$/, "");
      const title = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, ASSIGNMENT_LIMITS.title) || "New assignment";
      return { lineup: { title, brief, checkpoint: "auto", suggestions: "ask", stages: roles.map((role) => ({ role, name: GUEST_NAME[role], job: ROLE_JOB[role], task: ROLE_TASK[role], checkpoint: "auto" as Checkpoint })) } };
    },
    start(lineup, team = [], now = Date.now()) {
      if (active() >= ASSIGNMENT_LIMITS.running) throw new Error("Three assignments are already under way. Finish or stop one first.");
      const n = ++made;
      const who = (s: LineupStage, i: number): StageWho => {
        const standing = s.assistant_id ? team.find((t) => t.id === s.assistant_id) : null;
        if (standing) return { id: standing.id, name: standing.name, avatar: standing.avatar, job: standing.job, role: null, guest: false };
        return guest(uid(n * 10 + i), s.role, s.name?.trim() || GUEST_NAME[s.role], s.job?.trim() || ROLE_JOB[s.role] || ROLE_NAME[s.role]);
      };
      const a = assignment(uid(n), lineup.title.trim() || "New assignment", lineup.brief, now, lineup.stages.map((s, i) => [who(s, i), s.task, { checkpoint: s.checkpoint }]), { checkpoint: lineup.checkpoint, suggestions: lineup.suggestions });
      post("lineup", a, null, lineupWords(a), now);
      startStage(a, a.stages[0], now);
      return out(a);
    },
    patch(id, p) {
      const a = find(id);
      if (p.checkpoint) a.checkpoint = p.checkpoint;
      if (p.suggestions) a.suggestions = p.suggestions;
      return out(a);
    },
    patchStage(id, n, p) {
      const a = find(id);
      const s = a.stages[n];
      if (!s || s.status !== "pending") throw new Error("That stage has already run");
      s.checkpoint = p.checkpoint;
      return out(a);
    },
    go(id, now = Date.now()) {
      tick(now);
      const a = find(id);
      const s = waitingStage(a);
      if (!s || s.waits_for !== "approval") throw new Error("Nothing is waiting for your approval here");
      settle(a, s, now);
      Object.assign(s, { status: "done", waits_for: null });
      startStage(a, a.stages[s.position + 1], now);
      return out(a);
    },
    answer(id, input, now = Date.now()) {
      tick(now);
      const a = find(id);
      const s = waitingStage(a);
      if (!s || s.waits_for !== "answer") throw new Error("Nothing is waiting for an answer here");
      const answers = Array.isArray(input) ? input : suggestedAnswers(s.questions);
      if (!Array.isArray(input) && input.from_here) a.suggestions = "take";
      s.answers = [...s.answers.filter((x) => !answers.some((y) => y.id === x.id)), ...answers];
      settle(a, s, now, { answers });
      startStage(a, s, now, "Thanks. Carrying on with that.");
      return out(a);
    },
    sendBack(id, input, now = Date.now()) {
      tick(now);
      const a = find(id);
      const s = waitingStage(a);
      const to = a.stages[input.to];
      if (!s || s.waits_for !== "approval" || !to || to.position > s.position) throw new Error("There's nothing to send back here");
      settle(a, s, now);
      for (const x of a.stages) if (x.position > to.position && x.position <= s.position) Object.assign(x, { status: "pending", waits_for: null, handoff: null, finished_at: null, started_at: null });
      Object.assign(to, { handoff: null, note: input.note.trim() || undefined, sent_back_from: s.position, started_at: null });
      startStage(a, to, now, input.note.trim() ? "Back with me. I'll work from your note." : "Back with me. Having another go.");
      return out(a);
    },
    stop(id, now = Date.now()) {
      tick(now);
      const a = find(id);
      if (a.status !== "running" && a.status !== "waiting") return out(a);
      for (const s of a.stages) {
        if (s.status === "waiting") settle(a, s, now);
        if (s.status !== "done") Object.assign(s, { status: "skipped", waits_for: null, step: null });
        due.delete(s.id);
      }
      Object.assign(a, { status: "stopped", finished_at: iso(now), updated_at: iso(now) });
      return out(a);
    },
    remove(id) {
      const i = all.findIndex((a) => a.id === id);
      if (i >= 0) all.splice(i, 1);
      for (let n = posts.length - 1; n >= 0; n--) if (posts[n].assignment_id === id) posts.splice(n, 1);
    },
    guestOf(id) {
      for (const a of all) for (const s of a.stages) if (s.who.id === id && s.who.guest) return structuredClone(s.who);
      return null;
    },
    kept(guestId, as) {
      let who: StageWho | null = null;
      for (const a of all) for (const s of a.stages) if (s.who.id === guestId && s.who.guest) who = Object.assign(s.who, { guest: false, ...(as ? { id: as } : {}) });
      for (const p of posts) if (p.who?.id === guestId) Object.assign(p.who, { guest: false, ...(as ? { id: as } : {}) });
      return who ? structuredClone(who) : null;
    },
    posts(now = Date.now()) {
      tick(now);
      return structuredClone(posts);
    },
    say(text, assignmentId, team = [], now = Date.now()) {
      tick(now);
      const words = text.trim();
      const a = assignmentId ? all.find((x) => x.id === assignmentId) : null;
      const mine: TeamPost = { id: ++seq, kind: "said", who: null, from: "owner", text: words, assignment_id: a?.id ?? null, assignment_title: a?.title ?? null, stage_id: null, run_id: null, thread_id: null, waits_for: null, settled_at: null, created_at: iso(now) };
      posts.push(mine);
      const made = [mine];
      const reply = (who: StageWho | null, said: string) => {
        const p: TeamPost = { ...mine, id: ++seq, kind: "reply", who, from: who ? "assistant" : "ask", text: said, created_at: iso(now + 1) };
        posts.push(p);
        made.push(p);
      };
      const s = a ? waitingStage(a) : null;
      if (a && s?.waits_for === "answer") {
        // "continue and use all suggested routes", or the one question's answer in the owner's words.
        if (/\b(use|take|continue)\b.*\bsuggest/i.test(words)) this.answer(a.id, { use: "suggested", from_here: true }, now);
        else if (s.questions.length === 1) this.answer(a.id, [{ id: s.questions[0].id, question: s.questions[0].question, answer: words, by: "owner" }], now);
        else reply(s.who, `I asked ${s.questions.length} things. Pick an answer under each one above, or tap Use suggestions.`);
      } else if (a && s?.waits_for === "approval") {
        s.note = words;
        reply(s.who, "Noted. Tap Send back to return it with that note, or Go to carry on as it is.");
      } else {
        const at = words.match(/@(\w+)/)?.[1]?.toLowerCase();
        const named = at ? team.find((t) => t.name.toLowerCase() === at) : null;
        if (named) reply({ id: named.id, name: named.name, avatar: named.avatar, job: named.job, role: null, guest: false }, "I'm sample data, so I can only show how this works. In your own Athena I'd answer you here.");
        else reply(null, "This is sample data, so I can only show how it works. With your own team I'd answer here, or start an assignment for it.");
      }
      return structuredClone(made);
    },
  };
}

// ---------- the standing assistants' posts ----------

type Standing = Pick<TeamAssistant, "id" | "name" | "avatar" | "job">;

/**
 * What the standing assistants posted, from the runs the Team page shows:
 * a plan that waits for Go, a run that didn't finish, or what a run said. A
 * quiet run posts nothing. Only an assistant's latest run can still wait,
 * as on its desk (team/page-words.ts deskFor).
 */
export function standingPosts(team: readonly Standing[], runs: readonly TeamRun[], waits: (r: TeamRun) => number = (r) => r.waiting ?? 0, dismissed: (runId: string) => boolean = () => false, each = 2): TeamPost[] {
  const out: TeamPost[] = [];
  for (const a of team) {
    const mine = runs.filter((r) => r.assistant_id === a.id && (r.status === "done" || r.status === "failed")).sort((x, y) => Date.parse(y.started_at) - Date.parse(x.started_at));
    // The last week's, so the channel isn't a history of every run.
    const recent = mine.filter((r) => Date.parse(mine[0].started_at) - Date.parse(r.started_at) < 7 * 24 * 60 * MIN);
    const said = recent.filter((r) => r.status === "failed" || (!!r.summary?.trim() && !/^nothing\b/i.test(r.summary.trim()))).slice(0, each);
    for (const r of said) {
      const latest = r === mine[0];
      const at = r.finished_at ?? r.started_at;
      const left = latest && r.status === "done" ? waits(r) : 0;
      const plan = r.status === "done" && (r.waiting ?? 0) > 0 && !!r.thread_id;
      const kind: PostKind = r.status === "failed" ? "failed" : plan ? "plan" : "update";
      out.push({
        id: 900_000 + (parseInt(r.id.replace(/-/g, "").slice(-6), 16) % 90_000),
        kind,
        who: { id: a.id, name: a.name, avatar: a.avatar, job: a.job, role: null, guest: false },
        from: "assistant",
        text: r.status === "failed" ? r.error?.trim() || "My last run stopped partway." : splitReport(r.summary ?? "").said,
        assignment_id: null,
        assignment_title: null,
        stage_id: null,
        run_id: r.id,
        thread_id: r.thread_id,
        waits_for: plan ? "go" : kind === "failed" ? "dismiss" : null,
        settled_at: kind === "plan" ? (left > 0 ? null : at) : kind === "failed" ? (latest && !dismissed(r.id) ? null : at) : null,
        created_at: at,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** The conversation sample mode's "@Name" reply keeps its plan in. */
export const SAMPLE_ASKED_THREAD = "5a3e0000-0000-4000-8000-0000000a0f01";

/**
 * An "@Name" reply that proposes a change: what you typed, then the reply
 * holding its plan (`thread_id`, waiting for Go) until the plan is answered.
 */
export function askedPosts(who: Standing | undefined, at: string, settled: boolean): TeamPost[] {
  if (!who) return [];
  const t = Date.parse(at);
  const iso = (ms: number) => new Date(ms).toISOString();
  const base = { assignment_id: null, assignment_title: null, stage_id: null, run_id: null, settled_at: null };
  return [
    { ...base, id: 800_001, kind: "said", who: null, from: "owner", text: `@${who.name} put booking the offsite venue on my list`, thread_id: null, waits_for: null, created_at: iso(t) },
    { ...base, id: 800_002, kind: "reply", who: { id: who.id, name: who.name, avatar: who.avatar, job: who.job, role: null, guest: false }, from: "assistant", text: "I can add that. Here's the to-do I'd make.", thread_id: SAMPLE_ASKED_THREAD, waits_for: "go", settled_at: settled ? iso(t + MIN) : null, created_at: iso(t + MIN) },
  ];
}

/** One channel from both: oldest first, with what waits pulled out. */
export function sampleChat(assignmentPosts: readonly TeamPost[], standing: readonly TeamPost[], before?: number | null, page = 60): TeamChat {
  const all = [...assignmentPosts, ...standing].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const end = before == null ? all.length : Math.max(0, all.findIndex((p) => p.id === before));
  const start = Math.max(0, end - page);
  return { posts: all.slice(start, end), waiting: all.filter((p) => p.waits_for && !p.settled_at), before: start > 0 ? all[start].id : null };
}

let store: SampleAssignments | null = null;
/** This page's sample assignments: every change stays here. */
export const sampleAssignments = (): SampleAssignments => (store ??= makeSampleAssignments());
