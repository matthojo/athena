// The review inbox's email finds (0086), against Postgres with every migration applied: a find keeps the
// email it came from, sealed; the same words from another email aren't filed twice while one waits; "done"
// takes one out with nothing applied; and "Ignore emails like this" adds a rule to that email's account and
// clears what the rule catches.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/suggestion-inbox.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
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

async function call(path: string, body: unknown = {}) {
  const api = (await import("../netlify/functions/api")).default;
  const res = await api(
    new Request(`https://athena.test/api/${path}`, { method: "POST", headers: { Authorization: "Bearer master-token-for-tests", "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    {} as never,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("an email find: kept sealed, not repeated, done, and ignored by sender", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { propose, listSuggestions } = await import("./memory");
  const { createConnector, getConnector, deleteConnector } = await import("./connectors");
  const tag = `inbox-test-${Date.now()}`;
  const account = await createConnector({ name: "Test mail", provider: "gmail", url: "https://gmail.googleapis.com", auth_type: "token", secrets: { token: "x" } });
  try {
    const email = { from: "Northfield Leisure <bookings@mail.northfield.example>", subject: "Your spin class is booked", connector_id: account.id };
    const first = await propose({ op: "event", summary: `${tag} Appointment: Spin class · 2026-12-02`, payload: { title: "Spin class" }, source: tag, source_ref: `${tag}:t1`, email });
    assert.deepEqual(first.email, email);
    const [raw] = await qRaw<{ email: unknown }>(`SELECT email FROM suggestions WHERE id = $1`, [first.id]);
    assert.ok(!JSON.stringify(raw.email).includes("northfield"), "the sender is sealed at rest");

    // The same words from another email, while the first waits: answered once.
    const again = await propose({ op: "event", summary: `${tag} Appointment: Spin class · 2026-12-02`, payload: {}, source: tag, source_ref: `${tag}:t2`, email });
    assert.equal(again.id, first.id);
    // Worded a little differently (case, punctuation, "the"): still the same thing.
    const reworded = await propose({ op: "event", summary: `${tag} appointment — the spin class, 2026-12-02`, payload: {}, source: tag, source_ref: `${tag}:t5`, email });
    assert.equal(reworded.id, first.id);
    // Another date is another thing: filed, and its own card.
    const next = await propose({ op: "event", summary: `${tag} Appointment: Spin class · 2026-12-09`, payload: {}, source: tag, source_ref: `${tag}:t3`, email });
    assert.notEqual(next.id, first.id);
    const other = await propose({ op: "commitment", summary: `${tag} To do: Reply to Sam about the rota`, payload: { title: "Reply to Sam" }, source: tag, source_ref: `${tag}:t4` });

    // Put on the calendar from the card: done, nothing applied.
    const done = await call(`suggestions/${other.id}/done`);
    assert.equal(done.status, 200);
    assert.equal((done.json.suggestion as { status: string }).status, "accepted");
    assert.equal((done.json.suggestion as { result_id: unknown }).result_id, null);

    // Ignore by sender: the rule lands on the account, and both spin-class finds leave.
    const bad = await call(`suggestions/${first.id}/ignore`, { kind: "sender", value: "not an address" });
    assert.equal(bad.status, 400);
    const ignored = await call(`suggestions/${first.id}/ignore`, { kind: "sender", value: "northfield.example" });
    assert.equal(ignored.status, 200);
    assert.deepEqual(new Set(ignored.json.dismissed as string[]), new Set([first.id, next.id]));
    assert.deepEqual((await getConnector(account.id))?.mail_rules?.skip_senders, ["northfield.example"]);
    const pending = (await listSuggestions({ status: "pending", limit: 1000 })).filter((s) => s.source === tag);
    assert.equal(pending.length, 0);
  } finally {
    await qRaw(`DELETE FROM suggestions WHERE source = $1`, [tag]);
    await deleteConnector(account.id);
  }
});
