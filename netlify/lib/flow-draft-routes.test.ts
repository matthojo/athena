// POST /api/flows/draft (netlify/lib/flow-draft-routes.ts): the sentence checked, drafting handed the owner's
// spending setting, and other /api/flows paths left to the engine. No model and no database: drafting is a fake.
// Run: npx tsx --test netlify/lib/flow-draft-routes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowDraft } from "../../lib/flow-types";
import type { DraftDeps } from "../../lib/flow-draft";
import { handleFlowDraftRoutes } from "./flow-draft-routes";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const req = (method = "POST") => new Request("https://athena.example.com/api/flows/draft", { method });
const DRAFT: FlowDraft = { flow: { name: "Delivery day", trigger: { kind: "manual" }, steps: [], paused: true, origin: "draft" }, notes: [] };

test("POST { sentence } → { draft }, with the owner's spending setting and origin draft", async () => {
  let seen: { sentence: string; deps: DraftDeps } | null = null;
  const res = await handleFlowDraftRoutes(req(), ["flows", "draft"], async () => ({ sentence: "  Whenever a parcel's coming, remind me  " }), json, {
    money: async () => true,
    draft: async (sentence, deps) => ((seen = { sentence, deps }), DRAFT),
  });
  assert.equal(res?.status, 200);
  assert.deepEqual(await res!.json(), { draft: DRAFT });
  assert.deepEqual(seen, { sentence: "Whenever a parcel's coming, remind me", deps: { money: true, origin: "draft" } });
});

test("no sentence, a long one or another method is turned away; other paths are the engine's", async () => {
  const deps = { money: async () => false, draft: async () => assert.fail("drafted") };
  assert.equal((await handleFlowDraftRoutes(req(), ["flows", "draft"], async () => ({}), json, deps))?.status, 400);
  assert.equal((await handleFlowDraftRoutes(req(), ["flows", "draft"], async () => ({ sentence: 4 }), json, deps))?.status, 400);
  assert.equal((await handleFlowDraftRoutes(req(), ["flows", "draft"], async () => ({ sentence: "x".repeat(1001) }), json, deps))?.status, 400);
  assert.equal((await handleFlowDraftRoutes(req("GET"), ["flows", "draft"], async () => null, json, deps))?.status, 405);
  assert.equal(await handleFlowDraftRoutes(req(), ["flows"], async () => null, json, deps), null);
  assert.equal(await handleFlowDraftRoutes(req(), ["flows", "abc"], async () => null, json, deps), null);
  assert.equal(await handleFlowDraftRoutes(req(), ["flows", "draft", "x"], async () => null, json, deps), null);
});
