// Flows end to end on real Postgres with every migration: an event goes through triggers (lib/flow-triggers-db.ts,
// plugged in by lib/flow-engine.ts) into the engine (lib/flows.ts, lib/flow-run.ts) and Ask's own tools and plan code
// (lib/flow-effects.ts), with nothing faked but the clock. Then a route sweep: every /api/flows* call the app makes
// (app/src) has a server route, in the order netlify/functions/api.ts tries them.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/flows-e2e.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the flow, team-event and activity tables first. Made-up data only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FlowStep, FlowTrigger } from "./flow-types";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
// No site address: a queued run isn't handed to the background function, so the test walks it itself.
delete process.env.URL;
const skip = !url && "set ATHENA_TEST_DB_URL";

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE flow_runs, flows, flow_trigger_fires, team_events, ask_activity, ask_plans CASCADE`);
});

const T = (key: string) => ({ from: "trigger", key });

test("a delivery email, through triggers and the engine, adds a reminder for the delivery day", { skip }, async () => {
  await import("./flow-engine");
  const { createFlow, getRun } = await import("./flows");
  const { createPurchase } = await import("./trips");
  const { emitTeamEvent } = await import("./team-events");
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun } = await import("./flow-run");
  const { flowEffects } = await import("./flow-effects");
  const { getReminder } = await import("./db");
  const { listActivity } = await import("./ask-activity");

  const trigger: FlowTrigger = { kind: "event", event: { source: "collected", kind: "delivery" } };
  const remind: FlowStep = { id: "remind", title: null, kind: "tool", tool: "add_reminder", input: { text: ["Parcel from ", T("company")], date: [T("delivery_date")], time: ["08:00"] }, go: "auto", gives: [] };
  const flow = await createFlow({ name: "Delivery day", trigger, steps: [remind], paused: false });
  assert.ok(flow.trigger_gives.some((g) => g.key === "delivery_date"), "the delivery date under triggers' own name");

  const { purchase } = await createPurchase({ retailer: "Larkspur Home", items: ["Bedside lamp"], expected_on: "2030-01-17" });
  await emitTeamEvent("collected", purchase.id, "purchase", { title: "Your order is on its way", kind: "delivery" });

  const started = await runFlowTriggers(new Date(), "Europe/London");
  assert.equal(started?.length, 1, "the engine is plugged in, and the event starts one run");
  assert.equal(started![0].flow_id, flow.id);
  assert.deepEqual(await runFlowTriggers(new Date(), "Europe/London"), [], "the event is seen: a second pass starts nothing");

  const run = await runFlowRun(started![0].run_id, { fx: await flowEffects() });
  assert.equal(run?.status, "done", run?.error ?? "");
  const stored = (await getRun(run!.id))!.run;
  assert.equal(stored.values?.trigger?.company, "Larkspur Home");

  // The reminder is real, on the delivery day, and What Ask did shows it as the flow's.
  const [entry] = await listActivity();
  assert.equal(entry.source, "flow");
  assert.deepEqual([entry.flow_id, entry.flow_run_id, entry.flow_name], [flow.id, run!.id, "Delivery day"]);
  assert.equal(entry.change.kind, "reminder");
  const reminder = (await getReminder(entry.change.id))!;
  assert.equal(reminder.text, "Parcel from Larkspur Home");
  assert.equal(new Date(reminder.remind_at).toISOString(), "2030-01-17T08:00:00.000Z", "08:00 on the delivery day, London time");
});

test("a renewal flow's change waits for Go, Go makes it, and What Ask did shows “Flow: <name>”", { skip }, async () => {
  await import("./flow-engine");
  const { createFlow, getRun } = await import("./flows");
  const { upsertAsset, getCommitment } = await import("./memory");
  const { emitTeamEvent } = await import("./team-events");
  const { runFlowTriggers } = await import("./flow-triggers-db");
  const { runFlowRun, settleRun } = await import("./flow-run");
  const { flowEffects } = await import("./flow-effects");
  const { listActivity } = await import("./ask-activity");
  const { qRaw } = await import("./db");
  const { flowRunHref, flowRunOf, flowSourceWords } = await import("../app/src/flows/activity");

  const trigger: FlowTrigger = { kind: "event", event: { source: "collected", kind: "renewal" } };
  // A change other than a reminder, a to-do or a list line would wait anyway; this to-do is set to wait.
  const decide: FlowStep = { id: "decide", title: null, kind: "tool", tool: "add_todo", input: { title: ["Decide on the ", T("company"), " renewal"], kind: ["todo"], due_on: [T("renewal_date")] }, go: "ask", gives: [{ key: "todo", label: "the to-do", kind: "todo" }] };
  const flow = await createFlow({ name: "Renewal guard", trigger, steps: [decide], paused: false });

  const asset = await upsertAsset({ name: "Home broadband", provider: "Northwind Broadband", renews_on: "2030-02-04" });
  await emitTeamEvent("collected", asset.id, "asset", { title: "Your plan renews on 4 February", kind: "renewal" });
  const [start] = (await runFlowTriggers(new Date(), "Europe/London"))!;
  assert.equal(start.flow_id, flow.id);

  const fx = await flowEffects();
  const waiting = await runFlowRun(start.run_id, { fx });
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.waits_for, "go");
  assert.equal(waiting?.steps[0].pending?.text, "Add a to-do: Decide on the Northwind Broadband renewal");
  assert.equal((await qRaw(`SELECT id FROM ask_activity`)).length, 0, "nothing is made before Go");

  const went = await settleRun(start.run_id, { kind: "go", step_id: "decide" }, { fx });
  assert.equal(went.queued, true);
  const done = await runFlowRun(start.run_id, { fx });
  assert.equal(done?.status, "done", done?.error ?? "");

  const [entry] = await listActivity();
  assert.equal(entry.source, "flow");
  assert.equal(entry.flow_run_id, start.run_id);
  assert.equal(entry.flow_name, "Renewal guard");
  // What the app shows for it (app/src/flows/activity.ts reads these fields).
  assert.equal(flowSourceWords(entry.flow_name), "Flow: Renewal guard");
  assert.equal(flowRunHref(flowRunOf(entry)!), `#/flows/runs/${start.run_id}`);
  const todo = (await getCommitment(entry.change.id))!;
  assert.equal(todo.title, "Decide on the Northwind Broadband renewal");
  assert.equal(todo.due_on, "2030-02-04");
  assert.equal((await getRun(start.run_id))!.run.steps[0].status, "done");
});

test("deleting a flow takes its claimed fires with it", { skip }, async () => {
  const { createFlow, deleteFlow } = await import("./flows");
  const { dbFlowClaims } = await import("./flow-triggers-db");
  const { qRaw } = await import("./db");
  const flow = await createFlow({ name: "Gone soon" });
  const other = await createFlow({ name: "Stays" });
  await dbFlowClaims.fire(flow.id, "event:1", new Date());
  await dbFlowClaims.fire(other.id, "event:1", new Date());
  assert.equal(await deleteFlow(flow.id), true);
  const left = await qRaw<{ flow_id: string }>(`SELECT flow_id FROM flow_trigger_fires`);
  assert.deepEqual(left.map((r) => r.flow_id), [other.id]);
});

// ---------- the route sweep ----------

/** Every app source file, tests aside. */
function appFiles(dir = join(import.meta.dirname, "../app/src")): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return appFiles(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

/** Each request(`/flows…`, { method }) the app makes, with its ids filled in. Pure. */
function appFlowCalls(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const file of appFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/request(?:<[^(]*>)?\(\s*([`"])(\/flows[^`"]*)\1(?:\s*,\s*\{([^}]*)\})?/g)) {
      const method = /method:\s*"([A-Z]+)"/.exec(m[3] ?? "")?.[1] ?? "GET";
      const paths = m[2].includes("${path}") ? ["answer", "go", "skip", "stop"].map((p) => m[2].replace("${path}", p)) : [m[2]];
      for (const p of paths) out.push({ method, path: p });
    }
  }
  return out;
}

test("route sweep: every /api/flows* call in the app has a server route", { skip }, async () => {
  const { handleFlowDraftRoutes } = await import("../netlify/lib/flow-draft-routes");
  const { handleFlowSuggestRoutes } = await import("../netlify/lib/flow-suggest-routes");
  const { handleFlowRoutes } = await import("../netlify/lib/flow-routes");
  const { createFlow, insertRun } = await import("./flows");
  const { engineFlows } = await import("./flow-engine");
  const { readSignals, listDismissed, dismissSuggestion } = await import("./flow-suggest-store");

  // api.ts tries drafting's and suggestions' routes before the engine's /api/flows/:id.
  const api = readFileSync(join(import.meta.dirname, "../netlify/functions/api.ts"), "utf8");
  const at = (s: string) => api.indexOf(s);
  assert.ok(at(`first === "flows" && second === "draft"`) > 0);
  assert.ok(at(`first === "flows" && second === "draft"`) < at(`if (first === "flows") {`), "draft before /api/flows/:id");
  assert.ok(at(`first === "flows" && second === "suggestions"`) < at(`if (first === "flows") {`), "suggestions before /api/flows/:id");
  assert.ok(api.includes("flows: engineFlows"), "suggestions read the engine's flows");

  const flow = await createFlow({ name: "Sweep", steps: [{ id: "hi", title: null, kind: "notify", text: ["Hello"] }] });
  const run = (await insertRun(flow, { label: "Run now", values: {} }))!.run;
  const fx = await (await import("./flow-effects")).flowEffects();
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  const fill = (p: string) =>
    p
      .replace(/^\/flows\/suggestions\/\$\{[^}]+\}/, "/flows/suggestions/follow-delivery-reminder")
      .replace(/^\/flows\/runs\/\$\{[^}]+\}/, `/flows/runs/${run.id}`)
      .replace(/^\/flows\/\$\{[^}]+\}/, `/flows/${flow.id}`);
  const route = async (method: string, path: string): Promise<Response | null> => {
    const segments = path.split("/").filter(Boolean);
    const req = new Request(`https://athena.example.com/api${path}`, { method });
    // What the app sends to each.
    const sent: Record<string, unknown> =
      method === "PATCH" ? { paused: true }
      : path === "/flows" ? { name: "Swept", paused: true }
      : path.endsWith("/draft") ? { sentence: "Whenever a parcel's coming, remind me" }
      : path.endsWith("/hand") ? { assistant_id: "new" }
      : path.endsWith("/run") ? { dry: false }
      : path.endsWith("/answer") ? { step_id: "hi", choice: 0 }
      : /\/(go|skip)$/.test(path) ? { step_id: "hi" }
      : {};
    const body = async () => sent;
    const [, second] = segments;
    if (second === "draft") return handleFlowDraftRoutes(req, segments, body, json, { money: async () => false, draft: async (s) => (await import("./flow-draft")).fallbackDraft(s) });
    if (second === "suggestions") return handleFlowSuggestRoutes(req, segments, json, { signals: readSignals, timeZone: async () => "Europe/London", dismissed: listDismissed, dismiss: dismissSuggestion, flows: engineFlows });
    return handleFlowRoutes(req, segments, body, json, { effects: async () => fx, handOff: async () => undefined });
  };

  // Deleting the flow goes last, so the other calls find it.
  const calls = appFlowCalls().sort((a, b) => Number(a.method === "DELETE") - Number(b.method === "DELETE"));
  for (const want of ["GET /flows", "POST /flows", "GET /flows/catalog", "POST /flows/draft", "GET /flows/suggestions", "POST /flows/runs/${encodeURIComponent(runId)}/go"]) {
    assert.ok(calls.some((c) => `${c.method} ${c.path}` === want), `the sweep found ${want}`);
  }
  for (const c of calls) {
    const path = fill(c.path);
    assert.ok(!path.includes("${"), `${c.path}: every id filled`);
    let res: Response | null = null;
    try {
      res = await route(c.method, path);
    } catch (error) {
      // Answer, Go and Skip on a run that isn't waiting: the route is there, and refuses for this run's state.
      assert.ok(/\/runs\/[^/]+\/(answer|go|skip)$/.test(path) && /already carrying on/.test(String(error)), `${c.method} ${path}: ${error}`);
      continue;
    }
    assert.ok(res, `${c.method} ${path}: no route answered`);
    assert.ok(res!.status !== 404 && res!.status !== 405, `${c.method} ${path}: ${res!.status} ${await res!.text()}`);
  }
});
