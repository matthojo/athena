// A note's earlier versions on real Postgres (lib/note-versions.ts, updateNote in lib/db.ts; 0061, 0094): each
// version says what wrote it, and edits the owner didn't make, however many, only push out versions someone else
// wrote. The owner's own allowance is trimmed only by the owner's own changes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/note-versions.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Makes its own notes and deletes them after.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const made: string[] = [];

after(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  if (made.length) await qRaw(`DELETE FROM notes WHERE id = ANY($1::uuid[])`, [made]);
});

/** A note with `n` earlier versions the owner wrote, as the app's editor keeps them (one per ten minutes). */
async function ownersNote(n: number): Promise<string> {
  const { createNote, qRaw, updateNote } = await import("./db");
  const note = await createNote({ title: "Venue plans", body: "Owner draft 0", source: "manual" });
  made.push(note.id);
  for (let i = 1; i <= n; i++) {
    await updateNote(note.id, { body: `Owner draft ${i}` }, { by: "owner" });
    // The next save is a new sitting, not the same burst of typing.
    await qRaw(`UPDATE note_versions SET created_at = created_at - interval '11 minutes' WHERE note_id = $1`, [note.id]);
  }
  return note.id;
}

test("edits by another program, however many, never push out the owner's own words", { skip }, async () => {
  const { updateNote } = await import("./db");
  const { listNoteVersions, NOTE_VERSIONS_OTHERS, NOTE_VERSIONS_OWNERS } = await import("./note-versions");
  const id = await ownersNote(5);
  for (let i = 1; i <= 60; i++) await updateNote(id, { body: `Agent text ${i}` }, { by: "mcp" });
  const versions = await listNoteVersions(id);
  const bodies = versions.map((v) => v.body);
  // Every draft the owner wrote is still there, the last one included (it was replaced by the first agent edit).
  for (let i = 0; i <= 5; i++) assert.ok(bodies.includes(`Owner draft ${i}`), `Owner draft ${i} was pushed out`);
  // The agent's own versions keep to their allowance, newest first.
  const agents = bodies.filter((b) => b.startsWith("Agent text"));
  assert.equal(agents.length, NOTE_VERSIONS_OTHERS);
  assert.equal(agents[0], "Agent text 59");
  assert.ok(versions.length <= NOTE_VERSIONS_OWNERS + NOTE_VERSIONS_OTHERS + 1);
  // What replaced the owner's last draft, and what wrote it.
  const { qRaw } = await import("./db");
  const [row] = await qRaw<{ changed_by: string; written_by: string }>(
    `SELECT changed_by, written_by FROM note_versions WHERE note_id = $1 ORDER BY created_at ASC, id ASC OFFSET 5 LIMIT 1`,
    [id],
  );
  assert.deepEqual(row, { changed_by: "mcp", written_by: "owner" });
});

test("the owner's own changes trim the owner's allowance, and someone else's allowance too", { skip }, async () => {
  const { updateNote, qRaw } = await import("./db");
  const { listNoteVersions, NOTE_VERSIONS_OWNERS } = await import("./note-versions");
  const id = await ownersNote(NOTE_VERSIONS_OWNERS + 5);
  const versions = await listNoteVersions(id);
  assert.equal(versions.length, NOTE_VERSIONS_OWNERS, "the owner's own: the newest 20");
  assert.equal(versions[0].body, `Owner draft ${NOTE_VERSIONS_OWNERS + 4}`);
  // A restore is the owner's too.
  await updateNote(id, { body: "Agent text" }, { by: "mcp" });
  await updateNote(id, { body: "Put back" }, { by: "restore" });
  const [counts] = await qRaw<{ owners: number; others: number }>(
    `SELECT count(*) FILTER (WHERE COALESCE(written_by IN ('owner', 'restore'), true))::int AS owners,
            count(*) FILTER (WHERE NOT COALESCE(written_by IN ('owner', 'restore'), true))::int AS others
     FROM note_versions WHERE note_id = $1`,
    [id],
  );
  assert.deepEqual(counts, { owners: NOTE_VERSIONS_OWNERS, others: 1 });
});

test("a change that doesn't say what made it (a run, a collection) counts as someone else's", { skip }, async () => {
  const { updateNote } = await import("./db");
  const { listNoteVersions, NOTE_VERSIONS_OTHERS } = await import("./note-versions");
  const id = await ownersNote(2);
  for (let i = 1; i <= 45; i++) await updateNote(id, { body: `Run text ${i}` });
  const bodies = (await listNoteVersions(id)).map((v) => v.body);
  for (let i = 0; i <= 2; i++) assert.ok(bodies.includes(`Owner draft ${i}`), `Owner draft ${i} was pushed out`);
  assert.equal(bodies.filter((b) => b.startsWith("Run text")).length, NOTE_VERSIONS_OTHERS);
});

test("versions kept before 0094 say nothing about who wrote them, and count as the owner's", { skip }, async () => {
  const { updateNote, qRaw } = await import("./db");
  const id = await ownersNote(3);
  await qRaw(`UPDATE note_versions SET written_by = NULL WHERE note_id = $1`, [id]);
  for (let i = 1; i <= 40; i++) await updateNote(id, { body: `Agent text ${i}` }, { by: "mcp" });
  const kept = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM note_versions WHERE note_id = $1 AND written_by IS NULL`, [id]);
  assert.equal(kept[0].n, 3);
});
