// GET /api/profile/history?key= through the real /api function (stage 2A, docs/notes/profile-ui.md).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/profile-history.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the owner's facts first.
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

test("/api/profile/history: one key's values, newest first, current and superseded; forgotten ones gone", { skip }, async () => {
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM facts WHERE subject_kind = 'me'`);
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

  await call("PUT", "profile", { values: [{ key: "Role", value: "Designer" }, { key: "Name", value: "Sam" }] });
  await call("PUT", "profile", { values: [{ key: "Role", value: "Product designer" }] });

  let r = await call("GET", "profile/history?key=role");
  assert.equal(r.status, 200);
  const facts = r.json.facts as Array<{ key: string; value: string; superseded_at: string | null }>;
  assert.deepEqual(facts.map((f) => [f.value, f.superseded_at === null]), [["Product designer", true], ["Designer", false]]);
  assert.ok(facts.every((f) => f.key === "Role"));

  // Forgetting archives the current value; the superseded one stays as history.
  await call("PUT", "profile", { values: [{ key: "Role", value: "" }] });
  r = await call("GET", "profile/history?key=Role");
  assert.deepEqual(r.json.facts.map((f: { value: string }) => f.value), ["Designer"]);

  assert.equal((await call("GET", "profile/history")).status, 400);
  assert.equal((await call("POST", "profile/history?key=Role", {})).status, 405);
  assert.equal((await call("GET", "profile/history?key=Role", undefined, "wrong")).status, 401);
});
