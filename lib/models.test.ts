// Which model runs each role (lib/models.ts), without a database: the row as read back is checked, the env vars and
// code defaults answer when there's no row, a failed choice is tried once on the deploy's default, else the code's,
// and a choice is marked when a newer version is listed or the gateway no longer lists it.
// The database side (the owner's row, agreements, assistants, routes) is lib/models.db.test.ts.
// Run: npx tsx --test lib/models.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotate, cleanAssistantModels, cleanSettings, defaultFor, fallbackRef, fallbackTarget, messageModel, ModelChoiceError, resolveImageModel, resolveJobModel, resolveThinkModel, withFallback } from "./models";
import { forgetCatalogue, SNAPSHOT, type GatewayList } from "./model-catalogue";
import { JOBS, type JobId } from "./model-types";

delete process.env.NETLIFY_DB_URL;

test("the row as read: bad refs and unknown keys dropped, and a provider not agreed to is ignored", () => {
  const s = cleanSettings({
    think: { provider: "gemini", model: "gemini-3.1-pro-preview" },
    everyday: "anthropic/claude-haiku-5-5",
    careful: { provider: "nope", model: "x" },
    image: { provider: "openai", model: "gpt-image-1.5" },
    jobs: { drafts: { provider: "openai", model: "gpt-5.2" }, briefing: "anthropic/claude-opus-5-5", made_up: "anthropic/claude-opus-5-5" },
    consent: { openai: "2026-11-17T10:00:00.000Z", gemini: "not a date", anthropic: "2026-11-17T10:00:00.000Z" },
    extra: true,
  });
  assert.deepEqual(s, {
    everyday: { provider: "anthropic", model: "claude-haiku-5-5" },
    image: { provider: "openai", model: "gpt-image-1.5" },
    jobs: { drafts: { provider: "openai", model: "gpt-5.2" }, briefing: { provider: "anthropic", model: "claude-opus-5-5" } },
    consent: { openai: "2026-11-17T10:00:00.000Z" },
  });
  assert.deepEqual(cleanSettings(null), {});
  assert.deepEqual(cleanSettings("junk"), {});
});

test("an assistant's models as read: null image is no pictures; a provider not agreed to is ignored", () => {
  assert.deepEqual(cleanAssistantModels({ think: { provider: "gemini", model: "g" }, image: null }, {}), { image: null });
  assert.deepEqual(cleanAssistantModels({ think: { provider: "gemini", model: "g" } }, { gemini: "2026-11-17T10:00:00.000Z" }), { think: { provider: "gemini", model: "g" } });
  assert.deepEqual(cleanAssistantModels(undefined, {}), {});
});

test("with no row: each job's env var, else its tier's default; Ask's env var, else Sonnet; pictures off", async () => {
  const saved = { ...process.env };
  try {
    for (const j of Object.keys(JOBS) as JobId[]) delete process.env[JOBS[j].env];
    delete process.env.ATHENA_ANSWER_MODEL;
    process.env.ATHENA_DRAFT_MODEL = "claude-opus-5-5";
    for (const j of Object.keys(JOBS) as JobId[]) {
      const r = await resolveJobModel(j);
      if (j === "drafts") assert.deepEqual(r, { ref: { provider: "anthropic", model: "claude-opus-5-5" }, from: "env" });
      else assert.deepEqual(r, { ref: defaultFor(j), from: "default" }, j);
    }
    assert.equal((await resolveJobModel("file_summary")).ref.model, "claude-haiku-5-5");
    assert.equal((await resolveJobModel("briefing")).ref.model, "claude-sonnet-5-5");
    assert.deepEqual(await resolveThinkModel(), { ref: { provider: "anthropic", model: "claude-sonnet-5-5" }, from: "default" });
    process.env.ATHENA_ASSISTANT_MODEL = "claude-haiku-5-5";
    assert.equal((await resolveThinkModel({ envName: "ATHENA_ASSISTANT_MODEL" })).from, "env");
    assert.equal(await resolveImageModel(), null);
  } finally {
    process.env = saved;
  }
});

test("a failed choice: tried once on the code default (no env model) and marked; the default itself, and a busy gateway, aren't retried", async () => {
  const tried: string[] = [];
  const run = async (ref: { model: string }) => {
    tried.push(ref.model);
    if (ref.model !== "claude-sonnet-5-5") throw Object.assign(new Error("model not found"), { status: 404 });
    return "ok";
  };
  const out = await withFallback({ ref: { provider: "gemini", model: "gemini-gone" }, from: "owner" }, "think", run);
  assert.deepEqual(out, { value: "ok", ref: { provider: "anthropic", model: "claude-sonnet-5-5" }, fell_back: true, tried: { provider: "gemini", model: "gemini-gone" } }, "tried names the model that didn't answer");
  assert.deepEqual(tried, ["gemini-gone", "claude-sonnet-5-5"]);
  const fine = await withFallback({ ref: { provider: "anthropic", model: "claude-sonnet-5-5" }, from: "owner" }, "think", run);
  assert.equal(fine.tried, undefined, "no tried when the chosen model answered");

  const job = await withFallback({ ref: { provider: "anthropic", model: "claude-opus-5-5" }, from: "job" }, "file_summary", async (r) => (r.model === "claude-haiku-5-5" ? "small" : Promise.reject(new Error("down"))));
  assert.deepEqual(job.ref, { provider: "anthropic", model: "claude-haiku-5-5" }, "an everyday job falls back to Haiku");

  await assert.rejects(withFallback({ ref: { provider: "anthropic", model: "claude-sonnet-5-5" }, from: "default" }, "think", async () => Promise.reject(new Error("down"))), /down/);
  class RateLimited extends Error {}
  assert.equal(fallbackRef({ ref: { provider: "gemini", model: "g" }, from: "owner" }, "think", new RateLimited("busy")), null);
});

test("the fallback: the deploy's env model, unless that's what failed, then the code default", () => {
  const saved = { ...process.env };
  try {
    delete process.env.ATHENA_ANSWER_MODEL;
    const gone = { provider: "gemini", model: "gemini-gone" } as const;
    assert.deepEqual(fallbackTarget("think", gone), defaultFor("think"));
    process.env.ATHENA_ANSWER_MODEL = "claude-opus-5-5";
    assert.deepEqual(fallbackTarget("think", gone), { provider: "anthropic", model: "claude-opus-5-5" }, "the deploy's model first");
    assert.deepEqual(fallbackTarget("think", { provider: "anthropic", model: "claude-opus-5-5" }), defaultFor("think"), "the env model failed: the code default");
    process.env.ATHENA_ASSISTANT_MODEL = "claude-haiku-5-5";
    assert.equal(fallbackTarget("think", gone, "ATHENA_ASSISTANT_MODEL")?.model, "claude-haiku-5-5", "a caller's own env var");
    process.env.ATHENA_DRAFT_MODEL = "claude-fable-5-2";
    assert.equal(fallbackTarget("drafts", gone)?.model, "claude-fable-5-2", "a job's env var");
    assert.equal(fallbackTarget("careful", gone)?.model, "claude-sonnet-5-5", "a tier has no env var");
    delete process.env.ATHENA_ANSWER_MODEL;
    assert.equal(fallbackTarget("think", defaultFor("think")), null, "nothing left to try");
  } finally {
    process.env = saved;
  }
});

test("newer and withdrawn: a chosen model keeps running; a newer version is offered; a gone one says what runs instead", () => {
  const saved = { ...process.env };
  try {
    delete process.env.ATHENA_ANSWER_MODEL;
    delete process.env.ATHENA_DRAFT_MODEL;
    const owner = (provider: "anthropic" | "openai" | "gemini", model: string) => ({ ref: { provider, model }, from: "owner" as const });
    // The newest of its family: nothing to say.
    assert.deepEqual(annotate(owner("anthropic", "claude-sonnet-5-5"), "think", SNAPSHOT), owner("anthropic", "claude-sonnet-5-5"));
    // Hidden but listed (an older version, a dated snapshot): kept, and the newest offered.
    assert.deepEqual(annotate(owner("anthropic", "claude-opus-4-8"), "think", SNAPSHOT), { ...owner("anthropic", "claude-opus-4-8"), newer: { provider: "anthropic", model: "claude-opus-5-5" } });
    assert.deepEqual(annotate(owner("openai", "gpt-5-mini-2025-08-07"), "everyday", SNAPSHOT).newer, { provider: "openai", model: "gpt-5.4-mini" });
    assert.equal(annotate(owner("openai", "gpt-5.5-2026-04-23"), "think", SNAPSHOT).newer, undefined, "a snapshot of the newest isn't older");
    // Gone from the list: the fallback runs instead, and the newest of the family is offered.
    const gone: GatewayList = { ...SNAPSHOT, providers: { ...SNAPSHOT.providers, anthropic: { models: SNAPSHOT.providers.anthropic!.models.filter((m) => m !== "claude-opus-5") } } };
    assert.deepEqual(annotate(owner("anthropic", "claude-opus-5"), "think", gone), {
      ref: defaultFor("think"),
      from: "owner",
      withdrawn: { provider: "anthropic", model: "claude-opus-5" },
      newer: { provider: "anthropic", model: "claude-opus-5-5" },
    });
    process.env.ATHENA_DRAFT_MODEL = "claude-haiku-5-5";
    assert.equal(annotate({ ref: { provider: "gemini", model: "gemini-0-gone" }, from: "job" }, "drafts", SNAPSHOT).ref.model, "claude-haiku-5-5", "the deploy's model runs instead");
    // Pictures have nothing else to run: the same model, marked.
    const pic = annotate(owner("gemini", "gemini-0-image"), "image", SNAPSHOT);
    assert.deepEqual(pic, { ...owner("gemini", "gemini-0-image"), withdrawn: { provider: "gemini", model: "gemini-0-image" } });
    // The committed snapshot can't say a model has gone.
    assert.equal(annotate(owner("gemini", "gemini-9-ultra"), "think", SNAPSHOT, false).withdrawn, undefined);
  } finally {
    process.env = saved;
  }
});

test("a model for one message: checked like a choice, and none named is none", async () => {
  forgetCatalogue({ ...SNAPSHOT, fetched_at: new Date().toISOString() });
  try {
    assert.equal(await messageModel(undefined), null);
    assert.equal(await messageModel(null), null);
    assert.deepEqual(await messageModel({ provider: "anthropic", model: "claude-sonnet-5-5" }), { ref: { provider: "anthropic", model: "claude-sonnet-5-5" }, from: "owner" });
    const code = async (raw: unknown) => (await messageModel(raw).then(() => null, (e: unknown) => (e instanceof ModelChoiceError ? e.code : String(e))));
    // No row here, so no agreement: Google is refused until the owner agrees.
    assert.equal(await code({ provider: "gemini", model: "gemini-3.8-flash" }), "consent_needed");
    assert.equal(await code({ provider: "anthropic", model: "claude-gone-1" }), "unknown_model");
    assert.equal(await code({ provider: "anthropic" }), "bad_input");
    assert.equal(await code("claude-sonnet-5-5"), "bad_input");
  } finally {
    forgetCatalogue();
  }
});
