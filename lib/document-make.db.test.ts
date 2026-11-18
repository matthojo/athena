// Real path: a note made into a file to download, through the real /api function on Postgres with every
// migration (files in an in-memory blob store). Markdown and Word are made, kept sealed and linked to the
// note, and sent back as attachments under the note's name, only to the bearer token. Asking again for a
// note that hasn't changed gives the same file. Ask's make_document leaves a "document" receipt, can be on
// an assistant's allowlist, and its Undo deletes the file.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/document-make.db.test.ts
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

test("a note becomes a Markdown or Word file: made, sealed, downloaded, reused, undone", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw, createNote, updateNote } = await import("./db");
  const { useFileStore, saveFile, listNoteFiles, fileBlocks } = await import("./files");
  const { documentsForNote, makeDocument } = await import("./document-make-db");
  const { DOCX_TYPE } = await import("./assignment-types");
  const { runAssistantTool, TOOLS } = await import("./assistant");
  const { allowableTools } = await import("./team-chat");

  const blobs = new Map<string, ArrayBuffer>();
  useFileStore(() => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, v), get: async (k: string) => blobs.get(k) ?? null, delete: async (k: string) => void blobs.delete(k) }) as never);
  for (const t of ["note_files", "files", "notes"]) await qRaw(`DELETE FROM ${t}`);

  const send = (method: string, path: string, body?: unknown, token: string | null = "master-token-for-tests") =>
    api(
      new Request(`https://athena.test/api${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {} as never,
    );
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await send(method, path, body);
    return { status: res.status, body: (await res.json()) as any };
  };

  const body = "Flights **booked** for [@Priya](athena://person/5a3e0000-0000-4000-8000-00000000d0c1).\n\n- [x] Passport\n- [ ] Hotel\n\n| Item | Cost |\n|---|--:|\n| Flights | £240 |";
  const note = await createNote({ title: "Lisbon: trip plan – café", body, type: "note", source: "manual", tags: [] });

  // ---- Markdown: the note as written ----
  const md = await call("POST", `/notes/${note.id}/document`, { format: "md" });
  assert.equal(md.status, 201);
  assert.equal(md.body.document.note_id, note.id);
  assert.equal(md.body.document.format, "md");
  assert.equal(md.body.document.name, "Lisbon trip plan – café.md");
  const mdFile = await send("GET", `/files/${md.body.document.file_id}/download`);
  assert.equal(mdFile.status, 200);
  assert.equal(mdFile.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(mdFile.headers.get("content-disposition"), `attachment; filename="Lisbon trip plan _ caf_.md"; filename*=UTF-8''${encodeURIComponent("Lisbon trip plan – café.md")}`);
  assert.equal(mdFile.headers.get("cache-control"), "private, no-store");
  assert.equal(await mdFile.text(), `# Lisbon: trip plan – café\n\n${body}\n`);
  assert.equal(md.body.document.size, Buffer.byteLength(`# Lisbon: trip plan – café\n\n${body}\n`));

  // ---- Word ----
  const docx = await call("POST", `/notes/${note.id}/document`, { format: "docx" });
  assert.equal(docx.status, 201);
  assert.equal(docx.body.document.name, "Lisbon trip plan – café.docx");
  const docxFile = await send("GET", `/files/${docx.body.document.file_id}/download`);
  assert.equal(docxFile.headers.get("content-type"), DOCX_TYPE);
  assert.match(docxFile.headers.get("content-disposition") ?? "", /^attachment; filename="Lisbon trip plan _ caf_\.docx"; filename\*=UTF-8''/);
  const bytes = Buffer.from(await docxFile.arrayBuffer());
  assert.equal(bytes.length, docx.body.document.size);
  assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");
  const text = bytes.toString("utf8");
  for (const has of ["word/document.xml", "Flights ", ">booked<", ">Priya<", "☑ ", "☐ ", "<w:tbl>", "£240"]) assert.ok(text.includes(has), has);
  assert.ok(!text.includes("athena://"));

  // Kept like any file: sealed bytes, a sealed name, linked to the note.
  const kept = Buffer.from(blobs.get(docx.body.document.file_id)!);
  assert.ok(!kept.includes("word/document.xml") && !kept.subarray(0, 2).equals(Buffer.from("PK")));
  const [row] = await qRaw<{ name: string; type: string }>(`SELECT name, type FROM files WHERE id = $1`, [docx.body.document.file_id]);
  assert.equal(row.type, DOCX_TYPE);
  assert.ok(!row.name.includes("Lisbon"));
  assert.deepEqual((await listNoteFiles(note.id)).map((f) => f.id), [md.body.document.file_id, docx.body.document.file_id]);
  assert.deepEqual(await documentsForNote(note.id), [docx.body.document, md.body.document]);
  // Claude reads the note, not the zip.
  const read = await fileBlocks([docx.body.document.file_id]);
  assert.deepEqual([read.blocks.length, read.skipped], [0, ["Lisbon trip plan – café.docx"]]);

  // ---- the same note again: the same file; a changed note: a new one ----
  assert.equal((await makeDocument(note.id, "docx")).file_id, docx.body.document.file_id);
  assert.equal((await call("POST", `/notes/${note.id}/document`, { format: "md" })).body.document.file_id, md.body.document.file_id);
  await updateNote(note.id, { body: `${body}\n\nSeat 14A.` });
  const again = await makeDocument(note.id, "docx");
  assert.notEqual(again.file_id, docx.body.document.file_id);
  assert.equal((await documentsForNote(note.id)).length, 3);

  // ---- what's turned away ----
  assert.equal((await send("POST", `/notes/${note.id}/document`, { format: "md" }, null)).status, 401);
  assert.equal((await send("GET", `/files/${md.body.document.file_id}/download`, undefined, null)).status, 401);
  assert.equal((await send("GET", `/files/${md.body.document.file_id}/download`, undefined, "wrong")).status, 401);
  assert.equal((await call("POST", `/notes/${note.id}/document`, { format: "pdf" })).status, 400);
  assert.equal((await call("POST", `/notes/${note.id}/document`, {})).status, 400);
  assert.equal((await call("GET", `/notes/${note.id}/document`)).status, 405);
  assert.equal((await call("POST", `/notes/5a3e0000-0000-4000-8000-00000000d0c1/document`, { format: "md" })).status, 404);
  assert.equal((await call("GET", `/files/${md.body.document.file_id}/else`)).status, 404);
  assert.equal((await call("GET", `/files/5a3e0000-0000-4000-8000-00000000d0c1/download`)).status, 404);
  const empty = await createNote({ title: "", body: "", type: "note", source: "manual", tags: [] });
  assert.deepEqual(await call("POST", `/notes/${empty.id}/document`, { format: "docx" }), { status: 400, body: { error: "There's nothing in that note yet" } });
  // An uploaded zip is still not a file Athena keeps, whatever it says it is.
  await assert.rejects(saveFile({ id: "5a3e0000-0000-4000-8000-00000000d0c2", name: "x.docx", type: DOCX_TYPE, bytes: bytes, link: { note: note.id } }), /photos, screenshots, PDFs and text files/);

  // ---- Ask's make_document: a receipt, and Undo deletes the file ----
  assert.ok(allowableTools(TOOLS).includes("make_document"));
  const second = await createNote({ title: "Weekly review", body: "## Went well\n\nShipped the **pricing page**.", type: "note", source: "manual", tags: [] });
  const run = await runAssistantTool("make_document", { note_id: second.id, format: "docx" });
  assert.equal(run.changes.length, 1);
  const change = run.changes[0];
  const made = JSON.parse(run.result).document;
  assert.deepEqual({ kind: change.kind, action: change.action, title: change.title, open: change.open }, { kind: "document", action: "created", title: "Weekly review.docx", open: { kind: "note", id: second.id } });
  assert.match(change.detail, /^Word document · \d+ KB · from Weekly review$/);
  assert.deepEqual(change.undo, { op: "delete_document", note_id: second.id, id: made.file_id });
  assert.deepEqual(made, { file_id: change.id, name: "Weekly review.docx", format: "docx" });
  assert.equal((await send("GET", `/files/${made.file_id}/download`)).status, 200);
  // Marked as made from its note; a Markdown file the owner attached isn't one of the note's documents.
  assert.deepEqual(await qRaw(`SELECT made_from_note, stage_id FROM files WHERE id = $1`, [made.file_id]), [{ made_from_note: second.id, stage_id: null }]);
  const own = await saveFile({ id: crypto.randomUUID(), name: "my-notes.md", type: "text/markdown", bytes: new TextEncoder().encode("# Mine\n"), link: { note: second.id } });
  assert.deepEqual((await documentsForNote(second.id)).map((d) => d.file_id), [made.file_id]);
  assert.ok((await listNoteFiles(second.id)).some((f) => f.id === own.id));
  // Unchanged: the file that's there, and nothing new to undo.
  const same = await runAssistantTool("make_document", { note_id: second.id, format: "docx" });
  assert.equal(same.changes.length, 0);
  assert.match(JSON.parse(same.result).done, /^No change: Weekly review\.docx is already on that note$/);
  await assert.rejects(runAssistantTool("make_document", { note_id: second.id, format: "pdf" }));

  // Undo can't be pointed at a file that isn't a document on that note.
  assert.equal((await call("POST", "/assistant/undo", { undo: { op: "delete_document", note_id: second.id, id: md.body.document.file_id } })).status, 200);
  assert.equal((await send("GET", `/files/${md.body.document.file_id}/download`)).status, 200);
  const undone = await call("POST", "/assistant/undo", { undo: change.undo });
  assert.equal(undone.status, 200);
  assert.equal((await send("GET", `/files/${made.file_id}/download`)).status, 404);
  assert.ok(!blobs.has(made.file_id));
  assert.deepEqual(await documentsForNote(second.id), []);
  assert.deepEqual(await qRaw(`SELECT 1 FROM files WHERE id = $1`, [made.file_id]), []);
  // The first note's files are as they were.
  assert.equal((await documentsForNote(note.id)).length, 3);
});
