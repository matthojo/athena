// The catalogue (lib/model-catalogue.ts): the gateway's list joined with Athena's notes, honest "unknown" for a model
// with no notes, the newest version of each family, and the list kept for a day with the committed snapshot when
// the gateway can't be read.
// Run: npx tsx --test lib/model-catalogue.test.ts (no database: the kept copy is skipped and logged).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { abilitiesOf, describe, familyOf, forgetCatalogue, gatewayList, getCatalogue, HIDDEN, joinCatalogue, newerVersion, onList, OPENROUTER_MAKERS, plainName, readGatewayList, shownModels, SNAPSHOT, type GatewayList } from "./model-catalogue";
import { DEFAULT_MODELS, PROVIDERS, refKey } from "./model-types";

const LIST: GatewayList = {
  fetched_at: "2026-11-17T12:00:00.000Z",
  providers: {
    anthropic: { models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"] },
    gemini: { models: ["gemini-3-pro-image", "gemini-9-ultra"] },
    openai: { models: ["gpt-image-9", "gpt-5.2"] },
    openrouter: { models: ["acme/mystery-1", "deepseek/deepseek-v3.2"] },
    typesafe: { models: ["jev-1"] },
  },
};

beforeEach(() => forgetCatalogue());

test("the join: Athena's providers only, each model once, nothing recommended", () => {
  const all = joinCatalogue(LIST);
  const keys = all.map((m) => refKey(m.ref));
  assert.ok(!keys.some((k) => k.startsWith("typesafe/")), "Jev isn't offered");
  assert.equal(keys.filter((k) => k === "anthropic/claude-sonnet-5-5").length, 1, "a repeated id is listed once");
  assert.ok(!keys.includes("openrouter/acme/mystery-1"), "a maker not on the list isn't offered");
  assert.ok(all.every((m) => m.recommended === false && !("recommended_for" in m)));
  assert.ok(joinCatalogue(SNAPSHOT).every((m) => m.recommended === false));
  const sonnet = all.find((m) => m.ref.model === "claude-sonnet-5-5")!;
  assert.equal(sonnet.name, "Claude Sonnet 5.5");
  assert.ok(sonnet.blurb);
  assert.deepEqual(sonnet.abilities, { tools: true, vision: true, images: false, web: "native" });
});

test("a model with no notes: a plain name from its id, nothing else guessed", () => {
  const m = describe({ provider: "openrouter", model: "acme/mystery-1" });
  assert.equal(m.name, "Mystery 1");
  assert.equal(m.blurb, null);
  assert.equal(m.speed, null);
  assert.equal(m.cost, null);
  assert.equal(m.recommended, false);
  assert.deepEqual(m.abilities, { tools: "unknown", vision: "unknown", images: false, web: "handoff" });
  // An unknown Gemini model is unknown too; only the providers' picture naming is read from an id.
  assert.equal(abilitiesOf({ provider: "gemini", model: "gemini-9-ultra" }).tools, "unknown");
  assert.equal(abilitiesOf({ provider: "openai", model: "gpt-image-9" }).images, true);
  assert.equal(abilitiesOf({ provider: "gemini", model: "gemini-nano-banana-2.1" }).images, true);
  assert.equal(abilitiesOf({ provider: "openrouter", model: "someone/gpt-image-clone" }).images, false);
});

test("what Athena knows: picture models can't think, and every default is a model it knows", () => {
  assert.equal(abilitiesOf({ provider: "gemini", model: "gemini-3-pro-image" }).images, true);
  assert.equal(abilitiesOf({ provider: "gemini", model: "gemini-3-pro-image" }).tools, false);
  assert.equal(abilitiesOf({ provider: "openrouter", model: "deepseek/deepseek-v3.2" }).vision, false);
  for (const ref of [DEFAULT_MODELS.think, DEFAULT_MODELS.everyday, DEFAULT_MODELS.careful]) {
    assert.equal(abilitiesOf(ref).tools, true);
    assert.ok(SNAPSHOT.providers[ref.provider]?.models.includes(ref.model), `${ref.model} is in the snapshot`);
  }
});

test("preview models are marked from their id", () => {
  assert.equal(describe({ provider: "gemini", model: "gemini-3.1-pro-preview" }).preview, true);
  assert.equal(describe({ provider: "openrouter", model: "deepseek/deepseek-v4-flash-vision-exp" }).preview, true);
  assert.equal(describe({ provider: "openai", model: "gpt-5.2" }).preview, false);
});

test("the gateway's answer is checked: wrong shapes are refused, odd ids dropped", () => {
  assert.equal(readGatewayList(null, "x"), null);
  assert.equal(readGatewayList({ providers: "no" }, "x"), null);
  assert.equal(readGatewayList({ providers: { typesafe: { models: ["jev"] } } }, "x"), null);
  const r = readGatewayList({ providers: { openai: { models: ["gpt-5.2", 7, "", "x".repeat(300)] } } }, "2026-11-17T00:00:00.000Z")!;
  assert.deepEqual(r.providers.openai?.models, ["gpt-5.2"]);
});

test("the snapshot path: when the gateway can't be read, the committed list answers", async () => {
  let asked = 0;
  const down = async () => {
    asked++;
    throw new Error("offline");
  };
  const c = await getCatalogue({ fetch: down as never });
  assert.equal(asked, 1);
  assert.equal(c.source, "snapshot");
  assert.equal(c.updated_at, SNAPSHOT.fetched_at);
  assert.equal(c.models.length, shownModels(SNAPSHOT).length, "the shown models, from every provider");
  assert.ok(c.models.some((m) => m.ref.model === "claude-sonnet-5-5"));
  // A 500 or a strange body is the same as no answer.
  const broken = async () => new Response("{}", { status: 200 });
  assert.equal((await gatewayList({ fetch: broken as never })).source, "snapshot");
  const failing = async () => new Response("no", { status: 500 });
  assert.equal((await gatewayList({ fetch: failing as never })).source, "snapshot");
});

test("kept for a day: one read of the gateway, then the copy, then a fresh read", async () => {
  let asked = 0;
  const live = async () => {
    asked++;
    return new Response(JSON.stringify({ providers: { anthropic: { models: ["claude-sonnet-5-5", "claude-opus-5-5"] } } }), { status: 200 });
  };
  const now = new Date("2026-11-17T12:00:00Z");
  const first = await gatewayList({ fetch: live as never, now });
  assert.equal(first.source, "gateway");
  assert.deepEqual(first.list.providers.anthropic?.models, ["claude-sonnet-5-5", "claude-opus-5-5"]);
  const later = await gatewayList({ fetch: live as never, now: new Date("2026-11-18T11:00:00Z") });
  assert.equal(later.source, "kept");
  assert.equal(asked, 1);
  const nextDay = await gatewayList({ fetch: live as never, now: new Date("2026-11-18T12:30:00Z") });
  assert.equal(nextDay.source, "gateway");
  assert.equal(asked, 2);
});

// ---------- families, on the committed snapshot ----------

const shown = () => new Set(shownModels(SNAPSHOT).map(refKey));

test("families: the id read as family and version", () => {
  const f = (provider: "anthropic" | "openai" | "gemini" | "meta" | "openrouter", model: string) => {
    const r = familyOf({ provider, model });
    return r && [r.key, r.version.join(".")];
  };
  assert.deepEqual(f("anthropic", "claude-sonnet-4-5"), ["anthropic:claude-sonnet", "4.5"]);
  assert.deepEqual(f("anthropic", "claude-haiku-4-5-20251001"), ["anthropic:claude-haiku", "4.5"]);
  assert.deepEqual(f("openai", "gpt-5.4-mini"), ["openai:gpt-mini", "5.4"]);
  assert.deepEqual(f("openai", "gpt-4o"), ["openai:gpt", "4"]);
  assert.deepEqual(f("openai", "gpt-image-2.5-flare-2026-09-08"), ["openai:gpt-image-flare", "2.5"]);
  assert.deepEqual(f("gemini", "gemini-3-flash-preview"), ["gemini:gemini-flash", "3"]);
  assert.deepEqual(f("gemini", "gemini-3-pro-image"), ["gemini:gemini-pro-image", "3"]);
  assert.deepEqual(f("meta", "muse-spark-1.3"), ["meta:muse-spark", "1.3"]);
  assert.deepEqual(f("openrouter", "qwen/qwen3-vl-235b-a22b-instruct"), ["openrouter:qwen/qwen-vl", "3"]);
  assert.deepEqual(f("openrouter", "deepseek/deepseek-chat-v3.1"), ["openrouter:deepseek/deepseek", "3.1"]);
  assert.deepEqual(f("openrouter", "moonshotai/kimi-k2.5"), ["openrouter:moonshotai/kimi-k", "2.5"]);
  assert.deepEqual(f("openrouter", "mistralai/mistral-large-4-0"), ["openrouter:mistralai/mistral-large", "4.0"]);
  assert.deepEqual(f("openrouter", "mistralai/mistral-small-2603"), ["openrouter:mistralai/mistral-small", "4"], "Mistral's dated names, by their number");
  for (const alias of ["chat-latest", "gemini-flash-latest"]) assert.equal(familyOf({ provider: alias === "chat-latest" ? "openai" : "gemini", model: alias }), null, alias);
  assert.equal(familyOf({ provider: "openrouter", model: "~x-ai/grok-latest" }), null);
  assert.equal(familyOf({ provider: "openrouter", model: "inclusionai/ling-3.2-flash:free" }), null);
});

test("families: only the newest version, per family", () => {
  const s = shown();
  const has = (k: string) => assert.ok(s.has(k), `${k} is shown`);
  const not = (k: string) => assert.ok(!s.has(k), `${k} is hidden`);
  // Anthropic: one of each.
  ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-2"].forEach((m) => has(`anthropic/${m}`));
  ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"].forEach((m) => not(`anthropic/${m}`));
  assert.equal([...s].filter((k) => k.startsWith("anthropic/")).length, 4);
  // OpenAI: GPT, GPT mini, pictures.
  ["gpt-5.5", "gpt-5.4-mini", "gpt-image-2", "gpt-5.5-pro"].forEach((m) => has(`openai/${m}`));
  ["gpt-5.4", "gpt-5-mini", "gpt-image-1.5", "gpt-5.4-pro", "gpt-5.2", "gpt-5", "gpt-4o", "gpt-4.1", "gpt-4o-mini", "gpt-4.1-mini", "gpt-5.2-pro", "o3"].forEach((m) => not(`openai/${m}`));
  // Gemini: Flash, Flash Lite, and the picture models.
  ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-3.1-pro-preview"].forEach((m) => has(`gemini/${m}`));
  ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash-image"].forEach((m) => not(`gemini/${m}`));
  // Meta's Muse Spark.
  has("meta/muse-spark-1.3");
  not("meta/muse-spark-1.2");
  not("meta/muse-spark-1.1");
  // Every size of the newest version stays: Gemma 4, not 3 or 2.
  ["google/gemma-4-31b-it", "google/gemma-4-26b-a4b-it"].forEach((m) => has(`openrouter/${m}`));
  ["google/gemma-3-27b-it", "google/gemma-3-4b-it", "google/gemma-2-27b-it"].forEach((m) => not(`openrouter/${m}`));
  // Grok 4.20 is 4.2: older than 4.7 and 4.6.
  has("openrouter/x-ai/grok-4.7");
  not("openrouter/x-ai/grok-4.6");
  not("openrouter/x-ai/grok-4.20");
  // Mistral: Large 4.0, Small 4 (2603); Saba, Codestral 2508 and Voxtral Small hidden by name.
  ["mistral-large-4-0", "mistral-small-2603"].forEach((m) => has(`openrouter/mistralai/${m}`));
  ["mistral-large-2512", "mistral-small-3.2-24b-instruct", "mistral-large-2407", "mistral-small-3.1-24b-instruct", "mistral-small-24b-instruct-2501", "mistral-saba", "codestral-2508", "voxtral-small-24b-2507"].forEach((m) => not(`openrouter/mistralai/${m}`));
  // Kimi: K3 and K2.6.
  has("openrouter/moonshotai/kimi-k3");
  not("openrouter/moonshotai/kimi-k2.6");
  not("openrouter/moonshotai/kimi-k2.5");
  // No family shows more than one version.
  const steps = new Map<string, Set<string>>();
  for (const k of s) {
    const [provider, ...rest] = k.split("/");
    const f = familyOf({ provider: provider as "openai", model: rest.join("/") })!;
    const set = steps.get(f.key) ?? new Set();
    set.add(f.dateOnly ? `@${f.date}` : f.version.join("."));
    steps.set(f.key, set);
  }
  for (const [key, set] of steps) assert.ok(set.size <= 1, `${key}: ${[...set].join(", ")}`);
});

test("families: dated snapshots and aliases are hidden", () => {
  const s = shown();
  for (const k of s) {
    assert.ok(!/-\d{4}-\d{2}-\d{2}$|-\d{8}$/.test(k), `${k} is a dated snapshot`);
    assert.ok(!/latest$|\/~/.test(k), `${k} is an alias`);
  }
  for (const k of ["openai/chat-latest", "gemini/gemini-flash-latest", "openai/gpt-5-2025-08-07", "anthropic/claude-haiku-4-5-20251001", "openrouter/deepseek/deepseek-v4-flash-0731", "openrouter/moonshotai/kimi-k2-0905"]) {
    assert.ok(!s.has(k), `${k} is hidden`);
  }
  // A short date with no undated twin is the model's own name.
  assert.ok(s.has("openrouter/mistralai/devstral-2512"));
  assert.ok(s.has("openrouter/mistralai/ministral-14b-2512"));
});

test("OpenRouter: only the makers on Athena's list", () => {
  const makers = new Set([...shown()].filter((k) => k.startsWith("openrouter/")).map((k) => k.split("/")[1]));
  assert.deepEqual([...makers].sort(), Object.keys(OPENROUTER_MAKERS).sort(), "every maker on the list has a model, and no other maker");
  const s = shown();
  for (const k of ["openrouter/gryphe/mythomax-l2-13b", "openrouter/openrouter/auto", "openrouter/perplexity/sonar", "openrouter/meta/muse-spark-open", "openrouter/meta-llama/llama-guard-4-12b", "openrouter/openai/gpt-oss-safeguard-20b"]) {
    assert.ok(!s.has(k), `${k} isn't offered`);
  }
  assert.ok([...s].filter((k) => k.startsWith("openrouter/google/")).every((k) => k.includes("/gemma-")), "Google on OpenRouter: Gemma only");
});

test("notes belong to one exact model: a newer one has none of an older one's", () => {
  for (const m of joinCatalogue(SNAPSHOT)) {
    if (!m.blurb && !m.speed && !m.cost && m.abilities.tools === "unknown") assert.equal(m.name, plainName(m.ref), `${m.ref.model}: no notes, so a plain name`);
  }
  const opus = describe({ provider: "anthropic", model: "claude-opus-5" });
  assert.equal(opus.blurb, null, "Opus 5 doesn't borrow Opus 5.5's blurb");
  const muse = describe({ provider: "meta", model: "muse-spark-1.3" });
  assert.deepEqual([muse.blurb, muse.speed, muse.cost], [null, null, null]);
  const flash = describe({ provider: "gemini", model: "gemini-3.8-flash" });
  assert.deepEqual([flash.blurb, flash.speed, flash.cost], [null, null, null], "not Gemini 3 Flash's notes");
});

test("newer: the newest shown version in the family, when it's newer", () => {
  assert.deepEqual(newerVersion({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" }, SNAPSHOT), { provider: "anthropic", model: "claude-sonnet-5-5" });
  assert.deepEqual(newerVersion({ provider: "gemini", model: "gemini-3-flash-preview" }, SNAPSHOT), { provider: "gemini", model: "gemini-3.8-flash" });
  assert.deepEqual(newerVersion({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }, SNAPSHOT), { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" });
  assert.equal(newerVersion({ provider: "anthropic", model: "claude-sonnet-5-5" }, SNAPSHOT), null);
  assert.equal(newerVersion({ provider: "openai", model: "chat-latest" }, SNAPSHOT), null, "an alias has no family");
  assert.equal(newerVersion({ provider: "openrouter", model: "gryphe/mythomax-l2-13b" }, SNAPSHOT), null, "nothing shown to offer");
});

test("a hidden choice is still named: include adds a listed model, never an unlisted one", () => {
  const extra = joinCatalogue(SNAPSHOT, [
    { provider: "anthropic", model: "claude-opus-4-8" },
    { provider: "gemini", model: "gemini-0-gone" },
  ]);
  assert.equal(extra.length, shownModels(SNAPSHOT).length + 1);
  assert.equal(extra.find((m) => m.ref.model === "claude-opus-4-8")?.name, "Claude Opus 4.8");
});

test("hidden by name: old one-model families, each with a reason; still listed, so a chosen one runs and is named", () => {
  const s = shown();
  const owner = ["mistralai/mistral-nemo", "mistralai/mixtral-8x22b-instruct", "z-ai/glm-4.5-air", "qwen/qwen3-next-80b-a3b-instruct"];
  for (const m of owner) assert.ok(Object.hasOwn(HIDDEN, `openrouter/${m}`), `${m} is on the list`);
  for (const [key, why] of Object.entries(HIDDEN)) {
    const [provider, ...rest] = key.split("/");
    const ref = { provider: provider as "openrouter", model: rest.join("/") };
    assert.ok(!s.has(key), `${key} isn't shown`);
    assert.ok(onList(ref, SNAPSHOT), `${key} is on the gateway's list, so a choice of it stays valid`);
    assert.match(why, /^[A-Z].{10,120}\.$/, `${key}: a one-line reason`);
    // Its family has no other shown model: the list is for old one-model families, not for trimming a live one.
    const f = familyOf(ref)!;
    assert.ok(![...s].some((k) => { const [p, ...r] = k.split("/"); return familyOf({ provider: p as "openrouter", model: r.join("/") })?.key === f.key; }), `${key}: no other ${f.key} is shown`);
    const named = joinCatalogue(SNAPSHOT, [ref]).find((m) => refKey(m.ref) === key);
    // OpenAI's o-series ids ("o3") are already their names.
    assert.ok(named && (named.name !== ref.model || /^o\d/.test(ref.model)), `${key} is named when chosen`);
  }
  assert.equal(shownModels(SNAPSHOT).length, 67);
});

test("plain names: every id in the snapshot reads as a name, none empty or garbled", () => {
  assert.equal(plainName({ provider: "gemini", model: "gemini-3.8-flash" }), "Gemini 3.8 Flash");
  assert.equal(plainName({ provider: "openrouter", model: "qwen/qwen3.8-27b" }), "Qwen3.8 27B");
  const cases: Array<[string, string, string]> = [
    ["anthropic", "claude-opus-4-5", "Claude Opus 4.5"],
    ["anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5 (2025-10-01)"],
    ["openai", "gpt-5.5", "GPT-5.5"],
    ["openai", "gpt-5.4-mini", "GPT-5.4 mini"],
    ["openai", "gpt-4o", "GPT-4o"],
    ["openai", "o3", "o3"],
    ["openai", "gpt-image-2.6-flare", "GPT Image 2.6 Flare"],
    ["gemini", "gemini-3.1-pro-preview", "Gemini 3.1 Pro"],
    ["gemini", "gemini-3.1-pro-preview-customtools", "Gemini 3.1 Pro Custom Tools"],
    ["meta", "muse-spark-1.3", "Muse Spark 1.3"],
    ["openrouter", "deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["openrouter", "deepseek/deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision"],
    ["openrouter", "moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro"],
    ["openrouter", "mistralai/mistral-large-4-0", "Mistral Large 4.0"],
    ["openrouter", "mistralai/mistral-small-2603", "Mistral Small 4"],
    ["openrouter", "mistralai/mistral-large-2512", "Mistral Large 3"],
    ["openrouter", "mistralai/mistral-small-24b-instruct-2501", "Mistral Small 3 24B"],
    ["openrouter", "mistralai/ministral-14b-2512", "Ministral 14B 2512"],
    ["openrouter", "mistralai/mixtral-8x22b-instruct", "Mixtral 8x22B"],
    ["openrouter", "google/gemma-4-26b-a4b-it", "Gemma 4 26B A4B"],
    ["openrouter", "z-ai/glm-4.6v", "GLM 4.6V"],
    ["openrouter", "minimax/minimax-m3.1-flash", "MiniMax M3.1 Flash"],
    ["openrouter", "openai/gpt-oss-120b", "GPT-OSS 120B"],
    ["openrouter", "x-ai/grok-4.20-multi-agent", "Grok 4.20 Multi-Agent"],
    ["openrouter", "inclusionai/ling-3.2-flash:free", "Ling 3.2 Flash (free)"],
    ["openrouter", "~moonshotai/kimi-latest", "Kimi Latest"],
  ];
  for (const [provider, model, name] of cases) assert.equal(plainName({ provider: provider as "openai", model }), name, model);
  let n = 0;
  for (const provider of PROVIDERS) {
    for (const model of SNAPSHOT.providers[provider]?.models ?? []) {
      const name = plainName({ provider, model });
      n++;
      assert.ok(name.trim() === name && name.length >= 2 && name.length <= 60, `${model}: "${name}"`);
      assert.ok(!/[/_~:]|\s{2}|--|^-|-$/.test(name), `${model}: "${name}" has id punctuation left in it`);
      assert.ok(!/(^| )(instruct|it|preview|exp)( |$)/i.test(name), `${model}: "${name}" keeps a word that says nothing`);
      // Each word starts with a capital or a digit, except OpenAI's o-series and its lower-case sizes.
      for (const w of name.replace(/\(.*\)/g, "").split(" ").filter(Boolean)) assert.ok(/^[A-Z0-9]/.test(w) || /^o\d/.test(w) || w === "mini" || w === "nano", `${model}: "${w}" in "${name}"`);
    }
  }
  assert.equal(n, 281, "every id in the snapshot");
  // Shown models, as the picker lists them: no two in one provider share a name.
  const seen = new Set<string>();
  for (const m of joinCatalogue(SNAPSHOT)) {
    const k = `${m.ref.provider}:${m.name}`;
    assert.ok(!seen.has(k), `${k} twice`);
    seen.add(k);
  }
});
