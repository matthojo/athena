// Team on real Postgres with every migration (0067 included): assistants and triggers made, read,
// changed and removed; words and memory sealed at rest; the cap of 12; bad input refused; and the
// routes (lists, 404s, the 501 stubs in their final shape).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team tables first.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const MUSE = {
  name: "Muse",
  job: "Finds good prices for gift ideas",
  instructions: "Look for the best price from a shop the owner trusts.",
  allow: ["add_todo"],
  triggers: [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }],
};

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
});

test("an assistant is made, read, changed and removed, with its triggers", { skip }, async () => {
  const { createAssistant, getAssistant, listAssistants, updateAssistant, deleteAssistant, listTriggers } = await import("./team");
  const { qRaw } = await import("./db");

  const a = await createAssistant(MUSE);
  assert.equal(a.name, "Muse");
  assert.equal(a.job, MUSE.job);
  assert.deepEqual(a.allow, ["add_todo"]);
  assert.equal(a.avatar.v, 1, "a character from a fresh seed");
  assert.ok(a.personality.greeting);
  assert.deepEqual(a.memory, { summary: "", facts: [] });
  assert.equal(a.triggers.length, 1);
  assert.deepEqual(a.triggers[0].event, { source: "saved", savedAction: "gift-idea" });

  // Sealed at rest: the name and job are nowhere in the row as stored.
  const [raw] = await qRaw<{ payload: string }>(`SELECT payload FROM team_assistants WHERE id = $1`, [a.id]);
  assert.ok(!raw.payload.includes("Muse") && !raw.payload.includes("gift"), "payload is sealed");

  assert.deepEqual((await listAssistants()).map((x) => x.id), [a.id]);
  assert.deepEqual(await getAssistant(a.id), a);

  // Change the job and add a schedule beside the kept event trigger.
  const keep = a.triggers[0].id;
  const b = await updateAssistant(a.id, { job: "Watches gift prices", paused: true, triggers: [{ id: keep, kind: "event", event: { source: "saved", savedAction: "gift-idea", match: "lego" } }, { kind: "schedule", days: ["weekdays"], time: "8am" }] });
  assert.equal(b.job, "Watches gift prices");
  assert.equal(b.name, "Muse", "untouched words stay");
  assert.equal(b.paused, true);
  assert.deepEqual(b.avatar, a.avatar, "the character stays");
  assert.equal(b.triggers.length, 2);
  assert.equal(b.triggers.find((t) => t.kind === "event")!.id, keep, "the kept trigger keeps its id");
  const sched = b.triggers.find((t) => t.kind === "schedule")!;
  assert.deepEqual(sched.days, [1, 2, 3, 4, 5]);
  assert.equal(sched.time, "08:00");

  // Triggers left out are removed.
  const c = await updateAssistant(a.id, { triggers: [{ id: sched.id, kind: "schedule", days: ["friday"], time: "17:00" }] });
  assert.deepEqual(c.triggers.map((t) => [t.id, t.days, t.time]), [[sched.id, [5], "17:00"]]);

  assert.equal(await deleteAssistant(a.id), true);
  assert.equal(await getAssistant(a.id), null);
  assert.deepEqual(await listTriggers(), [], "its triggers went with it");
  assert.equal(await deleteAssistant(a.id), false);
});

test("triggers on their own: list, get, create, update, delete", { skip }, async () => {
  const { createAssistant, createTrigger, getTrigger, listTriggers, updateTrigger, deleteTrigger } = await import("./team");
  const a = await createAssistant({ job: "Turns Linear issues into to-dos" });
  assert.ok(a.name, "a name from the seed when none is given");
  const t = await createTrigger(a.id, { kind: "event", event: { source: "collected", connector: "linear", kind: "issue", match: "bug" } });
  assert.deepEqual(await getTrigger(t.id), t);
  assert.deepEqual((await listTriggers(a.id)).map((x) => x.id), [t.id]);
  const u = await updateTrigger(t.id, { kind: "schedule", days: "mon, wed", time: "09:30" });
  assert.equal(u.kind, "schedule");
  assert.deepEqual(u.days, [1, 3]);
  assert.equal(u.event, null);
  assert.equal(await deleteTrigger(t.id), true);
  assert.equal(await getTrigger(t.id), null);
});

test("bad input is refused, and the team stops at 12", { skip }, async () => {
  const { createAssistant, checkRoom } = await import("./team");
  const { AthenaInputError } = await import("./db");
  const { MAX_ASSISTANTS } = await import("./team-types");
  await assert.rejects(createAssistant({}), /job/);
  await assert.rejects(createAssistant({ job: "x", allow: ["Rm -rf"] }), AthenaInputError);
  await assert.rejects(createAssistant({ job: "x", triggers: [{ kind: "schedule", days: ["someday"], time: "8" }] }), AthenaInputError);
  await assert.rejects(createAssistant({ job: "x", triggers: [{ kind: "event" }] }), /event/);
  await assert.rejects(createAssistant({ job: "x", bogus: 1 }), AthenaInputError);
  const avatar = (await createAssistant({ job: "x" })).avatar;
  await assert.rejects(createAssistant({ job: "x", avatar: { ...avatar, accessories: ["beanie", "crown"] } }), /one accessory per slot/);
  await assert.rejects(createAssistant({ job: "x", avatar: { ...avatar, fur: "neon" } }), /palette/);

  for (let i = 1; i < MAX_ASSISTANTS; i++) await createAssistant({ job: `Job ${i}` });
  await assert.rejects(createAssistant({ job: "one too many" }), /12 assistants/);
  assert.throws(() => checkRoom(MAX_ASSISTANTS), AthenaInputError);
});

test("memory is sealed, cut to size, and comes back", { skip }, async () => {
  const { createAssistant, getAssistant, setMemory } = await import("./team");
  const { qRaw } = await import("./db");
  const a = await createAssistant({ job: "Sums up the week" });
  const facts = Array.from({ length: 40 }, (_, i) => `fact ${i}`);
  const m = await setMemory(a.id, { summary: "Jordan likes Friday summaries short. ".repeat(100), facts });
  assert.ok(m.summary.length <= 2000 && m.summary.length > 1990);
  assert.equal(m.facts.length, 30);
  assert.equal(m.facts[29], "fact 39", "the newest facts are kept");
  const [raw] = await qRaw<{ memory: string }>(`SELECT memory FROM team_assistants WHERE id = $1`, [a.id]);
  assert.ok(!raw.memory.includes("Friday"), "memory is sealed");
  const back = await getAssistant(a.id);
  assert.deepEqual(back!.memory, m);
  assert.ok(back!.memory_updated_at);
});

test("routes: list, one, change, remove, 404s, draft, memory and the 501 stubs", { skip }, async () => {
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const call = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://x/api${path}`);
    const res = await handleTeamRoutes(new Request(u, { method }), u, path.split("/").filter(Boolean), async () => (body ?? null) as Record<string, unknown> | null, (d, s = 200) => Response.json(d, { status: s }));
    return res ? { status: res.status, body: await res.json() } : null;
  };

  const made = await call("POST", "/team", MUSE);
  assert.equal(made!.status, 201);
  const id = made!.body.id as string;
  const list = await call("GET", "/team");
  assert.equal(list!.body.max, 12);
  assert.deepEqual(list!.body.assistants.map((a: { id: string }) => a.id), [id]);
  assert.equal((await call("GET", `/team/${id}`))!.body.name, "Muse");
  assert.equal((await call("PATCH", `/team/${id}`, { name: "Muse II" }))!.body.name, "Muse II");
  assert.equal((await call("PUT", `/team/${id}`))!.status, 405);
  assert.equal((await call("GET", "/team/not-an-id"))!.status, 404);
  assert.equal((await call("GET", "/team/00000000-0000-4000-8000-000000000000"))!.status, 404);

  // No model here: the plain draft from the sentence (lib/team-draft.ts).
  const draft = await call("POST", "/team/draft", { text: "Every Friday at 5, sum up my week" });
  assert.equal(draft!.status, 200);
  assert.equal(draft!.body.draft.job, "Sum up my week");
  assert.equal((await call("POST", "/team/draft", { text: " " }))!.status, 400);
  assert.deepEqual((await call("GET", `/team/${id}/runs`))!.body.runs, []);
  // Run now with no background function to reach (no bearer token here): the run is kept, failed, and says so.
  const ran = await call("POST", `/team/${id}/run`);
  assert.equal(ran!.status, 503);
  assert.equal(ran!.body.run.status, "failed");
  assert.deepEqual((await call("GET", `/team/${id}/runs`))!.body.runs.map((r: { id: string }) => r.id), [ran!.body.run.id]);
  assert.deepEqual((await call("DELETE", `/team/${id}/memory`))!.body.memory, { summary: "", facts: [] });

  assert.deepEqual((await call("DELETE", `/team/${id}`))!.body, { ok: true });
  assert.equal((await call("DELETE", `/team/${id}`))!.status, 404);
});
