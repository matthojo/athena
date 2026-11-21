// Assistants' triggers become flows (lib/team-flows.ts) on real Postgres with every migration: the move on fixtures
// (each trigger kind, a paused one, a slot already run, a guest left alone, run twice), a Friday schedule that fires
// once across the switch whichever pass comes first, an event batch for an assistant, an event Team claimed before
// the move left to Team, a job flow's run kept as the assistant's run (its label, card, quiet run, waits-for-Go
// count), making and editing triggers once moved, a shared assistant's export and import round trip, a paused
// assistant's flows (handed ones too) not running, and a failed run tried once more only when nothing ran.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team-flows.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team, flow, event and nudge tables first, and leaves the move
// undone after, so other files see a copy from before it. Made-up data only.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { FlowEffects, ThinkResult } from "./flow-run";
import type { Change } from "./assistant";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
// No site address: a queued run isn't handed to a background function; the test walks it itself.
delete process.env.URL;
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";

async function clean() {
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE flow_runs, flows, flow_trigger_fires, team_runs, team_events, team_triggers, team_posts, ask_skills, team_assistants, ask_plans, ask_activity CASCADE`);
  await qRaw(`DELETE FROM settings WHERE key IN ('team.triggers_moved', 'team.routines_migrated')`);
  await qRaw(`DELETE FROM nudges WHERE key LIKE 'team:%' OR key LIKE 'flow:%'`);
}
beforeEach(async () => {
  if (url) await clean();
});
after(async () => {
  if (url) await clean();
});

/** A Friday at 17:02 in London (no daylight saving in November): two minutes after a "Fridays at 17:00" slot. */
const FRIDAY = new Date("2026-11-20T17:02:00Z");
const SLOT = "2026-11-20T17:00:00.000Z";

async function ageTriggers() {
  const { qRaw } = await import("./db");
  await qRaw(`UPDATE team_triggers SET created_at = '2026-01-01T00:00:00Z'`);
}

test("the move: each trigger kind becomes a job flow, paused stays paused, a slot that ran is kept, a guest is left alone, and twice is once", { skip }, async () => {
  const { createAssistant, getAssistant, getTrigger } = await import("./team");
  const { moveTriggers, triggersMoved, isPlainJob, JOB_TASK } = await import("./team-flows");
  const { listFlows } = await import("./flows");
  const { qRaw } = await import("./db");

  const wren = await createAssistant({ name: "Wren", job: "Sums up the week", triggers: [{ kind: "schedule", days: [5], time: "17:00" }] });
  const moss = await createAssistant({
    name: "Moss",
    job: "Finds prices for gift ideas",
    triggers: [
      { kind: "event", event: { source: "saved", savedAction: "gift-idea", match: "train" } },
      { kind: "event", event: { source: "note", tag: "gifts" }, paused: true },
    ],
  });
  await ageTriggers();
  // Wren's Friday slot already ran as a trigger.
  await qRaw(`UPDATE team_triggers SET last_slot = $1, last_fired_at = $1 WHERE assistant_id = $2::uuid`, [SLOT, wren.id]);
  // A guest (on an assignment) has no place on the team, so nothing of it moves.
  const guest = await createAssistant({ name: "Guest", job: "Helps with one assignment" });
  await qRaw(`INSERT INTO team_triggers (assistant_id, kind, days, at_time) VALUES ($1::uuid, 'schedule', '{1}', '09:00')`, [guest.id]);
  const [asg] = await qRaw<{ id: string }>(`INSERT INTO team_assignments (payload) VALUES ('{}') RETURNING id`);
  await qRaw(`UPDATE team_assistants SET assignment_id = $2::uuid WHERE id = $1::uuid`, [guest.id, asg.id]);

  assert.equal(await triggersMoved(), false);
  const first = await moveTriggers(FRIDAY);
  assert.deepEqual(first, { moved: 3, skipped: 0, done: true });
  assert.equal(await triggersMoved(), true);

  const flows = await listFlows();
  assert.equal(flows.length, 3, "one flow per trigger, none for the guest");
  for (const f of flows) {
    assert.equal(f.origin, "trigger");
    assert.ok(isPlainJob(f), "one think step: the job");
    assert.deepEqual(f.steps[0], { id: "job", title: null, kind: "think", task: [JOB_TASK], web: true, gives: [] });
  }
  const friday = flows.find((f) => f.assistant_id === wren.id)!;
  assert.deepEqual(friday.trigger, { kind: "schedule", days: [5], time: "17:00" });
  assert.equal(friday.name, "Every Friday at 17:00");
  assert.equal(friday.paused, false);
  assert.equal(friday.created_at, "2026-01-01T00:00:00.000Z", "made when its trigger was");
  const gift = flows.find((f) => f.assistant_id === moss.id && f.trigger.kind === "event" && f.trigger.event.source === "saved")!;
  assert.deepEqual(gift.trigger, { kind: "event", event: { source: "saved", savedAction: "gift-idea", match: "train" } });
  const tagged = flows.find((f) => f.assistant_id === moss.id && f.trigger.kind === "event" && f.trigger.event.source === "note")!;
  assert.equal(tagged.paused, true, "a paused trigger is a paused flow");

  // The slot it last ran for is claimed for the flow.
  const fires = await qRaw<{ fire_key: string }>(`SELECT fire_key FROM flow_trigger_fires WHERE flow_id = $1`, [friday.id]);
  assert.deepEqual(fires.map((r) => r.fire_key), [`schedule:${SLOT}`]);
  // The trigger rows stay (old runs still name them), marked moved; the assistant shows its flows as its triggers.
  const [row] = await qRaw<{ moved_at: Date | null }>(`SELECT moved_at FROM team_triggers WHERE assistant_id = $1::uuid`, [wren.id]);
  assert.ok(row.moved_at);
  const w = (await getAssistant(wren.id))!;
  assert.equal(w.triggers.length, 1);
  assert.equal(w.triggers[0].flow_id, friday.id);
  assert.equal(w.triggers[0].id, friday.id);
  assert.equal(w.triggers[0].time, "17:00");
  const old = await qRaw<{ id: string }>(`SELECT id FROM team_triggers WHERE assistant_id = $1::uuid`, [wren.id]);
  assert.ok(await getTrigger(old[0].id), "a moved trigger still resolves");
  const g = (await getAssistant(guest.id))!;
  assert.equal(g.triggers.length, 1, "the guest's row isn't moved");
  assert.equal(g.triggers[0].flow_id, undefined);

  // Twice: nothing new, nothing doubled.
  assert.deepEqual(await moveTriggers(FRIDAY), { moved: 0, skipped: 0, done: true });
  assert.equal((await listFlows()).length, 3);
  // A trigger row made since (an old tab) moves on the next pass, once.
  await qRaw(`INSERT INTO team_triggers (assistant_id, kind, days, at_time) VALUES ($1::uuid, 'schedule', '{1}', '08:00')`, [wren.id]);
  assert.equal((await moveTriggers(FRIDAY)).moved, 1);
  assert.equal((await moveTriggers(FRIDAY)).moved, 0);
  assert.equal((await listFlows()).filter((f) => f.assistant_id === wren.id).length, 2);
});

test("a move that fails part-way moves nothing: every assistant keeps running on its triggers", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { moveTriggers, triggersMoved } = await import("./team-flows");
  const { qRaw } = await import("./db");
  await createAssistant({ name: "Wren", job: "Sums up the week", triggers: [{ kind: "schedule", days: [5], time: "17:00" }] });
  await createAssistant({ name: "Moss", job: "Gift prices", triggers: [{ kind: "event", event: { source: "saved" } }] });
  // The second trigger's flow can't be made (a check, added for the test, refuses event flows): the first was.
  await qRaw(`ALTER TABLE flows ADD CONSTRAINT test_no_events CHECK (trigger_kind <> 'event')`);
  try {
    await assert.rejects(moveTriggers(FRIDAY));
  } finally {
    await qRaw(`ALTER TABLE flows DROP CONSTRAINT test_no_events`);
  }
  assert.equal(await triggersMoved(), false);
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM flows`))[0].n, 0, "not even the first");
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_triggers WHERE moved_at IS NULL`))[0].n, 2, "both still triggers");
});

for (const order of ["Team's pass first", "the move first"] as const) {
  test(`a Friday schedule fires once across the switch (${order})`, { skip }, async () => {
    await import("./flow-engine");
    const { createAssistant } = await import("./team");
    const { moveTriggers } = await import("./team-flows");
    const { queueTeamRuns } = await import("./team-triggers");
    const { runFlowTriggers } = await import("./flow-triggers-db");
    const { qRaw } = await import("./db");
    await createAssistant({ name: "Wren", job: "Sums up the week", triggers: [{ kind: "schedule", days: [5], time: "17:00" }] });
    await ageTriggers();

    const teamRuns: unknown[] = [];
    const flowRuns: unknown[] = [];
    if (order === "Team's pass first") {
      teamRuns.push(...(await queueTeamRuns(FRIDAY, TZ)));
      await moveTriggers(FRIDAY);
    } else {
      await moveTriggers(FRIDAY);
      teamRuns.push(...(await queueTeamRuns(FRIDAY, TZ)));
    }
    // Pass after pass in the window: nothing more.
    for (const at of [FRIDAY, new Date(FRIDAY.getTime() + 5 * 60_000), new Date(FRIDAY.getTime() + 10 * 60_000)]) {
      flowRuns.push(...((await runFlowTriggers(at, TZ)) ?? []));
      teamRuns.push(...(await queueTeamRuns(at, TZ)));
    }
    assert.equal(teamRuns.length + flowRuns.length, 1, "one run for the slot, whichever way");
    assert.equal(order === "Team's pass first" ? teamRuns.length : flowRuns.length, 1);
    const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM flow_runs`);
    assert.equal(n, flowRuns.length);
  });
}

test("events: an assistant's job flows take a pass's events in one batch; a plain flow runs per item; one Team claimed before the move stays Team's", { skip }, async () => {
  await import("./flow-engine");
  const { createAssistant } = await import("./team");
  const { createFlow, getRun } = await import("./flows");
  const { moveTriggers } = await import("./team-flows");
  const { emitTeamEvent } = await import("./team-events");
  const { queueTeamRuns } = await import("./team-triggers");
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { qRaw } = await import("./db");

  const moss = await createAssistant({
    name: "Moss",
    job: "Finds prices for gift ideas",
    triggers: [
      { kind: "event", event: { source: "saved", savedAction: "gift-idea" } },
      { kind: "event", event: { source: "saved" } },
    ],
  });
  await ageTriggers();
  // Before the move: Team's pass claims this one and runs it as a trigger.
  await emitTeamEvent("saved", "s0", "saved", { savedAction: "gift_idea", title: "Rosemary hand balm" });
  const before = await queueTeamRuns(new Date(), TZ);
  assert.equal(before.length, 1);

  await moveTriggers(new Date());
  await createFlow({ name: "Note each save", trigger: { kind: "event", event: { source: "saved" } }, steps: [] });
  await emitTeamEvent("saved", "s1", "saved", { savedAction: "gift_idea", title: "Wooden train set" });
  await emitTeamEvent("saved", "s2", "saved", { savedAction: "gift_idea", title: "Kite" });
  await emitTeamEvent("saved", "s3", "saved", { savedAction: "saved", title: "An article about kites" });
  // Team's pass now claims them too, but no trigger of its fires.
  assert.equal((await queueTeamRuns(new Date(), TZ)).length, 0);

  const started = (await runFlowTriggers(new Date(), TZ)) ?? [];
  const runs = await Promise.all(started.map((s) => getRun(s.run_id)));
  const mossRuns = runs.filter((r) => r!.run.assistant_id === moss.id);
  assert.equal(mossRuns.length, 1, "Moss's two job flows: one run for the pass");
  assert.equal(mossRuns[0]!.event_ids.length, 3, "all three of the pass's events, and not the one Team had");
  assert.equal(mossRuns[0]!.run.label, "3 new items");
  const plain = runs.filter((r) => !r!.run.assistant_id);
  assert.equal(plain.length, 3, "the plain flow: one run per item");
  // Nothing more on the next pass.
  assert.equal(((await runFlowTriggers(new Date(), TZ)) ?? []).length, 0);
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_runs WHERE flow_run_id IS NULL`);
  assert.equal(n, 1, "Team ran only the one it claimed before the move");
});

test("a job flow's run is the assistant's run: its label, summary, card, quiet run and waits-for-Go count, with no extra row", { skip }, async () => {
  await import("./flow-engine");
  const { createAssistant } = await import("./team");
  const { moveTriggers } = await import("./team-flows");
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun, settleRun } = await import("./flow-run");
  const { flowEffects } = await import("./flow-effects");
  const { listTeamRuns, listTeamActivity, deliverTeamNudges } = await import("./team-run");
  const { savePlan } = await import("./ask-plans");
  const { qRaw } = await import("./db");

  const wren = await createAssistant({ name: "Wren", job: "Sums up the week", personality: { tone: "calm", traits: [], pronoun: "he", greeting: "" }, triggers: [{ kind: "schedule", days: [5], time: "17:00" }] });
  await ageTriggers();
  await moveTriggers(FRIDAY);

  const asked: string[] = [];
  let reply: (threadId: string) => Promise<ThinkResult>;
  const real = await flowEffects({ now: () => FRIDAY });
  const fx: FlowEffects = {
    ...real,
    async think(_id, prompt, o) {
      asked.push(prompt);
      assert.equal(o.label, "Every Friday at 17:00");
      const thread = crypto.randomUUID();
      return reply(thread);
    },
  };

  // A run that did something and has a change waiting for Go: kept on Team, with its card.
  reply = async (thread) => {
    const plan = await savePlan([{ label: "Add a to-do: book the dentist", tool: "add_todo", input: { title: "Book the dentist", kind: "todo" }, stands_for: crypto.randomUUID() }], { source: "routine", thread_id: thread });
    return { text: "Two things slipped this week.", changes: [], plan: { id: plan.id, steps: ["Add a to-do: book the dentist"] }, thread_id: thread, summary: "Two things slipped this week. One change is ready when you are: tap Go.", quiet: false };
  };
  const [started] = (await runFlowTriggers(FRIDAY, TZ))!;
  const ran = await runFlowRun(started.run_id, { fx });
  assert.equal(ran?.status, "waiting");
  assert.match(asked[0], /^It's your scheduled time \(Every Friday at 17:00\)\. Do your job now\.$/, "asked what a Team run asked");

  const runs = await listTeamRuns(wren.id);
  assert.equal(runs.length, 1, "one row on Team: no extra quiet one");
  const r = runs[0];
  assert.equal(r.label, "Every Friday at 17:00");
  assert.equal(r.status, "done");
  assert.equal(r.summary, "Two things slipped this week. One change is ready when you are: tap Go.");
  assert.equal(r.quiet, false);
  assert.equal(r.waiting, 1, "the waits-for-Go count, from its plan");
  assert.equal(r.flow_run_id, started.run_id);
  assert.equal((await listTeamActivity()).length, 1, "on the Team page and Home too");

  // Its "From Wren" card goes through Team's own delivery, once; the flow keeps no card of its own for it.
  const sent = await deliverTeamNudges(new Date(FRIDAY.getTime() + 60_000), TZ, { canPush: false, send: async () => undefined, quiet: null });
  assert.equal(sent.sent, 1);
  const { q } = await import("./db");
  const cards = await q<{ key: string; payload: string }>(`SELECT key, payload FROM nudges WHERE key LIKE 'team:%' OR key LIKE 'flow:%'`);
  assert.deepEqual(cards.map((c) => [c.key, (JSON.parse(c.payload) as { title: string }).title]), [[`team:${r.id}`, "From Wren"]]);
  const [{ notices }] = await qRaw<{ notices: boolean }>(`SELECT notices_pending AS notices FROM flow_runs WHERE id = $1::uuid`, [started.run_id]);
  assert.equal(notices, false);
  // Team chat has its post, once.
  const posts = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_posts WHERE run_id = $1::uuid`, [r.id]);
  assert.equal(posts[0].n, 1);

  // Go from the run page: the plan runs, the run finishes, Team's row says so and nothing waits; no second post.
  const out = await settleRun(started.run_id, { kind: "go", step_id: "job" }, { fx });
  assert.equal(out.queued, true);
  await runFlowRun(started.run_id, { fx });
  const afterGo = (await listTeamRuns(wren.id))[0];
  assert.equal(afterGo.id, r.id);
  assert.equal(afterGo.waiting, 0);
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_posts WHERE run_id = $1::uuid`, [r.id]))[0].n, 1);

  // Next Friday's run had nothing to do: quiet, kept in Recent runs, no card.
  reply = async (thread) => ({ text: "All quiet. Nothing needed doing.", changes: [], plan: null, thread_id: thread, summary: "All quiet. Nothing needed doing.", quiet: true });
  const next = new Date(FRIDAY.getTime() + 7 * 86_400_000);
  const [second] = (await runFlowTriggers(next, TZ))!;
  await runFlowRun(second.run_id, { fx: { ...fx, now: () => next } });
  const quiet = (await listTeamRuns(wren.id))[0];
  assert.equal(quiet.quiet, true);
  assert.equal((await deliverTeamNudges(new Date(next.getTime() + 60_000), TZ, { canPush: false, send: async () => undefined, quiet: null })).sent, 0);
});

test("once moved: setup and Ask make job flows, editing triggers edits them, removing the assistant removes them", { skip }, async () => {
  const { createAssistant, updateAssistant, deleteAssistant, getAssistant } = await import("./team");
  const { moveTriggers, listJobFlows } = await import("./team-flows");
  const { runRoutineTool } = await import("./routines");
  const { qRaw } = await import("./db");
  await moveTriggers(new Date());

  const moss = await createAssistant({ name: "Moss", job: "Finds prices for gift ideas", triggers: [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }] });
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_triggers`))[0].n, 0, "no trigger rows");
  const [job] = await listJobFlows(moss.id);
  assert.equal(job.name, "When you file something as a gift idea");
  assert.equal(moss.triggers[0].flow_id, job.id);

  // The trigger editor sends the whole set: the kept one changes in place, a new one is a new flow.
  const edited = await updateAssistant(moss.id, { triggers: [{ id: job.id, kind: "event", event: { source: "saved", savedAction: "gift-idea" }, paused: true }, { kind: "schedule", days: [1], time: "08:30" }] });
  assert.equal(edited.triggers.length, 2);
  const flows = await listJobFlows(moss.id);
  assert.equal(flows.find((f) => f.id === job.id)?.paused, true);
  assert.deepEqual(flows.find((f) => f.id !== job.id)?.trigger, { kind: "schedule", days: [1], time: "08:30" });
  // Left out: gone.
  await updateAssistant(moss.id, { triggers: [{ kind: "schedule", days: [1], time: "09:00" }] });
  assert.deepEqual((await listJobFlows(moss.id)).map((f) => f.trigger), [{ kind: "schedule", days: [1], time: "09:00" }]);

  // Ask's save_routine: an assistant and its flow.
  let made = "";
  await runRoutineTool("save_routine", { prompt: "What slipped this week?", days: ["friday"], time: "16:00" }, (c) => ((made = c.id), "ok"));
  const routine = (await getAssistant(made))!;
  assert.equal(routine.triggers[0].flow_id, (await listJobFlows(made))[0].id);
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_triggers`))[0].n, 0);

  await deleteAssistant(moss.id);
  assert.deepEqual(await listJobFlows(moss.id), []);
});

test("sharing: export writes the flows' triggers in the format older copies read; import makes paused flows that come on with the assistant", { skip }, async () => {
  const { createAssistant, getAssistant, updateAssistant } = await import("./team");
  const { moveTriggers, listJobFlows } = await import("./team-flows");
  const { sharedFromAssistant, serialiseShared, readShared } = await import("./team-share");
  const { importAssistant } = await import("./team-share-store");
  await moveTriggers(new Date());

  const wren = await createAssistant({
    name: "Wren",
    job: "Sums up the week",
    instructions: "Keep it under ten lines.",
    triggers: [
      { kind: "schedule", days: [5], time: "17:00" },
      { kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } },
    ],
  });
  const text = serialiseShared(sharedFromAssistant(wren));
  const file = JSON.parse(text) as { triggers: unknown[] };
  // Exactly what a copy from before flows wrote and reads: kind and days and time, or kind and event. No flow ids.
  assert.deepEqual(file.triggers, [
    { kind: "schedule", days: [5], time: "17:00" },
    { kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } },
  ]);

  const { assistant, writing } = await importAssistant({ shared: readShared(JSON.parse(text)) });
  await writing;
  assert.equal(assistant.paused, true);
  const flows = await listJobFlows(assistant.id);
  assert.equal(flows.length, 2);
  assert.ok(flows.every((f) => f.paused && f.origin === "shared"), "paused flows, marked imported");
  assert.deepEqual(flows.map((f) => f.trigger), [
    { kind: "schedule", days: [5], time: "17:00" },
    { kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } },
  ]);
  // Round trip: the imported one exports the same file.
  assert.deepEqual(JSON.parse(serialiseShared(sharedFromAssistant((await getAssistant(assistant.id))!))).triggers, file.triggers);
  // Turned on, its flows come on with it.
  await updateAssistant(assistant.id, { paused: false });
  assert.ok((await listJobFlows(assistant.id)).every((f) => !f.paused));
});

test("Go from Ask's plan card on a flow's waiting change is the run's own Go: kept as that run's change, and the run carries on", { skip }, async () => {
  const { createFlow, insertRun, getRun } = await import("./flows");
  const { runFlowRun } = await import("./flow-run");
  const { flowEffects, goWaitingFlowPlan } = await import("./flow-effects");
  const { listActivity } = await import("./ask-activity");
  const flow = await createFlow({ name: "Remember the bins", trigger: { kind: "manual" }, steps: [{ id: "todo", title: null, kind: "tool", tool: "add_todo", input: { title: ["Put the bins out"], kind: ["todo"] }, go: "ask", gives: [] }] });
  const made = (await insertRun(flow, { label: "Run now", values: { trigger: {} } }))!;
  const fx = await flowEffects();
  await runFlowRun(made.run.id, { fx });
  const waiting = (await getRun(made.run.id))!;
  assert.equal(waiting.run.waits_for, "go");
  const planId = waiting.run.steps[0].pending!.plan_id;

  const handed: string[] = [];
  const went = await goWaitingFlowPlan(planId, undefined, { handOff: async (id) => void handed.push(id) });
  assert.ok(went, "a run waits on it");
  assert.deepEqual(went!.plan.ran?.results.map((x) => [x.status, x.error ?? null]), [["done", null]]);
  assert.equal(went!.changes.length, 1);
  assert.deepEqual(handed, [made.run.id], "the run carries on now");
  const activity = (await listActivity({ limit: 5 })) as unknown as Array<{ source: string; flow_run_id?: string | null }>;
  assert.ok(activity.some((e) => e.source === "flow" && e.flow_run_id === made.run.id), "What Ask did shows it as the run's");
  assert.equal(await goWaitingFlowPlan(crypto.randomUUID(), undefined), null, "a plan no run waits on: Ask's own Go");
});

/** Wren, with a Friday 17:00 job flow, moved; and fakes for its runs' turns. */
async function wrenWithJob() {
  await import("./flow-engine");
  const { createAssistant } = await import("./team");
  const { moveTriggers } = await import("./team-flows");
  const { flowEffects } = await import("./flow-effects");
  const wren = await createAssistant({ name: "Wren", job: "Sums up the week", personality: { tone: "calm", traits: [], pronoun: "he", greeting: "" }, triggers: [{ kind: "schedule", days: [5], time: "17:00" }] });
  await ageTriggers();
  await moveTriggers(FRIDAY);
  const real = await flowEffects({ now: () => FRIDAY });
  return { wren, real };
}

const busy = () => new Error("Athena's AI was busy (529)");
const deliver = async (at: Date) => (await import("./team-run")).deliverTeamNudges(at, TZ, { canPush: false, send: async () => undefined, quiet: null });

test("pausing an assistant stops every flow it runs: its job flow and a flow handed to it don't start or carry on; Run now still runs", { skip }, async () => {
  const { wren, real } = await wrenWithJob();
  const { createFlow, setFlowAssistant, insertRun, getRun } = await import("./flows");
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun } = await import("./flow-run");
  const { listTeamRuns } = await import("./team-run");
  const { qRaw } = await import("./db");

  // A flow of the owner's, handed to Wren: Fridays at 17:00, Wren thinks about it.
  const made = await createFlow({ name: "Weekly money check", trigger: { kind: "schedule", days: [5], time: "17:00" }, steps: [{ id: "think", title: null, kind: "think", task: ["Look over the week's spending"], web: false, gives: [] }] });
  const handed = await setFlowAssistant(made.id, wren.id, new Date("2026-01-01T00:00:00Z"));
  await qRaw(`UPDATE flows SET created_at = '2026-01-01T00:00:00Z'`);
  // A run of the handed flow queued before the pause (a pass that just fired), not yet walked.
  const queued = (await insertRun(handed, { label: "Every Friday at 17:00", values: { trigger: {} } }))!;
  await qRaw(`UPDATE team_assistants SET paused = true WHERE id = $1::uuid`, [wren.id]);

  let thought = 0;
  const fx: FlowEffects = { ...real, async think(_id, _p, o) { thought++; return { text: "Done.", changes: [], plan: null, thread_id: o.dry ? null : crypto.randomUUID(), summary: "Done.", quiet: false }; } };

  // The pass starts neither flow.
  assert.deepEqual((await runFlowTriggers(FRIDAY, TZ)) ?? [], []);
  // The run queued before the pause stops, saying why, and nothing thinks.
  const stopped = await runFlowRun(queued.run.id, { fx });
  assert.equal(stopped?.status, "stopped");
  assert.equal(stopped?.summary, "Stopped: Wren is paused.");
  assert.equal(thought, 0);
  assert.equal((await listTeamRuns(wren.id)).length, 0, "nothing ran, so nothing on Team");

  // Run now, by hand, still runs a paused assistant's flow, as Team's Run now did.
  const byHand = (await insertRun(handed, { label: "Run now", values: { trigger: {} }, byHand: true }))!;
  assert.equal((await runFlowRun(byHand.run.id, { fx }))?.status, "done");
  assert.equal(thought, 1);

  // Turned on again: the next Friday, both run.
  await qRaw(`UPDATE team_assistants SET paused = false WHERE id = $1::uuid`, [wren.id]);
  const next = new Date(FRIDAY.getTime() + 7 * 86_400_000);
  const started = (await runFlowTriggers(next, TZ))!;
  assert.equal(started.length, 2);
  assert.ok((await getRun(started[0].run_id))?.run);
});

test("retry: a run that failed before anything ran is tried once more on the next pass, then the owner is told once", { skip }, async () => {
  const { wren, real } = await wrenWithJob();
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun, sweepFlowRuns } = await import("./flow-run");
  const { getRun } = await import("./flows");
  const { listTeamRuns } = await import("./team-run");
  const { q, qRaw } = await import("./db");

  let tries = 0;
  const fx: FlowEffects = { ...real, async think() { tries++; throw busy(); } };
  const [started] = (await runFlowTriggers(FRIDAY, TZ))!;

  // First failure: back in the queue, marked retried, no card and no Team chat post.
  const first = await runFlowRun(started.run_id, { fx });
  assert.equal(first?.status, "queued");
  const stored = (await getRun(started.run_id))!;
  assert.equal(stored.state.retried, true);
  assert.deepEqual(stored.state.lines, [], "it starts again from where this go started");
  let [r] = await listTeamRuns(wren.id);
  assert.equal(r.status, "queued");
  assert.equal(r.retried, true, "Recent runs: Trying again shortly");
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 60_000))).sent, 0);
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_posts WHERE run_id = $1::uuid`, [r.id]))[0].n, 0);

  // The next pass hands it off again (it was queued over REHAND_SECONDS ago).
  await qRaw(`UPDATE flow_runs SET updated_at = now() - interval '2 minutes' WHERE id = $1::uuid`, [started.run_id]);
  const handed: string[] = [];
  await sweepFlowRuns({ fx, handOff: async (id) => void handed.push(id) });
  assert.deepEqual(handed, [started.run_id]);

  // Second failure is final: told once, as before, and the card says it tried twice.
  const second = await runFlowRun(started.run_id, { fx });
  assert.equal(second?.status, "failed");
  assert.equal(tries, 2);
  [r] = await listTeamRuns(wren.id);
  assert.equal(r.status, "failed");
  assert.equal(r.retried, true);
  assert.equal(r.error, "Athena's AI was busy. Try Run now in a few minutes.");
  assert.equal((await listTeamRuns(wren.id)).length, 1, "one record for the run");
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 120_000))).sent, 1);
  const cards = await q<{ key: string; payload: string }>(`SELECT key, payload FROM nudges WHERE key LIKE 'team:%' OR key LIKE 'flow:%'`);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].key, `team:${r.id}`);
  assert.ok((JSON.parse(cards[0].payload) as { why: string[] }).why.includes("Wren tried twice and won't try again on his own."));
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_posts WHERE run_id = $1::uuid`, [r.id]))[0].n, 1);
  // Never a third try.
  assert.equal(await runFlowRun(started.run_id, { fx }), null);
});

test("retry: a run that failed after a change isn't tried again, so the change never happens twice", { skip }, async () => {
  const { wren, real } = await wrenWithJob();
  const { createFlow, setFlowAssistant, insertRun } = await import("./flows");
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun } = await import("./flow-run");
  const { listTeamRuns } = await import("./team-run");

  // The job's turn changed something, then failed (lib/flow-effects.ts think says so).
  const madeThenFailed: FlowEffects = { ...real, async think() { throw Object.assign(busy(), { madeSomething: true }); } };
  const [job] = (await runFlowTriggers(FRIDAY, TZ))!;
  assert.equal((await runFlowRun(job.run_id, { fx: madeThenFailed }))?.status, "failed");
  const [r] = await listTeamRuns(wren.id);
  assert.equal(r.status, "failed");
  assert.equal(r.retried, false);
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 60_000))).sent, 1, "told at once");

  // A handed flow whose first step added a to-do, then its think step failed: the to-do isn't added again.
  const made = await createFlow({
    name: "Renewal guard",
    trigger: { kind: "manual" },
    steps: [
      { id: "todo", title: null, kind: "tool", tool: "add_todo", input: { title: ["Decide on the renewal"], kind: ["todo"] }, go: "auto", gives: [] },
      { id: "think", title: null, kind: "think", task: ["Say what to weigh up"], web: false, gives: [] },
    ],
  });
  const handed = await setFlowAssistant(made.id, wren.id);
  let added = 0;
  const fx: FlowEffects = {
    ...real,
    async runTool() {
      added++;
      return { result: "{}", changes: [{ kind: "commitment", id: crypto.randomUUID(), action: "created", title: "Decide on the renewal", detail: "To do", label: "Added a to-do: Decide on the renewal", open: null, undo: null } as unknown as Change] };
    },
    async log(changes) {
      return changes;
    },
    async think() {
      throw busy();
    },
  };
  const run = (await insertRun(handed, { label: "When something arrives", values: { trigger: {} } }))!;
  const out = await runFlowRun(run.run.id, { fx });
  assert.equal(out?.status, "failed");
  assert.equal(added, 1);
  assert.equal(await runFlowRun(run.run.id, { fx }), null, "not queued again");
  assert.equal(added, 1);
});

test("retry: a retried run that succeeds sends one card, not two", { skip }, async () => {
  const { wren, real } = await wrenWithJob();
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun } = await import("./flow-run");
  const { listTeamRuns } = await import("./team-run");
  const { q, qRaw } = await import("./db");

  let tries = 0;
  const fx: FlowEffects = {
    ...real,
    async think() {
      if (++tries === 1) throw busy();
      const thread = crypto.randomUUID();
      return { text: "Two things slipped this week.", changes: [], plan: null, thread_id: thread, summary: "Two things slipped this week: the dentist and the boiler service.", quiet: false };
    },
  };
  const [started] = (await runFlowTriggers(FRIDAY, TZ))!;
  assert.equal((await runFlowRun(started.run_id, { fx }))?.status, "queued");
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 60_000))).sent, 0);
  // Picked up again: its run on Team works again, then finishes.
  assert.equal((await runFlowRun(started.run_id, { fx }))?.status, "done");
  const runs = await listTeamRuns(wren.id);
  assert.equal(runs.length, 1, "one record for the run");
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].retried, true);
  assert.equal(runs[0].summary, "Two things slipped this week: the dentist and the boiler service.");
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 120_000))).sent, 1);
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 180_000))).sent, 0);
  const cards = await q<{ key: string }>(`SELECT key FROM nudges WHERE key LIKE 'team:%' OR key LIKE 'flow:%'`);
  assert.deepEqual(cards.map((c) => c.key), [`team:${runs[0].id}`]);
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_posts WHERE run_id = $1::uuid`, [runs[0].id]))[0].n, 1, "one Team chat post");
});

test("a run waiting to be tried again stops if its assistant is paused first: Team's record says so, with no card", { skip }, async () => {
  const { wren, real } = await wrenWithJob();
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun } = await import("./flow-run");
  const { listTeamRuns } = await import("./team-run");
  const { qRaw } = await import("./db");

  let tries = 0;
  const fx: FlowEffects = { ...real, async think() { tries++; throw busy(); } };
  const [started] = (await runFlowTriggers(FRIDAY, TZ))!;
  assert.equal((await runFlowRun(started.run_id, { fx }))?.status, "queued");
  await qRaw(`UPDATE team_assistants SET paused = true WHERE id = $1::uuid`, [wren.id]);
  const out = await runFlowRun(started.run_id, { fx });
  assert.equal(out?.status, "stopped");
  assert.equal(out?.summary, "Stopped: Wren is paused.");
  assert.equal(tries, 1);
  const [r] = await listTeamRuns(wren.id);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "Paused before it ran.");
  assert.equal((await deliver(new Date(FRIDAY.getTime() + 60_000))).sent, 0);
});
