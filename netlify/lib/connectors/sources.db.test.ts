// Real path for the Sources screens: the real /api routes and run executor against Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/sources.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  // Claude is never reached: every run here stops at its accounts.
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const CLIENT_ID = "1234-sources.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-sources-secret";

test("Sources: client reuse, run state, blocked_by and run items", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { handleConnectorRoutes } = await import("./routes");
  const { executeRun } = await import("./runner");
  const C = await import("../../../lib/connectors");
  const { createNote, archiveEntity, qRaw } = await import("../../../lib/db");

  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);

  const api = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    try {
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, text: await res.text() };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 400, text: `${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? "")}` };
    }
  };
  const post = async (body: unknown) => api("POST", "/connectors", body);

  // ---- reuse an own client ----
  const first = await post({ provider: "gmail", name: "Personal Gmail", account_label: "personal", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  assert.equal(first.status, 201, first.text);
  const gmail = JSON.parse(first.text);

  const second = await post({ provider: "google-calendar", name: "Personal Calendar", account_label: "personal", client_from: gmail.id });
  assert.equal(second.status, 201, second.text);
  const cal = JSON.parse(second.text);
  assert.equal(cal.has_own_client, true);
  assert.equal(cal.has_client_secret, true);
  assert.ok(!second.text.includes(CLIENT_ID) && !second.text.includes(CLIENT_SECRET), "the client is never echoed back");
  const sealed = await C.getConnectorWithSecrets(cal.id);
  assert.deepEqual(sealed!.secrets.ownClient, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, "copied sealed to sealed");
  const [raw] = await qRaw<{ credentials: string }>(`SELECT credentials FROM connectors WHERE id = $1`, [cal.id]);
  assert.ok(!raw.credentials.includes(CLIENT_ID), "sealed at rest");

  const yt = await post({ provider: "youtube", name: "YouTube", client_from: gmail.id });
  assert.equal(yt.status, 201, "YouTube shares Google's setup");

  const cross = await post({ provider: "outlook-mail", name: "Client Outlook", client_from: gmail.id });
  assert.equal(cross.status, 400, "Google's client can't become Microsoft's");
  assert.equal(cross.text.trim(), "Personal Gmail's Google setup doesn't work for Outlook");
  assert.ok(!cross.text.includes(CLIENT_ID));

  const linear = await post({ provider: "linear", name: "Linear", auth_type: "token", token: "lin_api_x", client_from: gmail.id });
  assert.equal(linear.status, 400, "a token account can't take a client");
  const both = await post({ provider: "google-calendar", name: "Work Calendar", client_from: gmail.id, client_id: "other" });
  assert.equal(both.status, 400);
  const nobody = await post({ provider: "google-calendar", name: "Work Calendar", client_from: "00000000-0000-4000-8000-000000000000" });
  assert.equal(nobody.status, 400);
  assert.match(nobody.text, /no longer exists/);

  // ---- GET /api/connectors: own clients by name only ----
  let list = await api("GET", "/connectors");
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(CLIENT_ID) && !list.text.includes(CLIENT_SECRET), "the list never carries the client");
  let state = JSON.parse(list.text);
  assert.deepEqual(state.setup.own_clients.Google, { from: gmail.id, name: "Personal Gmail" }, "the first Google account with a client");
  assert.equal(state.setup.own_clients.Microsoft, undefined);

  // ---- a run blocked by a signed-out account ----
  const created = await api("POST", "/collections", { recipe: "email-digest", name: "Email digest", label: "personal", connector_ids: [gmail.id], schedule: "daily", run_at: "07:15" });
  assert.equal(created.status, 201, created.text);
  const digest = JSON.parse(created.text);
  const run1 = await C.queueRun(digest.id, "manual");

  list = await api("GET", "/connectors");
  state = JSON.parse(list.text);
  let col = state.collections.find((c: { id: string }) => c.id === digest.id);
  assert.deepEqual(col.current_run, { id: run1.id, status: "queued", started_at: null });
  assert.equal(col.last_run, null);

  await executeRun(run1.id);
  const [done] = await C.listRuns(digest.id);
  assert.equal(done.status, "failed");
  assert.equal(done.error, "Personal Gmail is signed out");
  assert.deepEqual(done.stats.blocked_by, [gmail.id]);

  state = JSON.parse((await api("GET", "/connectors")).text);
  col = state.collections.find((c: { id: string }) => c.id === digest.id);
  assert.equal(col.current_run, null);
  assert.deepEqual({ ...col.last_run, finished_at: !!col.last_run.finished_at }, {
    id: run1.id,
    status: "failed",
    finished_at: true,
    error: "Personal Gmail is signed out",
    saved: 0,
    blocked_by: [gmail.id],
  });
  const viaCollections = JSON.parse((await api("GET", "/collections")).text).collections[0];
  assert.equal(viaCollections.last_run.id, run1.id, "GET /api/collections carries it too");

  // ---- what a run saved: the run's window, nothing either side ----
  const before = await createNote({ title: "Earlier digest note", body: "x", source: digest.source });
  await C.recordCollected({ source: digest.source, kind: "note", externalId: "m-0", recordId: before.id, title: "Earlier digest note", itemDate: "2026-11-05" });
  await qRaw(`UPDATE collected_items SET collected_at = now() - interval '2 days' WHERE external_id = 'm-0'`);
  await qRaw(`UPDATE notes SET created_at = now() - interval '2 days' WHERE id = $1`, [before.id]);

  const run2 = await C.queueRun(digest.id, "schedule");
  await C.startRun(run2.id);
  const a = await createNote({ title: "Reply to the landlord", body: "x", source: digest.source });
  await C.recordCollected({ source: digest.source, kind: "note", externalId: "m-1", recordId: a.id, title: "Reply to the landlord", itemDate: "2026-11-07", runId: run2.id });
  const b = await createNote({ title: "Dentist moved to Tuesday", body: "x", source: digest.source });
  await C.recordCollected({ source: digest.source, kind: "note", externalId: "m-2", recordId: b.id, title: "Dentist moved to Tuesday", itemDate: "2026-11-06", runId: run2.id });
  await archiveEntity("note", b.id);
  // Seen before, updated this run.
  await C.recordCollected({ source: digest.source, kind: "note", externalId: "m-0", recordId: before.id, title: "Earlier digest note (updated)", itemDate: "2026-11-05", runId: run2.id });
  // Another collection's item in the same minutes.
  const other = await createNote({ title: "Not this collection", body: "x", source: "meetings" });
  await C.recordCollected({ source: "meetings", kind: "note", externalId: "e-1", recordId: other.id, title: "Not this collection" });
  // Deleted by you: left out.
  const gone = await createNote({ title: "Deleted", body: "x", source: digest.source });
  await C.recordCollected({ source: digest.source, kind: "note", externalId: "m-3", recordId: gone.id, title: "Deleted", runId: run2.id });
  await qRaw(`DELETE FROM notes WHERE id = $1`, [gone.id]);

  // While it runs, the list says so, and the items so far show.
  state = JSON.parse((await api("GET", "/connectors")).text);
  col = state.collections.find((c: { id: string }) => c.id === digest.id);
  assert.equal(col.current_run.status, "running");
  assert.equal(col.last_run.id, run1.id, "the last finished run stays until this one ends");

  await C.finishRun(run2.id, { status: "succeeded", summary: "2 notes", stats: { notes_created: 2, notes_updated: 1, turns: 4 } });
  // Saved after the run ended: not in it.
  const later = await createNote({ title: "Later", body: "x", source: digest.source });
  await new Promise((r) => setTimeout(r, 20));
  await C.recordCollected({ source: digest.source, kind: "note", externalId: "m-4", recordId: later.id, title: "Later" });

  const items = await api("GET", `/collections/${digest.id}/runs/${run2.id}/items`);
  assert.equal(items.status, 200, items.text);
  const got = JSON.parse(items.text).items as Array<{ title: string; new: boolean; archived: boolean; kind: string; record_id: string; item_date: string | null }>;
  assert.deepEqual(
    got.map((i) => [i.title, i.new, i.archived]),
    [
      ["Reply to the landlord", true, false],
      ["Dentist moved to Tuesday", true, true],
      ["Earlier digest note (updated)", false, false],
    ],
    "new first, newest item date first; titles opened; the deleted one, the later one and the other collection's left out",
  );
  assert.deepEqual(Object.keys(got[0]).sort(), ["archived", "item_date", "kind", "new", "record_id", "title"]);
  assert.equal(got[0].record_id, a.id);

  const noItems = await api("GET", `/collections/${digest.id}/runs/${run1.id}/items`);
  assert.deepEqual(JSON.parse(noItems.text), { items: [] });
  const wrong = await api("GET", `/collections/${digest.id}/runs/00000000-0000-4000-8000-000000000000/items`);
  assert.equal(wrong.status, 404);
  const bad = await api("GET", `/collections/${digest.id}/runs/nope/items`);
  assert.equal(bad.status, 404);

  state = JSON.parse((await api("GET", "/connectors")).text);
  col = state.collections.find((c: { id: string }) => c.id === digest.id);
  assert.equal(col.last_run.id, run2.id);
  assert.equal(col.last_run.saved, 2);
  assert.deepEqual(col.last_run.blocked_by, []);

  // ---- manual collections: enabled changes nothing ----
  for (const enabled of [true, false]) {
    const m = JSON.parse((await api("POST", "/collections", { recipe: "custom", name: `Manual ${enabled}`, instructions: "Look", connector_ids: [cal.id], schedule: "manual", enabled })).text);
    assert.equal(m.next_run_at, null);
  }
  await qRaw(`UPDATE collections SET next_run_at = now() - interval '1 hour' WHERE schedule = 'manual'`);
  const claimed = await C.claimDueCollections();
  assert.equal(claimed.length, 0, "the scheduler never claims a manual collection");
  const manual = JSON.parse((await api("GET", "/collections")).text).collections.find((c: { name: string }) => c.name === "Manual false");
  // Run now hands the run to the background function: answer that call here.
  const g = globalThis as { Netlify?: unknown; fetch: typeof fetch };
  g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
  const realFetch = g.fetch;
  const handed: string[] = [];
  g.fetch = (async (input: URL | string, init?: RequestInit) => {
    if (!String(input).endsWith("/api/collect-run")) return realFetch(input, init);
    handed.push(...JSON.parse(String(init?.body)).run_ids);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    const ran = await api("POST", `/collections/${manual.id}/run`);
    assert.equal(ran.status, 202, `Run now works whether it's on or off: ${ran.text}`);
    assert.deepEqual(handed, [JSON.parse(ran.text).id]);
  } finally {
    g.fetch = realFetch;
  }
});
