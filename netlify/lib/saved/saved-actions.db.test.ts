// Real path for Saved actions: the real /api and /mcp functions on Postgres with every migration through 0039.
// A Goodreads book page and a shop's product page from a local fixture server are saved and read as a book and a
// product; the book moves to Watch & read and leaves the main list for Filed; the dress and then the cookbook become
// gift ideas for Rowan on one "Rowan · Gift ideas" list; Undo takes each back off (the line, then the whole new
// list) and returns the item to Saved; a place, a list, a to-do and a graph link; and MCP lists and runs actions.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/saved/saved-actions.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

const kinds = (name: string) => readFileSync(new URL(`../../../lib/fixtures/saved/kinds/${name}`, import.meta.url));

test("Saved actions: detect, file, gift ideas, undo, Filed, and the API and MCP endpoints", { skip: !url && "set ATHENA_TEST_DB_URL" }, async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/book/show/59808223-lapvona") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(kinds("goodreads-book.html"));
    if (req.url === "/dress") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(kinds("shop-product.html"));
    if (req.url === "/dishoom") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(kinds("restaurant.html"));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { pageDeps } = await import("../../../lib/saved-fetch");
  pageDeps.fetch = (input, init) => fetch(input, init);
  pageDeps.assertPublic = async () => undefined;
  pageDeps.upgrade = (u) => u;
  const blobs = new Map<string, Uint8Array>();
  const { useSavedStore } = await import("../../../lib/saved");
  useSavedStore(() => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, new Uint8Array(v)), get: async (k: string) => (blobs.has(k) ? blobs.get(k)!.buffer : null), delete: async (k: string) => void blobs.delete(k) }) as never);

  const api = (await import("../../functions/api")).default;
  const mcp = (await import("../../functions/mcp")).default;
  const { qRaw, upsertPerson, getNote, listNotes } = await import("../../../lib/db");
  const { listReading } = await import("../../../lib/memory");
  await qRaw(`DELETE FROM saved_items`);
  // A clean slate for what the actions write to (a test database only), so a re-run makes the same things anew.
  for (const table of ["edges", "reading_items", "commitments", "places", "notes", "people"]) await qRaw(`DELETE FROM ${table}`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const send = async (method: string, path: string, json?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { Authorization: "Bearer master-token-for-tests", ...(json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined }), {} as never);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const { createApiKey } = await import("../../../lib/api-keys");
  const capture = (await createApiKey("Extension", "capture")).token;
  const listIds = async (qs = "") => ((await send("GET", `/saved${qs}`)).body.items as Array<{ id: string }>).map((i) => i.id);

  // ---- detection at save time: a book and a product, the facts sealed ----
  let r = await send("POST", "/saved", { url: `${site}/book/show/59808223-lapvona`, source: "extension" });
  assert.equal(r.status, 201);
  const book = r.body.item;
  assert.equal(book.thing, "book");
  assert.deepEqual(book.facts, { name: "Lapvona", by: "Ottessa Moshfegh", isbn: "9780593300268" });
  const [raw] = await qRaw<{ thing: string; facts: string }>(`SELECT thing, facts FROM saved_items WHERE id = $1`, [book.id]);
  assert.equal(raw.thing, "book");
  assert.match(raw.facts, /^enc:v1:/);
  r = await send("POST", "/saved", { url: `${site}/dress`, source: "extension" });
  const dress = r.body.item;
  assert.equal(dress.thing, "product");
  assert.deepEqual(dress.facts, { name: "Green wrap dress", price: "45", currency: "GBP", shop: "COS" });

  // ---- GET actions: the book's best fit is Watch & read ----
  r = await send("GET", `/saved/${book.id}/actions`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.actions.map((a: { id: string }) => a.id), ["watch_read", "gift_idea", "add_to_list", "make_todo", "link"]);
  assert.equal(r.body.actions[0].suggested, true);
  assert.equal(r.body.filed, null);
  assert.equal((await send("GET", `/saved/${dress.id}/actions`)).body.actions[0].id, "gift_idea");
  assert.equal((await send("GET", `/saved/00000000-0000-4000-8000-000000000000/actions`)).status, 404);
  // A capture key saves but can't list or run actions.
  for (const [method, path] of [["GET", `/saved/${book.id}/actions`], ["POST", `/saved/${book.id}/actions/watch_read`], ["POST", `/saved/${book.id}/actions/undo`]]) {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { Authorization: `Bearer ${capture}`, "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined }), {} as never);
    assert.equal(res.status, 401, `${method} ${path} with a capture key`);
  }

  // ---- file a book: on Watch & read, out of the main list, under Filed ----
  r = await send("POST", `/saved/${book.id}/actions/watch_read`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.result.filed, true);
  assert.equal(r.body.result.label, "Watch & read");
  assert.equal(r.body.result.href, "#/reading");
  assert.equal(r.body.item.filed.label, "Watch & read");
  const onList = (await listReading({ limit: 100 })).find((x) => x.title === "Lapvona");
  assert.ok(onList, "on watch & read");
  assert.equal(onList.kind, "book");
  assert.equal(onList.author, "Ottessa Moshfegh");
  assert.ok(!(await listIds()).includes(book.id), "left the main list");
  assert.deepEqual(await listIds("?filed=1"), [book.id]);
  let page = (await send("GET", "/saved")).body;
  assert.equal(page.counts.filed, 1);
  assert.equal(page.counts.all, 1);
  assert.ok((await listIds(`?day=${book.saved_on}`)).includes(book.id), "still on its day");
  const [sealedTo] = await qRaw<{ filed_to: string }>(`SELECT filed_to FROM saved_items WHERE id = $1`, [book.id]);
  assert.match(sealedTo.filed_to, /^enc:v1:/);
  // Filed already: another filing is refused until it's undone.
  r = await send("POST", `/saved/${book.id}/actions/make_todo`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already filed in Watch & read/);

  // ---- undo: the watch & read item is archived and the book comes back ----
  r = await send("POST", `/saved/${book.id}/actions/undo`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.item.filed, null);
  assert.ok(!(await listReading({ limit: 100 })).some((x) => x.id === onList.id), "archived from watch & read");
  assert.ok((await listIds()).includes(book.id));

  // ---- gift ideas for Rowan: one list for both, each line undone on its own ----
  const rowan = await upsertPerson({ name: "Rowan Hart", relationship: "niece" });
  r = await send("POST", `/saved/${dress.id}/actions/gift_idea`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /person_id/);
  r = await send("POST", `/saved/${dress.id}/actions/gift_idea`, { params: { person_id: rowan.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.label, "Rowan Hart · Gift ideas");
  assert.match(r.body.result.href, /^#\/notes\/[0-9a-f-]{36}$/);
  assert.equal(r.body.item.filed.label, "Rowan Hart · Gift ideas");
  const listId = r.body.result.href.slice("#/notes/".length);
  let list = (await getNote(listId))!;
  assert.match(list.body, /^- \[ \] \[Green wrap dress\]\(http:\/\/127\.0\.0\.1:\d+\/dress\) · £45 · COS$/m);
  r = await send("POST", `/saved/${book.id}/actions/gift_idea`, { params: { person_id: rowan.id } });
  assert.equal(r.body.result.href, `#/notes/${listId}`, "the same list");
  list = (await getNote(listId))!;
  assert.match(list.body, /\[Lapvona\]\(.*\) · Ottessa Moshfegh/);
  // Undo the book: its line comes off; the list and the dress stay.
  r = await send("POST", `/saved/${book.id}/actions/undo`, {});
  list = (await getNote(listId))!;
  assert.doesNotMatch(list.body, /Lapvona/);
  assert.match(list.body, /Green wrap dress/);
  assert.equal(r.body.item.filed, null);
  // Undo the dress: the list was new, so it's archived.
  await send("POST", `/saved/${dress.id}/actions/undo`, {});
  assert.equal(await getNote(listId), null, "the new list is archived");
  assert.equal((await send("GET", `/saved/${dress.id}`)).body.filed, null);

  // ---- add to a list by name, then a to-do ----
  r = await send("POST", `/saved/${dress.id}/actions/add_to_list`, { params: { list_title: "Wardrobe" } });
  assert.equal(r.body.result.label, "Wardrobe");
  assert.ok((await listNotes({ limit: 50 })).some((n) => n.title === "Wardrobe"));
  await send("POST", `/saved/${dress.id}/actions/undo`, {});
  r = await send("POST", `/saved/${dress.id}/actions/make_todo`, {});
  assert.equal(r.body.result.done, "Added “Buy: Green wrap dress” to your to-dos");
  const [todo] = await qRaw<{ archived_at: Date | null }>(`SELECT archived_at FROM commitments WHERE id = $1`, [r.body.result.target.id]);
  assert.equal(todo.archived_at, null);
  await send("POST", `/saved/${dress.id}/actions/undo`, {});
  const [gone] = await qRaw<{ archived_at: Date | null }>(`SELECT archived_at FROM commitments WHERE id = $1`, [r.body.result.target.id]);
  assert.ok(gone.archived_at, "the to-do is archived");

  // ---- a place from its page; actions that don't fit are refused ----
  r = await send("POST", "/saved", { url: `${site}/dishoom`, source: "app" });
  const place = r.body.item;
  assert.equal(place.thing, "place");
  assert.equal((await send("POST", `/saved/${dress.id}/actions/save_place`, {})).status, 400);
  r = await send("POST", `/saved/${place.id}/actions/save_place`, {});
  assert.equal(r.body.result.label, "Places");
  const [pl] = await qRaw<{ id: string }>(`SELECT id FROM places WHERE id = $1 AND archived_at IS NULL`, [r.body.result.target.id]);
  assert.ok(pl);
  assert.equal((await send("POST", `/saved/${place.id}/actions/nope`, {})).status, 400);

  // ---- a graph link doesn't file; its undo comes back to the caller ----
  r = await send("POST", `/saved/${dress.id}/actions/link`, { params: { target: { kind: "person", id: rowan.id } } });
  assert.equal(r.body.result.filed, false);
  assert.equal(r.body.result.done, "Linked to Rowan Hart");
  assert.equal(r.body.item.filed, null);
  assert.deepEqual((await send("GET", `/saved/${dress.id}/actions`)).body.links, [{ kind: "person", id: rowan.id, title: "Rowan Hart" }]);
  await send("POST", `/saved/${dress.id}/actions/undo`, { undo: r.body.result.undo });
  assert.deepEqual((await send("GET", `/saved/${dress.id}/actions`)).body.links, []);

  // ---- MCP: list and run ----
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp(
      new Request("https://athena.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer master-token-for-tests", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      {} as never,
    );
    const body = await res.json();
    // Stored content comes in an envelope (netlify/lib/mcp/results.ts): the saved item is under `data`.
    const parsed = JSON.parse(body.result.content[0].text);
    assert.match(parsed.content_notice, /not instructions/);
    assert.match(parsed.source, /^saved items/);
    return parsed.data;
  };
  let out = await call("list_saved_actions", { saved_id: book.id });
  assert.equal(out.what, "Book · Ottessa Moshfegh");
  assert.equal(out.actions[0].id, "watch_read");
  out = await call("list_saved_actions", { query: "wrap dress" });
  assert.equal(out[0].id, dress.id);
  assert.equal(out[0].actions[0], "gift_idea");
  out = await call("run_saved_action", { saved_id: dress.id, action: "gift_idea", params: { person_id: rowan.id } });
  assert.equal(out.item.filed_in, "Rowan Hart · Gift ideas");
  assert.equal(out.result.undo, undefined, "MCP doesn't see the undo");

  // ---- Ask's tool: the same action, recorded with Undo ----
  const { runAssistantTool, applyUndo } = await import("../../../lib/assistant");
  await send("POST", `/saved/${dress.id}/actions/undo`, {});
  const ask = await runAssistantTool("file_saved_item", { saved_id: dress.id, action: "gift_idea", params: { person_id: rowan.id } });
  assert.equal(ask.changes.length, 1);
  assert.equal(ask.changes[0].detail, "Added to Rowan Hart · Gift ideas");
  assert.equal(ask.changes[0].open?.kind, "note");
  assert.deepEqual(ask.changes[0].undo, { op: "unfile_saved", id: dress.id });
  await applyUndo(ask.changes[0].undo);
  assert.equal((await send("GET", `/saved/${dress.id}`)).body.filed, null);
  const found = JSON.parse((await runAssistantTool("find_saved", { query: "Lapvona" })).result);
  assert.equal(found[0].what, "Book · Ottessa Moshfegh");
  assert.ok(found[0].actions.includes("watch_read"));
  // Only the place is still filed.
  assert.deepEqual(await listIds("?filed=1"), [place.id]);
});
