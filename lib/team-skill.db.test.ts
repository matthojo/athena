// An assistant's own skill on real Postgres (migration 0069, docs/team.md "Skills"): written when the
// assistant is added (after the response) and owned by it; loaded into its chats and runs; never listed,
// offered or loaded by main Ask; deleted with the assistant; and the update offer, which keeps the
// owner's own edits unless they accept. The model is a fake client, or none (the plain skill).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team-skill.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team and skill tables first.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";
// No model key: the skill Athena writes is the plain one, so it's known exactly.
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete process.env[k];

const PENNY = { name: "Penny", job: "Finds good prices for gift ideas", instructions: "Only shops the owner trusts.", allow: ["add_todo"] };
const ANSWERS = [
  { question: "Which shops do you trust?", answer: "Waterstones and Smyths" },
  { question: "What's your budget per gift?", answer: "Under £50" },
];

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  await qRaw(`DELETE FROM ask_threads`);
  // The starters are added once; with the table emptied, say they were, so lists hold only these tests' skills.
  await qRaw(`INSERT INTO settings (key, value) VALUES ('skills.starters', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`);
});

type Params = { system?: unknown; tools?: Array<{ name: string }>; tool_choice?: { name?: string }; messages: Array<{ role: string; content: unknown }> };
type Block = { type: string; [k: string]: unknown };
function fakeClient(script: (p: Params, n: number) => Block[]) {
  const calls: Params[] = [];
  const client = {
    messages: {
      create: async (p: Params) => {
        calls.push(structuredClone(p));
        const content = script(p, calls.length);
        return { id: `m${calls.length}`, type: "message", role: "assistant", model: "fake", content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { client: client as never, calls };
}
const text = (t: string): Block => ({ type: "text", text: t });
const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input });

/** The team routes as api.ts calls them, with waitUntil kept so a test can wait for the skill. */
async function route(method: string, path: string, body?: unknown) {
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const { AthenaInputError } = await import("./db");
  const later: Promise<unknown>[] = [];
  const u = new URL(`https://x/api${path}`);
  try {
    const res = await handleTeamRoutes(new Request(u, { method }), u, u.pathname.split("/").filter(Boolean).slice(1), async () => (body ?? null) as Record<string, unknown> | null, (d, s = 200) => Response.json(d, { status: s }), (p) => later.push(p));
    return { status: res!.status, body: await res!.json(), later };
  } catch (error) {
    if (error instanceof AthenaInputError) return { status: error.status, body: { error: error.message }, later };
    throw error;
  }
}

test("adding an assistant writes its skill after the response, owned by it and off", { skip }, async () => {
  const { assistantSkill } = await import("./skills-store");
  const made = await route("POST", "/team", { ...PENNY, answers: ANSWERS });
  assert.equal(made.status, 201);
  assert.equal(made.body.name, "Penny");
  assert.equal(made.later.length, 1, "the skill is written under waitUntil");
  const before = await route("GET", `/team/${made.body.id}/skill`);
  assert.equal(before.status, 200);
  await Promise.all(made.later);
  const s = (await assistantSkill(made.body.id))!;
  assert.equal(s.assistant_id, made.body.id);
  assert.equal(s.enabled, false, "never on: main Ask doesn't use it");
  assert.equal(s.source.kind, "team");
  assert.match(s.body, /Waterstones and Smyths/);
  assert.match(s.body, /Under £50/);
  assert.deepEqual(s.team?.answers, ANSWERS);
  const info = await route("GET", `/team/${made.body.id}/skill`);
  assert.equal(info.body.skill.id, s.id);
  assert.match(info.body.skill.summary, /^Penny finds good prices/);
  assert.equal(info.body.stale, false);
  assert.equal(info.body.edited, false);
  // Sealed at rest, like any skill.
  const { qRaw } = await import("./db");
  const [raw] = await qRaw<{ payload: string }>(`SELECT payload FROM ask_skills WHERE id = $1::uuid`, [s.id]);
  assert.doesNotMatch(raw.payload, /Waterstones/);
});

test("an assistant without a skill gets one on request; a name already taken gets a number", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { createSkill } = await import("./skills-store");
  await createSkill({ name: "penny-finds-good-prices-for-gift-ideas", description: "Use when the owner asks.", body: "1. Something else." });
  const a = await createAssistant(PENNY);
  const none = await route("GET", `/team/${a.id}/skill`);
  assert.deepEqual(none.body, { skill: null, stale: false, edited: false });
  const given = await route("POST", `/team/${a.id}/skill`, { answers: ANSWERS });
  assert.equal(given.status, 200);
  assert.equal(given.body.skill.name, "penny-finds-good-prices-for-gift-ideas-2");
  assert.deepEqual(given.body.skill.answers, ANSWERS);
  assert.equal((await route("GET", `/team/00000000-0000-4000-8000-000000000000/skill`)).status, 404);
});

test("its chats and runs load the skill; a check does too; another assistant's turn doesn't", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { attachSkill } = await import("./team-skill-make");
  const penny = await createAssistant(PENNY);
  const dot = await createAssistant({ name: "Dot", job: "Turns Linear issues into to-dos" });
  await attachSkill(penny.id, ANSWERS);

  const chat = fakeClient((p) => (p.tool_choice?.name === "memory" ? [use("memory", { summary: "", facts: [] })] : [text("On it.")]));
  await runAssistantTurn(penny.id, "Any news on the scarf?", { mode: "chat", client: chat.client });
  assert.match(String(chat.calls[0].system), /<skill name="penny-finds-good-prices-for-gift-ideas">[\s\S]*Waterstones and Smyths[\s\S]*<\/skill>/, "chat");

  const run = fakeClient((p) => (p.tool_choice?.name === "memory" ? [use("memory", { summary: "", facts: [] })] : [text("Nothing new.")]));
  await runAssistantTurn(penny.id, "Run now", { mode: "run", client: run.client });
  assert.match(String(run.calls[0].system), /<skill name="penny-[^"]+">[\s\S]*Under £50/, "run");

  const check = fakeClient(() => [text("Nothing new.")]);
  await runAssistantTurn(penny.id, "Anything on prices?", { mode: "chat", readOnly: true, client: check.client });
  assert.match(String(check.calls[0].system), /Under £50/, "a check");

  const other = fakeClient((p) => (p.tool_choice?.name === "memory" ? [use("memory", { summary: "", facts: [] })] : [text("Done.")]));
  await runAssistantTurn(dot.id, "Run now", { mode: "run", client: other.client });
  assert.doesNotMatch(String(other.calls[0].system), /Waterstones|<skill name=/, "Dot never gets Penny's skill");
});

test("main Ask never lists, offers or loads an assistant's skill, even switched on or picked by id", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { attachSkill } = await import("./team-skill-make");
  const { createSkill, enabledSkills, updateSkill, listSkills } = await import("./skills-store");
  const { loadSkillTools } = await import("./skills-ask");
  const { runAsk } = await import("./answer");
  const { qRaw } = await import("./db");
  const penny = await createAssistant(PENNY);
  const own = (await attachSkill(penny.id, ANSWERS))!;
  const mine = await createSkill({ name: "deal-notes", description: "Use when the owner asks about a deal.", body: "1. Read the calls.", enabled: true });

  // Switching it on through the editor's route is ignored; even forced on in the table, Ask's list skips it.
  assert.equal((await updateSkill(own.id, { enabled: true })).enabled, false);
  await qRaw(`UPDATE ask_skills SET enabled = true WHERE id = $1::uuid`, [own.id]);
  assert.deepEqual((await enabledSkills()).map((s) => s.id), [mine.id]);
  const picked = await loadSkillTools({ picked: own.id });
  assert.equal(picked.picked, null, "picked by id with “/”: not loaded");
  assert.match(picked.skills.prompt(), /deal-notes/);
  assert.doesNotMatch(picked.skills.prompt(), /penny-/);
  await assert.rejects(picked.skills.run("use_skill", { name: own.name }), /no skill called/, "use_skill can't load it");

  const ask = fakeClient(() => [text("Here's what I found.")]);
  await runAsk("What gifts are on my list?", { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, client: ask.client, web: async () => false }, { log: false, skill: own.id });
  const system = String(ask.calls[0].system);
  assert.match(system, /deal-notes/);
  assert.doesNotMatch(system, /penny-finds|Waterstones and Smyths/);
  assert.doesNotMatch(JSON.stringify(ask.calls[0].messages), /Waterstones and Smyths/);

  // Settings → Skills still shows it, tagged with its assistant.
  const listed = (await listSkills()).find((s) => s.id === own.id)!;
  assert.equal(listed.assistant_id, penny.id);
});

test("deleting an assistant deletes its skill; the owner's skills stay", { skip }, async () => {
  const { createAssistant, deleteAssistant } = await import("./team");
  const { attachSkill } = await import("./team-skill-make");
  const { createSkill, getSkill, listSkills } = await import("./skills-store");
  const penny = await createAssistant(PENNY);
  const own = (await attachSkill(penny.id, []))!;
  const mine = await createSkill({ name: "deal-notes", description: "Use when the owner asks about a deal.", body: "1. Read the calls." });
  assert.equal(await deleteAssistant(penny.id), true);
  assert.equal(await getSkill(own.id), null);
  assert.deepEqual((await listSkills()).map((s) => s.id), [mine.id]);
  // A skill written for an assistant that was deleted meanwhile isn't kept.
  const gone = await createAssistant({ name: "Wren", job: "Sums up the week" });
  await deleteAssistant(gone.id);
  assert.equal(await attachSkill(gone.id, []), null);
});

test("the update offer: the owner's edits stay until they accept", { skip }, async () => {
  const { createAssistant, updateAssistant } = await import("./team");
  const { attachSkill } = await import("./team-skill-make");
  const { updateSkill, assistantSkill } = await import("./skills-store");
  const penny = await createAssistant(PENNY);
  const own = (await attachSkill(penny.id, ANSWERS))!;
  const mine = "# How Penny works\n\n1. Only Waterstones.\n2. Never over £30.";
  await updateSkill(own.id, { body: mine });
  let info = await route("GET", `/team/${penny.id}/skill`);
  assert.equal(info.body.edited, true);
  assert.equal(info.body.stale, false, "nothing to offer while the job is the same");

  // The job changes: an offer, and the owner's text is untouched.
  await updateAssistant(penny.id, { instructions: "Any shop with free delivery." });
  info = await route("GET", `/team/${penny.id}/skill`);
  assert.equal(info.body.stale, true);
  assert.equal((await assistantSkill(penny.id))!.body, mine);

  // The preview is only words: nothing saved.
  const preview = await route("POST", `/team/${penny.id}/skill`, { preview: true });
  assert.match(preview.body.preview.body, /free delivery/);
  assert.match(preview.body.preview.body, /Waterstones and Smyths/, "the setup answers are kept");
  assert.ok(preview.body.preview.gist.length > 0);
  assert.equal((await assistantSkill(penny.id))!.body, mine);

  // Keep mine: the offer goes, the text stays.
  info = await route("POST", `/team/${penny.id}/skill`, { keep: true });
  assert.equal(info.body.stale, false);
  assert.equal(info.body.edited, true);
  assert.equal((await assistantSkill(penny.id))!.body, mine);

  // It comes back when the job changes again; accepting replaces the owner's text.
  await updateAssistant(penny.id, { job: "Finds good prices for birthday gifts" });
  assert.equal((await route("GET", `/team/${penny.id}/skill`)).body.stale, true);
  const again = await route("POST", `/team/${penny.id}/skill`, { preview: true });
  const accepted = await route("PUT", `/team/${penny.id}/skill`, again.body.preview);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.stale, false);
  assert.equal(accepted.body.edited, false);
  assert.match((await assistantSkill(penny.id))!.body, /birthday gifts/);
  assert.equal((await route("PUT", `/team/${penny.id}/skill`, { body: "" })).status, 400);
});
