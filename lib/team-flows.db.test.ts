// Assistants' triggers become flows (lib/team-flows.ts) on real Postgres with every migration: the move on fixtures
// (each trigger kind, a paused one, a slot already run, a guest left alone, run twice), a Friday schedule that fires
// once across the switch whichever pass comes first, an event batch for an assistant, an event Team claimed before
// the move left to Team, a job flow's run kept as the assistant's run (its label, card, quiet run, waits-for-Go
// count), making and editing triggers once moved, and a shared assistant's export and import round trip.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team-flows.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team, flow, event and nudge tables first, and leaves the move
// undone after, so other files see a copy from before it. Made-up data only.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { FlowEffects, ThinkResult } from "./flow-run";

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
  const muse = await createAssistant({
    name: "Muse",
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
  const gift = flows.find((f) => f.assistant_id === muse.id && f.trigger.kind === "event" && f.trigger.event.source === "saved")!;
  assert.deepEqual(gift.trigger, { kind: "event", event: { source: "saved", savedAction: "gift-idea", match: "train" } });
  const tagged = flows.find((f) => f.assistant_id === muse.id && f.trigger.kind === "event" && f.trigger.event.source === "note")!;
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
  await createAssistant({ name: "Muse", job: "Gift prices", triggers: [{ kind: "event", event: { source: "saved" } }] });
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

  const muse = await createAssistant({
    name: "Muse",
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
  const museRuns = runs.filter((r) => r!.run.assistant_id === muse.id);
  assert.equal(museRuns.length, 1, "Muse's two job flows: one run for the pass");
  assert.equal(museRuns[0]!.event_ids.length, 3, "all three of the pass's events, and not the one Team had");
  assert.equal(museRuns[0]!.run.label, "3 new items");
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

  const muse = await createAssistant({ name: "Muse", job: "Finds prices for gift ideas", triggers: [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }] });
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_triggers`))[0].n, 0, "no trigger rows");
  const [job] = await listJobFlows(muse.id);
  assert.equal(job.name, "When you file something as a gift idea");
  assert.equal(muse.triggers[0].flow_id, job.id);

  // The trigger editor sends the whole set: the kept one changes in place, a new one is a new flow.
  const edited = await updateAssistant(muse.id, { triggers: [{ id: job.id, kind: "event", event: { source: "saved", savedAction: "gift-idea" }, paused: true }, { kind: "schedule", days: [1], time: "08:30" }] });
  assert.equal(edited.triggers.length, 2);
  const flows = await listJobFlows(muse.id);
  assert.equal(flows.find((f) => f.id === job.id)?.paused, true);
  assert.deepEqual(flows.find((f) => f.id !== job.id)?.trigger, { kind: "schedule", days: [1], time: "08:30" });
  // Left out: gone.
  await updateAssistant(muse.id, { triggers: [{ kind: "schedule", days: [1], time: "09:00" }] });
  assert.deepEqual((await listJobFlows(muse.id)).map((f) => f.trigger), [{ kind: "schedule", days: [1], time: "09:00" }]);

  // Ask's save_routine: an assistant and its flow.
  let made = "";
  await runRoutineTool("save_routine", { prompt: "What slipped this week?", days: ["friday"], time: "16:00" }, (c) => ((made = c.id), "ok"));
  const routine = (await getAssistant(made))!;
  assert.equal(routine.triggers[0].flow_id, (await listJobFlows(made))[0].id);
  assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_triggers`))[0].n, 0);

  await deleteAssistant(muse.id);
  assert.deepEqual(await listJobFlows(muse.id), []);
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
