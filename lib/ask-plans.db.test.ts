// Ask plans, routines and What Ask did on the real path: Postgres with every migration (0055 included),
// the real Anthropic client from lib/ai.ts, and the model stubbed at fetch.
//  1. A request with three changes comes back as a plan and writes nothing; Go makes all three (a to-do
//     linked to the person a step before it added); Undo all takes them back through What Ask did.
//  2. A routine's slot is claimed once; its run goes through Ask's one loop, proposing only: it
//     writes nothing, keeps an Ask conversation, and delivers a nudge with a push that opens it.
//  3. A single change runs straight away, is logged, and is undone from the log.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/ask-plans.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties nudges, routines, plans and the activity log first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  content?: unknown;
}
interface Req {
  tools: Array<{ name: string }>;
  messages: Array<{ role: string; content: string | Block[] }>;
}

const NO_SOURCES = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
const realFetch = globalThis.fetch;
let script: (req: Req) => Block[] = () => [];
let calls = 0;

/** The tool results the model has been sent so far, parsed, in order. */
function results(req: Req): Array<Record<string, unknown>> {
  return req.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result").map((b) => JSON.parse(String(b.content)))));
}

before(() => {
  if (!url) return;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") {
      const req = JSON.parse(String(init.body ?? (input instanceof Request ? await input.text() : "{}"))) as Req;
      calls++;
      const content = script(req);
      const usesTool = content.some((b) => b.type === "tool_use");
      const m = { id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      return new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/json", "request-id": "req_test" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function counts() {
  const { qRaw } = await import("./db");
  const [r] = await qRaw<{ c: number; p: number; r: number; a: number }>(
    `SELECT (SELECT count(*)::int FROM commitments) AS c, (SELECT count(*)::int FROM people) AS p, (SELECT count(*)::int FROM reminders) AS r, (SELECT count(*)::int FROM ask_activity) AS a`,
  );
  return r;
}

test("a three-step plan writes nothing; Go makes all three in order; Undo all takes them back", { skip }, async () => {
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ask_activity, ask_plans CASCADE`);
  const { runPlanTool } = await import("./assistant");
  const { runAsk } = await import("./answer");
  const { goPlan, undoPlan, getPlan } = await import("./ask-plans");
  const { logChanges, undoActivity, listActivity } = await import("./ask-activity");
  const { applyUndo } = await import("./assistant");

  const thread = "55555555-5555-4555-8555-555555555555";
  // The model: add Sam, a to-do for Sam (using the stand-in id it was given) and a reminder, then reply.
  script = (req) => {
    const done = results(req);
    if (done.length === 0) return [{ type: "tool_use", id: "t1", name: "add_person", input: { name: "Sam Okafor", step: "Add Sam Okafor to People" } }];
    if (done.length === 1) {
      assert.equal(typeof done[0].queued, "string", "queued, not made");
      return [
        { type: "tool_use", id: "t2", name: "add_todo", input: { title: "Book the venue with Sam", kind: "todo", person_id: done[0].id, step: "Add a to-do: book the venue" } },
        { type: "tool_use", id: "t3", name: "add_reminder", input: { text: "Chase the venue", date: "2026-12-01", time: "09:00", step: "Remind me to chase the venue" } },
      ];
    }
    return [{ type: "text", text: "Three changes are ready. Nothing changes until you tap Approve." }];
  };
  const was = await counts();
  const reply = await runAsk("Add Sam Okafor, a to-do to book the venue with him, and remind me on 1 December to chase it", { sources: NO_SOURCES, web: async () => false, mentions: async () => ({ found: [], missing: [] }) }, { tz: TZ, now: new Date("2026-11-10T10:00:00Z"), thread_id: thread });
  assert.ok(reply.plan, "a plan came back");
  assert.equal(reply.text, "Three changes are ready. Nothing changes until you tap Approve.", "its words, written without the answer tool, go with the plan");
  assert.deepEqual(reply.plan!.steps.map((s) => s.label), ["Add Sam Okafor to People", "Add a to-do: book the venue", "Remind me to chase the venue"]);
  assert.equal(reply.changes, undefined);
  assert.deepEqual(await counts(), was, "nothing written before Go");
  // The plan is kept sealed.
  const [raw] = await qRaw<{ payload: string; thread_id: string }>(`SELECT payload, thread_id FROM ask_plans WHERE id = $1`, [reply.plan!.id]);
  assert.match(raw.payload, /^enc:v1:/);
  assert.equal(raw.thread_id, thread);

  const run = (tool: string, input: unknown) => runPlanTool(tool, input, { tz: TZ, now: new Date("2026-11-10T10:00:00Z") });
  const go = await goPlan(reply.plan!.id, undefined, { run, log: logChanges });
  assert.deepEqual(go.plan.ran!.results.map((r) => r.status), ["done", "done", "done"]);
  assert.equal(go.changes.length, 3);
  assert.ok(go.changes.every((c) => c.activity_id && c.undo));
  const now = await counts();
  assert.deepEqual([now.c - was.c, now.p - was.p, now.r - was.r, now.a - was.a], [1, 1, 1, 3]);
  // The to-do is linked to the person Go made, not the stand-in.
  const person = go.changes[0].id;
  const [todo] = await qRaw<{ person_id: string }>(`SELECT person_id FROM commitments WHERE id = $1`, [go.changes[1].id]);
  assert.equal(todo.person_id, person);
  // A second Go runs nothing.
  const again = await goPlan(reply.plan!.id, undefined, { run: async () => assert.fail("ran twice"), log: logChanges });
  assert.equal(again.changes.length, 3);
  const log = await listActivity();
  assert.deepEqual(log.map((e) => e.source), ["plan", "plan", "plan"]);
  assert.ok(log.every((e) => e.thread_id === thread && e.plan_id === reply.plan!.id));

  const undone = await undoPlan(reply.plan!.id, (id) => undoActivity(id, (op) => applyUndo(op)));
  assert.ok(undone.results.every((r) => r.ok), JSON.stringify(undone.results));
  assert.deepEqual((await listActivity()).map((e) => e.state), ["undone", "undone", "undone"]);
  const [after] = await qRaw<{ c: string | null; p: string | null }>(`SELECT (SELECT archived_at::text FROM commitments WHERE id = $1) AS c, (SELECT archived_at::text FROM people WHERE id = $2) AS p`, [go.changes[1].id, person]);
  assert.ok(after.c && after.p, "the to-do and the person are archived, not deleted");
  assert.ok((await getPlan(reply.plan!.id))!.ran_at);
});

test("a routine runs once per slot, proposes without writing, keeps a conversation and sends a nudge that opens it", { skip }, async () => {
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ask_routines, nudges, nudge_mutes`);
  await qRaw(`DELETE FROM settings WHERE key = 'proactive'`);
  const { createRoutine, getRoutine } = await import("./routines");
  const { claimDueRoutines, runRoutine, deliverRoutines } = await import("./routine-run");
  const { runAsk } = await import("./answer");
  const { saveAskThread, listAskThreads } = await import("./ask-threads");

  const r = await createRoutine({ prompt: "Every Friday: move anything that slipped to next week", title: "What slipped", days: ["friday"], time: "16:00" }, new Date("2026-11-01T00:00:00Z"));
  const now = new Date("2026-11-13T16:02:00Z");
  const due = await claimDueRoutines(now, TZ);
  assert.deepEqual(due.map((d) => d.routine.id), [r.id]);
  assert.equal(due[0].slot.toISOString(), "2026-11-13T16:00:00.000Z");
  assert.deepEqual(await claimDueRoutines(now, TZ), [], "one run per slot");

  // One loop, no hand-off: it queues one change, which a routine never makes.
  script = (req) => {
    assert.ok(!req.tools.some((t) => t.name === "hand_off"));
    if (!results(req).length) return [{ type: "tool_use", id: "a1", name: "add_todo", input: { title: "Chase the slipped invoice", kind: "todo", due_on: "2026-11-16", step: "Add a to-do: chase the invoice on Monday" } }];
    return [{ type: "text", text: "One thing slipped: the invoice. I'd move it to Monday." }];
  };
  const was = await counts();
  const ran = await runRoutine((await getRoutine(r.id))!, due[0].slot, {
    ask: (q, o) => runAsk(q, { sources: NO_SOURCES, web: async () => false, mentions: async () => ({ found: [], missing: [] }) }, { ...o, long: true, plan: "propose", log: false }),
    saveThread: saveAskThread,
  }, { now, tz: TZ });
  assert.equal(ran.plan, true);
  assert.deepEqual(await counts(), was, "a routine's run writes nothing but its conversation");

  const thread = (await listAskThreads()).threads.find((t) => t.id === ran.thread_id)!;
  assert.equal(thread.title, "What slipped");
  const reply = thread.messages[1] as unknown as { role: string; text: string; plan: { proposed: boolean; steps: unknown[] }; changes?: unknown[] };
  assert.equal(reply.role, "answer");
  assert.equal(reply.text, "One thing slipped: the invoice. I'd move it to Monday.");
  assert.equal(reply.plan.proposed, true);
  assert.equal(reply.plan.steps.length, 1);
  assert.equal(reply.changes, undefined);

  // Delivery takes runs from the last day by the real clock (lib/routines.ts pendingNudges); the run above is pinned to 13 Nov.
  await qRaw(`UPDATE ask_routines SET last_run_at = now() WHERE id = $1::uuid`, [r.id]);
  const pushed: Array<{ title: string; url: string }> = [];
  const out = await deliverRoutines(now, TZ, { canPush: true, quiet: null, send: async (p) => pushed.push(p as { title: string; url: string }) });
  assert.deepEqual(out, { sent: 1, held: 0 });
  const [nudge] = await qRaw<{ id: string; rule: string; payload: string }>(`SELECT id, rule, payload FROM nudges WHERE key LIKE 'routine:%'`);
  assert.equal(nudge.rule, "routine");
  assert.match(nudge.payload, /^enc:v1:/);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, "What slipped");
  assert.equal(pushed[0].url, `/#/ask/nudge/${nudge.id}`);
  const { nudgeById } = await import("./proactive/store");
  assert.equal((await nudgeById(nudge.id))!.thread_id, ran.thread_id, "the card opens the conversation");
  assert.deepEqual(await deliverRoutines(now, TZ, { canPush: true, quiet: null, send: async () => assert.fail("sent twice") }), { sent: 0, held: 0 });
});

test("a run in quiet hours waits, then goes out when they end", { skip }, async () => {
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE nudges`);
  const { setPending } = await import("./routines");
  const { deliverRoutines, routineNudge } = await import("./routine-run");
  const [r] = await qRaw<{ id: string }>(`SELECT id FROM ask_routines LIMIT 1`);
  await qRaw(`UPDATE ask_routines SET last_run_at = now() WHERE id = $1`, [r.id]);
  await setPending(r.id, routineNudge({ id: r.id, title: "Late one", days: [5], time: "23:00" }, new Date("2026-11-13T23:00:00Z"), "66666666-6666-4666-8666-666666666666", "Done.", 0));
  const night = new Date("2026-11-13T23:01:00Z");
  assert.deepEqual(await deliverRoutines(night, TZ, { canPush: false, quiet: null, send: async () => undefined }), { sent: 0, held: 1 });
  assert.deepEqual(await deliverRoutines(new Date("2026-11-14T07:05:00Z"), TZ, { canPush: false, quiet: null, send: async () => undefined }), { sent: 1, held: 0 });
});

test("a single change runs straight away, is logged, and is undone from What Ask did", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { applyUndo } = await import("./assistant");
  const { runAsk } = await import("./answer");
  const { getActivity, undoActivity } = await import("./ask-activity");
  script = (req) =>
    results(req).length ? [{ type: "text", text: "Added." }] : [{ type: "tool_use", id: "s1", name: "add_todo", input: { title: "Water the plants", kind: "todo", step: "Add a to-do: water the plants" } }];
  const reply = await runAsk("Add a to-do to water the plants", { sources: NO_SOURCES, web: async () => false, mentions: async () => ({ found: [], missing: [] }) }, { tz: TZ });
  assert.equal(reply.plan, undefined);
  assert.equal(reply.changes?.length, 1);
  assert.equal(reply.text, "Added.");
  const id = reply.changes![0].activity_id!;
  assert.equal((await getActivity(id))!.source, "ask");
  const e = await undoActivity(id, (op) => applyUndo(op));
  assert.equal(e.state, "undone");
  assert.equal((await getActivity(id))!.state, "undone");
  const [row] = await qRaw<{ archived_at: string | null }>(`SELECT archived_at::text FROM commitments WHERE id = $1`, [reply.changes![0].id]);
  assert.ok(row.archived_at);
});
