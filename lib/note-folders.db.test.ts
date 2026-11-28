// Folders for notes on real Postgres (lib/note-folders.ts, 0097): names sealed at rest, one name per place,
// three deep at most, no folder inside its own, a note's folder set and cleared, and deleting a folder moving
// what it held up a level (each moved note counting as changed, so other devices sync it).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/note-folders.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Makes its own folders and notes and deletes them after.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const notes: string[] = [];
const folders: string[] = [];

after(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  if (notes.length) await qRaw(`DELETE FROM notes WHERE id = ANY($1::uuid[])`, [notes]);
  if (folders.length) await qRaw(`DELETE FROM note_folders WHERE id = ANY($1::uuid[])`, [folders]);
});

async function folder(name: string, parent: string | null = null) {
  const { createFolder } = await import("./note-folders");
  const f = await createFolder({ name, parent_id: parent });
  folders.push(f.id);
  return f;
}

test("a folder's name is sealed at rest and read back opened", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { listFolders } = await import("./note-folders");
  const f = await folder("Therapy notes");
  const [raw] = await qRaw<{ name: string }>(`SELECT name FROM note_folders WHERE id = $1`, [f.id]);
  assert.notEqual(raw.name, "Therapy notes");
  assert.ok((await listFolders()).some((x) => x.id === f.id && x.name === "Therapy notes"));
});

test("two folders in the same place can't share a name; another place can", { skip }, async () => {
  const work = await folder("Work A");
  await folder("Clients", work.id);
  const { createFolder, updateFolder } = await import("./note-folders");
  await assert.rejects(createFolder({ name: "clients", parent_id: work.id }), /already a folder called “Clients”/);
  const other = await folder("Clients");
  const later = await folder("Later", work.id);
  await assert.rejects(updateFolder(later.id, { name: "CLIENTS" }), /already/);
  await assert.rejects(updateFolder(other.id, { parent_id: work.id }), /already/, "moving it there clashes too");
});

test("three deep at most, and never inside its own", { skip }, async () => {
  const { createFolder, updateFolder } = await import("./note-folders");
  const a = await folder("Level 1");
  const b = await folder("Level 2", a.id);
  const c = await folder("Level 3", b.id);
  await assert.rejects(createFolder({ name: "Level 4", parent_id: c.id }), /3 deep/);
  await assert.rejects(updateFolder(a.id, { parent_id: c.id }), /its own/);
  const top = await folder("Top B");
  await assert.rejects(updateFolder(b.id, { parent_id: (await folder("Inside Top B", top.id)).id }), /3 deep/, "b holds c: two levels, under two more is four");
  const moved = await updateFolder(b.id, { parent_id: top.id });
  assert.equal(moved.parent_id, top.id, "b and c under Top B: three deep, fine");
});

test("a note's folder is set, checked and cleared", { skip }, async () => {
  const { createNote, updateNote, getNote } = await import("./db");
  const { checkFolderId } = await import("./note-folders");
  const f = await folder("Recipes C");
  const n = await createNote({ title: "Lemon tart", body: "Blind bake first.", folder_id: f.id });
  notes.push(n.id);
  assert.equal(n.folder_id, f.id);
  await updateNote(n.id, { folder_id: null });
  assert.equal((await getNote(n.id))?.folder_id, null);
  await assert.rejects(checkFolderId("5a3e0000-0000-4000-8000-00000000dead"), /isn't there/);
  await checkFolderId(null);
});

test("deleting a folder moves its notes and folders up a level, and counts the notes as changed", { skip }, async () => {
  const { createNote, getNote, qRaw } = await import("./db");
  const { deleteFolder, listFolders } = await import("./note-folders");
  const work = await folder("Work D");
  const clients = await folder("Clients D", work.id);
  const acme = await folder("Acme D", clients.id);
  const n = await createNote({ title: "Kick-off", body: "Agenda", folder_id: clients.id });
  notes.push(n.id);
  await qRaw(`UPDATE notes SET updated_at = now() - interval '1 day' WHERE id = $1`, [n.id]);
  const before = (await getNote(n.id))!.updated_at;
  const res = await deleteFolder(clients.id);
  assert.deepEqual(res, { moved_to: work.id, notes: 1, folders: 1 });
  const after = (await getNote(n.id))!;
  assert.equal(after.folder_id, work.id);
  assert.ok(new Date(after.updated_at) > new Date(before), "the move is a change other devices pull");
  const now = await listFolders();
  assert.equal(now.find((f) => f.id === acme.id)?.parent_id, work.id);
  assert.ok(!now.some((f) => f.id === clients.id));
  // At the top, what it held leaves every folder.
  const n2 = await createNote({ title: "Loose", body: "x", folder_id: work.id });
  notes.push(n2.id);
  await deleteFolder(work.id);
  assert.equal((await getNote(n2.id))?.folder_id, null);
  assert.equal((await listFolders()).find((f) => f.id === acme.id)?.parent_id, null);
});
