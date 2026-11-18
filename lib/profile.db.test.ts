// The owner's profile against Postgres: who may change a fact about the owner, accepting a suggestion,
// and /api/profile through the real /api function.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/profile.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the owner's facts, suggestions and the profile_setup row first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";

async function reset() {
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM facts WHERE subject_kind = 'me'`);
  await qRaw(`DELETE FROM suggestions`);
  await qRaw(`DELETE FROM settings WHERE key = 'profile_setup'`);
}

test("a fact about the owner from anyone else goes to review; the owner's value stands until they accept", { skip }, async () => {
  await reset();
  const { addFact, listFacts, listSuggestions, acceptSuggestion, rejectSuggestion } = await import("./memory");
  const current = async () => (await listFacts({ subjectKind: "me" })).map((f) => [f.key, f.value]);

  // The owner types it: saved.
  const typed = await addFact({ subject_kind: "me", key: "Home town", value: "Bristol" });
  assert.ok("value" in typed);
  assert.deepEqual(await current(), [["Home town", "Bristol"]]);

  // An agent, even at full confidence, files a suggestion and changes nothing.
  const learned = await addFact({ subject_kind: "me", key: "home town", value: "Bath", source: "email-digest", source_ref: "gmail:1", confidence: 1 });
  assert.ok("op" in learned && learned.op === "fact");
  assert.match(learned.summary, /About you · Home town: Bath/);
  assert.deepEqual(await current(), [["Home town", "Bristol"]]);
  // A confidence alone, with no source, is still not the owner.
  const guessed = await addFact({ subject_kind: "me", key: "Role", value: "Designer", confidence: 0.4 });
  assert.ok("op" in guessed);
  // The same value again from an agent: nothing to ask.
  const same = await addFact({ subject_kind: "me", key: "Home town", value: "bristol", source: "mcp", confidence: 0.9 });
  assert.ok("value" in same && same.id === (typed as { id: string }).id);
  assert.equal((await listSuggestions()).length, 2);

  // Rejecting leaves the owner's value; accepting saves it, with its provenance, and the old one stays as history.
  await rejectSuggestion(guessed.id);
  const { result } = await acceptSuggestion(learned.id);
  assert.deepEqual(await current(), [["Home town", "Bath"]]);
  const history = await listFacts({ subjectKind: "me", history: true });
  assert.deepEqual(history.map((f) => [f.value, f.superseded_at === null]), [["Bath", true], ["Bristol", false]]);
  assert.equal((result as { source: string }).source, "email-digest");
  assert.equal((result as { confidence: number }).confidence, 1);

  // Facts about other people are unaffected: an agent still writes them directly.
  const { upsertPerson } = await import("./db");
  const p = await upsertPerson({ name: "Profile Test Person" });
  const friend = await addFact({ subject_kind: "person", subject_id: p.id, key: "Kids", value: "Two", source: "mcp", confidence: 0.9 });
  assert.ok("value" in friend);
});

test("Ask's remember: about the owner, saved directly as their own words", { skip }, async () => {
  await reset();
  const { addFact, listFacts } = await import("./memory");
  // The same call the assistant makes (lib/assistant.ts, remember with no person).
  const f = await addFact({ subject_kind: "me", key: "Diet", value: "Vegetarian", source: "assistant", confidence: null }, { byOwner: true });
  assert.equal(f.value, "Vegetarian");
  assert.deepEqual((await listFacts({ subjectKind: "me" })).map((x) => x.key), ["Diet"]);
});

test("/api/profile: save, read by section, archive with an empty value; setup progress round trip", { skip }, async () => {
  await reset();
  const api = (await import("../netlify/functions/api")).default;
  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(
      new Request(`https://athena.test/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {} as never,
    );
    return { status: res.status, json: await res.json() };
  };
  type Section = { id: string; fields: Array<{ key: string; fact: { value: string } | null; owner_typed: boolean | null }> };
  const value = (sections: Section[], id: string, key: string) => sections.find((s) => s.id === id)?.fields.find((f) => f.key === key)?.fact?.value ?? null;

  assert.equal((await call("GET", "profile", undefined, "wrong")).status, 401);
  let r = await call("GET", "profile");
  assert.equal(r.status, 200);
  assert.equal(value(r.json.sections, "about", "Name"), null);

  r = await call("PUT", "profile", { values: [{ key: "name", value: "Jordan" }, { key: "Briefing length", value: "Short" }, { key: "Coffee order", value: "Oat flat white" }] });
  assert.equal(r.status, 200);
  assert.equal(value(r.json.sections, "about", "Name"), "Jordan");
  assert.equal(value(r.json.sections, "help", "Briefing length"), "Short");
  assert.equal(value(r.json.sections, "other", "Coffee order"), "Oat flat white");
  assert.equal(r.json.sections.find((s: Section) => s.id === "about").fields.find((f: { key: string }) => f.key === "Name").owner_typed, true);

  // The prompt block reads what was saved.
  const { profilePromptBlock } = await import("./profile");
  assert.match(await profilePromptBlock(), /- Name: Jordan/);

  // An empty value archives it.
  r = await call("PUT", "profile", { values: [{ key: "Coffee order", value: "" }] });
  assert.equal(value(r.json.sections, "other", "Coffee order"), null);
  assert.equal((await call("GET", "profile")).json.sections.find((s: Section) => s.id === "other").fields.length, 0);
  assert.equal((await call("PUT", "profile", { values: "Jordan" })).status, 400);

  // Wizard progress.
  r = await call("GET", "profile/setup");
  assert.deepEqual(r.json, { version: 1, step: null, completed_at: null, skipped: [], started_at: null });
  r = await call("POST", "profile/setup", { step: "routines", skip: "about" });
  assert.deepEqual(r.json, { version: 1, step: "routines", completed_at: null, skipped: ["about"], started_at: null });
  r = await call("POST", "profile/setup", { complete: true });
  assert.ok(r.json.completed_at);
  assert.deepEqual((await call("GET", "profile/setup")).json.skipped, ["about"]);
  assert.equal((await call("POST", "profile/setup", { step: "nowhere" })).status, 400);
  assert.equal((await call("PUT", "profile/setup", {})).status, 405);
});

test("Let Ask search the web: on with no row, kept once set, and only true or false is taken; GET and PUT /api/profile/ask-web", { skip }, async () => {
  const { loadAskWeb, saveAskWeb } = await import("./profile");
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM settings WHERE key = 'ask_web'`);
  assert.equal(await loadAskWeb(), true);
  assert.deepEqual(await saveAskWeb({ on: false }), { on: false });
  assert.equal(await loadAskWeb(), false);
  await assert.rejects(() => saveAskWeb({ on: "yes" }), /Send on: true or false/);
  assert.deepEqual(await saveAskWeb({ on: true }), { on: true });
  assert.equal(await loadAskWeb(), true);

  const api = (await import("../netlify/functions/api")).default;
  const call = async (method: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(
      new Request("https://athena.test/api/profile/ask-web", { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
      {} as never,
    );
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await call("GET", undefined, "wrong")).status, 401);
  assert.deepEqual(await call("GET"), { status: 200, json: { on: true } });
  assert.deepEqual(await call("PUT", { on: false }), { status: 200, json: { on: false } });
  assert.deepEqual(await call("GET"), { status: 200, json: { on: false } });
  assert.equal((await call("PUT", { on: 1 })).status, 400);
  assert.equal((await call("POST", { on: true })).status, 405);
  assert.deepEqual(await call("GET"), { status: 200, json: { on: false } }, "a refused write changes nothing");
  await qRaw(`DELETE FROM settings WHERE key = 'ask_web'`);
});
