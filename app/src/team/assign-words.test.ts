import { test } from "node:test";
import assert from "node:assert/strict";
import { answerBy, applyPreset, assignmentLine, canRemove, guestLine, lineupProblem, lineupWho, moveStage, ownerAnswers, presetOf, removeStage, setCheckpoint, sizeWords, stageBadge, stageStep, suggestedAnswers, swapStage, teamFull, thingsWait, threadCount, threadsOf, waitingPosts, waitTitle, WAITS_WORD } from "./assign-words";
import type { Assignment, AssignmentStage, Lineup, StageQuestion, StageWho, TeamPost } from "../../../lib/assignment-types";

const who = (name: string, guest = true): StageWho => ({ id: name, name, avatar: {} as StageWho["avatar"], job: "Reads it", role: guest ? "seo" : null, guest });
const stage = (p: Partial<AssignmentStage> = {}): AssignmentStage => ({ id: "s", position: 0, who: who("Piper"), checkpoint: "auto", status: "pending", waits_for: null, run_id: null, thread_id: null, waiting: 0, step: null, note_version: null, sent_back_from: null, started_at: null, finished_at: null, task: "Write it", handoff: null, questions: [], answers: [], ...p });
const asg = (status: Assignment["status"], stages: AssignmentStage[]): Pick<Assignment, "status" | "stages"> => ({ status, stages });
const lineup = (n = 3): Lineup => ({ title: "T", brief: "B", checkpoint: "auto", suggestions: "ask", stages: (["engineer", "seo", "reviewer", "editor"] as const).slice(0, n).map((role) => ({ role, task: `${role} task`, checkpoint: "auto" as const })) });
const post = (p: Partial<TeamPost> & Pick<TeamPost, "id">): TeamPost => ({ kind: "update", who: who("Piper"), from: "assistant", text: "", assignment_id: null, assignment_title: null, stage_id: null, run_id: null, thread_id: null, waits_for: null, settled_at: null, created_at: new Date(2026, 10, 17, 9, p.id).toISOString(), ...p });

test("the waiting words: a question needs your answer, a change or a checkpoint needs your approval", () => {
  assert.equal(WAITS_WORD.answer, "Needs your answer");
  assert.equal(WAITS_WORD.go, "Needs your approval");
  assert.equal(WAITS_WORD.approval, "Needs your approval");
  assert.equal(stageBadge(stage({ status: "waiting", waits_for: "answer" })), "Needs your answer");
  assert.equal(stageBadge(stage({ status: "waiting", waits_for: "approval" })), "Needs your approval");
  assert.equal(stageBadge(stage({ status: "running" })), "Working");
  assert.equal(stageBadge(stage({ status: "failed" })), "Didn't finish");
  assert.equal(stageBadge(stage()), null);
  assert.equal(stageStep(stage({ step: " Reading the brief " })), "Reading the brief");
  assert.equal(stageStep(stage()), "Getting it done");
});

test("a guest says Guest under its name; a standing assistant says its job", () => {
  assert.equal(guestLine(who("Piper")), "Guest · SEO");
  assert.equal(guestLine({ guest: true, role: "custom", job: "x" }), "Guest");
  assert.equal(guestLine(who("Wren", false)), "Reads it");
});

test("an assignment's line names the stage it's on", () => {
  assert.equal(assignmentLine(asg("waiting", [stage({ status: "done" }), stage({ status: "waiting", waits_for: "answer" })])), "Piper needs your answer");
  assert.equal(assignmentLine(asg("waiting", [stage({ status: "waiting", waits_for: "approval" })])), "Piper needs your approval");
  assert.equal(assignmentLine(asg("running", [stage({ status: "running" })])), "Piper is working");
  assert.equal(assignmentLine(asg("done", [stage({ status: "done" })])), "Done");
  assert.equal(assignmentLine(asg("stopped", [stage({ status: "skipped" })])), "Stopped");
});

test("the count's words", () => {
  assert.equal(thingsWait(1), "1 thing waits for you");
  assert.equal(thingsWait(3), "3 things wait for you");
});

test("the strip lists the chat's waiting posts, oldest first: one row each, a run that didn't finish among them", () => {
  const q = post({ id: 5, kind: "question", waits_for: "answer", assignment_id: "a" });
  const plan = post({ id: 2, kind: "plan", waits_for: "go", who: who("Dot", false) });
  const failed = post({ id: 3, kind: "failed", waits_for: "dismiss", run_id: "r3", who: who("Wren", false) });
  const asked = post({ id: 4, kind: "reply", waits_for: "go", thread_id: "t4", who: who("Dot", false) });
  const settled = post({ id: 1, kind: "approval", waits_for: "approval", settled_at: "2026-11-17T09:00:00Z" });
  assert.deepEqual(waitingPosts({ waiting: [q, settled, asked, plan, failed] }).map((p) => p.id), [2, 3, 4, 5]);
  assert.equal(WAITS_WORD.dismiss, "Didn't finish");
  assert.equal(waitTitle(asked), "Dot needs your approval");
  assert.equal(waitTitle(q), "Piper needs your answer");
  assert.equal(waitTitle(plan), "Dot needs your approval");
  assert.equal(waitTitle(failed), "Wren didn't finish");
});

test("threads: one per assignment with its lineup first; other posts stand alone", () => {
  const posts = [post({ id: 4, kind: "question", waits_for: "answer", assignment_id: "a", assignment_title: "Launch" }), post({ id: 1, kind: "lineup", who: null, from: "ask", assignment_id: "a", assignment_title: "Launch" }), post({ id: 2 }), post({ id: 3, kind: "handoff", assignment_id: "a" })];
  const t = threadsOf(posts);
  assert.deepEqual(t.map((x) => x.key), ["post:2", "a"]);
  assert.deepEqual(t[1].posts.map((p) => p.kind), ["lineup", "handoff", "question"]);
  assert.equal(t[1].title, "Launch");
  assert.equal(t[1].waits, 1);
  assert.equal(threadCount(t[1]), "3 posts · 1 waits");
  assert.equal(threadCount(t[0]), "1 post");
});

test("answers: the owner's picks, or every suggestion, each marked with whose it was", () => {
  const qs: StageQuestion[] = [
    { id: "q1", question: "Which?", choices: ["A", "B"], allowOther: true, suggested: 1, why: "Because" },
    { id: "q2", question: "Mention it?", choices: ["Yes", "No"], allowOther: false, suggested: 0, why: "Because" },
  ];
  assert.deepEqual(suggestedAnswers(qs).map((a) => [a.answer, a.by]), [["B", "suggested"], ["Yes", "suggested"]]);
  assert.equal(ownerAnswers(qs, ["A", undefined]), null);
  assert.deepEqual(ownerAnswers(qs, [" my own ", "No"])?.map((a) => [a.id, a.answer, a.by]), [["q1", "my own", "owner"], ["q2", "No", "owner"]]);
  assert.equal(answerBy({ by: "suggested" }), "Suggested, taken for you");
  assert.equal(answerBy({ by: "owner" }), "Your answer");
});

test("the three presets set each stage's checkpoint, and the last stage always carries on", () => {
  const l = lineup(4);
  assert.deepEqual(applyPreset(l, "auto").stages.map((s) => s.checkpoint), ["auto", "auto", "auto", "auto"]);
  assert.deepEqual(applyPreset(l, "each").stages.map((s) => s.checkpoint), ["approve", "approve", "approve", "auto"]);
  assert.deepEqual(applyPreset(l, "last").stages.map((s) => s.checkpoint), ["auto", "auto", "approve", "auto"]);
  assert.equal(applyPreset(l, "each").checkpoint, "approve");
  assert.equal(presetOf(applyPreset(l, "last")), "last");
  assert.equal(presetOf(l), "auto");
  assert.equal(presetOf(setCheckpoint(l, 0, "approve")), null);
  // With two stages, "each" and "last" are the same lineup: the first that matches is named.
  assert.equal(presetOf(applyPreset(lineup(2), "last")), "each");
});

test("the lineup's edits: reorder, remove down to two, swap a guest or a standing assistant", () => {
  const l = applyPreset(lineup(3), "each");
  const moved = moveStage(l, 2, 0);
  assert.deepEqual(moved.stages.map((s) => s.role), ["reviewer", "engineer", "seo"]);
  assert.equal(moved.stages[2].checkpoint, "auto");
  assert.equal(moveStage(l, 0, 9), l);
  assert.equal(canRemove(l), true);
  const two = removeStage(l, 2);
  assert.deepEqual(two.stages.map((s) => [s.role, s.checkpoint]), [["engineer", "approve"], ["seo", "auto"]]);
  assert.equal(canRemove(two), false);
  assert.equal(removeStage(two, 0), two);
  const swapped = swapStage(l, 1, { role: "editor" });
  assert.deepEqual([swapped.stages[1].role, swapped.stages[1].task, swapped.stages[1].checkpoint, swapped.stages[1].name], ["editor", "seo task", "approve", undefined]);
  const standing = swapStage(l, 1, { assistant_id: "w", name: "Wren", job: "Writes Friday's summary" });
  assert.deepEqual(lineupWho(standing.stages[1]), { name: "Wren", line: "Writes Friday's summary" });
  assert.deepEqual(lineupWho(l.stages[0]), { name: "Engineer", line: "Guest" });
  assert.deepEqual(lineupWho({ ...l.stages[0], name: "Ada" }), { name: "Ada", line: "Guest · Engineer" });
});

test("Go waits for a lineup that can run", () => {
  assert.equal(lineupProblem(lineup(3)), null);
  assert.equal(lineupProblem(lineup(1)), "A lineup needs at least 2 stages.");
  assert.equal(lineupProblem({ ...lineup(2), stages: [...lineup(2).stages.slice(0, 1), { role: "seo", task: " ", checkpoint: "auto" }] }), "Each stage needs a task.");
  assert.equal(lineupProblem({ ...lineup(2), stages: Array.from({ length: 7 }, () => lineup(2).stages[0]) }), "A lineup has 6 stages at most.");
});

test("keeping a guest when the team is full, and a file's size", () => {
  assert.equal(teamFull("Piper"), "Your team is full. Remove an assistant to keep Piper.");
  assert.equal(sizeWords(900), "900 B");
  assert.equal(sizeWords(3_180), "3 KB");
  assert.equal(sizeWords(2_400_000), "2.3 MB");
});
