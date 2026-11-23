// Real path for a to-do's details: the real /api function on Postgres with every migration through 0084.
// Steps, links and priority saved and read back; stored sealed; a list replaced whole; bad input refused;
// athena:// links (and description mentions) become the to-do's content edges, and go with it when deleted.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/todo-details.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("To-do details: steps, links and priority round-trip sealed, sync edges and clean up", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../functions/api")).default;
  const { qRaw, upsertPerson, createNote } = await import("../../lib/db");
  await qRaw(`DELETE FROM edges WHERE source_type = 'commitment' OR target_type = 'commitment'`);
  await qRaw(`DELETE FROM commitments`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json()) as any };
  };

  const person = await upsertPerson({ name: "Priya Shah" });
  const note = await createNote({ title: "Visa checklist", body: "", type: "note" });

  // ---- created with everything ----
  let r = await call("POST", "/commitments", {
    title: "Renew the passport",
    notes: `Ask [@Visa checklist](athena://note/${note.id}) first`,
    priority: 3,
    steps: ["Find the old passport", { text: "Get photos taken", done: true }],
    links: ["https://www.example.com/passport", { url: `athena://person/${person.id}`, title: "Priya Shah" }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body;
  assert.equal(c.priority, 3);
  assert.deepEqual(c.steps.map((s: any) => [s.text, s.done]), [["Find the old passport", false], ["Get photos taken", true]]);
  assert.deepEqual(c.links.map((l: any) => l.title), ["example.com", "Priya Shah"]);

  // Sealed at rest: neither the step text nor the address is readable in the row.
  const [raw] = await qRaw<{ steps: unknown; links: unknown }>(`SELECT steps, links FROM commitments WHERE id = $1`, [c.id]);
  assert.doesNotMatch(JSON.stringify(raw.steps), /passport/i);
  assert.doesNotMatch(JSON.stringify(raw.links), /example\.com/);

  // The note mentioned and the person linked are the to-do's content edges.
  const edges = async () =>
    (await qRaw<{ target_type: string; target_id: string }>(`SELECT target_type, target_id FROM edges WHERE source_type = 'commitment' AND source_id = $1 ORDER BY target_type`, [c.id])).map((e) => `${e.target_type}:${e.target_id}`);
  assert.deepEqual(await edges(), [`note:${note.id}`, `person:${person.id}`]);

  // ---- a tick is the whole list back, ids kept; other fields left alone ----
  const ticked = c.steps.map((s: any) => ({ ...s, done: true }));
  r = await call("PATCH", `/commitments/${c.id}`, { steps: ticked });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.steps.map((s: any) => s.id), c.steps.map((s: any) => s.id));
  assert.ok(r.body.steps.every((s: any) => s.done));
  assert.equal(r.body.links.length, 2);
  assert.equal(r.body.priority, 3);

  // ---- removing the person's link drops its edge; the description's stays ----
  r = await call("PATCH", `/commitments/${c.id}`, { links: [c.links[0]], priority: 0 });
  assert.equal(r.body.links.length, 1);
  assert.equal(r.body.priority, 0);
  assert.deepEqual(await edges(), [`note:${note.id}`]);

  // ---- clearing the description drops that edge too ----
  r = await call("PATCH", `/commitments/${c.id}`, { notes: "" });
  assert.deepEqual(await edges(), []);

  // ---- bad input is refused, not stored ----
  r = await call("PATCH", `/commitments/${c.id}`, { links: ["javascript:alert(1)"] });
  assert.equal(r.status, 400);
  r = await call("PATCH", `/commitments/${c.id}`, { priority: 7 });
  assert.equal(r.status, 400);
  r = await call("PATCH", `/commitments/${c.id}`, { steps: "Call them" });
  assert.equal(r.status, 400);

  // ---- an old to-do with no details reads as empty lists ----
  r = await call("POST", "/commitments", { title: "Plain one" });
  assert.deepEqual([r.body.steps, r.body.links, r.body.priority], [[], [], 0]);

  // ---- deleted for good: its edges go with it ----
  r = await call("PATCH", `/commitments/${c.id}`, { links: [{ url: `athena://person/${person.id}`, title: "Priya" }] });
  assert.equal((await edges()).length, 1);
  r = await call("DELETE", `/commitments/${c.id}`);
  const [left] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM edges WHERE source_type = 'commitment' AND source_id = $1`, [c.id]);
  assert.equal(left.n, 0);
});

test("To-do details from Ask, Team assistants and flows (Ask's tools), and from collections", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { q, qRaw, upsertPerson } = await import("../../lib/db");
  const { runAssistantTool, applyUndo } = await import("../../lib/assistant");
  const { getCommitment } = await import("../../lib/memory");
  const { AthenaWriter } = await import("./connectors/runner");
  await qRaw(`DELETE FROM suggestions WHERE op = 'commitment'`);
  await qRaw(`DELETE FROM edges WHERE source_type = 'commitment' OR target_type = 'commitment'`);
  await qRaw(`DELETE FROM commitments`);
  const now = new Date("2026-11-23T10:00:00Z");
  const tz = "Europe/London";
  const ask = (name: string, input: unknown) => runAssistantTool(name, input, { now, tz });
  const person = await upsertPerson({ name: "Marcus Webb" });

  // ---- add_todo with everything ----
  let r = await ask("add_todo", {
    title: "Renew the passport",
    kind: "todo",
    notes: "The old one runs out in March.",
    steps: ["Find the old passport", "Get photos taken", "Fill in the form"],
    links: ["https://www.example.com/renew", `athena://person/${person.id}`],
    priority: "high",
  });
  const id = JSON.parse(r.result).id ?? r.changes[0].id;
  let c = (await getCommitment(id))!;
  assert.deepEqual(c.steps.map((s) => s.text), ["Find the old passport", "Get photos taken", "Fill in the form"]);
  assert.equal(c.links.length, 2);
  assert.equal(c.priority, 3);
  assert.equal(c.notes, "The old one runs out in March.");
  assert.match(r.changes[0].detail, /3 steps · 2 links · High priority/);

  // A bad link is a clear error, and nothing is saved.
  await assert.rejects(() => ask("add_todo", { title: "Broken", kind: "todo", links: ["javascript:alert(1)"] }), /https addresses or athena/);

  // ---- find_todos shows step ids, so one step can be ticked ----
  const found = JSON.parse((await ask("find_todos", { query: "passport" })).result);
  assert.equal(found[0].steps.length, 3);
  assert.equal(found[0].priority, "high");
  assert.equal(found[0].description, "The old one runs out in March.");
  const [first, second] = found[0].steps;

  r = await ask("change_todo", { id, done_steps: [first.id], add_steps: ["Post it off"], remove_steps: [second.id], priority: "medium" });
  c = (await getCommitment(id))!;
  assert.deepEqual(c.steps.map((s) => [s.text, s.done]), [["Find the old passport", true], ["Fill in the form", false], ["Post it off", false]]);
  assert.equal(c.priority, 2);
  assert.equal(c.status, "open", "ticking a step leaves the to-do open");
  assert.match(r.changes[0].detail, /Medium priority · 1 step added · 1 step ticked · 1 step removed/);

  // An unknown step id is refused with where to find the right one.
  await assert.rejects(() => ask("change_todo", { id, done_steps: ["nope"] }), /find_todos/);

  // ---- Undo puts the steps and priority back as they were ----
  await applyUndo(r.changes[0].undo);
  c = (await getCommitment(id))!;
  assert.deepEqual(c.steps.map((s) => [s.text, s.done]), [["Find the old passport", false], ["Get photos taken", false], ["Fill in the form", false]]);
  assert.equal(c.priority, 3);

  // ---- links added, then cleared ----
  await ask("change_todo", { id, add_links: ["example.com/photo-rules"] });
  assert.equal((await getCommitment(id))!.links.length, 3);
  await ask("change_todo", { id, clear: ["links", "steps"] });
  c = (await getCommitment(id))!;
  assert.deepEqual([c.links.length, c.steps.length], [0, 0]);

  // ---- a collection: steps only when they're a real list of one to-do's parts ----
  const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 } as never;
  const collection = { id: "c-meet", name: "Meetings", recipe: "calendar-meetings", connector_ids: [], label: "Work", source: "calendar-meetings", instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 0, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
  const w = new AthenaWriter(collection, "run-1", stats, now, tz);
  const todo = async (fields: Record<string, unknown>) => JSON.parse(await w.run("athena_todo", { kind: "todo", confidence: 0.95, ...fields }));

  let out = await todo({
    external_id: "m1",
    title: "Send Marcus the signed contract",
    quote: "I'll get legal to sign it off, then send the countersigned copy to Marcus.",
    steps: ["Get legal's sign-off", "Send the countersigned copy"],
  });
  assert.equal(out.steps, 2);
  assert.equal((await getCommitment(out.id))!.steps.length, 2);

  // One "step" is the to-do said twice: the to-do is filed, the step isn't, and the model is told why.
  out = await todo({ external_id: "m2", title: "Book the venue", quote: "I'll book the venue.", steps: ["Book the venue for the offsite"] });
  assert.equal((await getCommitment(out.id))!.steps.length, 0);
  assert.match(out.steps, /separate actions as their own to-dos/);

  // A decision never gets steps.
  out = await todo({ external_id: "m3", kind: "decision", title: "Move the launch to March", quote: "We agreed to move the launch to March.", steps: ["Tell sales", "Update the plan"] });
  assert.equal((await getCommitment(out.id))!.steps.length, 0);

  // Below the bar it waits in Review, steps and all, and says so in the summary.
  out = await todo({ external_id: "m4", title: "Draft the hiring plan", quote: "Maybe draft the hiring plan.", confidence: 0.5, steps: ["List the roles", "Cost them"] });
  // Read through q(), which opens what's sealed.
  const [s] = await q<{ summary: string; payload: string }>(`SELECT summary, payload FROM suggestions WHERE op = 'commitment' ORDER BY created_at DESC LIMIT 1`);
  assert.match(s.summary, /\(2 steps\)/);
});
