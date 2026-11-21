// AI models on real Postgres with every migration (0077 included), through the real routes (docs/ai-models.md):
//  1. the owner's choices: kept, read back, a null goes back to the default, and bad input refused with a code;
//  2. agreements: a provider not agreed to is refused (409), agreeing lets it through, taking it back resets every
//     choice on it, the owner's and each assistant's;
//  3. precedence for every role and every job: assistant, owner (job, then tier), env var, default;
//  4. an assistant's own models through the team routes: kept, PATCH without them keeps them, checked like the owner's;
//  5. used: Ask's loop, an assistant's turn, a Team run and a background job call the model the settings say, and a
//     model that fails before answering is tried once on the default, with `fell_back` on the reply and the run;
//  6. Try it: one small call, timed, under the same agreement rule;
//  7. a hidden model already chosen (an older version, a snapshot) stays valid and runs; effective offers the newer
//     version, flags one the gateway stops listing with what runs instead, and lists each assistant's models.
//  8. a model for one message (Ask's and an assistant chat's `model`): honoured for that turn, refused without the
//     agreement (409 through api.ts), checked for tools, and never stored;
//  9. the routes are reached through netlify/functions/api.ts, as the app calls them, behind the token.
// The model is a fake client; the gateway's list is the committed snapshot (no network).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/models.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team tables, ask_threads and the ai_models row first.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  process.env.ANTHROPIC_API_KEY ??= "test";
  (globalThis as { Netlify?: unknown }).Netlify ??= { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const OPUS = { provider: "anthropic", model: "claude-opus-5-5" } as const;
const HAIKU = { provider: "anthropic", model: "claude-haiku-5-5" } as const;
const SONNET = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;
const GEMINI = { provider: "gemini", model: "gemini-3.1-pro-preview" } as const;
const GEMINI_PICTURES = { provider: "gemini", model: "gemini-3-pro-image" } as const;
const MOSS = { name: "Moss", job: "Finds good prices for gift ideas", instructions: "Only shops the owner trusts.", allow: ["add_todo"] };
const ENVS = ["ATHENA_ANSWER_MODEL", "ATHENA_ASSISTANT_MODEL", "ATHENA_FILE_SUMMARY_MODEL", "ATHENA_CHECKIN_DEEPER_MODEL", "ATHENA_TEAM_MEMORY_MODEL", "ATHENA_TEAM_QUESTIONS_MODEL", "ATHENA_BRIEFING_MODEL", "ATHENA_DRAFT_MODEL", "ATHENA_RECIPE_MODEL", "ATHENA_TEAM_DRAFT_MODEL", "ATHENA_TEAM_SKILL_MODEL", "ATHENA_LEARNER_MODEL", "ATHENA_COLLECTOR_MODEL"];

beforeEach(async () => {
  if (!url) return;
  for (const e of ENVS) delete process.env[e];
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  await qRaw(`DELETE FROM ask_threads`);
  await qRaw(`DELETE FROM settings WHERE key IN ('ai_models', 'ai_gateway_models')`);
  // The gateway's list: the snapshot, held as if just read, so nothing goes to the network.
  const { forgetCatalogue, SNAPSHOT } = await import("./model-catalogue");
  forgetCatalogue({ ...SNAPSHOT, fetched_at: new Date().toISOString() });
});
after(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM settings WHERE key IN ('ai_models', 'ai_gateway_models')`);
});

type Params = { model: string; tool_choice?: { name?: string }; messages: unknown[] };
type Block = { type: string; [k: string]: unknown };

/** A fake model: `fails` names models that error before answering; every call's model is kept. */
function fakeClient(script: (p: Params) => Block[], fails: string[] = []) {
  const models: string[] = [];
  const client = {
    messages: {
      create: async (p: Params) => {
        models.push(p.model);
        if (fails.includes(p.model)) throw Object.assign(new Error("Model not found"), { status: 404, error: { type: "not_found_error" } });
        const content = script(p);
        return { id: `m${models.length}`, type: "message", role: "assistant", model: p.model, content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { client: client as never, models };
}
const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `tu_${name}_${randomUUID().slice(0, 6)}`, name, input });
const answer = (t: string): Block => use("answer", { text: t, found: true, general: true, from_today: false, sources: [], next: [], ask: { question: "", options: [], more: [] } });
const replyOrMemory = (t: string) => (p: Params) => (p.tool_choice?.name === "memory" ? [use("memory", { summary: "", facts: [] })] : [answer(t)]);

async function routes(client?: unknown) {
  const { handleModelsRoutes } = await import("../netlify/lib/models-routes");
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const { AthenaInputError } = await import("./db");
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
  const call = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://x/api${path}`);
    const req = new Request(u, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const segments = u.pathname.split("/").filter(Boolean).slice(1);
    const read = async () => (body as Record<string, unknown>) ?? null;
    try {
      const r = segments[0] === "team" ? await handleTeamRoutes(req, u, segments, read, json) : await handleModelsRoutes(req, segments, read, json, { client: client as never });
      return { status: r!.status, body: (await r!.json()) as Record<string, any> };
    } catch (error) {
      // As api.ts answers.
      if (error instanceof AthenaInputError) return { status: error.status, body: { error: error.message } as Record<string, any> };
      throw error;
    }
  };
  return call;
}

test("the owner's choices: kept, read back, null is the default, and bad input refused with a code", { skip }, async () => {
  const call = await routes();
  const empty = await call("GET", "/models");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.settings, {});
  assert.deepEqual(empty.body.effective.think, { ref: SONNET, from: "default" });
  assert.equal(empty.body.effective.image, null, "pictures are off until chosen");
  assert.deepEqual(empty.body.effective.everyday, { ref: HAIKU, from: "default" });
  assert.equal(empty.body.configured.anthropic, true);
  assert.ok(empty.body.catalogue.length > 50 && empty.body.updated_at);
  assert.ok(empty.body.catalogue.every((m: { recommended: boolean }) => m.recommended === false), "nothing recommended");
  assert.deepEqual(empty.body.effective.assistants, {}, "no assistant has models of its own");

  const set = await call("PATCH", "/models", { think: OPUS, everyday: "anthropic/claude-sonnet-5-5", jobs: { drafts: HAIKU } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.settings, { think: OPUS, everyday: SONNET, jobs: { drafts: HAIKU } });
  assert.deepEqual(set.body.effective.think, { ref: OPUS, from: "owner" });
  assert.deepEqual(set.body.effective.jobs.drafts, { ref: HAIKU, from: "job" });
  assert.deepEqual(set.body.effective.jobs.file_summary, { ref: SONNET, from: "tier" });
  assert.deepEqual((await call("GET", "/models")).body.settings, set.body.settings, "kept");

  const back = await call("PATCH", "/models", { think: null, jobs: { drafts: null } });
  assert.deepEqual(back.body.settings, { everyday: SONNET });
  assert.deepEqual(back.body.effective.think, { ref: SONNET, from: "default" });

  const refused = async (body: unknown, code: string) => {
    const r = await call("PATCH", "/models", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, code, JSON.stringify(r.body));
    assert.ok(r.body.error);
  };
  await refused({ think: { provider: "anthropic", model: "claude-made-up" } }, "unknown_model");
  await refused({ mood: OPUS }, "bad_input");
  await refused({ consent: { gemini: "2026-11-17T10:00:00Z" } }, "bad_input");
  await refused({ jobs: { made_up: OPUS } }, "bad_input");
  await refused({ think: "not a model" }, "bad_input");
  await refused({ image: OPUS }, "no_pictures");
  // Nothing was kept from a refused change.
  assert.deepEqual((await call("GET", "/models")).body.settings, { everyday: SONNET });
});

test("agreements: refused without one, kept with one, and taking it back resets every choice on that provider", { skip }, async () => {
  const call = await routes();
  const { createAssistant } = await import("./team");
  const moss = await createAssistant(MOSS);

  const no = await call("PATCH", "/models", { think: GEMINI });
  assert.equal(no.status, 409);
  assert.equal(no.body.code, "consent_needed");
  assert.equal(no.body.provider, "gemini");
  assert.match(no.body.error, /Google/);
  const noTeam = await call("PATCH", `/team/${moss.id}`, { models: { think: GEMINI } });
  assert.equal(noTeam.status, 409, "an assistant's model needs the same agreement");
  assert.equal(noTeam.body.code, "consent_needed");
  // Hand-written into the row without an agreement, it's ignored when read.
  const { qRaw } = await import("./db");
  await qRaw(`INSERT INTO settings (key, value) VALUES ('ai_models', $1::jsonb)`, [JSON.stringify({ think: GEMINI })]);
  const { resolveThinkModel } = await import("./models");
  assert.deepEqual(await resolveThinkModel(), { ref: SONNET, from: "default" });
  await qRaw(`DELETE FROM settings WHERE key = 'ai_models'`);

  assert.equal((await call("POST", "/models/consent", { provider: "anthropic" })).status, 400, "Anthropic needs none");
  assert.equal((await call("POST", "/models/consent", { provider: "jev" })).status, 400);
  const yes = await call("POST", "/models/consent", { provider: "gemini" });
  assert.equal(yes.status, 200);
  const when = yes.body.settings.consent.gemini;
  assert.ok(Date.parse(when));
  assert.equal((await call("POST", "/models/consent", { provider: "gemini" })).body.settings.consent.gemini, when, "agreeing again keeps the first time");

  assert.equal((await call("PATCH", "/models", { think: GEMINI, image: GEMINI_PICTURES, careful: OPUS, jobs: { briefing: GEMINI, drafts: HAIKU } })).status, 200);
  assert.equal((await call("PATCH", `/team/${moss.id}`, { models: { think: GEMINI, image: GEMINI_PICTURES } })).status, 200);
  assert.deepEqual((await resolveThinkModel({ assistantId: moss.id })).ref, GEMINI);

  const taken = await call("DELETE", "/models/consent/gemini");
  assert.equal(taken.status, 200);
  assert.deepEqual(taken.body.settings, { careful: OPUS, jobs: { drafts: HAIKU } }, "only Google's choices go");
  assert.deepEqual(taken.body.effective.think, { ref: SONNET, from: "default" });
  assert.equal(taken.body.effective.image, null);
  assert.deepEqual(taken.body.effective.jobs.briefing, { ref: OPUS, from: "tier" });
  const after = (await call("GET", `/team/${moss.id}`)).body;
  assert.deepEqual(after.models, {}, "the assistant's Google models went back to Ask's");
  const [row] = await qRaw<{ models: unknown }>(`SELECT models FROM team_assistants WHERE id = $1`, [moss.id]);
  assert.deepEqual(row.models, {}, "and the row itself is reset");
  assert.equal((await call("PATCH", "/models", { think: GEMINI })).status, 409, "asked again next time");
  assert.equal((await call("DELETE", "/models/consent/anthropic")).status, 400);
});

test("precedence for every role and job: assistant, owner (job, then tier), env var, default", { skip }, async () => {
  const { JOBS } = await import("./model-types");
  const { resolveJobModel, resolveThinkModel, resolveImageModel, updateModelSettings, grantConsent } = await import("./models");
  const { createAssistant, updateAssistant } = await import("./team");
  const jobs = Object.keys(JOBS) as Array<keyof typeof JOBS>;
  assert.equal(jobs.length, 12);

  // Default, then each job's own env var.
  for (const j of jobs) assert.deepEqual(await resolveJobModel(j), { ref: JOBS[j].tier === "everyday" ? HAIKU : SONNET, from: "default" }, j);
  for (const j of jobs) {
    process.env[JOBS[j].env] = "claude-fable-5-2";
    assert.deepEqual(await resolveJobModel(j), { ref: { provider: "anthropic", model: "claude-fable-5-2" }, from: "env" }, j);
  }
  // The owner's tier beats the env var; a job's own model beats its tier.
  await updateModelSettings({ everyday: SONNET, careful: OPUS });
  for (const j of jobs) assert.deepEqual(await resolveJobModel(j), { ref: JOBS[j].tier === "everyday" ? SONNET : OPUS, from: "tier" }, j);
  await updateModelSettings({ jobs: Object.fromEntries(jobs.map((j) => [j, HAIKU])) });
  for (const j of jobs) assert.deepEqual(await resolveJobModel(j), { ref: HAIKU, from: "job" }, j);

  // Thinking: env var, then the owner, then the assistant's own.
  process.env.ATHENA_ANSWER_MODEL = "claude-opus-5";
  const moss = await createAssistant(MOSS);
  const plain = await createAssistant({ ...MOSS, name: "Plain" });
  assert.deepEqual(await resolveThinkModel(), { ref: { provider: "anthropic", model: "claude-opus-5" }, from: "env" });
  assert.deepEqual(await resolveThinkModel({ envName: "ATHENA_ASSISTANT_MODEL" }), { ref: { provider: "anthropic", model: "claude-fable-5-2" }, from: "env" }, "capture's env var");
  await updateModelSettings({ think: OPUS });
  assert.deepEqual(await resolveThinkModel(), { ref: OPUS, from: "owner" });
  assert.deepEqual(await resolveThinkModel({ assistantId: plain.id }), { ref: OPUS, from: "owner" }, "the same as Ask");
  await updateAssistant(moss.id, { models: { think: HAIKU } });
  assert.deepEqual(await resolveThinkModel({ assistantId: moss.id }), { ref: HAIKU, from: "assistant" });

  // Pictures: off, the owner's, an assistant's own, or off for one assistant.
  assert.equal(await resolveImageModel(), null);
  await grantConsent("gemini");
  await updateModelSettings({ image: GEMINI_PICTURES });
  assert.deepEqual(await resolveImageModel(), { ref: GEMINI_PICTURES, from: "owner" });
  assert.deepEqual(await resolveImageModel({ assistantId: plain.id }), { ref: GEMINI_PICTURES, from: "owner" });
  await updateAssistant(moss.id, { models: { think: HAIKU, image: null } });
  assert.equal(await resolveImageModel({ assistantId: moss.id }), null, "no pictures for this one");
  await updateAssistant(plain.id, { models: { image: { provider: "gemini", model: "gemini-2.5-flash-image" } } });
  assert.deepEqual(await resolveImageModel({ assistantId: plain.id }), { ref: { provider: "gemini", model: "gemini-2.5-flash-image" }, from: "assistant" });
  await updateModelSettings({ image: null });
  assert.equal(await resolveImageModel(), null, "null turns pictures off");
});

test("an assistant's own models through the team routes: kept, kept when left out, and checked", { skip }, async () => {
  const call = await routes();
  const made = await call("POST", "/team", { ...MOSS, models: { think: OPUS } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.models, { think: OPUS });
  const id = made.body.id;
  assert.deepEqual((await call("GET", "/team")).body.assistants[0].models, { think: OPUS });
  const renamed = await call("PATCH", `/team/${id}`, { name: "Moss Two" });
  assert.deepEqual(renamed.body.models, { think: OPUS }, "PATCH without models keeps them");
  const own = await call("PATCH", `/team/${id}`, { models: { image: null } });
  assert.deepEqual(own.body.models, { image: null }, "models is the whole set: think is Ask's again, no pictures");
  const cant = await call("PATCH", `/team/${id}`, { models: { think: { provider: "openrouter", model: "gryphe/mythomax-l2-13b" } } });
  assert.equal((await call("POST", "/models/consent", { provider: "openrouter" })).status, 200);
  const cant2 = await call("PATCH", `/team/${id}`, { models: { think: { provider: "openrouter", model: "gryphe/mythomax-l2-13b" } } });
  assert.equal(cant.status, 409);
  assert.equal(cant2.status, 400);
  assert.equal(cant2.body.code, "cant_think", "a model that can't use tools can't think");
  const unknown = await call("PATCH", `/team/${id}`, { models: { think: { provider: "openrouter", model: "acme/not-listed" } } });
  assert.equal(unknown.body.code, "unknown_model");
  // A gateway model Athena has no notes on can think: its tools are unknown, not "no".
  const untested = await call("PATCH", `/team/${id}`, { models: { think: { provider: "openrouter", model: "mistralai/mistral-medium-3" } } });
  assert.equal(untested.status, 200);
  assert.equal((await call("PATCH", `/team/${id}`, { models: { voice: OPUS } })).body.code, "bad_input");
  assert.equal((await call("PATCH", `/team/${id}`, { models: { think: GEMINI_PICTURES } })).status, 409);
  assert.deepEqual((await call("GET", `/team/${id}`)).body.models, { think: { provider: "openrouter", model: "mistralai/mistral-medium-3" } });
});

test("used: Ask, an assistant's turn and a Team run think with the chosen model, and fall back once when it fails", { skip }, async () => {
  const { updateModelSettings } = await import("./models");
  const { runAsk } = await import("./answer");
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const noSources = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
  const deps = (client: never) => ({ client, sources: noSources, web: async () => false, mentions: async () => ({ found: [], missing: [] }) });

  await updateModelSettings({ think: OPUS });
  const ok = fakeClient(() => [answer("Paris.")]);
  const reply = await runAsk("What's the capital of France?", deps(ok.client), { now: new Date("2026-11-17T10:00:00Z"), tz: "Europe/London", log: false });
  assert.deepEqual(ok.models, ["claude-opus-5-5"], "Ask thinks with the owner's model");
  assert.deepEqual(reply.model, OPUS);
  assert.equal(reply.fell_back, undefined);

  const down = fakeClient(() => [answer("Paris.")], ["claude-opus-5-5"]);
  const saved = await runAsk("What's the capital of France?", deps(down.client), { now: new Date("2026-11-17T10:00:00Z"), tz: "Europe/London", log: false });
  assert.deepEqual(down.models, ["claude-opus-5-5", "claude-sonnet-5-5"], "tried once on the default");
  assert.deepEqual(saved.model, SONNET);
  assert.equal(saved.fell_back, true);
  assert.deepEqual(saved.tried, OPUS, "tried names the model that didn't answer");
  assert.equal(saved.text, "Paris.");
  assert.equal(reply.tried, undefined);

  // An assistant with its own model thinks with it; one without thinks with Ask's.
  const moss = await createAssistant({ ...MOSS, models: { think: HAIKU } });
  const plain = await createAssistant({ ...MOSS, name: "Plain" });
  const a = fakeClient(replyOrMemory("Found it."));
  const t = await runAssistantTurn(moss.id, "Any good price for the scarf?", { mode: "chat", readOnly: true, client: a.client });
  assert.equal(a.models[0], "claude-haiku-5-5");
  assert.deepEqual(t.reply.model, HAIKU);
  const b = fakeClient(replyOrMemory("Found it."));
  await runAssistantTurn(plain.id, "Any good price for the scarf?", { mode: "chat", readOnly: true, client: b.client });
  assert.equal(b.models[0], "claude-opus-5-5");

  // A Team run keeps the model it used, and that it fell back.
  const { enqueueTeamRun, runTeamRun, getTeamRun } = await import("./team-run");
  const { updateAssistant } = await import("./team");
  await updateAssistant(moss.id, { models: { think: OPUS } });
  const c = fakeClient(replyOrMemory("Nothing new today."), ["claude-opus-5-5"]);
  const queued = await enqueueTeamRun(moss.id);
  await runTeamRun(queued.id, { turn: (id, prompt, opts) => runAssistantTurn(id, prompt, { ...opts, client: c.client }) });
  const run = (await getTeamRun(queued.id))!;
  assert.equal(run.status, "done");
  assert.deepEqual(run.model, SONNET);
  assert.equal(run.fell_back, true);
  assert.deepEqual(run.tried, OPUS, "the run keeps the model that didn't answer");
  assert.deepEqual(c.models.slice(0, 2), ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("used: a background job calls its model, and falls back once when it fails", { skip }, async () => {
  const { updateModelSettings, jobMessage } = await import("./models");
  const { draftSkill } = await import("./skill-draft");
  await updateModelSettings({ careful: OPUS, jobs: { team_memory: SONNET } });
  const draft = use("skill_draft", { name: "gift-prices", description: "Find good prices for gift ideas the owner saves.", body: "# Gift prices\n\n1. Look at saved gift ideas.\n2. Check prices." });
  const ok = fakeClient(() => [draft]);
  await draftSkill([{ role: "user", text: "Find me good prices for gifts" }, { role: "assistant", text: "Sure." }], { client: ok.client }).catch(() => undefined);
  assert.deepEqual(ok.models, ["claude-opus-5-5"], "skill_draft is careful work: the owner's Careful model");

  await updateModelSettings({ jobs: { team_memory: { provider: "anthropic", model: "claude-sonnet-5" } } });
  const failing = fakeClient(() => [{ type: "text", text: "hi" }], ["claude-sonnet-5"]);
  const m = await jobMessage("team_memory", failing.client, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, Date.now() + 10_000);
  assert.deepEqual(failing.models, ["claude-sonnet-5", "claude-haiku-5-5"], "an everyday job falls back to Haiku");
  assert.equal(m.model, "claude-haiku-5-5");

  // With the deploy's own model for the job, that's the fallback; when it's what failed, the code default.
  process.env.ATHENA_TEAM_MEMORY_MODEL = "claude-opus-5-5";
  const again = fakeClient(() => [{ type: "text", text: "hi" }], ["claude-sonnet-5"]);
  await jobMessage("team_memory", again.client, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, Date.now() + 10_000);
  assert.deepEqual(again.models, ["claude-sonnet-5", "claude-opus-5-5"], "the deploy's default first");
  await updateModelSettings({ jobs: { team_memory: null } });
  const envDown = fakeClient(() => [{ type: "text", text: "hi" }], ["claude-opus-5-5"]);
  await jobMessage("team_memory", envDown.client, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, Date.now() + 10_000);
  assert.deepEqual(envDown.models, ["claude-opus-5-5", "claude-haiku-5-5"], "the env model failed: the code default");
});

test("a hidden choice stays valid and runs; effective offers the newer one and flags a withdrawn one", { skip }, async () => {
  const call = await routes();
  const { resolveThinkModel, jobMessage } = await import("./models");
  const { forgetCatalogue, SNAPSHOT, shownModels } = await import("./model-catalogue");
  const OLD_OPUS = { provider: "anthropic", model: "claude-opus-4-8" } as const;
  const SNAP_HAIKU = { provider: "anthropic", model: "claude-haiku-4-5-20251001" } as const;
  const OLD_SONNET = { provider: "anthropic", model: "claude-sonnet-4-6" } as const;
  const hidden = (ref: { provider: string; model: string }) => !shownModels(SNAPSHOT).some((r) => r.provider === ref.provider && r.model === ref.model);
  assert.ok(hidden(OLD_OPUS) && hidden(SNAP_HAIKU) && hidden(OLD_SONNET), "none of these is shown");

  // Chosen anyway (already chosen before the list was trimmed, or by hand): accepted, since the gateway lists them.
  const set = await call("PATCH", "/models", { think: OLD_OPUS, jobs: { team_memory: SNAP_HAIKU } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const made = await call("POST", "/team", { ...MOSS, models: { think: OLD_SONNET } });
  assert.equal(made.status, 201);
  const id = made.body.id as string;
  await call("POST", "/team", { ...MOSS, name: "Plain" });

  assert.deepEqual(await resolveThinkModel(), { ref: OLD_OPUS, from: "owner" }, "it keeps running");
  assert.deepEqual(await resolveThinkModel({ assistantId: id }), { ref: OLD_SONNET, from: "assistant" });
  const job = fakeClient(() => [{ type: "text", text: "hi" }]);
  await jobMessage("team_memory", job.client, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, Date.now() + 10_000);
  assert.deepEqual(job.models, [SNAP_HAIKU.model], "a dated snapshot runs as chosen");

  const got = await call("GET", "/models");
  assert.deepEqual(got.body.effective.think, { ref: OLD_OPUS, from: "owner", newer: OPUS }, "kept, and the new one offered");
  assert.deepEqual(got.body.effective.jobs.team_memory, { ref: SNAP_HAIKU, from: "job", newer: HAIKU });
  assert.deepEqual(got.body.effective.think.withdrawn, undefined);
  assert.deepEqual(Object.keys(got.body.effective.assistants), [id], "only assistants with models of their own");
  assert.deepEqual(got.body.effective.assistants[id], { think: { ref: OLD_SONNET, from: "assistant", newer: SONNET }, image: null });
  const named = (ref: { model: string }) => got.body.catalogue.find((m: { ref: { model: string } }) => m.ref.model === ref.model);
  assert.equal(named(OLD_OPUS)?.name, "Claude Opus 4.8", "a hidden choice is in the catalogue, so the app can name it");
  assert.ok(named(OLD_SONNET) && named(SNAP_HAIKU));
  assert.ok(!named({ model: "claude-opus-4-7" }), "other hidden models aren't");

  // The gateway stops listing Opus 4.8: flagged, and what runs instead is the deploy's default.
  process.env.ATHENA_ANSWER_MODEL = HAIKU.model;
  forgetCatalogue({ ...SNAPSHOT, fetched_at: new Date().toISOString(), providers: { ...SNAPSHOT.providers, anthropic: { models: SNAPSHOT.providers.anthropic!.models.filter((m) => m !== OLD_OPUS.model) } } });
  const gone = await call("GET", "/models");
  assert.deepEqual(gone.body.effective.think, { ref: HAIKU, from: "owner", newer: OPUS, withdrawn: OLD_OPUS });
  assert.ok(!gone.body.catalogue.some((m: { ref: { model: string } }) => m.ref.model === OLD_OPUS.model), "not listed, so not in the catalogue");
  assert.deepEqual(gone.body.settings.think, OLD_OPUS, "the choice itself is kept");
  // At call time it's tried and falls back to the same model.
  const { runAsk } = await import("./answer");
  const noSources = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
  const ask = fakeClient(() => [answer("Paris.")], [OLD_OPUS.model]);
  const reply = await runAsk("What's the capital of France?", { client: ask.client, sources: noSources, web: async () => false, mentions: async () => ({ found: [], missing: [] }) } as never, { now: new Date("2026-11-17T10:00:00Z"), tz: "Europe/London", log: false });
  assert.deepEqual(ask.models, [OLD_OPUS.model, HAIKU.model]);
  assert.deepEqual(reply.model, HAIKU);
  assert.equal(reply.fell_back, true);
});

test("Try it: one small call, timed, under the same agreement rule", { skip }, async () => {
  const fake = fakeClient(() => [{ type: "text", text: " Hello there,\n friend! " }]);
  const call = await routes(fake.client);
  const ok = await call("POST", "/models/test", { ref: OPUS, role: "think" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.reply, "Hello there, friend!");
  assert.equal(typeof ok.body.ms, "number");
  assert.deepEqual(fake.models, ["claude-opus-5-5"]);
  assert.equal((await call("POST", "/models/test", { ref: "gemini/gemini-3.1-pro-preview", role: "think" })).status, 409);
  assert.equal((await call("POST", "/models/test", { ref: OPUS, role: "voice" })).status, 400);
  const broken = fakeClient(() => [], ["claude-opus-5-5"]);
  const failed = await (await routes(broken.client))("POST", "/models/test", { ref: OPUS, role: "think" });
  assert.deepEqual(failed.body, { ok: false, error: "The gateway doesn't have that model right now." });
});

test("through api.ts: every /api/models route is reached, behind the token", { skip }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const got = await call("GET", "/models");
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.ok(got.body.catalogue.length > 50 && got.body.effective.think);
  assert.equal((await call("PATCH", "/models", { think: OPUS })).body.effective.think.ref.model, OPUS.model);
  assert.equal((await call("POST", "/models/consent", { provider: "gemini" })).status, 200);
  assert.equal((await call("DELETE", "/models/consent/gemini")).status, 200);
  assert.equal((await call("POST", "/models/test", { ref: GEMINI_PICTURES, role: "image" })).body.code, "consent_needed");
  assert.equal((await call("GET", "/models", undefined, "wrong")).status, 401);
});

test("a model for one message: honoured for that turn in Ask and an assistant chat, refused without an agreement, never stored", { skip }, async () => {
  const { updateModelSettings, loadModelSettings, messageModel, grantConsent } = await import("./models");
  const { runAsk } = await import("./answer");
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const noSources = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
  const deps = (client: never) => ({ client, sources: noSources, web: async () => false, mentions: async () => ({ found: [], missing: [] }) });
  const when = { now: new Date("2026-11-17T10:00:00Z"), tz: "Europe/London", log: false as const };

  await updateModelSettings({ think: HAIKU });
  const before = await loadModelSettings();

  // Ask: this message on Sonnet, the next back on the owner's Haiku.
  const one = fakeClient(() => [answer("A cat on a mat.")]);
  const reply = await runAsk("What's in this photo?", deps(one.client), { ...when, model: await messageModel(SONNET) });
  assert.deepEqual(one.models, ["claude-sonnet-5-5"], "this message thinks with the model it named");
  assert.deepEqual(reply.model, SONNET);
  const next = fakeClient(() => [answer("Fine.")]);
  await runAsk("And now?", deps(next.client), when);
  assert.deepEqual(next.models, ["claude-haiku-5-5"], "the next message is back on the chosen model");
  assert.deepEqual(await loadModelSettings(), before, "nothing stored");

  // An assistant chat: the same, over the assistant's own model.
  const moss = await createAssistant({ ...MOSS, models: { think: OPUS } });
  const a = fakeClient(replyOrMemory("Found it."));
  const t = await runAssistantTurn(moss.id, "Is this scarf a good price?", { mode: "chat", client: a.client, model: await messageModel(SONNET) });
  assert.equal(a.models[0], "claude-sonnet-5-5");
  assert.deepEqual(t.reply.model, SONNET);
  const b = fakeClient(replyOrMemory("Found it."));
  await runAssistantTurn(moss.id, "And this one?", { mode: "chat", client: b.client });
  assert.equal(b.models[0], "claude-opus-5-5", "the assistant's own model again");
  // A check (read-only) is never a chat, so it never takes a message's model.
  const c = fakeClient(replyOrMemory("Found it."));
  await runAssistantTurn(moss.id, "Is it cheaper?", { mode: "chat", readOnly: true, client: c.client, model: await messageModel(SONNET) });
  assert.equal(c.models[0], "claude-opus-5-5");
  const { getAssistant } = await import("./team");
  assert.deepEqual((await getAssistant(moss.id))!.models, { think: OPUS }, "the assistant's models aren't changed");

  // The one-message model fails: the default answers, and tried says which one didn't.
  const down = fakeClient(() => [answer("A cat.")], ["claude-opus-5-5"]);
  const fell = await runAsk("What's in this photo?", deps(down.client), { ...when, model: await messageModel(OPUS) });
  assert.deepEqual(down.models, ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.deepEqual([fell.model, fell.fell_back, fell.tried], [SONNET, true, OPUS]);

  // The same checks as a choice: no agreement, a model that can't think, a picture model, a bad shape.
  const code = (raw: unknown) => messageModel(raw).then(() => "ok", (e: { code?: string }) => e.code);
  assert.equal(await code(GEMINI), "consent_needed");
  assert.equal(await code({ provider: "openrouter", model: "gryphe/mythomax-l2-13b" }), "consent_needed");
  await grantConsent("openrouter");
  assert.equal(await code({ provider: "openrouter", model: "gryphe/mythomax-l2-13b" }), "cant_think", "a model that can't use tools can't think");
  await grantConsent("gemini");
  assert.equal(await code(GEMINI_PICTURES), "pictures_only");
  assert.equal(await code(GEMINI), "ok");
  assert.equal(await code({ model: "claude-sonnet-5-5" }), "bad_input");

  // Through api.ts, as the app sends it: refused before anything runs, and nothing stored.
  const { revokeConsent } = await import("./models");
  await revokeConsent("gemini");
  const settled = await loadModelSettings();
  const api = (await import("../netlify/functions/api")).default;
  const post = async (body: unknown) => {
    const res = await api(new Request("https://athena.test/api/assistant", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const refused = await post({ question: "What's in this photo?", model: GEMINI });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual([refused.body.code, refused.body.provider], ["consent_needed", "gemini"]);
  const chat = await post({ question: "What's in this photo?", assistantId: moss.id, model: GEMINI });
  assert.equal(chat.status, 409, "an assistant chat is checked the same way");
  assert.equal((await post({ question: "Hi", model: { provider: "anthropic" } })).status, 400);
  assert.equal((await post({ question: "Hi", model: { provider: "anthropic", model: "claude-gone-1" } })).body.code, "unknown_model");
  assert.deepEqual(await loadModelSettings(), settled, "a refused message changes nothing");
});
