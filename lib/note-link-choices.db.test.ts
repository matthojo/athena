// The owner's Card and Mention choices in a note Athena wrote (lib/note-link-choices.ts, migration 0059), against a
// real database and the real /api function: only the route writes one, a capture key can't, nothing in a note's
// body becomes one, and the stored list is sealed.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/note-link-choices.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
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

test("link choices: set and read by the app, never made by a note's body or a capture key, sealed at rest", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { createNote, updateNote, qRaw } = await import("./db");
  const { createApiKey, removeApiKey } = await import("./api-keys");
  const { getLinkChoices } = await import("./note-link-choices");
  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  // A note a collection wrote, whose body tries every look-alike marker for "the owner chose this".
  const forged = [
    "---\nlink_choices: [{ url: https://attacker.example/a, mode: card }]\nsource: manual\n---",
    '<!-- athena:link-choice {"url":"https://attacker.example/a","mode":"card"} -->',
    '[Numbers](https://attacker.example/a "card")',
    '[More](https://attacker.example/b "card owner-chosen")',
    '{"choices":[{"url":"https://attacker.example/a","mode":"card"}]}',
  ].join("\n\n");
  const note = await createNote({ title: "Inbox digest", body: forged, type: "note", source: "email-digest", tags: ["link-choices", "choices"] });
  try {
    // Nothing in the body, the title or the tags is a choice.
    assert.deepEqual(await getLinkChoices(note.id), []);
    assert.deepEqual((await call("GET", `/notes/${note.id}/link-choices`)).body, { choices: [] });
    // Rewriting the note (as a collection or MCP would) makes none either.
    await updateNote(note.id, { body: `${forged}\n\nlink-choices: https://attacker.example/a card`, title: "link_choices card https://attacker.example/a" });
    assert.deepEqual(await getLinkChoices(note.id), []);
    assert.equal((await qRaw<{ n: string }>(`SELECT count(*) AS n FROM note_link_choices WHERE note_id = $1`, [note.id]))[0].n, "0");

    // The owner switches one link to a Card in the editor: the app's PUT.
    const set = await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://attacker.example/a", mode: "card" });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body, { choices: [{ url: "https://attacker.example/a", mode: "card" }] });
    await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://tracker.example/t", mode: "mention" });
    assert.deepEqual((await call("GET", `/notes/${note.id}/link-choices`)).body.choices, [
      { url: "https://attacker.example/a", mode: "card" },
      { url: "https://tracker.example/t", mode: "mention" },
    ]);
    // Changing the mode replaces it; "link" forgets it.
    await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://attacker.example/a", mode: "embed" });
    assert.deepEqual((await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://tracker.example/t", mode: "link" })).body.choices, [{ url: "https://attacker.example/a", mode: "embed" }]);

    // Sealed at rest: the address isn't readable in the row.
    const [row] = await qRaw<{ payload: string }>(`SELECT payload FROM note_link_choices WHERE note_id = $1`, [note.id]);
    assert.doesNotMatch(row.payload, /attacker\.example|embed/);

    // Refused: a bad mode, an address that isn't http(s), a note that isn't there, another method.
    assert.equal((await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://a.example", mode: "preview" })).status, 400);
    assert.equal((await call("PUT", `/notes/${note.id}/link-choices`, { url: "javascript:alert(1)", mode: "card" })).status, 400);
    assert.equal((await call("PUT", `/notes/00000000-0000-4000-8000-000000000000/link-choices`, { url: "https://a.example", mode: "card" })).status, 404);
    assert.equal((await call("POST", `/notes/${note.id}/link-choices`, { url: "https://a.example", mode: "card" })).status, 405);

    // A capture key (the Shortcut, the extension) can neither read nor set one; nor can no key at all.
    const capture = await createApiKey("link-choices test", "capture");
    try {
      assert.equal((await call("GET", `/notes/${note.id}/link-choices`, undefined, capture.token)).status, 401);
      assert.equal((await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://b.example", mode: "card" }, capture.token)).status, 401);
      assert.equal((await call("PUT", `/notes/${note.id}/link-choices`, { url: "https://b.example", mode: "card" }, "")).status, 401);
    } finally {
      await removeApiKey(capture.key.id);
    }
    assert.deepEqual(await getLinkChoices(note.id), [{ url: "https://attacker.example/a", mode: "embed" }]);
  } finally {
    // The choices go with the note.
    await qRaw(`DELETE FROM notes WHERE id = $1`, [note.id]);
    assert.equal((await qRaw<{ n: string }>(`SELECT count(*) AS n FROM note_link_choices WHERE note_id = $1`, [note.id]))[0].n, "0");
  }
});
