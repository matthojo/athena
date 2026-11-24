// Team runtime on real Postgres: events matched to triggers and claimed once, schedule slots claimed once,
// a run through a fake runAssistantTurn (lib/team-chat.ts's return shape) and its record, the paused check,
// and routines turned into assistants exactly once.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team-runtime.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team, routine, plan and activity tables first.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { Change } from "./assistant";
import type { TurnOptions, TurnResult } from "./team-chat";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";
const THREAD = "00000000-0000-4000-8000-00000000000f";
/** runAssistantTurn's return, as lib/team-chat.ts gives it in run mode. */
const result = (assistant_id: string, reply: Partial<TurnResult["reply"]> & { text: string }): TurnResult => ({ assistant_id, thread_id: THREAD, text: reply.text, reply: { sources: [], related: [], searched: "", skipped: [], found: true, flagged: false, ...reply } });

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_routines, ask_plans, ask_activity CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  await qRaw(`DELETE FROM settings WHERE key = 'team.routines_migrated'`);
});

/** Today at 12:00 UTC: cards are sent outside quiet hours (22:00 to 07:00 when none are set), whatever the clock says when the tests run. */
const midday = () => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

/** Make triggers old enough for any event or slot in a test. */
async function ageTriggers() {
  const { qRaw } = await import("./db");
  await qRaw(`UPDATE team_triggers SET created_at = '2026-01-01T00:00:00Z'`);
}

test("events: matched to event triggers, each claimed once, batched per assistant, pruned after 7 days", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { emitTeamEvent, pruneTeamEvents } = await import("./team-events");
  const { queueTeamRuns } = await import("./team-triggers");
  const { listTeamRuns } = await import("./team-run");
  const { qRaw } = await import("./db");

  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas", triggers: [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }] });
  const dot = await createAssistant({ name: "Dot", job: "Linear issues to to-dos", triggers: [{ kind: "event", event: { source: "collected", connector: "linear", match: "bug" } }] });
  const off = await createAssistant({ name: "Off", job: "Paused", paused: true, triggers: [{ kind: "event", event: { source: "saved" } }] });
  await ageTriggers();

  await emitTeamEvent("saved", "s1", "saved", { savedAction: "gift_idea", title: "Lego" });
  await emitTeamEvent("saved", "s2", "saved", { savedAction: "saved", title: "An article" });
  await emitTeamEvent("collected", "n1", "note", { connector: "linear", kind: "issue", title: "Login bug" });
  await emitTeamEvent("collected", "n2", "note", { connector: "linear", kind: "issue", title: "New feature" });
  // Never throws, even when the row can't be kept.
  await emitTeamEvent("nope" as never, null, null, {});

  const runs = await queueTeamRuns(new Date(), TZ);
  assert.deepEqual(runs.map((r) => r.assistant_id).sort(), [moss.id, dot.id].sort());
  assert.ok(runs.every((r) => r.status === "queued" && r.event_id && r.trigger_id));
  assert.equal((await listTeamRuns(off.id)).length, 0, "a paused assistant doesn't fire");
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_events WHERE processed_at IS NULL`);
  assert.equal(n, 0, "every event is claimed");
  assert.deepEqual(await queueTeamRuns(new Date(), TZ), [], "a claimed event never fires again");

  // A flood: every match for one assistant in one pass is one run that carries all of them, oldest first.
  for (let i = 0; i < 30; i++) await emitTeamEvent("collected", `b${i}`, "note", { connector: "linear", kind: "issue", title: `bug ${i}` });
  const batch = await queueTeamRuns(new Date(), TZ);
  assert.equal(batch.length, 1, "one run for 30 events");
  assert.equal(batch[0].assistant_id, dot.id);
  assert.equal(batch[0].event_ids!.length, 30);
  assert.equal(batch[0].event_id, batch[0].event_ids![0], "event_id is the first of them");
  assert.deepEqual(batch[0].event_ids, [...batch[0].event_ids!].sort((a, b) => Number(a) - Number(b)));
  const [{ left }] = await qRaw<{ left: number }>(`SELECT count(*)::int AS left FROM team_events WHERE processed_at IS NULL`);
  assert.equal(left, 0, "every event in the flood is marked processed");

  await qRaw(`UPDATE team_events SET created_at = now() - interval '8 days' WHERE ref_id = 's1'`);
  assert.equal(await pruneTeamEvents(), 1);
});

test("a batched run: its turn is told about every event, and its summary says how many", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { emitTeamEvent } = await import("./team-events");
  const { queueTeamRuns } = await import("./team-triggers");
  const { runTeamRun } = await import("./team-run");
  const dot = await createAssistant({ name: "Dot", job: "Linear issues to to-dos", allow: ["add_todo"], triggers: [{ kind: "event", event: { source: "collected", connector: "linear" } }] });
  await ageTriggers();
  for (let i = 0; i < 30; i++) await emitTeamEvent("collected", `i${i}`, "note", { connector: "linear", kind: "issue", title: `Issue ${i}` });
  const [run] = await queueTeamRuns(new Date(), TZ);
  let told: { prompt: string; first?: string } | null = null;
  const done = await runTeamRun(run.id, {
    turn: async (id, prompt, opts) => {
      told = { prompt, first: opts.event?.facets?.title as string };
      return result(id, { text: "Four were bugs." });
    },
  });
  assert.equal(told!.first, "Issue 0", "the first event goes in as `event`");
  assert.match(told!.prompt, /^30 things just arrived/);
  assert.equal(told!.prompt.split("\n").filter((l) => l.startsWith("- issue from linear")).length, 30, "the prompt lists every event");
  assert.match(told!.prompt, /“Issue 29”/);
  assert.equal(done!.summary, "30 new issues. Four were bugs.", "what arrived, when the reply doesn't say");
  assert.equal(done!.label, "30 new issues");
  assert.equal(done!.assistant_id, dot.id);
});

test("schedule triggers: a due slot is claimed once, even by two passes at once", { skip }, async () => {
  const { createAssistant, getAssistant } = await import("./team");
  const { queueTeamRuns } = await import("./team-triggers");
  const wren = await createAssistant({ name: "Wren", job: "Sums up the week", triggers: [{ kind: "schedule", days: ["wednesday"], time: "10:00" }] });
  await ageTriggers();
  const now = new Date("2026-11-11T10:05:00Z"); // Wednesday
  const [a, b] = await Promise.all([queueTeamRuns(now, TZ), queueTeamRuns(now, TZ)]);
  assert.equal(a.length + b.length, 1, "one run for the slot");
  assert.equal((await getAssistant(wren.id))!.triggers[0].last_slot, "2026-11-11T10:00:00.000Z");
  assert.deepEqual(await queueTeamRuns(new Date("2026-11-11T10:20:00Z"), TZ), [], "the same slot doesn't run again");
  assert.deepEqual(await queueTeamRuns(new Date("2026-11-11T12:00:00Z"), TZ), [], "a slot missed by more than the window is skipped");
});

test("a run: the turn's thread, reply and plan make the record; nothing is logged or saved twice", { skip }, async () => {
  const { createAssistant, getAssistant } = await import("./team");
  const { enqueueTeamRun, runTeamRun, getTeamRun, listTeamRuns } = await import("./team-run");
  const { savePlan, planCard } = await import("./ask-plans");
  const { logChanges, listActivity } = await import("./ask-activity");
  const { qRaw } = await import("./db");

  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas", allow: ["add_todo"], personality: { tone: "crisp", traits: [], pronoun: "she", greeting: "" } });
  const queued = await enqueueTeamRun(moss.id);
  const asked: Array<{ prompt: string; opts: TurnOptions }> = [];
  const done = await runTeamRun(queued.id, {
    // As runAssistantTurn does in run mode: the allowed change ran and is logged, the rest is one plan for Go.
    turn: async (id, prompt, opts) => {
      asked.push({ prompt, opts });
      const todo: Change = { kind: "commitment", id: "00000000-0000-4000-8000-0000000000aa", action: "created", title: "Compare prices", detail: "To do", label: "To do", open: null, undo: null };
      const changes = await logChanges([todo], { source: "routine", thread_id: THREAD });
      const plan = await savePlan(
        [
          { label: "Add Sam", tool: "add_person", input: { name: "Sam" }, stands_for: "S-1" },
          { label: "Add a to-do: call Sam", tool: "add_todo", input: { title: "Call Sam", person_id: "S-1" }, stands_for: "S-2" },
        ],
        { source: "routine", thread_id: THREAD },
      );
      return result(id, { text: "Lego is £40 at John Lewis [1].", changes, plan: planCard(plan, { proposed: true }) });
    },
  });

  assert.equal(asked[0].opts.mode, "run");
  assert.match(asked[0].opts.threadId ?? "", /^[0-9a-f-]{36}$/, "the run names its thread up front, so a failed turn's record can be checked");
  assert.equal(asked[0].opts.event, null);
  assert.match(asked[0].prompt, /run now/);
  assert.equal(done!.status, "done");
  assert.equal(done!.thread_id, THREAD, "the turn's thread_id");
  assert.equal(done!.summary, "Lego is £40 at John Lewis. 2 changes wait for your approval.");
  assert.equal(done!.label, "Run now");
  assert.equal(done!.step, null, "nothing to say once it's done");
  assert.equal(done!.quiet, false);
  assert.deepEqual((await listActivity({ limit: 10 })).map((e) => [e.source, e.change.title]), [["team", "Compare prices"]], "logged once, by the turn, and shown as the team's");
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ask_threads WHERE id = $1::uuid`, [THREAD]);
  assert.equal(n, 0, "the runner doesn't save the conversation (the turn does)");
  assert.ok((await getAssistant(moss.id))!.last_run_at);

  // Claimed once: a second start does nothing.
  assert.equal(await runTeamRun(queued.id, { turn: async () => assert.fail("ran twice") }), null);
  assert.deepEqual((await listTeamRuns(moss.id)).map((r) => r.id), [queued.id]);
  assert.equal((await getTeamRun(queued.id))!.status, "done");
});

test("paused: a trigger's run doesn't happen, Run now still runs; a failed turn is recorded", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { enqueueTeamRun, runTeamRun } = await import("./team-run");
  const dot = await createAssistant({ name: "Dot", job: "Asks first", paused: true, triggers: [{ kind: "schedule", days: ["monday"], time: "09:00" }] });
  const turn = async (id: string) => result(id, { text: "Nothing new." });

  const fromTrigger = await runTeamRun((await enqueueTeamRun(dot.id, { triggerId: dot.triggers[0].id })).id, { turn: async () => assert.fail("paused") });
  assert.equal(fromTrigger!.status, "failed");
  assert.equal(fromTrigger!.error, "Paused before it ran.");

  const runNow = await runTeamRun((await enqueueTeamRun(dot.id)).id, { turn });
  assert.equal(runNow!.status, "done");
  assert.equal(runNow!.summary, "Nothing new.");
  assert.equal(runNow!.quiet, true, "nothing to do: no card");

  const bad = await runTeamRun((await enqueueTeamRun(dot.id)).id, { turn: async () => { throw new Error("pg: something broke"); } });
  assert.equal(bad!.status, "failed");
  assert.equal(bad!.error, "Something went wrong on Athena's side. Try Run now.", "a line the owner can read, never the raw error");
});

test("routines become assistants once: idempotent, linked, and then routines stop running", { skip }, async () => {
  const { createRoutine, runRoutineTool } = await import("./routines");
  const { migrateRoutines, routinesMigrated } = await import("./team-migrate");
  const { claimDueRoutines } = await import("./routine-run");
  const { listAssistants, createAssistant } = await import("./team");
  const { qRaw } = await import("./db");

  const r1 = await createRoutine({ prompt: "What slipped this week?", title: "What slipped", days: ["friday"], time: "16:00" });
  const r2 = await createRoutine({ prompt: "Any birthdays coming up?", days: ["weekdays"], time: "08:00", paused: true });
  await qRaw(`UPDATE ask_routines SET last_slot = '2026-11-06T16:00:00Z', created_at = '2026-01-01T00:00:00Z'`);

  // Half done already (a pass that stopped part-way): only the other is made.
  await createAssistant({ name: "What slipped", job: "What slipped" }, { routineId: r1.id });
  const first = await migrateRoutines();
  assert.deepEqual(first, { made: 1, already: 1, failed: 0, done: true });
  assert.equal(await routinesMigrated(), true);
  const again = await migrateRoutines();
  assert.equal(again.made, 0, "safe to run again");

  const team = await listAssistants();
  assert.equal(team.length, 2);
  const birthdays = team.find((a) => a.routine_id === r2.id)!;
  assert.equal(birthdays.instructions, "Any birthdays coming up?");
  assert.equal(birthdays.paused, true);
  assert.deepEqual(birthdays.triggers.map((t) => [t.kind, t.days, t.time]), [["schedule", [1, 2, 3, 4, 5], "08:00"]]);

  // A routine that has its assistant never runs as a routine.
  assert.deepEqual(await claimDueRoutines(new Date("2026-11-13T16:05:00Z"), TZ), []);

  // save_routine now makes an assistant, and its Undo removes it.
  const said: unknown[] = [];
  await runRoutineTool("save_routine", { prompt: "What's on next week?", days: ["sunday"], time: "18:00" }, (c) => (said.push(c), "ok"));
  const made = (await listAssistants()).find((a) => a.instructions === "What's on next week?")!;
  assert.ok(made, "an assistant, not a routine");
  assert.deepEqual(made.triggers.map((t) => [t.days, t.time]), [[[0], "18:00"]]);
  assert.equal((said[0] as { id: string }).id, made.id);
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ask_routines`);
  assert.equal(n, 2, "no new routine row");
  const { applyRoutineUndo } = await import("./routines");
  await runRoutineTool("save_routine", { prompt: "What's on next week?", days: ["saturday"], time: "09:00", routine_id: made.id }, (c) => (said.push(c), "ok"));
  await applyRoutineUndo((said[1] as { undo: never }).undo);
  const back = (await listAssistants()).find((a) => a.id === made.id)!;
  assert.deepEqual(back.triggers.map((t) => [t.days, t.time]), [[[0], "18:00"]], "Undo puts the schedule back");
  await applyRoutineUndo((said[0] as { undo: never }).undo);
  assert.equal((await listAssistants()).some((a) => a.id === made.id), false);
});

test("Home keeps one card per assistant: a newer run's card closes the same assistant's older one, never another's", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { enqueueTeamRun, runTeamRun, deliverTeamNudges } = await import("./team-run");
  const { listLiveNudges } = await import("./proactive/store");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE nudges, nudge_mutes`);
  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas" });
  const dot = await createAssistant({ name: "Dot", job: "Turns Linear issues into to-dos" });
  const deps = { canPush: false, send: async () => undefined, quiet: null };
  const run = async (id: string, text: string, thread: string) => {
    const queued = await enqueueTeamRun(id);
    await runTeamRun(queued.id, { turn: async (aid) => ({ ...result(aid, { text }), thread_id: thread }) });
    await deliverTeamNudges(midday(), TZ, deps);
    return queued.id;
  };
  const first = await run(moss.id, "Found the Lego Ferrari for £34.", "00000000-0000-4000-8000-0000000000a1");
  const dots = await run(dot.id, "Three issues came in, all already on your list.", "00000000-0000-4000-8000-0000000000a2");
  const second = await run(moss.id, "Still £34 at Smyths.", "00000000-0000-4000-8000-0000000000a3");

  const live = await listLiveNudges();
  assert.deepEqual(live.map((n) => n.key).sort(), [`team:${dots}`, `team:${second}`].sort(), "Moss's newest and Dot's");
  const [old] = await qRaw<{ dismissed_at: string | null }>(`SELECT dismissed_at FROM nudges WHERE key = $1`, [`team:${first}`]);
  assert.ok(old.dismissed_at, "Moss's older card is closed, not deleted (its key still stops a resend)");
  assert.deepEqual(await deliverTeamNudges(midday(), TZ, deps), { sent: 0, held: 0 }, "nothing is sent again");
});

test("while it works a run says what it's doing; then a card in its voice, none when quiet, and a plain one when it fails", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { emitTeamEvent } = await import("./team-events");
  const { queueTeamRuns } = await import("./team-triggers");
  const { runTeamRun, getTeamRun, listTeamActivity, deliverTeamNudges, failStaleRuns, enqueueTeamRun } = await import("./team-run");
  const { listLiveNudges } = await import("./proactive/store");
  const { RateLimited } = await import("./ai");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE nudges, nudge_mutes`);
  const deps = { canPush: false, send: async () => undefined, quiet: null };
  const dot = await createAssistant({ name: "Dot", job: "Turns Linear issues into to-dos", personality: { tone: "warm", traits: [], pronoun: "they", greeting: "" }, triggers: [{ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } }] });
  await ageTriggers();
  for (const t of ["Checkout times out", "Billing export"]) await emitTeamEvent("collected", null, "note", { connector: "linear", kind: "issue", title: t });

  // The label is kept when it's queued: what set it off.
  const [queued] = await queueTeamRuns(new Date(), TZ);
  assert.equal(queued.label, "2 new issues");
  assert.equal(queued.status, "queued");

  // While the turn works, each step is the run's: the first is its own, the rest the turn's.
  const seen: Array<string | null | undefined> = [];
  const run = await runTeamRun(queued.id, {
    turn: async (id, _prompt, opts) => {
      seen.push((await getTeamRun(queued.id))!.step);
      opts.onStep?.({ id: "s1", text: "Looking at your to-dos", done: false });
      opts.onStep?.({ id: "s2", text: "Dropped", done: true, dropped: true });
      await new Promise((r) => setTimeout(r, 30));
      seen.push((await listTeamActivity(5)).find((r) => r.id === queued.id)!.step);
      return result(id, { text: "Nothing new: both are already to-dos.", found: false });
    },
  });
  assert.deepEqual(seen, ["Reading your 2 new issues", "Looking at your to-dos"]);
  assert.equal(run!.status, "done");
  assert.equal(run!.step, null);
  assert.equal(run!.quiet, true);
  await deliverTeamNudges(midday(), TZ, deps);
  assert.equal((await listLiveNudges()).length, 0, "a run with nothing to do sends no card");

  // A triggered run that fails before anything ran is tried once more, quietly; the second failure sends one card, from the assistant, saying what to do.
  await emitTeamEvent("collected", null, "note", { connector: "linear", kind: "issue", title: "Onboarding copy" });
  await emitTeamEvent("collected", null, "note", { connector: "linear", kind: "issue", title: "Search is slow" });
  const [again] = await queueTeamRuns(new Date(), TZ);
  const first = await runTeamRun(again.id, { turn: async () => { throw new RateLimited(); } });
  assert.equal(first!.status, "queued", "back in the queue for the next pass");
  assert.equal(first!.retried, true);
  await deliverTeamNudges(midday(), TZ, deps);
  assert.equal((await listLiveNudges()).length, 0, "no card for a first try");
  const failed = await runTeamRun(again.id, { turn: async () => { throw new RateLimited(); } });
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.error, "Athena's AI was busy. Ask Dot about them in a chat.");
  await deliverTeamNudges(midday(), TZ, deps);
  const [card] = await listLiveNudges();
  assert.equal(card.title, "From Dot");
  assert.equal(card.body, "Sorry, I couldn't finish. Athena's AI was busy. Ask me about the 2 new issues and I'll pick them up.");
  assert.equal(card.why[1], "Dot tried twice and won't try again on their own.");

  // Run now's failure is on the page the owner is looking at: no card.
  await runTeamRun((await enqueueTeamRun(dot.id)).id, { turn: async () => { throw new RateLimited(); } });
  assert.deepEqual(await deliverTeamNudges(midday(), TZ, deps), { sent: 0, held: 0 });

  // A run that went silent, or was never picked up, fails with a line saying so.
  const silent = await enqueueTeamRun(dot.id);
  const never = await enqueueTeamRun(dot.id);
  await qRaw(`UPDATE team_runs SET status = 'running', step_at = now() - interval '9 minutes' WHERE id = $1::uuid`, [silent.id]);
  await qRaw(`UPDATE team_runs SET started_at = now() - interval '11 minutes' WHERE id = $1::uuid`, [never.id]);
  const fresh = await enqueueTeamRun(dot.id);
  assert.equal(await failStaleRuns(), 2);
  assert.equal((await getTeamRun(silent.id))!.error, "The run stopped partway. Anything it changed is in What Ask did. Try Run now.");
  assert.equal((await getTeamRun(never.id))!.error, "The run couldn't start. Try Run now in a minute.");
  assert.equal((await getTeamRun(fresh.id))!.status, "queued", "a run just queued is left alone");
});

/** Set what a hand-off needs (a model and the bearer token) for one test. */
async function withHandOff<T>(work: () => Promise<T>): Promise<T> {
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, MCP_BEARER_TOKEN: process.env.MCP_BEARER_TOKEN };
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  process.env.MCP_BEARER_TOKEN ||= "test-token";
  try {
    return await work();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A stand-in for the background function: records each run handed to it, or fails. */
function fakeFunction(fail = false) {
  const runs: string[] = [];
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    if (fail) throw new Error("connect ECONNREFUSED");
    runs.push(JSON.parse(String(init.body)).run_id);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return { runs, fetchImpl };
}

test("something you do hands its run off at once; a hand-off that fails waits for the pass; nothing runs twice", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { emitTeamEvent } = await import("./team-events");
  const { queueTeamRuns, startTeamEvent } = await import("./team-triggers");
  const { getTeamRun, handOffQueuedRuns, failStaleRuns, runTeamRun } = await import("./team-run");
  const { qRaw } = await import("./db");
  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas", triggers: [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }] });
  await ageTriggers();
  const origin = "https://athena.test";

  await withHandOff(async () => {
    // A gift idea: claimed, queued and handed off straight away, labelled with what you saved.
    const fn = fakeFunction();
    const [run] = await startTeamEvent("saved", "s1", "saved", { savedAction: "gift_idea", title: "Lego Ferrari" }, { origin, fetchImpl: fn.fetchImpl });
    assert.equal(run.assistant_id, moss.id);
    assert.equal(run.status, "queued");
    assert.equal(run.label, "New gift idea: “Lego Ferrari”");
    assert.deepEqual(fn.runs, [run.id], "handed off once, now");
    assert.deepEqual(await queueTeamRuns(new Date(), TZ), [], "the pass doesn't queue it again");
    // Handed off twice (the pass catching up): it still runs once.
    await qRaw(`UPDATE team_runs SET started_at = now() - interval '1 minute' WHERE id = $1::uuid`, [run.id]);
    const pass = fakeFunction();
    assert.equal(await handOffQueuedRuns(origin, new Date(), [], pass.fetchImpl), 1);
    let turns = 0;
    const turn = async (id: string) => (turns++, result(id, { text: "Found it for £34 at Smyths." }));
    await Promise.all([runTeamRun(run.id, { turn }), runTeamRun(run.id, { turn })]);
    assert.equal(turns, 1, "one turn, however many hand-offs");
    assert.equal((await getTeamRun(run.id))!.status, "done");

    // A plain save: nobody waits for it, so nothing is queued and the event is left for the pass to mark seen.
    assert.deepEqual(await startTeamEvent("saved", "s2", "saved", { savedAction: "saved", title: "An article" }, { origin, fetchImpl: fn.fetchImpl }), []);
    assert.deepEqual(await queueTeamRuns(new Date(), TZ), []);
    const [{ open }] = await qRaw<{ open: number }>(`SELECT count(*)::int AS open FROM team_events WHERE processed_at IS NULL`);
    assert.equal(open, 0);

    // The hand-off fails: the run stays queued, the event isn't lost or matched again, and the next pass hands it off.
    const down = fakeFunction(true);
    const [stuck] = await startTeamEvent("saved", "s3", "saved", { savedAction: "gift_idea", title: "Scarf" }, { origin, fetchImpl: down.fetchImpl });
    assert.equal((await getTeamRun(stuck.id))!.status, "queued", "not failed at once");
    assert.deepEqual(await queueTeamRuns(new Date(), TZ), [], "its event was claimed with the run");
    assert.equal(await handOffQueuedRuns(origin, new Date(), [], fn.fetchImpl), 0, "too fresh: its own hand-off may still land");
    await qRaw(`UPDATE team_runs SET started_at = now() - interval '1 minute' WHERE id = $1::uuid`, [stuck.id]);
    assert.equal(await handOffQueuedRuns(origin, new Date(), [stuck.id], fn.fetchImpl), 0, "a run the pass just queued is skipped");
    assert.equal(await handOffQueuedRuns(origin, new Date(), [], fn.fetchImpl), 1);
    assert.equal(fn.runs.at(-1), stuck.id);
    // Still never picked up after 10 minutes: it fails, with a line saying so.
    await qRaw(`UPDATE team_runs SET started_at = now() - interval '11 minutes' WHERE id = $1::uuid`, [stuck.id]);
    assert.equal(await failStaleRuns(), 1);
    assert.equal((await getTeamRun(stuck.id))!.error, "The run couldn't start. Ask Moss about it in a chat.");

    // No address to hand off to: the event waits for the pass, which queues it as before.
    const saved = process.env.URL;
    delete process.env.URL;
    try {
      assert.deepEqual(await startTeamEvent("saved", "s4", "saved", { savedAction: "gift_idea", title: "Mug" }), []);
    } finally {
      if (saved !== undefined) process.env.URL = saved;
    }
    const later = await queueTeamRuns(new Date(), TZ);
    assert.equal(later.length, 1);
    assert.equal(later[0].label, "New gift idea: “Mug”");
  });
  // A save never fails because an assistant couldn't start: emitting still never throws.
  assert.equal(await emitTeamEvent("nope" as never, null, null, {}), null);
});

test("a run that fails before anything ran is tried once more; one that made something isn't", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { emitTeamEvent } = await import("./team-events");
  const { queueTeamRuns } = await import("./team-triggers");
  const { getTeamRun, runTeamRun, enqueueTeamRun, handOffQueuedRuns } = await import("./team-run");
  const { RateLimited } = await import("./ai");
  const { qRaw } = await import("./db");
  const fig = await createAssistant({ name: "Fig", job: "Sums up your week", triggers: [{ kind: "event", event: { source: "note", tag: "week" } }] });
  await ageTriggers();

  // Nothing ran: back in the queue, a second try, picked up by the next pass's hand-off.
  await emitTeamEvent("note", "n1", "note", { title: "Week notes", tags: ["week"] });
  const [run] = await queueTeamRuns(new Date(), TZ);
  const threads: string[] = [];
  const busy = async (_id: string, _p: string, opts: TurnOptions): Promise<TurnResult> => {
    threads.push(opts.threadId!);
    throw new RateLimited();
  };
  const once = await runTeamRun(run.id, { turn: busy });
  assert.equal(once!.status, "queued");
  assert.equal(once!.retried, true);
  assert.equal(once!.error, null);
  await qRaw(`UPDATE team_runs SET started_at = now() - interval '1 minute' WHERE id = $1::uuid`, [run.id]);
  const fn = fakeFunction();
  await withHandOff(() => handOffQueuedRuns("https://athena.test", new Date(), [], fn.fetchImpl));
  assert.deepEqual(fn.runs, [run.id]);
  const twice = await runTeamRun(run.id, { turn: busy });
  assert.equal(twice!.status, "failed", "the second failure is final");
  assert.equal(twice!.retried, true);
  assert.notEqual(threads[0], threads[1], "each try keeps its own conversation");

  // Something was made before it failed: trying again could make it twice, so it fails at once.
  await emitTeamEvent("note", "n2", "note", { title: "More week notes", tags: ["week"] });
  const [made] = await queueTeamRuns(new Date(), TZ);
  const halfway = await runTeamRun(made.id, {
    turn: async (_id, _p, opts) => {
      await qRaw(`INSERT INTO ask_activity (source, thread_id, payload) VALUES ('routine', $1::uuid, 'x')`, [opts.threadId]);
      throw new Error("Request timed out");
    },
  });
  assert.equal(halfway!.status, "failed");
  assert.equal(halfway!.retried, false);

  // Run now isn't retried: you're on the page and can tap it again.
  const now = await runTeamRun((await enqueueTeamRun(fig.id)).id, { turn: busy });
  assert.equal(now!.status, "failed");
  assert.equal((await getTeamRun(now!.id))!.retried, false);
});

test("a run says how many changes wait for Go, from its plan, until Go runs it", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { enqueueTeamRun, runTeamRun, getTeamRun, listTeamRuns, listTeamActivity } = await import("./team-run");
  const { savePlan } = await import("./ask-plans");
  const { qRaw } = await import("./db");
  const fig = await createAssistant({ name: "Fig", job: "Sums up your week" });
  const step = (label: string) => ({ label, tool: "add_todo", input: { title: label }, stands_for: label });
  const queued = await enqueueTeamRun(fig.id);
  assert.equal(queued.waiting, undefined, "a run just queued has no plan yet");
  const run = await runTeamRun(queued.id, {
    turn: async (id) => {
      await savePlan([step("Chase Priya"), step("Book the review")], { source: "routine", thread_id: THREAD });
      return result(id, { text: "Two to-dos wait for your approval.", plan: { id: "p", steps: [step("Chase Priya"), step("Book the review")] } as never });
    },
  });
  assert.equal(run!.waiting, 2);
  assert.equal((await listTeamRuns(fig.id))[0].waiting, 2);
  assert.equal((await listTeamActivity(5)).find((r) => r.id === run!.id)!.waiting, 2, "every list says the same");
  await qRaw(`UPDATE ask_plans SET ran_at = now() WHERE thread_id = $1::uuid`, [THREAD]);
  assert.equal((await getTeamRun(run!.id))!.waiting, 0, "nothing waits once Go has run it");
  const quiet = await runTeamRun((await enqueueTeamRun(fig.id)).id, { turn: async (id) => ({ ...result(id, { text: "Nothing to do.", found: false }), thread_id: null }) });
  assert.equal(quiet!.waiting, 0);
});

// Runs left behind would look unsent to the next reminders pass (lib/nudges.db.test.ts runs runReminders): clear them.
after(async () => {
  if (!process.env.ATHENA_TEST_DB_URL) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events CASCADE`);
});
