// Workflows through the real /api function on real Postgres (lib/workflow-share.ts): sharing an assistant
// checks its words against the owner's own people and places and takes out links into their Athena, the
// download waits until each finding is edited out or marked fine, and the zip it gives can be previewed and
// added on another copy: paused, with only the ticked tools it asked for, and its skill with the answers.
// Every name and address is made up. No model key: an assistant's own skill is the plain one.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/workflow-share.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team, skill and people tables first.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  process.env.URL = "https://athena.example.com";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete process.env[k];
const skip = !url && "set ATHENA_TEST_DB_URL";

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants CASCADE`);
  await qRaw(`DELETE FROM identities`);
  await qRaw(`DELETE FROM people`);
  await qRaw(`DELETE FROM places`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('skills.starters', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`);
});

async function api() {
  const fn = (await import("../netlify/functions/api")).default;
  // Work kept going after a response (an assistant's own skill being written): waited for, so tests don't race it.
  const later: Promise<unknown>[] = [];
  return async (method: string, path: string, body?: unknown) => {
    const res = await fn(
      new Request(`https://athena.example.com/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { waitUntil: (p: Promise<unknown>) => void later.push(p) } as never,
    );
    await Promise.all(later.splice(0));
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, type, json: type.includes("json") ? await res.json() : null, bytes: type.includes("zip") ? new Uint8Array(await res.arrayBuffer()) : null };
  };
}

test("sharing: links into Athena go, the owner's people are flagged, and the download waits for them", { skip }, async () => {
  const call = await api();
  const { qRaw } = await import("./db");
  const { putAssistantSkill } = await import("./skills-store");
  await call("POST", "people", { name: "Priya Shah", email: "priya@mail.test" });
  await qRaw(`INSERT INTO places (name, address) VALUES ('Corner Bakery', '12 Example Street, Exampleton')`);

  const made = await call("POST", "team", {
    name: "Muse",
    job: "Finds good prices for gift ideas",
    instructions: "Check prices for Priya's gift list at https://athena.example.com/#/notes/1 and [the list](athena://note/3f1c2d4e-1111-4222-8333-444455556666).",
    allow: ["add_to_list", "add_todo"],
    triggers: [{ kind: "schedule", days: [5], time: "17:00" }, { kind: "event", event: { source: "collected", connector: "gmail", kind: "delivery" } }],
  });
  assert.equal(made.status, 201);
  const id = made.json.id as string;
  await putAssistantSkill(id, { name: "muse-gift-prices", description: "Muse's own skill.", body: "1. Read the gift idea.\n2. Check prices at Corner Bakery and near 12 Example Street.\n3. Email priya@mail.test if it drops.", extra: "" }, { basis: "x", made: "y", summary: "Checks prices.", answers: [{ question: "Which shops do you trust?", answer: "Corner Bakery" }] });

  const look = await call("POST", `team/${id}/workflow`, {});
  assert.equal(look.status, 200);
  const x = look.json;
  assert.doesNotMatch(JSON.stringify(x.workflow), /athena\.example\.com|athena:\/\/|3f1c2d4e/);
  assert.deepEqual(x.removed.map((r: { kind: string }) => r.kind).sort(), ["athena-link", "site-link"]);
  assert.deepEqual(x.workflow.asks, [{ question: "Which shops do you trust?", choices: [] }], "the question goes, the owner's answer doesn't");
  assert.doesNotMatch(JSON.stringify(x.workflow), /"Corner Bakery"/);
  assert.deepEqual(x.workflow.would_like, ["add_to_list", "add_todo"]);
  assert.deepEqual(x.workflow.needs, ["gmail"]);
  const ids = x.findings.map((f: { id: string }) => f.id).sort();
  assert.deepEqual(ids, ["address:12 example street", "email:priya@mail.test", "person:priya", "place:corner bakery"]);

  // Not yet: the download is refused while anything is flagged.
  const early = await call("POST", `team/${id}/workflow`, { download: true });
  assert.equal(early.status, 409);
  assert.equal(early.json.findings.length, 4);

  // Edited out, or marked fine: the zip comes.
  const edits = { instructions: "Check prices for each gift idea.", skill: "1. Read the gift idea.\n2. Check prices at each shop you trust.\n3. Tell your owner if it drops." };
  const ready = await call("POST", `team/${id}/workflow`, { edits, fine: ["place:corner bakery"], download: true });
  assert.equal(ready.status, 200, JSON.stringify(ready.json));
  assert.ok(ready.bytes && ready.bytes.byteLength > 100);

  // The assistant itself is unchanged by the edits.
  const still = await call("GET", `team/${id}`);
  assert.match(still.json.instructions, /Priya/);

  // The zip previews on "another copy", and adds as a paused assistant with only the ticked tools it asked for.
  const zip = Buffer.from(ready.bytes!).toString("base64");
  const preview = await call("POST", "team/workflow/preview", { zip, file: "muse.zip" });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const p = preview.json;
  assert.equal(p.workflow.name, "Muse");
  assert.match(p.skill.body, /each shop you trust/);
  assert.deepEqual(p.needs, [{ id: "gmail", connected: false }]);
  assert.equal(p.room, true);

  const added = await call("POST", "team/workflow", { workflow: p.workflow, skill: p.skill, source: p.source, answers: [{ question: "Which shops do you trust?", answer: "Any shop on Example Road" }], allow: ["add_todo", "remember"], web: true });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const a = added.json.assistant;
  assert.equal(a.paused, true);
  assert.deepEqual(a.allow, ["add_todo"], "remember wasn't asked for");
  assert.equal(a.web, false, "the workflow didn't ask to look things up online");
  assert.deepEqual(a.triggers.map((t: { kind: string }) => t.kind).sort(), ["event", "schedule"]);
  const skill = await call("GET", `team/${a.id}/skill`);
  assert.match(skill.json.skill.body, /each shop you trust/);
  assert.match(skill.json.skill.body, /What your owner told you when they added you\n\n- Which shops do you trust\? Any shop on Example Road/);
  assert.equal(skill.json.stale, false);
  assert.equal(skill.json.edited, false);
});

test("adding: a bad workflow, a link off GitHub, and a full team are refused", { skip }, async () => {
  const call = await api();
  assert.equal((await call("POST", "team/workflow/preview", { workflow_json: "{\"format\": 1}" })).status, 400);
  const off = await call("POST", "team/workflow/preview", { url: "https://athena.example.com/w/muse" });
  assert.equal(off.status, 400);
  assert.match(off.json.error, /from GitHub/);
  assert.equal((await call("POST", "team/workflow", { workflow: { format: 1 } })).status, 400);

  const one = await call("POST", "team/workflow/preview", { workflow_json: JSON.stringify({ format: 1, name: "Dot", job: "Turns Linear issues into to-dos" }) });
  assert.equal(one.status, 200);
  assert.equal(one.json.skill, null);
  for (let i = 0; i < 12; i++) assert.equal((await call("POST", "team", { job: `Job ${i}` })).status, 201);
  const full = await call("POST", "team/workflow/preview", { workflow_json: JSON.stringify({ format: 1, job: "One more" }) });
  assert.equal(full.json.room, false);
  assert.equal((await call("POST", "team/workflow", { workflow: full.json.workflow, skill: null, answers: [], allow: [], web: false })).status, 400);
});
