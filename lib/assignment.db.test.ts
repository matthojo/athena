// Assignments on real Postgres, each stage a real Team run through Ask's one loop (lib/team-chat.ts
// runAssistantTurn) with a fake model: a 3-stage run from Go to a finished document; a question answered as
// suggested (asked for, and taken from here on) while a plan still waits for Go; approve; send-back, once;
// changing a taken suggestion; guests kept off the team and kept on it (memory once, 409 when full); the limits;
// the routes; and Ask's start_assignment and continue_assignment.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/assignment.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team, assignment, plan and activity tables first.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PostInput } from "./assignment-types";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

type Params = { system?: unknown; tools?: Array<{ name: string; input_schema?: unknown }>; tool_choice?: { name?: string }; messages: Array<{ role: string; content: unknown }> };
type Block = { type: string; [k: string]: unknown };
const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `tu_${name}_${randomUUID().slice(0, 6)}`, name, input });
const answer = (t: string): Block => use("answer", { text: t, found: true, general: false, from_today: false, sources: [], next: [], ask: { question: "", options: [], more: [] } });

/** One model call inside a stage's turn. */
interface Call {
  stage: number;
  total: number;
  /** Which time this stage is running (1 the first time). */
  visit: number;
  /** The model call within this turn, from 1. */
  step: number;
  /** The stage's message. */
  said: string;
  work: string;
  tools: string[];
  p: Params;
  results: Array<{ content?: string; is_error?: boolean }>;
}
type Play = (c: Call) => Block[] | null;

const posts: PostInput[] = [];
const queue: string[] = [];
let settled: Array<{ assignment_id: string; stage_id?: string }> = [];
let memories = 0;
/** Every stage's message, by "stage.visit". */
let said = new Map<string, string>();
let offered = new Map<string, string[]>();
let play: Play = () => null;
const visits = new Map<string, number>();

const LINEUP = {
  title: "Pricing page",
  stages: [
    { role: "engineer", task: "Write the spec" },
    { role: "editor", task: "Make it clear" },
    { role: "reviewer", task: "Check it against the brief" },
  ],
};

/** The fake model: the lineup and memory calls, and each stage's turn through `play` (by default it adds a section and hands off). */
const client = {
  messages: {
    create: async (p: Params) => {
      const done = (content: Block[]) => ({ id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      if (p.tool_choice?.name === "assignment_lineup") return done([use("assignment_lineup", LINEUP)]);
      if (p.tool_choice?.name === "memory") {
        memories++;
        return done([use("memory", { summary: "Wrote the pricing spec.", facts: ["The owner wants Pro first"] })]);
      }
      const first = JSON.stringify(p.messages[0].content);
      const at = first.match(/You are stage (\d) of (\d)/);
      if (!at) return done([answer("Nothing to do.")]);
      const stage = Number(at[1]);
      const step = (p.messages.length + 1) / 2;
      const text = JSON.parse(first) as string | Array<{ text?: string }>;
      const message = typeof text === "string" ? text : text.map((b) => b.text ?? "").join("\n");
      const key = `${message.match(/assignment: “([^”]+)”/)?.[1]}:${stage}`;
      if (step === 1) visits.set(key, (visits.get(key) ?? 0) + 1);
      const visit = visits.get(key)!;
      if (step === 1) {
        said.set(`${stage}.${visit}`, message);
        offered.set(`${stage}.${visit}`, (p.tools ?? []).map((t) => t.name));
      }
      const work = (message.match(/<work>\n([\s\S]*?)\n<\/work>/)?.[1] ?? "").replace("(nothing written yet)", "");
      const last = p.messages.at(-1)!.content;
      const results = Array.isArray(last) ? (last as Array<{ type: string; content?: string; is_error?: boolean }>).filter((b) => b.type === "tool_result") : [];
      const c: Call = { stage, total: Number(at[2]), visit, step, said: message, work, tools: (p.tools ?? []).map((t) => t.name), p, results };
      return done(play(c) ?? (step === 1 ? [use("hand_off", { did: `Did stage ${stage}`, open: "", next: `Over to stage ${stage + 1}`, work: `${work}\n## Stage ${stage}`.trim() })] : [answer(`Stage ${stage} is done.`)]));
    },
  },
} as never;

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_posts, team_stages, team_runs, team_events, team_triggers, ask_skills, team_assistants, team_assignments, ask_plans, ask_activity CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  await qRaw(`DELETE FROM ask_threads`);
  const { configureAssignments, resetAssignmentDeps } = await import("./assignment-run");
  resetAssignmentDeps();
  posts.length = 0;
  queue.length = 0;
  settled = [];
  memories = 0;
  said = new Map();
  offered = new Map();
  visits.clear();
  play = () => null;
  configureAssignments({
    post: async (input) => void posts.push(input),
    settled: async (ref) => void settled.push(ref),
    documentsFor: async (noteId) => [{ file_id: "f1", note_id: noteId, format: "md", name: "Pricing page.md", size: 10, created_at: new Date(0).toISOString() }],
    start: async (runId) => void queue.push(runId),
    client,
  });
});

/** Run every queued stage run, as the background function would, until nothing is queued. */
async function drain(): Promise<void> {
  const { runTeamRun } = await import("./team-run");
  const { runAssistantTurn } = await import("./team-chat");
  for (let i = 0; queue.length && i < 20; i++) {
    const id = queue.shift()!;
    await runTeamRun(id, { turn: (aid, prompt, opts) => runAssistantTurn(aid, prompt, { ...opts, client }) });
  }
  assert.equal(queue.length, 0, "the work stops moving");
}

const lineup = (over: Record<string, unknown> = {}, stages: Array<Record<string, unknown>> = LINEUP.stages) => ({ title: "Pricing page", brief: "Rewrite the pricing page so Pro comes first.", checkpoint: "auto", suggestions: "ask", stages: stages.map((s) => ({ checkpoint: "auto", ...s })), ...over });
const kinds = () => posts.map((p) => p.kind);
const Q = { question: "Which plan goes first?", choices: ["Free", "Pro"], suggested: 1, why: "The brief says Pro" };

test("a 3-stage run: Go makes the note, each stage is one Team run that hands on, and the last one's result comes to the owner", { skip }, async () => {
  const { startAssignment, readAssignment, assignmentWaiting } = await import("./assignment-run");
  const { getNote, qRaw } = await import("./db");
  const { listAssistants } = await import("./team");
  const { listTeamActivity } = await import("./team-run");
  const { listNoteVersions } = await import("./note-versions");

  const started = await startAssignment(lineup());
  assert.equal(started.status, "running");
  assert.ok(started.note_id, "one note, made at Go");
  assert.deepEqual(started.stages.map((s) => [s.position, s.status, s.who.role, s.who.guest]), [[1, "running", "engineer", true], [2, "pending", "editor", true], [3, "pending", "reviewer", true]]);
  assert.ok(started.stages.every((s) => s.who.name && s.who.avatar.v === 1 && s.who.job), "each guest is a character from a seed");
  assert.equal(new Set(started.stages.map((s) => s.who.name)).size, 3);
  assert.equal(queue.length, 1, "only the first stage is queued: the runner moves the work on");
  await drain();

  const a = (await readAssignment(started.id))!;
  assert.equal(a.status, "done");
  assert.ok(a.finished_at);
  assert.deepEqual(a.stages.map((s) => s.status), ["done", "done", "done"]);
  assert.deepEqual(a.stages.map((s) => s.handoff?.did), ["Did stage 1", "Did stage 2", "Did stage 3"]);
  assert.ok(a.stages.every((s) => s.run_id && s.thread_id && s.note_version && s.started_at && s.finished_at && s.waiting === 0));
  assert.equal(a.documents.length, 1, "documentsFor is asked for the note's files");
  const note = (await getNote(a.note_id!))!;
  assert.equal(note.body, "## Stage 1\n## Stage 2\n## Stage 3");
  assert.equal(note.source, "app", "the owner's own note, so reading it back isn't other people's words");
  // A note version per stage: what each one found.
  const versions = await listNoteVersions(a.note_id!);
  const found = (id: string | null) => versions.find((v) => v.id === id)?.body;
  assert.deepEqual(a.stages.map((s) => found(s.note_version)), ["", "## Stage 1", "## Stage 1\n## Stage 2"]);

  // The message: the brief, the work and every earlier handoff, quoted as data.
  const third = said.get("3.1")!;
  assert.match(third, /stage 3 of 3, the Reviewer/);
  assert.match(third, /<brief>\nRewrite the pricing page so Pro comes first\.\n<\/brief>/);
  assert.match(third, /<work>\n## Stage 1\n## Stage 2\n<\/work>/);
  assert.match(third, /<handoff stage="1" role="Engineer">\nDid: Did stage 1[\s\S]*<handoff stage="2" role="Editor">/);
  assert.doesNotMatch(said.get("1.1")!, /<handoffs>/);
  // Its tools: hand_off and the stage's ask_owner; nothing that starts or moves an assignment, and no desk.
  const tools = offered.get("1.1")!;
  assert.ok(tools.includes("hand_off") && tools.includes("ask_owner") && tools.includes("save_note"));
  assert.ok(!tools.includes("start_assignment") && !tools.includes("continue_assignment") && !tools.includes("check_with_assistant"));

  // Each stage is a Team run of its own, marked with its stage.
  const runs = await qRaw<{ stage_id: string; status: string; label: string }>(`SELECT stage_id, status, label FROM team_runs ORDER BY started_at`);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => r.stage_id), a.stages.map((s) => s.id));
  assert.ok(runs.every((r) => r.status === "done"));

  // What's posted, and what waits: nothing, in a run straight through.
  assert.deepEqual(kinds(), ["lineup", "update", "handoff", "update", "handoff", "update", "handoff", "done"]);
  assert.match(posts[0].text, /Lineup for “Pricing page”: Engineer → Editor → Reviewer\. Nothing runs until you tap Go\./);
  assert.equal(posts[1].text, "Starting stage 1 of 3: Write the spec");
  assert.ok(posts.slice(1).every((p) => p.assignment_id === a.id && p.assistant_id && p.stage_id && p.run_id));
  assert.ok(posts.every((p) => !p.waits_for));
  assert.equal(await assignmentWaiting(), 0);

  // Guests aren't on the team: not listed, not in the team's activity, no memory written, no Home card.
  assert.deepEqual(await listAssistants(), []);
  assert.deepEqual(await listTeamActivity(), []);
  assert.equal(memories, 0);
  const { deliverTeamNudges } = await import("./team-run");
  assert.deepEqual(await deliverTeamNudges(new Date(), "Europe/London", { canPush: false, send: async () => ({ sent: 0 }) as never, quiet: null as never }), { sent: 0, held: 0 });
});

test("a question: refused without a suggestion, then it waits; taken as suggested, the answer goes into the same stage's next turn", { skip }, async () => {
  const { startAssignment, readAssignment, answerStage, assignmentWaiting, approveStage } = await import("./assignment-run");
  let refused = "";
  play = (c) => {
    if (c.stage !== 1 || c.visit !== 1) return null;
    if (c.step === 1) return [use("ask_owner", { questions: [{ ...Q, suggested: undefined, why: "" }] })];
    if (c.step === 2) {
      refused = c.results[0]?.content ?? "";
      return [use("ask_owner", { questions: [Q, { question: "What tone should it take?", choices: ["Plain", "Bold"], suggested: 0, why: "Matches the site" }] })];
    }
    return [answer("unreached")];
  };
  const a0 = await startAssignment(lineup());
  await drain();
  assert.match(refused, /Every question needs "suggested"/);
  let a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "waiting");
  assert.deepEqual([a.stages[0].status, a.stages[0].waits_for], ["waiting", "answer"]);
  assert.deepEqual(a.stages[0].questions.map((q) => [q.id, q.suggested, q.why]), [["1.1", 1, "The brief says Pro"], ["1.2", 0, "Matches the site"]]);
  assert.equal(a.stages[0].handoff, null);
  assert.deepEqual(kinds(), ["lineup", "update", "question"], "one post per stop");
  assert.deepEqual([posts[2].waits_for, posts[2].text], ["answer", "I have 2 questions before I go on."]);
  assert.equal(await assignmentWaiting(), 1);
  await assert.rejects(approveStage(a.id), /waiting for your answer first/);

  // "Use suggestions", this stop only.
  await answerStage(a.id, { use: "suggested" });
  assert.deepEqual(settled.at(-1)?.stage_id, a.stages[0].id);
  await drain();
  a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "done");
  assert.equal(a.suggestions, "ask", "this stop only");
  assert.deepEqual(a.stages[0].answers, [
    { id: "1.1", question: "Which plan goes first?", answer: "Pro", by: "suggested" },
    { id: "1.2", question: "What tone should it take?", answer: "Plain", by: "suggested" },
  ]);
  assert.match(said.get("1.2")!, /<answers>\nQ: Which plan goes first\?\nA: Pro \(your suggestion, taken for the owner\)/);
  assert.equal(posts.find((p) => p.text.startsWith("Back on stage 1"))?.kind, "update");
  assert.equal(await assignmentWaiting(), 0);
});

test("the owner's own answers, and 'from here on': later questions are answered as suggested without stopping, but a plan still waits for Go", { skip }, async () => {
  const { startAssignment, readAssignment, answerStage, sweepAssignments, assignmentWaiting, STAGE_STOPS } = await import("./assignment-run");
  const { qRaw } = await import("./db");
  const { goPlan } = await import("./ask-plans");
  const { runPlanTool } = await import("./assistant");
  const { logChanges } = await import("./ask-activity");
  play = (c) => {
    if (c.stage === 1 && c.visit === 1 && c.step === 1) return [use("ask_owner", { questions: [Q] })];
    // Stage 2 keeps asking: taken as suggested each time, until it has had its stops.
    if (c.stage === 2 && c.step === 1 && c.visit <= STAGE_STOPS + 1) return [use("ask_owner", { questions: [{ ...Q, question: `Question on visit ${c.visit}?` }] })];
    if (c.stage === 2 && c.step === 2 && c.visit === STAGE_STOPS + 1) return [use("hand_off", { did: "Went on with my best judgement", open: "Assumed Pro", next: "" })];
    // Stage 3 queues a change outside its allowlist, then hands off.
    if (c.stage === 3 && c.step === 1) return [use("add_todo", { title: "Publish the pricing page", kind: "todo", step: "Add a to-do to publish it" }), use("hand_off", { did: "Checked it", open: "", next: "", work: `${c.work}\n## Reviewed` })];
    return null;
  };
  const todoCount = async () => (await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM commitments`))[0].n;
  const before = await todoCount();
  const a0 = await startAssignment(lineup());
  await drain();
  await answerStage(a0.id, [{ id: "1.1", answer: "Enterprise" }]);
  let a = (await readAssignment(a0.id))!;
  // (allowOther is true by default, so the owner's own words are taken.)
  assert.deepEqual(a.stages[0].answers.map((x) => [x.answer, x.by]), [["Enterprise", "owner"]]);
  await answerStage(a0.id, { use: "suggested", from_here: true });
  await drain();
  a = (await readAssignment(a0.id))!;
  assert.equal(a.suggestions, "take");
  assert.match(said.get("1.2")!, /A: Enterprise \(the owner\)/);
  // Stage 2 asked twice, never stopped, and on its third visit was told to go on.
  assert.deepEqual(a.stages[1].answers.map((x) => [x.id, x.by]), [["1.1", "suggested"], ["2.1", "suggested"]]);
  assert.equal(posts.filter((p) => p.text === "I went with my own suggestion, as you asked.").length, 2);
  assert.match(said.get(`2.${STAGE_STOPS + 1}`)!, /You've asked your questions: go on with your best judgement/);
  assert.equal(posts.filter((p) => p.kind === "question").length, 1, "only the first question stopped for the owner");
  // Taking suggestions never gives Go for a change: stage 3's to-do waits as a plan.
  assert.equal(a.status, "waiting");
  assert.deepEqual([a.stages[2].status, a.stages[2].waits_for, a.stages[2].waiting], ["waiting", "go", 1]);
  assert.equal(a.stages[2].handoff?.did, "Checked it", "its handoff is kept while the plan waits");
  const plan = posts.at(-1)!;
  assert.deepEqual([plan.kind, plan.waits_for, plan.run_id], ["plan", "go", a.stages[2].run_id]);
  assert.equal(await assignmentWaiting(), 1);
  assert.equal(await todoCount(), before, "nothing was made");
  assert.deepEqual(await sweepAssignments(), { moved: 0, failed: 0 }, "a plan that hasn't had its Go stays put");

  // Go on the plan (the existing route), then the sweep that follows it: the work moves on.
  const [{ id: planId }] = await qRaw<{ id: string }>(`SELECT id FROM ask_plans WHERE thread_id = $1::uuid`, [a.stages[2].thread_id]);
  await goPlan(planId, undefined, { run: (tool, input) => runPlanTool(tool, input, {}), log: logChanges });
  assert.deepEqual(await sweepAssignments(), { moved: 1, failed: 0 });
  a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "done");
  assert.equal(a.stages[2].waiting, 0);
  assert.equal(kinds().at(-1), "done");
  assert.equal(await todoCount(), before + 1);
});

test("approve: a stage with a checkpoint stops, Go carries on; a stage that fails can be tried again", { skip }, async () => {
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const { AthenaInputError } = await import("./db");
  const call = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://x/api${path}`);
    try {
      const res = await handleTeamRoutes(new Request(u, { method }), u, u.pathname.split("/").filter(Boolean).slice(1), async () => (body ?? null) as Record<string, unknown> | null, (d, s = 200) => Response.json(d, { status: s }));
      return res ? { status: res.status, body: (await res.json()) as Record<string, any> } : { status: 0, body: {} };
    } catch (error) {
      if (error instanceof AthenaInputError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  };
  // The lineup route proposes and keeps nothing.
  const proposed = await call("POST", "/team/assignments/lineup", { text: "Rewrite the pricing page" });
  assert.equal(proposed.status, 200);
  assert.deepEqual(proposed.body.lineup.stages.map((s: { role: string }) => s.role), ["engineer", "editor", "reviewer"]);
  assert.equal((await call("POST", "/team/assignments/lineup", { text: " " })).status, 400);
  assert.equal((await call("GET", "/team/assignments")).body.assignments.length, 0);

  let boom = true;
  play = (c) => {
    if (c.stage === 2 && c.step === 1 && boom) throw new Error("the model fell over");
    return null;
  };
  const made = await call("POST", "/team/assignments", { ...proposed.body.lineup, stages: proposed.body.lineup.stages.map((s: object, i: number) => ({ ...s, checkpoint: i === 0 ? "approve" : "auto" })) });
  assert.equal(made.status, 201);
  const id = made.body.id as string;
  // A stage that hasn't run can have its checkpoint set; one that has can't.
  assert.equal((await call("PATCH", `/team/assignments/${id}/stages/3`, { checkpoint: "approve" })).body.stages[2].checkpoint, "approve");
  assert.equal((await call("PATCH", `/team/assignments/${id}/stages/1`, { checkpoint: "auto" })).status, 400);
  assert.equal((await call("PATCH", `/team/assignments/${id}/stages/9`, { checkpoint: "auto" })).status, 404);
  assert.equal((await call("PATCH", `/team/assignments/${id}`, { checkpoint: "nope" })).status, 400);
  await drain();

  let a = (await call("GET", `/team/assignments/${id}`)).body;
  assert.equal(a.status, "waiting");
  assert.deepEqual([a.stages[0].status, a.stages[0].waits_for, a.stages[1].status], ["waiting", "approval", "pending"]);
  assert.equal(a.stages[0].handoff.did, "Did stage 1");
  assert.deepEqual(kinds().slice(-2), ["handoff", "approval"]);
  assert.deepEqual([posts.at(-1)!.waits_for, posts.at(-1)!.text], ["approval", "Stage 1 of 3 is done. Have a look, then tap Go to carry on, or send it back."]);
  assert.equal((await call("POST", `/team/assignments/${id}/answer`, { use: "suggested" })).status, 400, "nothing waits for an answer");
  assert.equal((await call("POST", `/team/assignments/${id}/answer`, {})).status, 400);

  assert.equal((await call("POST", `/team/assignments/${id}/go`)).body.stages[0].status, "done");
  await drain();
  a = (await call("GET", `/team/assignments/${id}`)).body;
  assert.equal(a.status, "failed", "stage 2's turn failed");
  assert.deepEqual(a.stages.map((s: { status: string }) => s.status), ["done", "failed", "pending"]);
  assert.deepEqual([posts.at(-1)!.kind, posts.at(-1)!.text], ["failed", "Stage 2 didn't finish. Tap Go to try it again."]);

  boom = false;
  assert.equal((await call("POST", `/team/assignments/${id}/go`)).body.status, "running");
  await drain();
  a = (await call("GET", `/team/assignments/${id}`)).body;
  assert.deepEqual([a.status, a.stages[2].waits_for], ["waiting", "approval"], "stage 3 was set to stop for approval");
  assert.equal((await call("POST", `/team/assignments/${id}/go`)).body.status, "done");
  assert.equal((await call("POST", `/team/assignments/${id}/go`)).status, 400, "nothing more waits");

  assert.equal((await call("POST", `/team/assignments/${id}/nope`)).status, 0);
  assert.equal((await call("GET", `/team/assignments/${id}/go`)).status, 405);
  assert.equal((await call("GET", `/team/assignments/${randomUUID()}`)).status, 404);
  assert.deepEqual((await call("DELETE", `/team/assignments/${id}`)).body, { ok: true });
  assert.equal((await call("DELETE", `/team/assignments/${id}`)).status, 404);
  const { qRaw } = await import("./db");
  const [{ n }] = await qRaw<{ n: number }>(`SELECT (SELECT count(*) FROM team_assistants)::int + (SELECT count(*) FROM team_stages)::int AS n`);
  assert.equal(n, 0, "its guests and stages go with it");
});

test("send-back: a reviewing stage sends the work back to one earlier stage, once; after that it comes to the owner", { skip }, async () => {
  const { startAssignment, readAssignment, sendBack, approveStage } = await import("./assignment-run");
  let second = "";
  play = (c) => {
    if (c.stage !== 3 || c.step > 2) return null;
    if (c.visit === 1 && c.step === 1) return [use("hand_off", { did: "Read it against the brief", open: "The table lists Free first. Put Pro first.", next: "", send_back_to: 1 })];
    if (c.visit === 2 && c.step === 1) return [use("hand_off", { did: "Read it again", open: "Still not right", next: "", send_back_to: 1 })];
    if (c.visit === 2 && c.step === 2) {
      second = c.results[0]?.content ?? "";
      return [use("hand_off", { did: "Read it again", open: "Still not right: over to you", next: "" })];
    }
    return null;
  };
  const a0 = await startAssignment(lineup({}, LINEUP.stages.map((s, i) => ({ ...s, checkpoint: i === 2 ? "approve" : "auto" }))));
  await drain();
  const a = (await readAssignment(a0.id))!;
  assert.equal(a.sent_back, true);
  assert.equal(a.stages[0].sent_back_from, 3);
  assert.equal(a.stages[0].note, "The table lists Free first. Put Pro first.");
  assert.match(said.get("1.2")!, /<sent_back by="Reviewer">\nThe table lists Free first\. Put Pro first\./);
  assert.ok(said.has("2.2"), "the stages between run again");
  assert.match(said.get("3.1")!, /send_back_to/);
  assert.doesNotMatch(said.get("3.2")!, /send_back_to/, "the one send-back is used");
  assert.match(second, /had its one send-back/);
  assert.equal(posts.filter((p) => p.text.startsWith("Sent back to stage 1 (Engineer): The table lists Free first.")).length, 1);
  // After that it comes to the owner: stage 3 waits at its checkpoint. The one send-back limits stages only, so the owner still can (17 Nov 2026).
  assert.deepEqual([a.status, a.stages[2].waits_for, a.stages[2].handoff?.open], ["waiting", "approval", "Still not right: over to you"]);
  await sendBack(a.id, 3, "Once more, with the table fixed");
  await drain();
  const b = (await readAssignment(a.id))!;
  assert.deepEqual([b.status, b.stages[2].waits_for, b.stages[2].note, b.sent_back], ["waiting", "approval", "Once more, with the table fixed", true]);
  await approveStage(a.id);
  assert.equal((await readAssignment(a.id))!.status, "done");
});

test("send-back by the owner at an approval, with a note; a stopped assignment runs nothing more", { skip }, async () => {
  const { startAssignment, readAssignment, sendBack, stopAssignment, goAssignment } = await import("./assignment-run");
  const a0 = await startAssignment(lineup({}, LINEUP.stages.map((s, i) => ({ ...s, checkpoint: i === 1 ? "approve" : "auto" }))));
  await drain();
  await assert.rejects(sendBack(a0.id, 3, "x"), /this stage's number or an earlier one's/);
  await sendBack(a0.id, 1, "Shorter, please");
  let a = (await readAssignment(a0.id))!;
  // The owner's send-back doesn't use up the stages' one.
  assert.deepEqual([a.sent_back, a.status, a.stages[0].status, a.stages[0].note, a.stages[1].status], [false, "running", "running", "Shorter, please", "pending"]);
  assert.equal(a.stages[0].handoff, null);
  await drain();
  a = (await readAssignment(a0.id))!;
  assert.deepEqual([a.status, a.stages[1].waits_for], ["waiting", "approval"]);
  const stopped = await stopAssignment(a.id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.stages.map((s) => s.status), ["done", "skipped", "skipped"]);
  await assert.rejects(goAssignment(a.id), /Nothing is waiting/);
  assert.equal(queue.length, 0);
});

test("changing a suggestion that was taken re-runs from that stage, and later stages' work is replaced", { skip }, async () => {
  const { startAssignment, readAssignment, changeAnswers } = await import("./assignment-run");
  const { getNote } = await import("./db");
  play = (c) => {
    if (c.stage === 2 && c.step === 1 && !/<answers>/.test(c.said)) return [use("ask_owner", { questions: [Q] })];
    if (c.stage === 2 && c.step === 1) return [use("hand_off", { did: "Edited", open: "", next: "", work: `${c.work}\n## ${c.said.match(/A: (\w+)/)![1]} first` })];
    return null;
  };
  const a0 = await startAssignment(lineup({ suggestions: "take" }));
  await drain();
  let a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "done");
  assert.equal((await getNote(a.note_id!))!.body, "## Stage 1\n## Pro first\n## Stage 3");
  assert.deepEqual(a.stages[1].answers.map((x) => [x.answer, x.by]), [["Pro", "suggested"]], "Suggested, taken for you");
  await assert.rejects(changeAnswers(a.id, 2, [{ id: "9.9", answer: "Free" }]), /no answer with that id/);

  await changeAnswers(a.id, 2, [{ id: "1.1", answer: "Free" }]);
  a = (await readAssignment(a0.id))!;
  assert.deepEqual([a.status, a.stages[0].status, a.stages[1].status, a.stages[2].status], ["running", "done", "running", "pending"]);
  assert.equal(a.stages[2].handoff, null);
  assert.equal((await getNote(a.note_id!))!.body, "## Stage 1", "the note is back to how that stage found it");
  await assert.rejects(changeAnswers(a.id, 2, [{ id: "1.1", answer: "Pro" }]), /A stage is working/);
  await drain();
  a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "done");
  assert.deepEqual(a.stages[1].answers.map((x) => [x.answer, x.by]), [["Free", "owner"]]);
  assert.equal((await getNote(a.note_id!))!.body, "## Stage 1\n## Free first\n## Stage 3");
});

test("guests and keeping one: off the team's lists and the 12, no triggers; kept, the same row is a standing assistant with its memory written once; 409 when full", { skip }, async () => {
  const { startAssignment, readAssignment, keepOnTeam } = await import("./assignment-run");
  const { createAssistant, listAssistants, getAssistant, updateAssistant, createTrigger } = await import("./team");
  const { loadTeamDesk } = await import("./team-chat");
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const { queueTeamRuns } = await import("./team-triggers");
  const { MAX_ASSISTANTS } = await import("./team-types");
  const { qRaw } = await import("./db");

  // A standing assistant can take a stage, beside guests.
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices for gift ideas" });
  const a0 = await startAssignment(lineup({}, [{ role: "engineer", task: "Write the spec" }, { role: "reviewer", assistant_id: moss.id, task: "Check the prices in it" }]));
  await drain();
  const a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "done");
  assert.deepEqual(a.stages.map((s) => [s.who.guest, s.who.role]), [[true, "engineer"], [false, null]]);
  assert.equal(memories, 1, "a standing assistant remembers its stage as after any run; a guest doesn't");
  const guest = a.stages[0].who;

  // Not on /api/team's list, the 12, check_with_assistant or triggers.
  assert.deepEqual((await listAssistants()).map((x) => x.id), [moss.id]);
  assert.deepEqual((await loadTeamDesk()).prompt().match(/- \w+:/g), ["- Moss:"]);
  await assert.rejects(updateAssistant(guest.id, { triggers: [{ kind: "schedule", days: [1], time: "09:00" }] }), /Keep it on the team/);
  await assert.rejects(createTrigger(guest.id, { kind: "schedule", days: [1], time: "09:00" }), /Keep it on the team/);
  assert.deepEqual(await queueTeamRuns(new Date(), "Europe/London"), []);
  for (let i = 1; i < MAX_ASSISTANTS; i++) await createAssistant({ job: `Job ${i}` });
  assert.equal((await listAssistants()).length, MAX_ASSISTANTS, "guests don't count toward the 12");

  // Full: refused with the line the app shows, and nothing changes.
  const u = new URL(`https://x/api/team/${guest.id}/keep`);
  const keep = () => handleTeamRoutes(new Request(u, { method: "POST" }), u, ["team", guest.id, "keep"], async () => null, (d, s = 200) => Response.json(d, { status: s }));
  const full = (await keep())!;
  assert.equal(full.status, 409);
  assert.deepEqual(await full.json(), { error: `Your team is full. Remove an assistant to keep ${guest.name}.` });
  assert.equal(memories, 1);

  await qRaw(`DELETE FROM team_assistants WHERE id = (SELECT id FROM team_assistants WHERE assignment_id IS NULL AND id <> $1::uuid LIMIT 1)`, [moss.id]);
  const kept = (await keep())!;
  assert.equal(kept.status, 200);
  const body = (await kept.json()) as { assistant: { id: string; memory: { summary: string }; triggers: unknown[]; allow: string[] } };
  assert.equal(body.assistant.id, guest.id, "the same row");
  assert.equal(body.assistant.memory.summary, "Wrote the pricing spec.");
  assert.deepEqual([body.assistant.triggers, body.assistant.allow], [[], []], "no triggers, the allowlist it had");
  assert.equal(memories, 2, "written once");
  assert.ok((await listAssistants()).some((x) => x.id === guest.id));
  await keepOnTeam(guest.id);
  assert.equal(memories, 2, "keeping it again writes nothing");
  // A kept guest stays on its assignment's trail, and can have triggers now.
  const after = (await readAssignment(a.id))!;
  assert.deepEqual([after.stages[0].who.id, after.stages[0].who.guest, after.stages[0].who.role], [guest.id, false, "engineer"]);
  assert.ok((await updateAssistant(guest.id, { triggers: [{ kind: "schedule", days: [1], time: "09:00" }] })).triggers.length === 1);
  // Its runs and conversation came with it.
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_runs WHERE assistant_id = $1::uuid`, [guest.id]);
  assert.equal(n, 1);
  assert.ok(await getAssistant(guest.id));
});

test("limits: 3 assignments at once, 2 to 6 stages, 3 questions a stop, a handoff of 2,000 characters", { skip }, async () => {
  const { startAssignment, readAssignment, readAssignments } = await import("./assignment-run");
  const { ASSIGNMENT_LIMITS: L } = await import("./assignment-types");
  let tooMany = "";
  play = (c) => {
    if (c.stage !== 1) return null;
    if (c.step === 1) return [use("ask_owner", { questions: [Q, Q, Q, Q] })];
    if (c.step === 2) {
      tooMany = c.results[0]?.content ?? "";
      return [use("hand_off", { did: "d".repeat(5000), open: "o".repeat(5000), next: "n".repeat(5000), work: "# Spec" })];
    }
    return null;
  };
  await assert.rejects(startAssignment(lineup({}, [LINEUP.stages[0]])), /at least 2 stages/);
  await assert.rejects(startAssignment(lineup({}, Array.from({ length: 7 }, () => LINEUP.stages[1]))), /6 stages at most/);
  await assert.rejects(startAssignment(lineup({ brief: "b".repeat(L.brief + 1) })), /under 4,000/);
  const two = lineup({}, LINEUP.stages.slice(0, 2));
  const first = await startAssignment(two);
  await startAssignment({ ...two, title: "Second" });
  await startAssignment({ ...two, title: "Third" });
  await assert.rejects(startAssignment({ ...two, title: "Fourth" }), /You have 3 assignments going, which is the most at once/);
  assert.equal((await readAssignments()).length, 3, "the fourth isn't kept");
  await drain();
  assert.match(tooMany, /3 questions at most/);
  const a = (await readAssignment(first.id))!;
  assert.equal(a.status, "done");
  const h = a.stages[0].handoff!;
  assert.ok(h.did.length + h.open.length + h.next.length <= L.handoff, "a handoff is cut to 2,000 characters");
  assert.ok(h.did.length > 0 && h.open.length > 0 && h.next.length > 0);
  // Done, they no longer count.
  assert.equal((await startAssignment({ ...two, title: "Fourth" })).status, "running");
});

test("held: a stage that read other people's words holds every stage after it", { skip }, async () => {
  const { startAssignment, readAssignment } = await import("./assignment-run");
  const { runTeamRun } = await import("./team-run");
  const { currentStage } = await import("./assignment-tools");
  const a0 = await startAssignment(lineup());
  const opts: Array<{ others?: boolean; flagged?: boolean; noMemory?: boolean }> = [];
  // A turn in lib/team-chat.ts's shape: stage 1 cites a web page; a flagged stage's work isn't written.
  for (let i = 0; queue.length && i < 5; i++) {
    await runTeamRun(queue.shift()!, {
      turn: async (assistant_id, _prompt, o) => {
        opts.push({ others: o.others, flagged: o.flagged, noMemory: o.noMemory });
        const desk = currentStage()!;
        desk.handoff = { did: `Did stage ${desk.position}`, open: "", next: "" };
        desk.work = `Work of stage ${desk.position}`;
        const web = desk.position === 1 ? [{ n: 1, kind: "web", id: null, url: "https://shop.test/pricing", title: "Pricing", date: null, account: null }] : [];
        return { assistant_id, thread_id: o.threadId ?? null, text: "Done.", reply: { text: "Done.", sources: web, related: [], searched: "", skipped: [], found: true, flagged: desk.position === 3 } as never };
      },
    });
  }
  assert.deepEqual(opts, [
    { others: undefined, flagged: undefined, noMemory: true },
    { others: true, flagged: false, noMemory: true },
    { others: true, flagged: false, noMemory: true },
  ]);
  const a = (await readAssignment(a0.id))!;
  assert.equal(a.status, "done");
  assert.ok(!("held" in a.stages[0]) && !("back" in a.stages[0]), "the runner's own marks aren't sent to the app");
  const { getNote } = await import("./db");
  assert.equal((await getNote(a.note_id!))!.body, "Work of stage 2", "a flagged turn changes nothing: its work isn't written");
});

test("Go on a stage that didn't finish settles that stage's failed post; an ordinary run's still waits to be dismissed", { skip }, async () => {
  const { configureAssignments, startAssignment, goAssignment, readAssignment, sweepAssignments } = await import("./assignment-run");
  const { postToTeam, settlePosts, listChat, countWaiting } = await import("./team-posts");
  const { qRaw } = await import("./db");
  // Team chat itself, as netlify/lib/assignment-wiring.ts wires it.
  configureAssignments({ post: (input) => postToTeam(input).then(() => undefined), settled: (ref) => settlePosts(ref).then(() => undefined) });
  const a0 = await startAssignment(lineup());
  const runId = queue.shift()!;
  await qRaw(`UPDATE team_runs SET status = 'failed', error = 'It stopped part-way.', finished_at = now() WHERE id = $1::uuid`, [runId]);
  assert.deepEqual(await sweepAssignments(), { moved: 0, failed: 1 });
  const stage = (await readAssignment(a0.id))!.stages[0];
  const ordinary = await postToTeam({ kind: "failed", text: "Moss didn't finish.", assistant_id: stage.who!.id, waits_for: "dismiss" });
  let waiting = (await listChat()).waiting;
  assert.deepEqual(waiting.map((p) => [p.kind, p.stage_id, p.waits_for]), [["failed", stage.id, "dismiss"], ["failed", null, "dismiss"]]);
  const stagePost = waiting[0].id;

  assert.equal((await goAssignment(a0.id)).status, "running");
  waiting = (await listChat()).waiting;
  assert.deepEqual(waiting.map((p) => p.id), [ordinary.id], "the stage's post left the strip; the ordinary run's still needs Dismiss");
  assert.equal(await countWaiting(), 1);
  assert.ok((await listChat()).posts.find((p) => p.id === stagePost)?.settled_at, "settled, still in the channel");
  assert.equal(queue.length, 1, "the stage runs again");
});

test("a stop's push: held in quiet hours, sent once, opens Team chat at the post, and leaves no card on Home", { skip }, async () => {
  const { configureAssignments, startAssignment, sweepAssignments } = await import("./assignment-run");
  const { postToTeam, settlePosts, listChat } = await import("./team-posts");
  const { deliverStopPushes } = await import("./assignment-push");
  const { listLiveNudges } = await import("./proactive/store");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE nudges`);
  configureAssignments({ post: (input) => postToTeam(input).then(() => undefined), settled: (ref) => settlePosts(ref).then(() => undefined) });
  await startAssignment(lineup());
  await qRaw(`UPDATE team_runs SET status = 'failed', error = 'It stopped part-way.', finished_at = now() WHERE id = $1::uuid`, [queue.shift()!]);
  await sweepAssignments();
  const [failed] = (await listChat()).waiting;
  // Noon today in UTC: within the post's 20 hours whenever this runs, and outside the night.
  const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const sent: Array<{ title: string; body: string; url?: string }> = [];
  const deps = (quiet: { from: string; to: string } | null, canPush = true) => ({ canPush, quiet, send: async (m: { title: string; body: string; url?: string }) => void sent.push(m) });

  assert.deepEqual(await deliverStopPushes(noon, "UTC", deps(null, false)), { sent: 0, held: 0 }, "no push set up");
  assert.deepEqual(await deliverStopPushes(noon, "UTC", deps({ from: "11:00", to: "13:00" })), { sent: 0, held: 1 });
  assert.equal(sent.length, 0);
  assert.deepEqual(await deliverStopPushes(noon, "UTC", deps(null)), { sent: 1, held: 0 });
  assert.deepEqual(sent, [{ title: `From ${failed.who!.name}`, body: "I didn't finish my stage of “Pricing page”. Tap Go to try it again.", url: `/#/team/chat/${failed.id}`, tag: `nudge:team:post:${failed.id}` }]);
  assert.deepEqual(await deliverStopPushes(noon, "UTC", deps(null)), { sent: 0, held: 0 }, "one per stop");
  assert.deepEqual(await listLiveNudges(noon), [], "no card of its own");
});

test("the sweep: a stage whose run died is failed, and an assignment nothing is working on is started again", { skip }, async () => {
  const { startAssignment, readAssignment, sweepAssignments } = await import("./assignment-run");
  const { qRaw } = await import("./db");
  const a0 = await startAssignment(lineup());
  const runId = queue.shift()!;
  assert.deepEqual(await sweepAssignments(), { moved: 0, failed: 0 }, "a queued run is left alone");
  await qRaw(`UPDATE team_runs SET status = 'failed', error = 'It stopped part-way.', finished_at = now() WHERE id = $1::uuid`, [runId]);
  assert.deepEqual(await sweepAssignments(), { moved: 0, failed: 1 });
  const a = (await readAssignment(a0.id))!;
  assert.deepEqual([a.status, a.stages[0].status], ["failed", "failed"]);
  assert.equal(posts.at(-1)!.kind, "failed");
  // A hand-on that was lost between two stages.
  await qRaw(`UPDATE team_stages SET status = 'done' WHERE id = $1::uuid`, [a.stages[0].id]);
  await qRaw(`UPDATE team_assignments SET status = 'running' WHERE id = $1::uuid`, [a.id]);
  assert.deepEqual(await sweepAssignments(), { moved: 1, failed: 0 });
  assert.equal((await readAssignment(a0.id))!.stages[1].status, "running");
  assert.equal(queue.length, 1);
});

test("Ask's tools: start_assignment keeps a lineup as a draft for Go and starts nothing; continue_assignment takes suggestions and approves, never a lineup or a plan", { skip }, async () => {
  const { runAsk } = await import("./answer");
  const { readAssignments, readAssignment, goAssignment, continueAssignment, startAssignment } = await import("./assignment-run");
  const none = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
  let result = "";
  let tools: string[] = [];
  const ask = {
    messages: {
      create: async (p: Params) => {
        if (p.tool_choice?.name === "assignment_lineup") return (client as { messages: { create: (p: Params) => Promise<unknown> } }).messages.create(p);
        const n = (p.messages.length + 1) / 2;
        tools = (p.tools ?? []).map((t) => t.name);
        const last = p.messages.at(-1)!.content;
        if (n === 2 && Array.isArray(last)) result = (last as Array<{ type: string; content?: string }>).find((b) => b.type === "tool_result")?.content ?? "";
        const content = n === 1 ? [use("start_assignment", { brief: "Rewrite the pricing page so Pro comes first." })] : [answer("Engineer, Editor and Reviewer are lined up. It waits for your Go.")];
        return { id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason: n === 1 ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as never;
  const reply = await runAsk("Get the pricing page rewritten: an engineer, an editor, then a reviewer.", { sources: none, client: ask, web: async () => false }, { log: false });
  assert.ok(tools.includes("start_assignment") && tools.includes("continue_assignment") && !tools.includes("hand_off"), "main Ask's tools");
  assert.match(reply.text, /waits for your Go/);
  assert.equal(reply.plan, undefined, "never a plan step");
  const told = JSON.parse(result) as { assignment_id: string; lineup: string; note: string };
  assert.equal(told.lineup, "Engineer → Editor → Reviewer");
  assert.match(told.note, /Nothing has started/);
  const [draft] = await readAssignments();
  assert.equal(draft.id, told.assignment_id);
  assert.deepEqual([draft.status, draft.note_id, draft.stages.length], ["draft", null, 3]);
  assert.deepEqual(kinds(), ["lineup"]);
  assert.equal(queue.length, 0, "nothing runs before Go");
  assert.deepEqual(await continueAssignment(null), { not_done: "No assignment is waiting." });
  assert.match(JSON.stringify(await continueAssignment(draft.id)), /hasn't started: its lineup waits for the owner's own Go/);

  // The owner reorders the draft and taps Go: the same assignment, its lineup replaced, no second lineup post.
  const edited = await startAssignment(lineup({}, [{ role: "reviewer", task: "Check it", checkpoint: "approve" }, { role: "editor", task: "Tidy it" }]), { id: draft.id });
  assert.equal(edited.id, draft.id);
  assert.deepEqual(edited.stages.map((s) => s.who.role), ["reviewer", "editor"]);
  assert.equal(kinds().filter((k) => k === "lineup").length, 1);
  await drain();
  assert.match(JSON.stringify(await continueAssignment(null)), /Stage 1 of “Pricing page” is approved/);
  await drain();
  assert.equal((await readAssignment(draft.id))!.status, "done");
  assert.match(JSON.stringify(await continueAssignment(draft.id, { useSuggestions: true })), /takes its suggestions from here on/);
  assert.equal((await readAssignment(draft.id))!.suggestions, "take");
  await assert.rejects(goAssignment(draft.id), /Nothing is waiting/);
});

after(async () => {
  if (!url) return;
  const { resetAssignmentDeps } = await import("./assignment-run");
  resetAssignmentDeps();
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_posts, team_stages, team_runs, team_events, team_assistants, team_assignments CASCADE`);
});
