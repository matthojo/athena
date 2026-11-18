// The person an unlinked to-do names (lib/todo-people.ts), against a real database and the real /api function:
// one match, several, none; a nickname; linking with the to-do's own PATCH; a dismissal that stays; names and
// titles still sealed with no new readable column; and a capture key (or no key) gets 401.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/todo-people.db.test.ts
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

test("to-do people: offered to the app, linked in one PATCH, dismissed for good, never to a capture key", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../functions/api")).default;
  const { qRaw } = await import("../../lib/db");
  const { createApiKey, removeApiKey } = await import("../../lib/api-keys");
  await qRaw(`DELETE FROM suggestions WHERE op = 'commitment'`);
  await qRaw(`DELETE FROM commitments`);
  await qRaw(`DELETE FROM settings WHERE key = 'todo_person_dismissed'`);

  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const person = async (name: string) => (await call("POST", "/people", { name })).body as { id: string; name: string };
  const todo = async (input: Record<string, unknown>) => {
    const r = await call("POST", "/commitments", input);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { id: string; kind: string; person_id: string | null };
  };
  const offered = async () => {
    const r = await call("GET", "/todo-people");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.suggestions as Record<string, Array<{ id: string; name: string }>>;
  };

  const tag = Math.random().toString(36).slice(2, 8);
  // Names nobody else in the test database has.
  const first = `Quenby${tag}`;
  const a = await person(`${first} Ashdown`);
  const b = await person(`${first} Birch`);
  const solo = await person(`Zephyrine${tag} Lowe`);
  const nick = `Captain${tag}`;
  assert.equal((await call("POST", "/identities", { person_id: solo.id, kind: "alias", value: nick })).status, 201);
  const made: string[] = [a.id, b.id, solo.id];

  try {
    // As a Shortcut capture leaves it: plain text, nobody attached.
    const one = await todo({ title: `Call Zephyrine${tag} about Saturday`, source: "shortcut" });
    const several = await todo({ title: `Send ${first} the keys` });
    const whole = await todo({ title: `Lunch with ${first} Birch` });
    const byNick = await todo({ title: `Ring ${nick.toLowerCase()} back`, kind: "waiting_on" });
    const none = await todo({ title: "Buy milk" });
    const linked = await todo({ title: `Thank Zephyrine${tag}`, person_id: solo.id, kind: "i_owe" });
    const decided = await todo({ title: `Go with Zephyrine${tag}'s plan`, kind: "decision" });
    const done = await todo({ title: `Text Zephyrine${tag}`, status: "done" });

    let s = await offered();
    assert.deepEqual(s[one.id], [{ id: solo.id, name: solo.name }], "one match: id and name, nothing else");
    assert.deepEqual(s[several.id].map((p) => p.id).sort(), [a.id, b.id].sort(), "several: the choices, not a guess");
    assert.deepEqual(s[whole.id], [{ id: b.id, name: b.name }], "a whole name settles it");
    assert.deepEqual(s[byNick.id], [{ id: solo.id, name: solo.name }], "a nickname, any case");
    for (const c of [none, linked, decided, done]) assert.equal(s[c.id], undefined, "no match, linked, a decision or done: nothing");

    // Nothing readable was added: the title and the name are still sealed, and the answer isn't kept anywhere.
    const [rawTodo] = await qRaw<{ title: string; person_id: string | null }>(`SELECT title, person_id FROM commitments WHERE id = $1`, [one.id]);
    assert.ok(rawTodo.title.startsWith("enc:v1:"));
    assert.equal(rawTodo.person_id, null, "reading suggestions links nobody");
    const [rawPerson] = await qRaw<{ name: string }>(`SELECT name FROM people WHERE id = $1`, [solo.id]);
    assert.ok(rawPerson.name.startsWith("enc:v1:"));
    assert.equal((await qRaw(`SELECT 1 FROM settings WHERE key = 'todo_person_dismissed'`)).length, 0, "nothing stored until a dismissal");

    // One tap: the to-do's own PATCH, as the person picker sends it.
    const r = await call("PATCH", `/commitments/${one.id}`, { person_id: solo.id, kind: "i_owe" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.person_id, r.body.person?.name, r.body.kind], [solo.id, solo.name, "i_owe"]);
    s = await offered();
    assert.equal(s[one.id], undefined, "linked: no longer offered");

    // Dismissed stays dismissed, for that to-do only, and only its id is kept.
    assert.deepEqual((await call("POST", `/todo-people/${several.id}/dismiss`)).body, { dismissed: true });
    assert.equal((await call("POST", `/todo-people/${several.id}/dismiss`)).status, 200, "twice is fine");
    s = await offered();
    assert.equal(s[several.id], undefined);
    assert.ok(s[whole.id] && s[byNick.id], "the others are still offered");
    await call("PATCH", `/commitments/${several.id}`, { title: `Send ${first} the spare keys` });
    assert.equal((await offered())[several.id], undefined, "still dismissed after an edit");
    const [kept] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'todo_person_dismissed'`);
    assert.deepEqual(kept.value, [several.id], "the to-do's id, once, and no name");
    assert.equal((await call("POST", "/todo-people/not-an-id/dismiss")).status, 400);
    assert.equal((await call("POST", "/todo-people")).status, 405);
    assert.equal((await call("GET", `/todo-people/${whole.id}/dismiss`)).status, 405);

    // An archived person isn't offered; the other one with that first name still is.
    await call("POST", `/people/${b.id}/archive`);
    assert.deepEqual((await offered())[whole.id], [{ id: a.id, name: a.name }]);

    // A capture key (the Shortcut) reads nothing here; nor does no key.
    const capture = await createApiKey("todo-people test", "capture");
    try {
      assert.equal((await call("GET", "/todo-people", undefined, capture.token)).status, 401);
      assert.equal((await call("POST", `/todo-people/${byNick.id}/dismiss`, undefined, capture.token)).status, 401);
      assert.equal((await call("GET", "/todo-people", undefined, "")).status, 401);
      assert.ok((await offered())[byNick.id], "and its refused dismissal changed nothing");
    } finally {
      await removeApiKey(capture.key.id);
    }
  } finally {
    await qRaw(`DELETE FROM commitments`);
    await qRaw(`DELETE FROM settings WHERE key = 'todo_person_dismissed'`);
    await qRaw(`DELETE FROM people WHERE id = ANY($1::uuid[])`, [made]);
  }
});
