// Shared flows on real Postgres with every migration (0088 included): a flow shared as a file through its route,
// checked against the owner's own people and refused while anything is flagged; a shared flow added off, origin
// shared, with the catalogue listing kept; a blank left unanswered keeping the flow off until its field is set; and
// a thinking step keeping it off until it has an assistant.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/flow-share-store.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the flow, team and people tables first. Made-up data only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { FlowStep } from "./flow-types";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE flow_runs, flows, team_events, team_runs, team_triggers, team_assistants, people CASCADE`);
});

const HASH = `sha256-${"ab".repeat(32)}`;

async function personId(name: string): Promise<string> {
  const { qRaw } = await import("./db");
  const [row] = await qRaw<{ id: string }>(`INSERT INTO people (name) VALUES ($1) RETURNING id`, [name]);
  return row.id;
}

test("export route: a flow as a file, flagged until settled, then a zip with flow.json", { skip }, async () => {
  const { createFlow } = await import("./flows");
  const { handleFlowRoutes } = await import("../netlify/lib/flow-routes");
  const priya = await personId("Priya Example");
  const steps: FlowStep[] = [
    { id: "a", title: null, kind: "tool", tool: "add_todo", input: { title: ["Ring Priya Example about the renewal"], person_id: [priya] }, go: "auto", gives: [] },
    { id: "b", title: null, kind: "notify", text: ["Done: https://athena.example.com/#/people/" + priya] },
  ];
  const flow = await createFlow({ name: "Renewal call", trigger: { kind: "manual" }, steps });
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  const deps = { effects: async () => ({}) as never, handOff: async () => {} };
  const call = (body: unknown) => handleFlowRoutes(new Request(`https://athena.example.com/api/flows/${flow.id}/export`, { method: "POST" }), ["flows", flow.id, "export"], async () => body as Record<string, unknown>, json, deps);

  const looked = await (await call({}))!.json();
  assert.equal(looked.shared.name, "Renewal call");
  assert.deepEqual(looked.shared.asks.map((a: { key: string }) => a.key), ["person"]);
  assert.ok(!JSON.stringify(looked.shared).includes(priya), "no record id");
  assert.ok(!JSON.stringify(looked.shared).includes("athena.example.com"), "no link to the site");
  assert.deepEqual(looked.findings.map((f: { kind: string }) => f.kind), ["person"]);
  assert.deepEqual(looked.blocked, []);

  const refused = (await call({ download: true }))!;
  assert.equal(refused.status, 409);

  const fine = looked.findings.map((f: { id: string }) => f.id);
  const zip = (await call({ download: true, fine }))!;
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.match(zip.headers.get("content-disposition") ?? "", /renewal-call\.zip/);
  const { readSkillZip } = await import("./skill-zip");
  const files = readSkillZip(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(files.map((f) => f.path), ["renewal-call/flow.json"]);
});

test("a flow added from Community is shared with its listing as based_on; one made here has none", { skip }, async () => {
  const { addSharedFlow, exportFlowFor } = await import("./flow-share-store");
  const { createFlow } = await import("./flows");
  const { readSharedFlow } = await import("./flow-share");
  const { COMMUNITY_SITE } = await import("./community-site");
  const saved = process.env.ATHENA_CATALOGUE_URL;
  delete process.env.ATHENA_CATALOGUE_URL;
  try {
    const shared = readSharedFlow({
      format: 1,
      name: "Bin day",
      trigger: { kind: "schedule", days: [3], time: "19:00" },
      steps: [{ id: "s1", title: null, kind: "tool", tool: "add_reminder", input: { text: ["Bins out tonight"], time: ["20:00"] }, go: "auto", gives: [] }],
      asks: [],
    });
    const { id } = await addSharedFlow(shared, {}, { id: "k3m9p2q7r4s8t1v6", hash: HASH, version: "1.0" });
    const fromCommunity = await exportFlowFor(id, { hosts: ["athena.example.com"], known: [] });
    assert.equal(fromCommunity.shared.based_on, `${COMMUNITY_SITE}/items/k3m9p2q7r4s8t1v6/`);
    const made = await createFlow({ name: "Bins", trigger: { kind: "manual" }, steps: [{ id: "a", title: null, kind: "notify", text: ["Bins out"] }] });
    const own = await exportFlowFor(made.id, { hosts: ["athena.example.com"], known: [] });
    assert.equal(own.shared.based_on, undefined);
    // Pointed at another catalogue, the listing isn't the Community site's, so the file names none.
    process.env.ATHENA_CATALOGUE_URL = "https://catalogue.example.com";
    assert.equal((await exportFlowFor(id, { hosts: ["athena.example.com"], known: [] })).shared.based_on, undefined);
  } finally {
    if (saved === undefined) delete process.env.ATHENA_CATALOGUE_URL;
    else process.env.ATHENA_CATALOGUE_URL = saved;
  }
});

test("addSharedFlow: off, origin shared, Go on every change step, money off, catalogue kept", { skip }, async () => {
  const { addSharedFlow } = await import("./flow-share-store");
  const { getFlow, updateFlow } = await import("./flows");
  const { readSharedFlow } = await import("./flow-share");
  const { qRaw } = await import("./db");
  const sam = await personId("Sam Example");
  const shared = readSharedFlow({
    format: 1,
    name: "Check in",
    money: true,
    trigger: { kind: "schedule", days: [1], time: "09:00" },
    steps: [
      { id: "s1", title: null, kind: "tool", tool: "add_todo", input: { title: ["Check in"], person_id: [{ blank: "who" }] }, go: "auto", gives: [] },
      { id: "s2", title: null, kind: "tool", tool: "money", input: {}, go: "auto", gives: [] },
    ],
    asks: [{ key: "who", question: "Who should you check in with?", fills: "person" }],
  });
  const { id } = await addSharedFlow(shared, { who: sam }, { id: "check-in-weekly", hash: HASH, version: "1.0.0" });
  const flow = (await getFlow(id))!;
  assert.equal(flow.paused, true);
  assert.equal(flow.origin, "shared");
  assert.equal(flow.money, false);
  assert.equal(flow.unfilled, undefined);
  // A change waits for Go; a step that only looks runs (the owner's decision, 24 Nov 2026).
  for (const s of flow.steps) assert.ok(s.kind === "tool" && s.go === (s.tool === "money" ? "auto" : "ask"), s.kind === "tool" ? s.tool : s.kind);
  const [todo] = flow.steps;
  assert.ok(todo.kind === "tool");
  assert.deepEqual(todo.input.person_id, [sam]);
  const [row] = await qRaw<{ catalogue_id: string; catalogue_hash: string; catalogue_version: string }>(`SELECT catalogue_id, catalogue_hash, catalogue_version FROM flows WHERE id = $1`, [id]);
  assert.deepEqual({ ...row }, { catalogue_id: "check-in-weekly", catalogue_hash: HASH, catalogue_version: "1.0.0" });
  // Nothing stops it being switched on.
  assert.equal((await updateFlow(id, { paused: false })).paused, false);
  // A listing that isn't one is refused, and so is words where a record was asked for.
  await assert.rejects(addSharedFlow(shared, {}, { id: "x", hash: "nope" }), /catalogue listing/);
  await assert.rejects(addSharedFlow(shared, { who: "Sam Example" }), /picked from the list/);
});

test("an unanswered blank keeps the flow off until its field is set", { skip }, async () => {
  const { addSharedFlow } = await import("./flow-share-store");
  const { getFlow, updateFlow } = await import("./flows");
  const { readSharedFlow } = await import("./flow-share");
  const shared = readSharedFlow({
    format: 1,
    name: "Check in",
    trigger: { kind: "manual" },
    steps: [{ id: "s1", title: null, kind: "tool", tool: "add_todo", input: { title: ["Check in"], person_id: [{ blank: "who" }] }, go: "auto", gives: [] }],
    asks: [{ key: "who", question: "Who should you check in with?", fills: "person" }],
  });
  const { id } = await addSharedFlow(shared, {});
  const flow = (await getFlow(id))!;
  assert.deepEqual(flow.unfilled, [{ step_id: flow.steps[0].id, field: "input.person_id", question: "Who should you check in with?" }]);
  await assert.rejects(updateFlow(id, { paused: false }), /Answer “Who should you check in with\?” in its step first/);
  // A rename keeps it listed.
  assert.equal((await updateFlow(id, { name: "Weekly check in" })).unfilled?.length, 1);
  const steps = structuredClone(flow.steps);
  const [s] = steps;
  if (s.kind === "tool") s.input.person_id = [await personId("Sam Example")];
  const set = await updateFlow(id, { steps });
  assert.equal(set.unfilled, undefined);
  assert.equal((await updateFlow(id, { paused: false })).paused, false);
});

test("a thinking step keeps a shared flow off until it has an assistant", { skip }, async () => {
  const { addSharedFlow } = await import("./flow-share-store");
  const { getFlow, setFlowAssistant, updateFlow } = await import("./flows");
  const { createAssistant } = await import("./team");
  const { readSharedFlow } = await import("./flow-share");
  const shared = readSharedFlow({
    format: 1,
    name: "Deal finder",
    web: true,
    trigger: { kind: "manual" },
    steps: [{ id: "s1", title: null, kind: "think", task: ["Find a cheaper broadband deal"], web: true, gives: [{ key: "answer", label: "the answer", kind: "text" }] }],
    asks: [],
  });
  const { id } = await addSharedFlow(shared, {});
  const flow = (await getFlow(id))!;
  assert.equal(flow.assistant_id, null);
  assert.ok(flow.steps[0].kind === "think" && flow.steps[0].web === false);
  await assert.rejects(updateFlow(id, { paused: false }), /Pick an assistant/);
  const moss = await createAssistant({ job: "Finds deals" });
  await setFlowAssistant(id, moss.id);
  assert.equal((await updateFlow(id, { paused: false })).paused, false);
});
