// Real path for to-do contexts: the real /api function and the collection runner's athena_todo on Postgres
// with every migration through 0037. The starter set; a to-do with and without contexts; a work-source item
// filed as Work and an ambiguous one left blank; the owner's correction followed next time; removing a context
// (and Undo); the owner's own contexts.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/todo-contexts.db.test.ts
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

test("To-do contexts: seeded, set by the owner, set by Athena only when clear, corrected, removed and restored", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../functions/api")).default;
  const { AthenaWriter } = await import("./connectors/runner");
  const { qRaw } = await import("../../lib/db");
  await qRaw(`DELETE FROM suggestions WHERE op = 'commitment'`);
  await qRaw(`DELETE FROM commitments`);
  await qRaw(`DELETE FROM todo_context_hints`);
  await qRaw(`DELETE FROM todo_contexts WHERE key IS NULL`);
  await qRaw(`UPDATE todo_contexts SET archived_at = NULL`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json()) as any };
  };

  // ---- the starter set ----
  let r = await call("GET", "/todo-contexts");
  assert.equal(r.status, 200);
  const all: Array<{ id: string; kind: string; key: string; name: string }> = r.body.contexts;
  assert.deepEqual(all.filter((c) => c.kind === "area").map((c) => c.name), ["Work", "Personal", "Health", "Money", "Family", "Home"]);
  assert.deepEqual(all.filter((c) => c.kind === "where").map((c) => c.name), ["Computer", "Phone", "Errands", "Home", "Office", "With someone", "Anywhere"]);
  const ctx = (kind: string, key: string) => all.find((c) => c.kind === kind && c.key === key)!.id;
  const WORK = ctx("area", "work"), PERSONAL = ctx("area", "personal"), HEALTH = ctx("area", "health");
  const COMPUTER = ctx("where", "computer"), PHONE = ctx("where", "phone"), ERRANDS = ctx("where", "errands");

  // ---- the owner's own to-dos: with and without ----
  r = await call("POST", "/commitments", { title: "Buy milk" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.area_id, r.body.where_id, r.body.context_by_athena], [null, null, false], "the owner's quick-add gets no guess");
  const milk = r.body;
  r = await call("POST", "/commitments", { title: "Draft the Q3 plan", area_id: WORK, where_id: COMPUTER });
  assert.deepEqual([r.body.area_id, r.body.where_id, r.body.context_by_athena], [WORK, COMPUTER, false]);
  const plan = r.body;
  r = await call("POST", "/commitments", { title: "x", where_id: WORK });
  assert.equal(r.status, 400, "an area can't be a where/how");
  r = await call("PATCH", `/commitments/${milk.id}`, { where_id: ERRANDS });
  assert.deepEqual([r.body.area_id, r.body.where_id], [null, ERRANDS]);
  r = await call("PATCH", `/commitments/${milk.id}`, { where_id: null });
  assert.equal(r.body.where_id, null, "null clears");
  // Titles stay sealed; contexts are plain ids.
  const [raw] = await qRaw<{ title: string; area_id: string }>(`SELECT title, area_id FROM commitments WHERE id = $1`, [plan.id]);
  assert.ok(raw.title.startsWith("enc:v1:"));
  assert.equal(raw.area_id, WORK);

  // ---- Athena filing to-dos from a collection ----
  const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 } as never;
  const collection = (source: string, label: string, recipe = "email-digest") =>
    ({ id: `c-${source}`, name: source, recipe, connector_ids: [], label, source, instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 0, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" }) as never;
  const writer = (source: string, label: string) => new AthenaWriter(collection(source, label), "run-1", stats, new Date("2026-11-06T09:00:00Z"), "Europe/London");
  const todo = async (w: InstanceType<typeof AthenaWriter>, fields: Record<string, unknown>) => {
    const out = JSON.parse(await w.run("athena_todo", { kind: "todo", confidence: 0.95, ...fields }));
    assert.equal(out.action, "created", JSON.stringify(out));
    return (await call("GET", `/commitments/${out.id}`)).body;
  };

  const work = writer("email-digest-work", "Work");
  let c = await todo(work, { external_id: "w1", title: "Send the renewal figures", quote: "Can you send the renewal figures by Friday?" });
  assert.deepEqual([c.area_id, c.where_id, c.context_by_athena], [WORK, null, true], "a work email's to-do is Work");
  const fromWork = c;

  const meetings = writer("calendar-meetings", "");
  c = await todo(meetings, { external_id: "m1", title: "Look into the thing we discussed", quote: "I'll look into it." });
  assert.deepEqual([c.area_id, c.where_id, c.context_by_athena], [null, null, false], "an ambiguous one stays blank");
  // The model's guess counts only when it's sure.
  c = await todo(meetings, { external_id: "m2", title: "Sort the venue", quote: "Sort the venue.", confidence: 0.82, area: "Family" });
  assert.equal(c.area_id, ctx("area", "family"));
  c = await todo(meetings, { external_id: "m3", title: "Sort the tickets", quote: "Sort the tickets.", confidence: 0.82, area: "Hobbies" });
  assert.equal(c.area_id, null, "an unknown name stays blank");

  const personal = writer("email-digest-personal", "Personal");
  c = await todo(personal, { external_id: "p1", title: "Call the dentist", quote: "Please call to rebook." });
  assert.deepEqual([c.area_id, c.where_id, c.context_by_athena], [HEALTH, PHONE, true], "words name Health and Phone");

  // ---- a correction is followed next time, for the same sender ----
  r = await call("POST", "/people", { name: "Gayle Ross" });
  const gayle = r.body;
  c = await todo(work, { external_id: "w2", kind: "i_owe", person_id: gayle.id, title: "Send Gayle the intro", quote: "I'll intro you." });
  assert.equal(c.area_id, WORK);
  r = await call("PATCH", `/commitments/${c.id}`, { area_id: PERSONAL });
  assert.deepEqual([r.body.area_id, r.body.context_by_athena], [PERSONAL, false], "the owner's pick, no longer Athena's");
  c = await todo(work, { external_id: "w3", kind: "i_owe", person_id: gayle.id, title: "Book lunch with Gayle", quote: "Let's get lunch." });
  assert.deepEqual([c.area_id, c.context_by_athena], [PERSONAL, true], "follows the owner's last correction for Gayle");
  c = await todo(work, { external_id: "w4", title: "Review the pricing page", quote: "Can you review it?" });
  assert.equal(c.area_id, WORK, "other senders aren't affected");

  // A to-do sent for review keeps the account's label for when it's accepted.
  const low = JSON.parse(await work.run("athena_todo", { kind: "todo", confidence: 0.5, external_id: "w5", title: "Maybe chase the auditors", quote: "might be worth chasing" }));
  assert.ok(low.suggestion_id ?? low.id, JSON.stringify(low));
  const [s] = await qRaw<{ id: string }>(`SELECT id FROM suggestions WHERE op = 'commitment' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`);
  r = await call("POST", `/suggestions/${s.id}/accept`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const accepted = (await call("GET", `/commitments/${r.body.result.id}`)).body;
  assert.equal(accepted.area_id, WORK, "accepted from Review, still Work");

  // ---- removing a context clears it from to-dos; Undo brings it back ----
  r = await call("GET", "/todo-contexts");
  assert.ok(r.body.counts[WORK] >= 3, "open to-dos per context");
  r = await call("PATCH", `/todo-contexts/${WORK}`, { archived: true });
  assert.ok(r.body.archived_at);
  assert.equal((await call("GET", `/commitments/${plan.id}`)).body.area_id, null, "removed: the to-do reads as blank");
  assert.equal((await call("GET", `/commitments/${fromWork.id}`)).body.area_id, null);
  const list = (await call("GET", "/commitments?status=open")).body;
  assert.ok((list.items ?? list).every((x: { area_id: string | null }) => x.area_id !== WORK), "and in the list");
  c = await todo(work, { external_id: "w6", title: "Send the board pack", quote: "Send the board pack." });
  assert.equal(c.area_id, null, "Athena doesn't use a removed context");
  r = await call("PATCH", `/todo-contexts/${WORK}`, { archived: false });
  assert.equal(r.body.archived_at, null);
  assert.equal((await call("GET", `/commitments/${plan.id}`)).body.area_id, WORK, "Undo: back on the to-do");

  // ---- the owner's own contexts ----
  r = await call("POST", "/todo-contexts", { kind: "where", name: "Gym", icon: "heart", colour: "orange" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const gym = r.body;
  r = await call("POST", "/todo-contexts", { kind: "where", name: " gym " });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already have a where\/how called “Gym”/);
  r = await call("POST", "/todo-contexts", { kind: "area", name: "Gym" });
  assert.equal(r.status, 201, "the same name is fine in the other kind");
  r = await call("PATCH", `/todo-contexts/${gym.id}`, { icon: "nope" });
  assert.equal(r.status, 400);
  r = await call("PATCH", `/todo-contexts/${PHONE}`, { name: "Calls" });
  assert.equal(r.body.key, "phone", "a renamed starter keeps its key");
  c = await todo(personal, { external_id: "p2", title: "Ring Mum", quote: "Ring me." });
  assert.equal(c.where_id, PHONE, "and its rules");
  c = await todo(personal, { external_id: "p3", title: "Book a gym induction", quote: "Book an induction." });
  assert.equal(c.where_id, gym.id, "the owner's own context matches its name");
  const wheres = all.filter((x) => x.kind === "where").map((x) => x.id);
  r = await call("POST", "/todo-contexts/order", { kind: "where", ids: [gym.id, ...wheres] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.contexts.find((x: { kind: string }) => x.kind === "where").id, gym.id);
  r = await call("POST", "/todo-contexts/order", { kind: "where", ids: wheres });
  assert.equal(r.status, 400, "every live one, once");

  // ---- Ask's change_todo sets, changes and clears them by name; Undo puts back only what it touched ----
  const { runRecordTool, applyRecordUndo } = await import("../../lib/assistant-records");
  let receipt: any = null;
  const askCtx = { record: (change: unknown) => ((receipt = change), JSON.stringify(change)), now: new Date(), tz: "Europe/London", capture: false };
  c = await todo(meetings, { external_id: "m4", title: "Look into the venue options", quote: "Look into venues." });
  assert.deepEqual([c.area_id, c.where_id], [null, null]);
  await runRecordTool("change_todo", { id: c.id, area: "family", where: "on the phone" }, askCtx as never);
  let after = (await call("GET", `/commitments/${c.id}`)).body;
  assert.deepEqual([after.area_id, after.where_id, after.context_by_athena], [ctx("area", "family"), PHONE, false], "names and aliases, set as the owner's");
  assert.match(receipt.detail, /Area: Family · Where: Calls/);
  await applyRecordUndo(receipt.undo, { tz: "Europe/London" });
  after = (await call("GET", `/commitments/${c.id}`)).body;
  assert.deepEqual([after.area_id, after.where_id], [null, null], "Undo");
  await runRecordTool("change_todo", { id: fromWork.id, where: "Computer" }, askCtx as never);
  after = (await call("GET", `/commitments/${fromWork.id}`)).body;
  assert.deepEqual([after.area_id, after.where_id], [WORK, COMPUTER], "the area it had stays");
  await runRecordTool("change_todo", { id: fromWork.id, clear: ["area"] }, askCtx as never);
  after = (await call("GET", `/commitments/${fromWork.id}`)).body;
  assert.deepEqual([after.area_id, after.where_id], [null, COMPUTER], "clear empties one");
  await assert.rejects(runRecordTool("change_todo", { id: fromWork.id, area: "Hobbies" }, askCtx as never), /No area called “Hobbies”. Areas: Work, Personal/);

  // Put the starter names back for other runs.
  await call("PATCH", `/todo-contexts/${PHONE}`, { name: "Phone" });
  await qRaw(`UPDATE todo_contexts SET position = CASE key WHEN 'computer' THEN 0 WHEN 'phone' THEN 1 WHEN 'errands' THEN 2 WHEN 'home' THEN 3 WHEN 'office' THEN 4 WHEN 'with_someone' THEN 5 WHEN 'anywhere' THEN 6 ELSE position END WHERE kind = 'where'`);
  await qRaw(`DELETE FROM commitments`);
  await qRaw(`DELETE FROM todo_context_hints`);
  await qRaw(`DELETE FROM todo_contexts WHERE key IS NULL`);
});
