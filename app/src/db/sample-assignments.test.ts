import { test } from "node:test";
import assert from "node:assert/strict";
import { askedPosts, makeSampleAssignments, SAMPLE_ASKED_THREAD, SAMPLE_ASSIGNMENT_IDS, sampleChat, STAGE_MS, standingPosts } from "./sample-assignments";
import { waitingPosts } from "../team/assign-words";
import type { TeamRun } from "../../../lib/team-types";
import type { StageWho } from "../../../lib/assignment-types";

const T0 = Date.UTC(2026, 10, 17, 12);
const { pricing, launch, offsite } = SAMPLE_ASSIGNMENT_IDS;
const waiting = (s: ReturnType<typeof makeSampleAssignments>, now: number) => sampleChat(s.posts(now), []).waiting;

test("the sample starts with one finished with a document, one waiting on a question, one waiting for Go", () => {
  const s = makeSampleAssignments(T0);
  const done = s.get(pricing, T0)!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.documents.map((d) => d.format), ["md", "docx"]);
  assert.equal(done.stages[0].answers[0].by, "suggested");
  const q = s.get(launch, T0)!;
  assert.deepEqual([q.status, q.stages[1].status, q.stages[1].waits_for, q.stages[1].questions.length], ["waiting", "waiting", "answer", 2]);
  const go = s.get(offsite, T0)!;
  assert.deepEqual([go.status, go.stages[1].waits_for, go.stages[1].checkpoint], ["waiting", "approval", "approve"]);
  // Every stage is a guest drawn from a seed, and every question has a suggestion.
  for (const a of s.list(T0)) for (const st of a.stages) {
    assert.equal(st.who.guest, true);
    assert.equal(st.who.avatar.v, 1);
    for (const x of st.questions) assert.ok(x.choices[x.suggested] && x.why);
  }
});

test("the chat reads the same set: each thread starts with its lineup, and what waits is oldest first", () => {
  const s = makeSampleAssignments(T0);
  const chat = sampleChat(s.posts(T0), []);
  for (const id of [pricing, launch, offsite]) assert.equal(chat.posts.filter((p) => p.assignment_id === id)[0].kind, "lineup");
  assert.deepEqual(chat.waiting.map((p) => [p.assignment_id, p.kind]), [[offsite, "approval"], [launch, "question"]]);
  // One per post that waits: the two questions on the launch post count once.
  assert.equal(waitingPosts(chat).length, 2);
  assert.equal(chat.posts.find((p) => p.kind === "done")!.documents!.length, 2);
  // Pages: the newest first, then older ones from `before`.
  const page = sampleChat(s.posts(T0), [], null, 4);
  assert.equal(page.posts.length, 4);
  const older = sampleChat(s.posts(T0), [], page.before, 4);
  assert.ok(older.posts.every((p) => Date.parse(p.created_at) <= Date.parse(page.posts[0].created_at)));
});

test("answering settles the question everywhere, and the stages run on to a document", () => {
  const s = makeSampleAssignments(T0);
  const qs = s.get(launch, T0)!.stages[1].questions;
  const a = s.answer(launch, [{ id: qs[0].id, question: qs[0].question, answer: "second brain offline", by: "owner" }, { id: qs[1].id, question: qs[1].question, answer: qs[1].choices[1], by: "owner" }], T0 + 1000);
  assert.deepEqual([a.status, a.stages[1].status, a.stages[1].waits_for], ["running", "running", null]);
  assert.deepEqual(waiting(s, T0 + 1000).map((p) => p.assignment_id), [offsite]);
  const settled = s.posts(T0 + 1000).find((p) => p.assignment_id === launch && p.kind === "question")!;
  assert.ok(settled.settled_at);
  assert.equal(settled.answers?.[0].answer, "second brain offline");
  // Piper hands off, Rook starts, then finishes: the last stage's result comes with its document.
  const mid = s.get(launch, T0 + 1000 + STAGE_MS + 10)!;
  assert.deepEqual(mid.stages.map((x) => x.status), ["done", "done", "running"]);
  assert.ok(mid.stages[1].handoff?.did);
  const end = s.get(launch, T0 + 1000 + 2 * STAGE_MS + 10)!;
  assert.equal(end.status, "done");
  assert.equal(end.documents.length, 2);
  assert.equal(s.posts(T0 + 60_000).filter((p) => p.assignment_id === launch).at(-1)!.kind, "done");
});

test("Use suggestions, this stop and from here on", () => {
  const once = makeSampleAssignments(T0).answer(launch, { use: "suggested" }, T0);
  assert.equal(once.suggestions, "ask");
  assert.deepEqual(once.stages[1].answers.map((x) => [x.answer, x.by]), [["offline notes app", "suggested"], ["No, leave it for the docs", "suggested"]]);
  assert.equal(makeSampleAssignments(T0).answer(launch, { use: "suggested", from_here: true }, T0).suggestions, "take");
  assert.throws(() => makeSampleAssignments(T0).answer(pricing, { use: "suggested" }, T0), /Nothing is waiting/);
});

test("Go on an approval starts the next stage; Send back returns it once, with the note", () => {
  const s = makeSampleAssignments(T0);
  const gone = s.go(offsite, T0);
  assert.deepEqual(gone.stages.map((x) => x.status), ["done", "done", "running"]);
  assert.deepEqual(waiting(s, T0).map((p) => p.assignment_id), [launch]);
  assert.throws(() => s.go(offsite, T0), /Nothing is waiting for your approval/);

  const b = makeSampleAssignments(T0);
  const back = b.sendBack(offsite, { to: 0, note: "Add the coach hire" }, T0);
  assert.deepEqual(back.stages.map((x) => x.status), ["running", "pending", "pending"]);
  assert.deepEqual([back.sent_back, back.stages[0].note, back.stages[0].sent_back_from], [false, "Add the coach hire", 1]);
  // It comes round to the approval again, and can be sent back again: the one send-back limits stages, not the owner.
  const again = b.get(offsite, T0 + 2 * STAGE_MS + 10)!;
  assert.deepEqual([again.status, again.stages[1].waits_for], ["waiting", "approval"]);
  assert.doesNotThrow(() => b.sendBack(offsite, { to: 0, note: "" }, T0 + 3 * STAGE_MS));
});

test("a new assignment: the lineup, three at once at most, a question with a suggestion, an approval, a document", () => {
  const s = makeSampleAssignments(T0);
  const { lineup } = s.draft("Work out the budget for the spring launch party. Keep it short.");
  assert.deepEqual(lineup.stages.map((x) => x.role), ["product-manager", "cfo", "reviewer"]);
  assert.equal(lineup.title, "Work out the budget for the spring");

  const made = s.start({ ...lineup, stages: lineup.stages.map((x, i) => ({ ...x, checkpoint: i === 1 ? "approve" as const : "auto" as const })) }, [], T0);
  assert.deepEqual(made.stages.map((x) => [x.who.name, x.who.guest, x.status]), [["Fern", true, "running"], ["Otto", true, "pending"], ["Rook", true, "pending"]]);
  // Two were already waiting: this is the third, and a fourth has to wait.
  assert.throws(() => s.start(lineup, [], T0), /Three assignments are already under way/);
  let t = T0 + 2 * STAGE_MS + 10;
  const asks = s.get(made.id, t)!;
  assert.deepEqual([asks.status, asks.stages[1].waits_for, asks.stages[1].questions.length], ["waiting", "answer", 1]);
  s.answer(made.id, { use: "suggested" }, t);
  t += STAGE_MS + 10;
  assert.deepEqual([s.get(made.id, t)!.status, s.get(made.id, t)!.stages[1].waits_for], ["waiting", "approval"]);
  s.go(made.id, t);
  const end = s.get(made.id, t + STAGE_MS + 10)!;
  assert.deepEqual([end.status, end.documents.length, end.stages[1].answers[0].by], ["done", 2, "suggested"]);

  // Taking suggestions from the start: the question never stops it.
  const b = makeSampleAssignments(T0);
  b.stop(offsite, T0);
  assert.equal(b.get(offsite, T0)!.status, "stopped");
  assert.deepEqual(waiting(b, T0).map((p) => p.assignment_id), [launch]);
  const quiet = b.start({ ...lineup, suggestions: "take" }, [], T0);
  const through = b.get(quiet.id, T0 + 3 * STAGE_MS + 10)!;
  assert.deepEqual([through.status, through.stages[1].answers[0].by], ["done", "suggested"]);
  assert.equal(b.posts(T0 + 60_000).some((p) => p.assignment_id === quiet.id && p.kind === "question"), false);
});

test("a stage's checkpoint changes only before it runs; a kept guest stops being one; removing takes its posts", () => {
  const s = makeSampleAssignments(T0);
  assert.equal(s.patchStage(launch, 2, { checkpoint: "approve" }).stages[2].checkpoint, "approve");
  assert.throws(() => s.patchStage(launch, 0, { checkpoint: "approve" }), /already run/);
  assert.equal(s.patch(launch, { suggestions: "take" }).suggestions, "take");
  const piper = s.get(launch, T0)!.stages[1].who;
  assert.equal(s.guestOf(piper.id)?.name, "Piper");
  assert.equal(s.kept(piper.id, "standing-1")?.guest, false);
  assert.deepEqual([s.get(launch, T0)!.stages[1].who.id, s.get(launch, T0)!.stages[1].who.guest], ["standing-1", false]);
  assert.equal(s.guestOf(piper.id), null);
  s.remove(launch);
  assert.equal(s.get(launch, T0), null);
  assert.equal(s.posts(T0).some((p) => p.assignment_id === launch), false);
});

test("typing in a thread answers the stage that waits, or leaves a note for Send back", () => {
  const s = makeSampleAssignments(T0);
  const note = s.say("Add the coach hire", offsite, [], T0);
  assert.deepEqual(note.map((p) => [p.kind, p.from]), [["said", "owner"], ["reply", "assistant"]]);
  assert.equal(s.get(offsite, T0)!.stages[1].note, "Add the coach hire");
  s.say("continue and use all suggested routes", launch, [], T0);
  const a = s.get(launch, T0)!;
  assert.deepEqual([a.suggestions, a.status, a.stages[1].answers.length], ["take", "running", 2]);
  // Outside a thread it goes to Ask, or to the assistant named.
  assert.equal(s.say("What's left this week?", null, [], T0)[1].from, "ask");
  const wren = { id: "w", name: "Wren", avatar: {} as StageWho["avatar"], job: "Writes Friday's summary" };
  assert.equal(s.say("@Wren what slipped?", null, [wren], T0)[1].who?.name, "Wren");
});

test("standing assistants post from their runs: a plan that waits, a run that didn't finish, and nothing for a quiet one", () => {
  const run = (p: Partial<TeamRun> & Pick<TeamRun, "id" | "assistant_id">): TeamRun => ({ trigger_id: null, event_id: null, status: "done", thread_id: `t-${p.id}`, summary: "Did a thing.", error: null, started_at: new Date(T0 - 60_000).toISOString(), finished_at: new Date(T0 - 30_000).toISOString(), ...p });
  const team = [{ id: "dot", name: "Dot", avatar: {} as StageWho["avatar"], job: "Turns issues into to-dos" }, { id: "wren", name: "Wren", avatar: {} as StageWho["avatar"], job: "Writes Friday's summary" }];
  const runs = [
    run({ id: "0000a1", assistant_id: "dot", summary: "Added 2 to-dos. One change waits for you to tap Approve.", waiting: 1 }),
    run({ id: "0000a2", assistant_id: "dot", summary: "Nothing to do this time.", started_at: new Date(T0 - 600_000).toISOString() }),
    run({ id: "0000a3", assistant_id: "wren", status: "failed", error: "Linear didn't answer", thread_id: null }),
  ];
  const posts = standingPosts(team, runs);
  assert.deepEqual(posts.map((p) => [p.who?.name, p.kind, p.waits_for, !!p.settled_at]).sort(), [["Dot", "plan", "go", false], ["Wren", "failed", "dismiss", false]]);
  assert.equal(posts.find((p) => p.kind === "plan")!.text, "Added 2 to-dos.");
  // A Go on this device settles the plan; a dismissal settles the failed run.
  const after = standingPosts(team, runs, () => 0, (id) => id === "0000a3");
  assert.ok(after.every((p) => p.settled_at));
  assert.equal(waitingPosts(sampleChat([], after)).length, 0);
  assert.deepEqual(waitingPosts(sampleChat([], posts)).map((p) => p.kind).sort(), ["failed", "plan"]);
  // An "@Name" reply that proposes a change waits for Go in its own conversation, until answered.
  const at = new Date(T0).toISOString();
  const asked = askedPosts(team[0], at, false);
  assert.deepEqual(asked.map((p) => [p.kind, p.from, p.thread_id, p.waits_for]), [["said", "owner", null, null], ["reply", "assistant", SAMPLE_ASKED_THREAD, "go"]]);
  assert.equal(waitingPosts(sampleChat(asked, posts)).length, 3);
  assert.equal(waitingPosts(sampleChat(askedPosts(team[0], at, true), posts)).length, 2);
});
