// Mentions of saved items, to-dos and Watch & read titles as graph edges (migration 0044): through the real
// /api function on Postgres. A note mentioning Rowan, a saved dress, a to-do and a book makes those edges;
// the three show on the note, on Rowan's page (through the note) and in the Graph; Ask's find tools name
// the notes; taking a mention out takes its edge away; the backfill brings back edges for old notes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/mention-edges.db.test.ts
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

type Ref = { kind: string; id: string; title: string; subtitle: string; note?: { id: string; title: string } };

test("@-mentions of saved items, to-dos and books are edges on the note, the person and the Graph", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw, backfillContentLinks } = await import("./db");
  const { saveItem } = await import("./saved");
  const { formatAthenaLink } = await import("./links");
  const { runAssistantTool } = await import("./assistant");
  const { runSavedTool } = await import("./assistant-saved");

  for (const t of ["saved_items", "commitments", "reading_items", "edges", "notes", "people"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key = 'backfill.content-links'`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(
      new Request(`https://athena.test/api${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {} as never,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const make = async (path: string, body: unknown) => {
    const r = await call("POST", path, body);
    assert.ok(r.status === 200 || r.status === 201, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  };

  const rowan = await make("/people", { name: "Rowan Hart", relationship: "niece" });
  const dress = (await saveItem({ url: "https://shop.example/green-dress", title: "Beautiful green dress", source: "app" }, { read: async () => ({ status: "failed" as const }) })).item;
  const todo = await make("/commitments", { title: "Wrap Rowan's present", due_on: "2026-12-04" });
  const book = await make("/reading", { title: "Matilda", kind: "book", author: "Roald Dahl" });

  const mention = {
    person: formatAthenaLink("person", rowan.id, "@Rowan Hart"),
    saved: formatAthenaLink("saved", dress.id, "@Beautiful green dress"),
    todo: formatAthenaLink("todo", todo.id, "@Wrap Rowan's present"),
    watch: formatAthenaLink("watch", book.id, "@Matilda"),
  };
  const body = `Birthday ideas for ${mention.person}: ${mention.saved}, and ${mention.watch}.\n\nThen ${mention.todo}.`;
  const note = await make("/notes", { title: "Rowan's birthday", body });

  // ---- the edges, under their tables' names ----
  const edges = async () =>
    (await qRaw<{ target_type: string; target_id: string; origin: string }>(`SELECT target_type, target_id, origin FROM edges WHERE source_type = 'note' AND source_id = $1 ORDER BY target_type`, [note.id])).map(
      (e) => `${e.target_type}:${e.target_id}:${e.origin}`,
    );
  assert.deepEqual(await edges(), [`commitment:${todo.id}:content`, `person:${rowan.id}:content`, `reading:${book.id}:content`, `saved:${dress.id}:content`]);

  // ---- the note's own links ----
  const onNote = (await call("GET", `/connections/note/${note.id}`)).body as { outgoing: Ref[] };
  assert.deepEqual(
    onNote.outgoing.map((c) => [c.kind, c.title, c.subtitle]).sort(),
    [["commitment", "Wrap Rowan's present", "To-do"], ["person", "Rowan Hart", "niece"], ["reading", "Matilda", "Book"], ["saved", "Beautiful green dress", "Link"]],
  );
  // The saved item, to-do and book link back to the note.
  for (const [kind, id] of [["saved", dress.id], ["commitment", todo.id], ["reading", book.id]]) {
    const back = (await call("GET", `/connections/${kind}/${id}`)).body as { backlinks: Ref[] };
    assert.deepEqual(back.backlinks.map((c) => c.id), [note.id], `${kind} links back to the note`);
  }

  // ---- Rowan's page: the three, through the note ----
  const onSophie = async () => ((await call("GET", `/connections/person/${rowan.id}`)).body as { backlinks: Ref[]; through_notes: Ref[] });
  const s1 = await onSophie();
  assert.deepEqual(s1.backlinks.map((c) => c.id), [note.id]);
  assert.deepEqual(s1.through_notes.map((c) => c.kind).sort(), ["commitment", "reading", "saved"]);
  for (const c of s1.through_notes) assert.deepEqual(c.note, { id: note.id, title: "Rowan's birthday" });

  // ---- the Graph ----
  const graph = (await call("GET", "/graph")).body as { nodes: Array<{ id: string; kind: string; title: string; degree: number }>; links: Array<{ source: string; target: string; relation: string }> };
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  assert.equal(node(dress.id)?.kind, "saved");
  assert.equal(node(dress.id)?.title, "Beautiful green dress");
  assert.equal(node(todo.id)?.kind, "commitment");
  assert.equal(node(book.id)?.kind, "reading");
  for (const id of [dress.id, todo.id, book.id]) {
    assert.ok(graph.links.some((l) => [l.source, l.target].includes(id) && [l.source, l.target].includes(note.id) && l.relation === "mentions"), "linked to the note");
  }

  // ---- Ask's find tools name the note ----
  const saved = JSON.parse(await runSavedTool("find_saved", { query: "green" }, () => "")) as Array<{ id: string; mentioned_in?: unknown }>;
  assert.deepEqual(saved.find((x) => x.id === dress.id)?.mentioned_in, [{ id: note.id, title: "Rowan's birthday" }]);
  const todos = JSON.parse((await runAssistantTool("find_todos", { query: "wrap" })).result) as Array<{ id: string; mentioned_in?: unknown }>;
  assert.deepEqual(todos[0].mentioned_in, [{ id: note.id, title: "Rowan's birthday" }]);
  const reads = JSON.parse((await runAssistantTool("find_watch_read", { query: "matilda" })).result) as Array<{ id: string; mentioned_in?: unknown }>;
  assert.deepEqual(reads[0].mentioned_in, [{ id: note.id, title: "Rowan's birthday" }]);
  const people = JSON.parse((await runAssistantTool("find_people", { query: "Rowan" })).result) as Array<{ in_their_notes?: Array<{ link: string }> }>;
  assert.deepEqual(people[0].in_their_notes?.map((x) => x.link).sort(), [mention.saved, mention.todo, mention.watch].sort(), "as links Ask can write back");

  // ---- taking the dress out takes its edge away ----
  const patched = await call("PATCH", `/notes/${note.id}`, { body: `Birthday ideas for ${mention.person}: ${mention.watch}.\n\nThen ${mention.todo}.` });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(await edges(), [`commitment:${todo.id}:content`, `person:${rowan.id}:content`, `reading:${book.id}:content`]);
  assert.deepEqual((await onSophie()).through_notes.map((c) => c.kind).sort(), ["commitment", "reading"]);
  assert.ok(!((await call("GET", "/graph")).body.nodes as Array<{ id: string }>).some((n) => n.id === dress.id), "a saved item nothing links to leaves the Graph");

  // An archived to-do drops off the note and the person.
  await qRaw(`UPDATE commitments SET archived_at = now() WHERE id = $1`, [todo.id]);
  assert.deepEqual((await onSophie()).through_notes.map((c) => c.kind), ["reading"]);
  await qRaw(`UPDATE commitments SET archived_at = NULL WHERE id = $1`, [todo.id]);

  // ---- the backfill: a note written before 0044 gets its edges ----
  await qRaw(`DELETE FROM edges WHERE source_id = $1 AND target_type IN ('commitment', 'reading')`, [note.id]);
  assert.deepEqual(await edges(), [`person:${rowan.id}:content`]);
  const first = await backfillContentLinks({ batch: 1 });
  assert.equal(first.done, true);
  assert.ok(first.synced >= 1);
  assert.deepEqual(await edges(), [`commitment:${todo.id}:content`, `person:${rowan.id}:content`, `reading:${book.id}:content`]);
  // It ran once: the next run finds it done and touches nothing.
  await qRaw(`DELETE FROM edges WHERE source_id = $1 AND target_type = 'reading'`, [note.id]);
  assert.deepEqual(await backfillContentLinks(), { synced: 0, done: true });
  assert.deepEqual(await edges(), [`commitment:${todo.id}:content`, `person:${rowan.id}:content`]);
  // Stopped part-way (no time left), it carries on where it was.
  await qRaw(`DELETE FROM settings WHERE key = 'backfill.content-links'`);
  await make("/notes", { title: "Another", body: `Reading ${mention.watch} again` });
  const partial = await backfillContentLinks({ batch: 1, budgetMs: -1 });
  assert.deepEqual(partial, { synced: 1, done: false });
  const rest = await backfillContentLinks({ batch: 1 });
  assert.equal(rest.done, true);
  assert.deepEqual(await edges(), [`commitment:${todo.id}:content`, `person:${rowan.id}:content`, `reading:${book.id}:content`]);
});
