// Team chat on real Postgres (migration 0076): a post made and read back sealed, settled by a Go, an answer or an
// approval, paged, the waiting list oldest first and agreeing with the runs' own count, the 90-day sweep, a
// standing assistant's run posting (or not), the card's link, and what's typed sent on through fakes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team-posts.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team, assignment, plan, activity and nudge tables first.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { TurnResult } from "./team-chat";
import type { TeamPost } from "./assignment-types";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";
const STEP = { label: "Email Sam the quote", tool: "draft_email", input: {}, stands_for: "Email Sam the quote" };

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_posts, team_stages, team_assignments, team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_plans, ask_activity, nudges CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
});

const midday = () => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

/** An assignment with one guest and its stage, as the runner would leave them. */
async function assignment(title = "Pricing page") {
  const { qRaw } = await import("./db");
  const { sealText } = await import("./data-box");
  const { createAssistant } = await import("./team");
  const [a] = await qRaw<{ id: string }>(`INSERT INTO team_assignments (payload, status) VALUES ($1, 'waiting') RETURNING id`, [sealText(JSON.stringify({ title, brief: "Rewrite it." }))]);
  const guest = await createAssistant({ name: "Vera", job: "Reviews the copy" });
  await qRaw(`UPDATE team_assistants SET assignment_id = $2, role = 'reviewer' WHERE id = $1`, [guest.id, a.id]);
  const words = { task: "Review", handoff: { did: "Read it", open: "The price table", next: "Check the numbers" }, questions: [{ id: "q1", question: "Which tone?", choices: ["Plain", "Warm"], allowOther: false, suggested: 0, why: "It matches the site." }], answers: [] };
  const [s] = await qRaw<{ id: string }>(`INSERT INTO team_stages (assignment_id, position, assistant_id, status, waits_for, words) VALUES ($1, 0, $2, 'waiting', 'answer', $3) RETURNING id`, [a.id, guest.id, sealText(JSON.stringify(words))]);
  return { id: a.id, guest, stage: s.id };
}

/** A finished run with its conversation, and a plan kept in it when `plan`. */
async function finishedRun(assistantId: string, opts: { plan?: boolean } = {}) {
  const { randomUUID } = await import("node:crypto");
  const { enqueueTeamRun, claimTeamRun, finishTeamRun } = await import("./team-run");
  const { savePlan } = await import("./ask-plans");
  const run = await enqueueTeamRun(assistantId);
  const thread = randomUUID();
  await claimTeamRun(run.id);
  await finishTeamRun(run.id, { status: "done", summary: "Found a quote.", thread_id: thread });
  const plan = opts.plan ? await savePlan([STEP], { source: "routine", thread_id: thread }) : null;
  return { id: run.id, thread, plan };
}

test("a post is kept sealed and read back as the channel draws it; a plan post points at its run's thread", { skip }, async () => {
  const { postToTeam, getPost } = await import("./team-posts");
  const { createAssistant } = await import("./team");
  const { qRaw } = await import("./db");
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices" });
  const run = await finishedRun(moss.id, { plan: true });

  const plan = await postToTeam({ kind: "plan", text: "I'd email Sam the quote. One change waits for you to tap Go.", assistant_id: moss.id, run_id: run.id, waits_for: "go" });
  assert.equal(plan.kind, "plan");
  assert.equal(plan.from, "assistant");
  assert.deepEqual(plan.who, { id: moss.id, name: "Moss", avatar: moss.avatar, job: "Finds good prices", role: null, guest: false });
  assert.equal(plan.thread_id, run.thread, "the run's conversation, where the plan card lives");
  assert.equal(plan.waits_for, "go");
  assert.equal(plan.settled_at, null);
  assert.equal(plan.assignment_id, null);
  assert.equal(plan.assignment_title, null);
  assert.ok(!JSON.stringify(plan).includes("draft_email"), "the plan itself is never copied");
  const [raw] = await qRaw<{ body: string }>(`SELECT body FROM team_posts WHERE id = $1`, [plan.id]);
  assert.ok(!raw.body.includes("Sam"), "body is sealed");
  assert.deepEqual(await getPost(plan.id), plan);
  assert.equal((await postToTeam({ kind: "plan", text: "Again", assistant_id: moss.id, run_id: run.id, waits_for: "go" })).id, plan.id, "one waiting post per run");

  const said = await postToTeam({ kind: "said", text: "  Thanks  ", assistant_id: moss.id });
  assert.deepEqual([said.from, said.who, said.text], ["owner", null, "Thanks"]);
  assert.equal((await postToTeam({ kind: "reply", text: "Done." })).from, "ask");

  await assert.rejects(postToTeam({ kind: "nope" as never, text: "x" }), /kind/);
  await assert.rejects(postToTeam({ kind: "update", text: "  " }), /text/);
  await assert.rejects(postToTeam({ kind: "update", text: "x", run_id: "1" }), /run_id/);
  await assert.rejects(postToTeam({ kind: "update", text: "x", waits_for: "soon" as never }), /waits_for/);
});

test("an assignment's posts carry its title and read their stage's words; a guest says so", { skip }, async () => {
  const { postToTeam } = await import("./team-posts");
  const a = await assignment();
  const q = await postToTeam({ kind: "question", text: "One thing before I go on.", assistant_id: a.guest.id, assignment_id: a.id, stage_id: a.stage, waits_for: "answer" });
  assert.equal(q.assignment_title, "Pricing page");
  assert.deepEqual([q.who?.name, q.who?.role, q.who?.guest], ["Vera", "reviewer", true]);
  assert.equal(q.questions?.[0].question, "Which tone?");
  assert.deepEqual(q.answers, []);
  const h = await postToTeam({ kind: "handoff", text: "Over to the next stage.", assistant_id: a.guest.id, assignment_id: a.id, stage_id: a.stage });
  assert.deepEqual(h.handoff, { did: "Read it", open: "The price table", next: "Check the numbers" });
  assert.equal(h.questions, undefined);
  const done = await postToTeam({ kind: "done", text: "Finished.", assignment_id: a.id });
  assert.deepEqual([done.documents, done.note_id], [[], null]);
});

test("settling: an answer or an approval by stage, a Go by its plan, and the count agrees with the runs' own", { skip }, async () => {
  const { postToTeam, settlePosts, settlePlanPosts, dismissPost, listChat, countWaiting } = await import("./team-posts");
  const { getTeamRun } = await import("./team-run");
  const { goPlan } = await import("./ask-plans");
  const { createAssistant } = await import("./team");
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices" });
  const dot = await createAssistant({ name: "Dot", job: "Sorts issues" });
  const a = await assignment();
  const one = await finishedRun(moss.id, { plan: true });
  const two = await finishedRun(dot.id, { plan: true });

  const q = await postToTeam({ kind: "question", text: "Which tone?", assistant_id: a.guest.id, assignment_id: a.id, stage_id: a.stage, waits_for: "answer" });
  const p1 = await postToTeam({ kind: "plan", text: "One change waits.", assistant_id: moss.id, run_id: one.id, waits_for: "go" });
  const p2 = await postToTeam({ kind: "plan", text: "One change waits.", assistant_id: dot.id, run_id: two.id, waits_for: "go" });
  await postToTeam({ kind: "update", text: "Nothing waits here.", assistant_id: dot.id });
  assert.deepEqual((await listChat()).waiting.map((p) => p.id), [q.id, p1.id, p2.id], "oldest first");
  assert.equal(await countWaiting(), 3);

  await assert.rejects(settlePosts({}), /which/i);
  assert.equal(await settlePosts({ stage_id: a.stage, assignment_id: one.id }), 0, "each key narrows");
  assert.equal(await settlePosts({ stage_id: a.stage }), 1);
  assert.equal(await settlePosts({ stage_id: a.stage }), 0, "once");
  assert.deepEqual((await listChat()).waiting.map((p) => p.id), [p1.id, p2.id]);

  // Go through the plan's own route settles its run's post, and only that one.
  const deps = { run: async () => [], log: async () => [] };
  await goPlan(one.plan!.id, undefined, deps);
  assert.equal(await settlePlanPosts(one.plan!.id), 1);
  assert.equal(await settlePlanPosts("nope"), 0);
  const after = await listChat();
  assert.deepEqual(after.waiting.map((p) => p.id), [p2.id]);
  assert.ok(after.posts.find((p) => p.id === p1.id)?.settled_at, "settled, still in the channel");

  // A Go that never told the channel still lowers it: the plan is the one record.
  await goPlan(two.plan!.id, undefined, deps);
  assert.equal((await getTeamRun(two.id))!.waiting, 0);
  assert.equal(await countWaiting(), 0);
  assert.deepEqual((await listChat()).waiting, []);
  for (const run of [one, two]) assert.equal((await getTeamRun(run.id))!.waiting, 0);

  const waits = await postToTeam({ kind: "approval", text: "Ready for you.", assistant_id: a.guest.id, assignment_id: a.id, stage_id: a.stage, waits_for: "approval" });
  // A run that didn't finish counts 1 like the rest, and only a dismissal settles it.
  const failed = await postToTeam({ kind: "failed", text: "Moss didn't finish.", assistant_id: a.guest.id, assignment_id: a.id, run_id: one.id, waits_for: "dismiss" });
  assert.equal(await countWaiting(), 2);
  assert.equal(await countWaiting(), (await listChat()).waiting.length, "the count is the rows in the strip");
  assert.equal(await settlePosts({ assignment_id: a.id }), 1);
  assert.equal(await settlePosts({ run_id: one.id }), 0);
  assert.ok((await listChat()).posts.find((p) => p.id === waits.id)?.settled_at);
  assert.deepEqual((await listChat()).waiting.map((p) => [p.id, p.waits_for]), [[failed.id, "dismiss"]]);
  assert.equal((await dismissPost(waits.id))!.waits_for, "approval", "not one to dismiss: untouched");
  assert.ok((await dismissPost(failed.id))!.settled_at);
  assert.ok((await dismissPost(failed.id))!.settled_at, "twice is fine");
  assert.equal(await dismissPost(999_999), null);
  assert.equal(await countWaiting(), 0);
});

test("the channel is read a page at a time, oldest first, back to its start", { skip }, async () => {
  const { postToTeam, listChat } = await import("./team-posts");
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) ids.push((await postToTeam({ kind: "update", text: `Post ${i}` })).id);
  const newest = await listChat({ limit: 3 });
  assert.deepEqual(newest.posts.map((p) => p.id), ids.slice(4));
  assert.equal(newest.before, ids[4]);
  const middle = await listChat({ limit: 3, before: newest.before });
  assert.deepEqual(middle.posts.map((p) => p.text), ["Post 1", "Post 2", "Post 3"]);
  const first = await listChat({ limit: 3, before: middle.before });
  assert.deepEqual(first.posts.map((p) => p.id), [ids[0]]);
  assert.equal(first.before, null, "the start of the channel");
  const all = await listChat();
  assert.equal(all.posts.length, 7);
  assert.equal(all.before, null);
  assert.deepEqual(await listChat({ before: ids[0] }), { posts: [], waiting: [], before: null });
});

test("the sweep: posts outside an assignment go after 90 days, unless they still wait; an assignment's stay", { skip }, async () => {
  const { postToTeam, sweepPosts, listChat } = await import("./team-posts");
  const { qRaw } = await import("./db");
  const { createAssistant } = await import("./team");
  const { ASSIGNMENT_LIMITS } = await import("./assignment-types");
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices" });
  const run = await finishedRun(moss.id, { plan: true });
  const a = await assignment();
  const old = await postToTeam({ kind: "update", text: "Old news", assistant_id: moss.id });
  const waiting = await postToTeam({ kind: "plan", text: "Still waiting", assistant_id: moss.id, run_id: run.id, waits_for: "go" });
  const threaded = await postToTeam({ kind: "lineup", text: "Vera, then done.", assignment_id: a.id });
  const fresh = await postToTeam({ kind: "update", text: "New news", assistant_id: moss.id });
  await qRaw(`UPDATE team_posts SET created_at = now() - make_interval(days => $2) WHERE id <> $1`, [fresh.id, ASSIGNMENT_LIMITS.postDays + 1]);
  assert.equal(await sweepPosts(), 1);
  assert.deepEqual((await listChat()).posts.map((p) => p.id), [waiting.id, threaded.id, fresh.id]);
  assert.ok(!(await listChat()).posts.some((p) => p.id === old.id));
  // An assignment's posts go with it.
  await qRaw(`DELETE FROM team_assignments WHERE id = $1`, [a.id]);
  assert.deepEqual((await listChat()).posts.map((p) => p.id), [waiting.id, fresh.id]);
});

test("a standing assistant's run: a plan waits in the channel, an update is said, a failure is told, and a quiet run posts nothing", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { enqueueTeamRun, runTeamRun, deliverTeamNudges, getTeamRun } = await import("./team-run");
  const { listChat, countWaiting } = await import("./team-posts");
  const { savePlan } = await import("./ask-plans");
  const { qRaw } = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices", triggers: [{ kind: "schedule", days: [1], time: "09:00" }] });
  const reply = (id: string, thread: string, r: Partial<TurnResult["reply"]> & { text: string }): TurnResult => ({ assistant_id: id, thread_id: thread, text: r.text, reply: { sources: [], related: [], searched: "", skipped: [], found: true, flagged: false, ...r } });

  // Quiet: nothing found, nothing changed, nothing waiting.
  const quiet = await enqueueTeamRun(moss.id, { triggerId: moss.triggers[0].id });
  await runTeamRun(quiet.id, { turn: async (id, _p, o) => reply(id, o.threadId!, { text: "Nothing new.", found: false }) });
  assert.equal((await getTeamRun(quiet.id))!.quiet, true);
  assert.deepEqual((await listChat()).posts, []);

  // Something to say.
  const told = await enqueueTeamRun(moss.id, { triggerId: moss.triggers[0].id });
  await runTeamRun(told.id, { turn: async (id, _p, o) => reply(id, o.threadId!, { text: "The Lego set is £10 less at Smyths." }) });
  // Something waiting: its plan is kept in the run's conversation, as the loop keeps it.
  const planned = await enqueueTeamRun(moss.id, { triggerId: moss.triggers[0].id });
  let thread = "";
  await runTeamRun(planned.id, {
    turn: async (id, _p, o) => {
      thread = o.threadId!;
      const plan = await savePlan([STEP], { source: "routine", thread_id: thread });
      return reply(id, thread, { text: "I'd email Sam the quote.", plan: { id: plan.id, source: "routine", steps: [{ label: STEP.label, stands_for: STEP.stands_for }] } as never });
    },
  });
  // Didn't finish, twice (a triggered run is tried once more first).
  const failing = await enqueueTeamRun(moss.id, { triggerId: moss.triggers[0].id });
  const boom = { turn: async () => Promise.reject(new Error("boom")) };
  await runTeamRun(failing.id, boom);
  assert.equal((await getTeamRun(failing.id))!.status, "queued", "tried once more before anything is said");
  await runTeamRun(failing.id, boom);
  // Run now's failure is on the page the owner is looking at: not told here.
  const now = await enqueueTeamRun(moss.id);
  await runTeamRun(now.id, boom);

  const chat = await listChat();
  assert.deepEqual(chat.posts.map((p) => [p.kind, p.run_id, p.waits_for]), [["update", told.id, null], ["plan", planned.id, "go"], ["failed", failing.id, "dismiss"]]);
  assert.equal(chat.posts[0].text, "The Lego set is £10 less at Smyths.");
  assert.equal(chat.posts[1].thread_id, thread);
  assert.ok(chat.posts.every((p) => p.who?.name === "Moss" && p.from === "assistant"));
  assert.deepEqual(chat.waiting.map((p) => p.id), [chat.posts[1].id, chat.posts[2].id], "the run that didn't finish waits too");
  assert.equal(await countWaiting(), 2);
  assert.equal((await getTeamRun(planned.id))!.waiting, 1, "the run's own count says the same");

  // A stage's run is the runner's to post.
  const { sealText } = await import("./data-box");
  const [a] = await qRaw<{ id: string }>(`INSERT INTO team_assignments (payload) VALUES ($1) RETURNING id`, [sealText(JSON.stringify({ title: "T", brief: "B" }))]);
  const [s] = await qRaw<{ id: string }>(`INSERT INTO team_stages (assignment_id, position, assistant_id, words) VALUES ($1, 0, $2, $3) RETURNING id`, [a.id, moss.id, sealText("{}")]);
  const staged = await enqueueTeamRun(moss.id, { triggerId: moss.triggers[0].id });
  await qRaw(`UPDATE team_runs SET stage_id = $2 WHERE id = $1`, [staged.id, s.id]);
  await runTeamRun(staged.id, { turn: async (id) => reply(id, randomUUID(), { text: "Stage work." }) });
  assert.equal((await listChat()).posts.length, 3);

  // The card and its push open Team chat at the run's post.
  const pushed: string[] = [];
  await deliverTeamNudges(midday(), TZ, { canPush: true, quiet: null, send: async (p) => void pushed.push(p.url ?? "") });
  // (A later run's card closes this one on Home, so it's read as stored.)
  const { q } = await import("./db");
  const [card] = await q<{ payload: string }>(`SELECT payload FROM nudges WHERE key = $1`, [`team:${planned.id}`]);
  assert.equal(JSON.parse(card.payload).url, `/#/team/chat/${chat.posts[1].id}`);
  assert.ok(pushed.includes(`/#/team/chat/${chat.posts[1].id}`), "the push opens the same place");
});

test("typing: a waiting stage gets its answer, “@Name” is a chat turn, the suggestions phrase takes them, the rest goes to Ask", { skip }, async () => {
  const { handleTeamChatRoutes, CHAT_FAILED, DESK_NOT_YET } = await import("../netlify/lib/team-chat-routes");
  const { createAssistant } = await import("./team");
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices" });
  const a = await assignment();
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const calls: string[] = [];
  let waiting: string | null = a.stage;
  const deps = {
    desk: {
      answerStage: async (id: string, text: string) => void calls.push(`answer ${id === a.id} ${text}`),
      useSuggestions: async (id: string, fromHere: boolean) => void calls.push(`suggestions ${id === a.id} ${fromHere}`),
      waitingStage: async () => waiting,
    },
    ask: async (text: string) => (calls.push(`ask ${text}`), "Ask's answer."),
    turn: async (id: string, text: string): Promise<{ text: string; thread_id?: string | null }> => (calls.push(`turn ${id === moss.id ? "moss" : id === a.guest.id ? "vera" : id} ${text}`), { text: "From the assistant." }),
  };
  const post = async (body: Record<string, unknown>, d: typeof deps | Omit<typeof deps, "desk"> = deps) => {
    const u = new URL("https://athena.test/api/team/chat");
    const res = await handleTeamChatRoutes(new Request(u, { method: "POST" }), u, async () => body, json, d);
    return { status: res.status, body: (await res.json()) as { posts?: TeamPost[]; error?: string } };
  };
  const kinds = (r: { body: { posts?: TeamPost[] } }) => r.body.posts!.map((p) => `${p.kind}:${p.from}:${p.text}`);

  // In a thread with a stage waiting, the text is its answer; the runner says what happens next.
  let r = await post({ text: "Warm, please", assignment_id: a.id });
  assert.equal(r.status, 201);
  assert.deepEqual(kinds(r), ["said:owner:Warm, please"]);
  assert.equal(r.body.posts![0].assignment_title, "Pricing page");
  // The phrase takes the suggestions from here on, before anything else.
  r = await post({ text: "Continue and use all suggested routes", assignment_id: a.id });
  assert.deepEqual(kinds(r), ["said:owner:Continue and use all suggested routes"]);
  // "@Name": a standing assistant, or this thread's guest, answered in the thread. Never the stage's answer.
  r = await post({ text: "@Vera why warm?", assignment_id: a.id });
  assert.deepEqual(kinds(r), ["said:owner:@Vera why warm?", "reply:assistant:From the assistant."]);
  assert.deepEqual([r.body.posts![1].who?.name, r.body.posts![1].assignment_id], ["Vera", a.id]);
  r = await post({ text: "@moss any news?" });
  assert.deepEqual([r.body.posts![1].who?.name, r.body.posts![1].assignment_id], ["Moss", null]);
  assert.deepEqual([r.body.posts![1].thread_id, r.body.posts![1].waits_for], [null, null], "no plan: no card, nothing waits");
  // A guest isn't reached from outside its thread; that, and anything else, goes to Ask.
  r = await post({ text: "@Vera hello" });
  assert.deepEqual(kinds(r), ["said:owner:@Vera hello", "reply:ask:Ask's answer."]);
  // No stage waiting: the thread's message goes to Ask, told which thread it is.
  waiting = null;
  r = await post({ text: "How is it going?", assignment_id: a.id });
  assert.deepEqual(kinds(r), ["said:owner:How is it going?", "reply:ask:Ask's answer."]);
  // Outside a thread the phrase is Ask's to act on.
  r = await post({ text: "continue and use all suggested routes" });
  assert.equal(r.body.posts!.length, 2);

  assert.deepEqual(calls, [
    `answer true Warm, please`,
    `suggestions true true`,
    `turn vera why warm?`,
    `turn moss any news?`,
    `ask @Vera hello`,
    `ask How is it going?\n\n(Typed in Team chat, in the thread of the assignment “Pricing page”, id ${a.id}.)`,
    `ask continue and use all suggested routes`,
  ]);

  // A failure is said in the channel and what was typed is kept; without the assignments side, that's said too.
  r = await post({ text: "Hello?" }, { ...deps, ask: async () => Promise.reject(new Error("down")) });
  assert.deepEqual(kinds(r), ["said:owner:Hello?", `reply:ask:${CHAT_FAILED}`]);
  r = await post({ text: "use the suggestions", assignment_id: a.id }, { ask: deps.ask, turn: deps.turn });
  assert.deepEqual(kinds(r), ["said:owner:use the suggestions", `reply:ask:${DESK_NOT_YET}`]);

  // An "@Name" reply that proposes changes carries its conversation and waits for Go; Go on its plan settles it.
  const { savePlan, goPlan } = await import("../lib/ask-plans");
  const { settlePlanPosts, listChat, dismissPost } = await import("./team-posts");
  const { randomUUID } = await import("node:crypto");
  const thread = randomUUID();
  const plan = await savePlan([STEP, STEP], { source: "ask", thread_id: thread });
  r = await post({ text: "@Moss email Sam and add a to-do" }, { ...deps, turn: async () => ({ text: "Two changes are ready for you.", thread_id: thread }) });
  const held = r.body.posts![1];
  assert.deepEqual([held.kind, held.who?.name, held.thread_id, held.waits_for, held.run_id], ["reply", "Moss", thread, "go", null]);
  assert.deepEqual((await listChat()).waiting.map((p) => p.id), [held.id]);
  await goPlan(plan.id, undefined, { run: async () => [], log: async () => [] });
  assert.equal(await settlePlanPosts(plan.id), 1);
  assert.deepEqual((await listChat()).waiting, []);

  // Dismiss: only a run that didn't finish.
  const { postToTeam } = await import("./team-posts");
  const failed = await postToTeam({ kind: "failed", text: "Moss didn't finish.", assistant_id: moss.id, waits_for: "dismiss" });
  const dismiss = async (id: string | number, method = "POST") => {
    const d = new URL(`https://athena.test/api/team/chat/${id}/dismiss`);
    const res = await handleTeamChatRoutes(new Request(d, { method }), d, async () => null, json, deps);
    return { status: res.status, body: (await res.json()) as { post?: TeamPost; error?: string } };
  };
  assert.equal((await dismiss(held.id)).status, 409);
  assert.equal((await dismiss(failed.id, "GET")).status, 405);
  assert.equal((await dismiss("abc")).status, 400);
  assert.equal((await dismiss(999_999)).status, 404);
  const gone = await dismiss(failed.id);
  assert.equal(gone.status, 200);
  assert.ok(gone.body.post?.settled_at);
  assert.equal((await dismiss(failed.id)).status, 200, "twice is fine");
  assert.equal((await dismissPost(failed.id))!.waits_for, "dismiss");

  // Refused before anything is kept.
  assert.equal((await post({ text: "  " })).status, 400);
  assert.equal((await post({ text: "x".repeat(4001) })).status, 400);
  assert.equal((await post({ text: "Hi", assignment_id: "nope" })).status, 400);
  assert.equal((await post({ text: "Hi", assignment_id: "00000000-0000-4000-8000-000000000001" })).status, 404);

  // GET reads the channel.
  const u = new URL("https://athena.test/api/team/chat?limit=2");
  const got = (await (await handleTeamChatRoutes(new Request(u), u, async () => null, json, deps)).json()) as { posts: TeamPost[]; waiting: TeamPost[]; before: number | null };
  assert.equal(got.posts.length, 2);
  assert.ok(got.before);
  assert.deepEqual(got.waiting, []);
  const bad = new URL("https://athena.test/api/team/chat?before=abc");
  assert.equal((await handleTeamChatRoutes(new Request(bad), bad, async () => null, json, deps)).status, 400);
  assert.equal((await handleTeamChatRoutes(new Request(u, { method: "DELETE" }), u, async () => null, json, deps)).status, 405);
});
