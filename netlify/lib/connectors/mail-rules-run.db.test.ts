// A whole email digest run with the owner's "inbox only" rule: the real routes save the rule (sealed), the real
// executeRun opens Gmail through its real adapter, and a stand-in Claude searches, then tries to open every thread,
// the skipped one included, by id. Gmail here ignores the query and returns everything, so Athena's own check is all
// that stands between. Nothing from the archived Name.com mail may reach the model, and the run counts what it kept out.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/mail-rules-run.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
type Msg = { role: string; content: string | Block[] };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const MAIL = [
  // Name.com's customer purchases: a filter skips the inbox (no INBOX label).
  { id: "m1", threadId: "t1", labelIds: ["Label_9"], from: "Name.com <orders@name.com>", subject: "Domain purchase: acme.dev", body: "SECRET-NAMECOM-BODY a customer bought acme.dev" },
  { id: "m2", threadId: "t2", labelIds: ["INBOX", "UNREAD"], from: "Priya <priya@example.com>", subject: "Can you review the budget by Friday?", body: "Please review the Q4 budget by Friday." },
  { id: "m3", threadId: "t3", labelIds: ["Label_9"], from: "Name.com <orders@name.com>", subject: "Domain purchase: beta.io", body: "SECRET-NAMECOM-BODY a customer bought beta.io" },
];
const gmailMessage = (m: (typeof MAIL)[number]) => ({
  id: m.id,
  threadId: m.threadId,
  labelIds: m.labelIds,
  snippet: m.subject,
  internalDate: String(Date.parse("2026-11-06T08:00:00Z")),
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "To", value: "owner@example.com" }, { name: "Subject", value: m.subject }], body: { data: b64(m.body) } },
});

/** Gmail, standing in. Every search returns every thread, whatever it asked: the worst a provider could do. */
function gmail(queries: string[]): F.Route {
  return (u) => {
    if (u.host !== "gmail.googleapis.com") return undefined;
    const p = u.pathname.replace("/gmail/v1/users/me", "");
    if (p === "/profile") return { body: { emailAddress: "owner@example.com" } };
    if (p === "/threads") {
      const q = u.searchParams.get("q") ?? "";
      // Athena's count of what the rules took out asks for the opposite, ids only: Gmail answers that one properly.
      if (q.includes("{(-in:inbox -in:sent)")) return { body: { threads: [{ id: "t1" }, { id: "t3" }] } };
      queries.push(q);
      return { body: { threads: [...new Set(MAIL.map((m) => m.threadId))].map((id) => ({ id })) } };
    }
    const t = /^\/threads\/(\w+)$/.exec(p);
    if (t) return { body: { id: t[1], messages: MAIL.filter((m) => m.threadId === t[1]).map(gmailMessage) } };
    const m = /^\/messages\/(\w+)$/.exec(p);
    if (m) return { body: gmailMessage(MAIL.find((x) => x.id === m[1])!) };
    return undefined;
  };
}

/** Claude, standing in: searches, then opens every thread the search gave and the skipped ones by id, then stops. Keeps every tool result. */
function standIn(results: string[]) {
  let n = 0;
  return (u: URL, init: RequestInit): F.Reply | undefined => {
    if (u.host !== "claude.test") return undefined;
    const body = JSON.parse(String(init.body)) as { tools: Array<{ name: string }>; messages: Msg[] };
    const tool = (suffix: string) => body.tools.find((t) => t.name.endsWith(suffix))!.name;
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = body.messages[body.messages.length - 1];
    const got = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
    for (const r of got) results.push(typeof r.content === "string" ? r.content : (r.content as Block[]).map((b) => b.text ?? "").join(""));
    if (n === 0) {
      // A search, a search naming the sender outright, and straight reads of the skipped thread and message.
      return reply(
        [
          { type: "tool_use", id: "s1", name: tool("search_threads"), input: { query: "newer_than:2d" } },
          { type: "tool_use", id: "s2", name: tool("search_threads"), input: { query: "from:name.com in:anywhere", includeTrash: true } },
          { type: "tool_use", id: "r1", name: tool("get_thread"), input: { threadId: "t1" } },
          { type: "tool_use", id: "r2", name: tool("get_message"), input: { messageId: "m3" } },
        ],
        "tool_use",
      );
    }
    if (n === 1) {
      const ids = new Set<string>();
      for (const text of results) for (const id of text.match(/"id":"(t\d)"/g) ?? []) ids.add(id.slice(6, 8));
      return reply([...ids].map((id, i) => ({ type: "tool_use", id: `g${i}`, name: tool("get_thread"), input: { threadId: id } })), "tool_use");
    }
    return reply([{ type: "text", text: "One thing to do: review the budget." }], "end_turn");
  };
}

test("email digest with the inbox-only rule: no non-inbox email reaches the model, and the run counts what it skipped", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  F.installFetch();
  try {
    const queries: string[] = [];
    const results: string[] = [];
    F.stub(gmail(queries), standIn(results));

    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun } = await import("./runner");
    const C = await import("../../../lib/connectors");
    const { qRaw } = await import("../../../lib/db");
    for (const t of ["mail_skips", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    };

    const made = await api("POST", "/connectors", { provider: "gmail", name: "Gmail", account_label: "personal", client_id: "cid.apps.googleusercontent.com", client_secret: "secret" });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.id as string;
    await C.updateConnectorSecrets(id, (s) => void (s.tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600, obtained_at: Date.now() } as never));
    assert.equal((await api("POST", `/connectors/${id}/check`)).status, 200);

    // The owner turns on "Only read mail that reaches my inbox".
    const saved = await api("PATCH", `/connectors/${id}`, { mail_rules: { inbox_only: true, skip_senders: ["not a sender"] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.mail_rules, { inbox_only: true, skip_senders: [], skip_subjects: [], skip_labels: [], only_labels: [] });
    // Sealed at rest: the column holds ciphertext only.
    const [row] = await qRaw<{ mail_rules: string }>(`SELECT mail_rules FROM connectors WHERE id = $1`, [id]);
    assert.ok(row.mail_rules.startsWith("enc:v1:") && !row.mail_rules.includes("inbox"), row.mail_rules.slice(0, 20));

    const digest = await api("POST", "/collections", { recipe: "email-digest", name: "Email digest", label: "personal", connector_ids: [id], schedule: "daily", run_at: "07:15" });
    assert.equal(digest.status, 201, JSON.stringify(digest.json));
    const run = await C.queueRun(digest.json.id, "manual");
    // Yesterday, so the account's week (counted back from the real date) always includes it.
    await executeRun(run.id, new Date(Date.now() - 86_400_000));
    const done = (await C.listRuns(digest.json.id)).find((r) => r.id === run.id)!;
    assert.equal(done.status, "succeeded", `${done.error ?? ""} ${JSON.stringify(done.stats)}`);

    // Every search went to Gmail with the rule on.
    assert.ok(queries.length >= 2);
    for (const query of queries) assert.ok(query.includes("in:inbox"), query);
    // The model saw Priya's email, and nothing at all from the mail that skipped the inbox.
    const seen = results.join("\n");
    assert.ok(seen.includes("review the Q4 budget"), seen.slice(0, 400));
    for (const leak of ["SECRET-NAMECOM-BODY", "Domain purchase", "name.com", "acme.dev", "beta.io"]) assert.ok(!seen.includes(leak), `${leak} reached the model:\n${seen}`);
    assert.ok(seen.includes("filtered out by the owner's rules"));
    // Counts only: the run says how many it skipped, and the account's week adds it up.
    assert.equal((done.stats as { mail_skipped?: number }).mail_skipped, 2);
    const week = await api("GET", `/connectors/${id}/mail`);
    assert.equal(week.json.skipped_week, 2);
    assert.equal(week.json.rules.inbox_only, true);
  } finally {
    F.restoreFetch();
  }
});
