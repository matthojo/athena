// Flows on real Postgres with every migration (0080 included): flows made, read, changed, handed over and removed;
// the owner's words sealed at rest and the jobs' half plain; FLOW_LIMITS.flows; the starter's guards (paused, a
// slot once, never its own events); a run walked end to end with fake effects, waiting for Go and carrying on;
// Stop; the reminders job's sweep (a Wait's time, a run left waiting too long); and the routes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/flows.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the flow and team tables first. Made-up data only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Change } from "./assistant";
import type { FlowEffects } from "./flow-run";
import type { FlowStep } from "./flow-types";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE flow_runs, flows, team_events, team_runs, team_triggers, team_assistants, nudges, ask_plans CASCADE`);
});

const change = (id: string, title: string): Change => ({ kind: "commitment", id, action: "created", title, detail: "To-do", label: `${title}: To-do`, open: null, undo: null }) as unknown as Change;

function fakeFx(now = new Date("2026-11-20T08:12:00Z")): { fx: FlowEffects; calls: string[] } {
  const calls: string[] = [];
  const fx: FlowEffects = {
    now: () => now,
    tz: "Europe/London",
    askMoney: async () => false,
    runTool: async (name) => {
      calls.push(`tool:${name}`);
      return name === "add_todo" ? { result: "{}", changes: [change("00000000-0000-4000-8000-000000000001", "Ring the bank")] } : { result: JSON.stringify([{ id: "p-1", name: "Sam Example" }]), changes: [] };
    },
    log: async (c) => c,
    savePlan: async () => {
      calls.push("plan");
      const { savePlan } = await import("./ask-plans");
      return (await savePlan([{ label: "Add a to-do: Ring the bank", tool: "add_todo", input: { title: "Ring the bank", kind: "todo" }, stands_for: "x" }], { source: "routine" })).id;
    },
    goPlan: async () => {
      calls.push("go");
      return { changes: [change("00000000-0000-4000-8000-000000000002", "Ring the bank")] };
    },
    dropPlan: async () => void calls.push("drop"),
    planRan: async () => null,
    assistant: async () => null,
    think: async () => ({ text: "", changes: [], plan: null }),
    draftAssignment: async () => ({ id: "x", lineup: "" }),
    assignment: async () => null,
    noteMade: async (runId, ids) => (await import("./flows")).noteMade(runId, ids),
  };
  return { fx, calls };
}

const todoAsk: FlowStep = { id: "todo", title: null, kind: "tool", tool: "add_todo", input: { title: ["Ring the bank"], kind: ["todo"] }, go: "ask", gives: [{ key: "todo", label: "the to-do", kind: "todo" }] };
const tell: FlowStep = { id: "tell", title: null, kind: "notify", text: ["Done: ", { from: "todo", key: "todo" }] };

test("a flow is made, read, changed and removed; its words are sealed and the jobs' half is plain", { skip }, async () => {
  const { createFlow, getFlow, updateFlow, deleteFlow, listFlows } = await import("./flows");
  const { qRaw } = await import("./db");
  const made = await createFlow({ name: "Renewal guard", trigger: { kind: "event", event: { source: "collected", kind: "renewal", match: "Northwind" } }, steps: [todoAsk, tell] });
  assert.equal(made.name, "Renewal guard");
  assert.deepEqual(made.trigger_gives.map((g) => g.key), ["item", "title"]);
  assert.equal(made.paused, false);
  const [raw] = await qRaw<{ payload: string; trigger_kind: string; schedule: unknown }>(`SELECT payload, trigger_kind, schedule FROM flows WHERE id = $1`, [made.id]);
  assert.ok(!raw.payload.includes("Renewal guard") && !raw.payload.includes("Northwind"), "the words are sealed");
  assert.equal(raw.trigger_kind, "event");
  assert.deepEqual(raw.schedule, { event: { source: "collected", kind: "renewal" } });
  const changed = await updateFlow(made.id, { name: "Renewals", paused: true, money: true });
  assert.equal(changed.name, "Renewals");
  assert.equal(changed.paused, true);
  assert.equal(changed.steps.length, 2);
  await assert.rejects(() => updateFlow(made.id, { steps: [{ ...todoAsk, tool: "send_note" }] }), /can't use/);
  assert.equal((await listFlows()).length, 1);
  assert.ok(await deleteFlow(made.id));
  assert.equal(await getFlow(made.id), null);
});

test("FLOW_LIMITS.flows: the 41st is refused", { skip }, async () => {
  const { createFlow } = await import("./flows");
  const { FLOW_LIMITS } = await import("./flow-types");
  for (let i = 0; i < FLOW_LIMITS.flows; i++) await createFlow({ name: `Flow ${i}` });
  await assert.rejects(() => createFlow({ name: "One more" }), /most Athena keeps/);
});

test("the starter: paused flows don't start, a slot starts once, a run's own records never start its flow", { skip }, async () => {
  const { createFlow, createFlowSource, createFlowStarter, updateFlow, getRun, noteMade } = await import("./flows");
  const { qRaw } = await import("./db");
  const handed: string[] = [];
  const starter = createFlowStarter({ handOff: async (id) => void handed.push(id) });
  const flow = await createFlow({ name: "Daily", trigger: { kind: "schedule", days: [1, 2, 3, 4, 5], time: "08:00" }, steps: [tell].slice(0, 0) });
  assert.deepEqual((await createFlowSource().listActive()).map((f) => f.id), [flow.id]);
  const first = await starter.start(flow.id, { label: "Weekdays at 08:00", values: { date: "2026-11-20" }, slot: "2026-11-20T08:00" });
  assert.ok(first);
  assert.deepEqual(handed, [first]);
  assert.equal(await starter.start(flow.id, { label: "Weekdays at 08:00", values: {}, slot: "2026-11-20T08:00" }), null, "a slot starts once");
  const run = await getRun(first);
  assert.equal(run?.run.status, "queued");
  assert.equal(run?.run.label, "Weekdays at 08:00");
  assert.deepEqual(run?.state.values.trigger, { date: "2026-11-20" });
  // A note the run made comes back as an event: it doesn't start the flow again.
  await noteMade(first!, ["00000000-0000-4000-8000-0000000000aa"]);
  const [ev] = await qRaw<{ id: string }>(`INSERT INTO team_events (kind, ref_id, ref_kind, facets) VALUES ('note', '00000000-0000-4000-8000-0000000000aa', 'note', '{}') RETURNING id`);
  assert.equal(await starter.start(flow.id, { label: "New note", values: {}, event_ids: [String(ev.id)] }), null);
  await updateFlow(flow.id, { paused: true });
  assert.equal(await starter.start(flow.id, { label: "Run", values: {} }), null);
  assert.deepEqual(await createFlowSource().listActive(), []);
});

test("a run end to end: it waits for Go, Go carries it on, and it ends with its card kept", { skip }, async () => {
  const { createFlow, insertRun, getRun } = await import("./flows");
  const { runFlowRun, settleRun } = await import("./flow-run");
  const { qRaw } = await import("./db");
  const { fx, calls } = fakeFx();
  const flow = await createFlow({ name: "Bank", steps: [todoAsk, tell] });
  const queued = (await insertRun(flow, { label: "An email from Example Bank", values: { trigger: {} } }))!;
  const waiting = await runFlowRun(queued.run.id, { fx });
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.waits_for, "go");
  assert.equal(await runFlowRun(queued.run.id, { fx }), null, "a waiting run isn't claimed again");
  const stored = (await getRun(queued.run.id))!;
  assert.equal(stored.run.steps[0].pending?.text, "Add a to-do: Ring the bank");
  assert.ok(stored.waiting_since);
  const [raw] = await qRaw<{ state: string; label: string; plan_id: string | null }>(`SELECT state, label, plan_id FROM flow_runs WHERE id = $1`, [queued.run.id]);
  assert.ok(!raw.state.includes("Ring the bank") && !raw.label.includes("Example Bank"), "a run's words are sealed");
  assert.ok(raw.plan_id);
  // The owner was told it waits (they didn't start it by hand).
  assert.equal(stored.state.notices[0]?.key, `flow:${queued.run.id}:todo:wait`);

  const went = await settleRun(queued.run.id, { kind: "go", step_id: "todo" }, { fx });
  assert.equal(went.run.status, "queued");
  await assert.rejects(() => settleRun(queued.run.id, { kind: "go", step_id: "todo" }, { fx }), /already carrying on/);
  const done = await runFlowRun(queued.run.id, { fx });
  assert.equal(done?.status, "done");
  assert.equal(done?.steps.find((s) => s.step_id === "tell")?.line, "Told you: Done: Ring the bank");
  assert.equal(done?.summary, "1 to-do added.");
  assert.ok(done?.finished_at);
  assert.deepEqual(calls, ["plan", "go"]);
  const [made] = await qRaw<{ made: string[] }>(`SELECT made FROM flow_runs WHERE id = $1`, [queued.run.id]);
  assert.deepEqual(made.made, ["00000000-0000-4000-8000-000000000002"]);
});

test("Stop drops what it waits on; the sweep carries a Wait on and stops a run left waiting too long", { skip }, async () => {
  const { createFlow, insertRun, getRun } = await import("./flows");
  const { runFlowRun, stopRun, sweepFlowRuns } = await import("./flow-run");
  const { qRaw } = await import("./db");
  const { fx, calls } = fakeFx();
  const flow = await createFlow({ name: "Later", steps: [{ id: "w", title: null, kind: "wait", days: 1, at: null }, { id: "hi", title: null, kind: "notify", text: ["Hello"] }] });
  const r1 = (await insertRun(flow, { label: "Run now", values: {}, byHand: true }))!;
  assert.equal((await runFlowRun(r1.run.id, { fx }))?.waits_for, "time");
  const later = fakeFx(new Date("2026-11-21T09:00:00Z"));
  const handed: string[] = [];
  const report = await sweepFlowRuns({ fx: later.fx, handOff: async (id) => void handed.push(id) });
  assert.equal(report.resumed, 1);
  assert.deepEqual(handed, [r1.run.id]);
  assert.equal((await runFlowRun(r1.run.id, { fx: later.fx }))?.status, "done");

  const askFlow = await createFlow({ name: "Bank", steps: [todoAsk] });
  const r2 = (await insertRun(askFlow, { label: "Run now", values: {} }))!;
  await runFlowRun(r2.run.id, { fx });
  const stopped = await stopRun(r2.run.id, { fx });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.summary, "You stopped it.");
  assert.ok(calls.includes("drop"));

  const r3 = (await insertRun(askFlow, { label: "Run now", values: {} }))!;
  await runFlowRun(r3.run.id, { fx });
  await qRaw(`UPDATE flow_runs SET waiting_since = now() - interval '15 days' WHERE id = $1`, [r3.run.id]);
  const swept = await sweepFlowRuns({ fx: { ...fx, now: () => new Date() } });
  assert.equal(swept.stopped, 1);
  const r3now = (await getRun(r3.run.id))!;
  assert.equal(r3now.run.status, "stopped");
  assert.equal(r3now.run.steps[0].line, "Stopped: nobody answered in 14 days");
});

test("the routes: list, make, the catalogue, run by hand, hand over and take back, 404s", { skip }, async () => {
  const { handleFlowRoutes } = await import("../netlify/lib/flow-routes");
  const { createAssistant } = await import("./team");
  const { fx } = fakeFx();
  const handed: string[] = [];
  const deps = { effects: async () => fx, handOff: async (id: string) => void handed.push(id) };
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleFlowRoutes(new Request(`https://athena.example.com/api/${path}`, { method }), path.split("/"), async () => (body ?? null) as Record<string, unknown> | null, json, deps);
    return res ? { status: res.status, body: await res.json() } : null;
  };
  assert.equal((await call("POST", "flows", { name: "Morning", trigger: { kind: "schedule", days: [1], time: "7am" } }))!.status, 201);
  const list = (await call("GET", "flows"))!.body;
  assert.equal(list.max, 40);
  const id = list.flows[0].id;
  assert.equal(list.flows[0].trigger.time, "07:00");
  assert.ok((await call("GET", "flows/catalog"))!.body.entries.length > 20);
  assert.equal(await call("POST", "flows/draft", { sentence: "x" }), null, "drafting's route");
  assert.equal(await call("GET", "flows/suggestions"), null, "suggestions' route");
  assert.equal((await call("GET", "flows/not-a-flow"))!.status, 404);
  assert.equal((await call("PUT", "flows"))!.status, 405);
  const ran = (await call("POST", `flows/${id}/run`, {}))!;
  assert.equal(ran.status, 202);
  assert.equal(ran.body.run.label, "Run now");
  assert.deepEqual(handed, [ran.body.run.id]);
  assert.equal((await call("GET", `flows/runs/${ran.body.run.id}`))!.body.run.id, ran.body.run.id);
  const dry = (await call("POST", `flows/${id}/run`, { dry: true }))!;
  assert.equal(dry.body.run.dry, true);
  const muse = await createAssistant({ name: "Muse", job: "Finds good prices for gift ideas" });
  const handedTo = (await call("POST", `flows/${id}/hand`, { assistant_id: muse.id }))!.body.flow;
  assert.equal(handedTo.assistant_id, muse.id);
  assert.ok(handedTo.handed_at);
  const fresh = (await call("POST", `flows/${id}/hand`, { assistant_id: "new" }))!.body.flow;
  assert.notEqual(fresh.assistant_id, muse.id);
  assert.ok(fresh.assistant_id);
  const back = (await call("POST", `flows/${id}/take-back`))!.body.flow;
  assert.equal(back.assistant_id, null);
  assert.equal(back.handed_at, null);
  const one = (await call("GET", `flows/${id}`))!.body;
  assert.equal(one.runs.length, 2);
  assert.deepEqual((await call("DELETE", `flows/${id}`))!.body, { ok: true });
});

test("a run's cards go through the shared gate once: sent, pushed, and not sent again", { skip }, async () => {
  const { createFlow, insertRun, getRun } = await import("./flows");
  const { runFlowRun } = await import("./flow-run");
  const { deliverFlowNotices } = await import("./flow-effects");
  const { qRaw } = await import("./db");
  const { fx } = fakeFx(new Date("2026-11-20T12:00:00Z"));
  const flow = await createFlow({ name: "Hello", steps: [{ id: "hi", title: null, kind: "notify", text: ["Your parcel is out for delivery"] }] });
  const r = (await insertRun(flow, { label: "Run now", values: {} }))!;
  await runFlowRun(r.run.id, { fx });
  const pushes: Array<{ title: string; body: string; url: string }> = [];
  const deps = { canPush: true, send: async (p: { title: string; body: string; url: string }) => void pushes.push(p), quiet: null };
  const out = await deliverFlowNotices(new Date("2026-11-20T12:00:00Z"), "Europe/London", deps);
  assert.deepEqual(out, { sent: 1, held: 0 });
  assert.deepEqual(pushes, [{ title: "Hello", body: "Your parcel is out for delivery", url: `/#/flows/runs/${r.run.id}`, tag: `nudge:flow:${r.run.id}:hi` }]);
  const [n] = await qRaw<{ rule: string; key: string }>(`SELECT rule, key FROM nudges`);
  assert.deepEqual(n, { rule: "team", key: `flow:${r.run.id}:hi` });
  assert.equal((await getRun(r.run.id))!.state.notices[0].done, true);
  assert.deepEqual(await deliverFlowNotices(new Date("2026-11-20T12:05:00Z"), "Europe/London", deps), { sent: 0, held: 0 });
  assert.equal(pushes.length, 1);
});
