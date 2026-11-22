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
