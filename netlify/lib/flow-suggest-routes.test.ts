// Run: npx tsx --test netlify/lib/flow-suggest-routes.test.ts
// GET /api/flows/suggestions and POST /api/flows/suggestions/:id/dismiss, with fakes for the store and the flows port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleFlowSuggestRoutes, type FlowSuggestDeps } from "./flow-suggest-routes";
import { binsHabit, deliveryHabit, NOW, TZ } from "../../lib/flow-suggest.fixtures";
import type { FlowSuggestion } from "../../lib/flow-types";

const json = (data: unknown, status = 200) => Response.json(data, { status });

function fakes(over: Partial<FlowSuggestDeps> = {}) {
  const dismissed = new Set<string>();
  const signals = deliveryHabit();
  signals.reminders.push(...binsHabit().reminders);
  const deps: FlowSuggestDeps = {
    signals: async () => signals,
    timeZone: async () => TZ,
    dismissed: async () => new Set(dismissed),
    dismiss: async (id) => void dismissed.add(id),
    flows: { list: async () => [] },
    now: () => NOW,
    ...over,
  };
  return { deps, dismissed };
}

const call = (deps: FlowSuggestDeps, method: string, path: string) => {
  const url = new URL(`https://athena.example.com/api/${path}`);
  return handleFlowSuggestRoutes(new Request(url, { method }), path.split("/"), json, deps);
};

test("GET lists the suggestions; a dismissed one is gone from the next GET", async () => {
  const { deps, dismissed } = fakes();
  const res = await call(deps, "GET", "flows/suggestions");
  assert.equal(res?.status, 200);
  const { suggestions } = (await res!.json()) as { suggestions: FlowSuggestion[] };
  assert.equal(suggestions.length, 2);
  const id = suggestions.find((s) => s.id === "follow-delivery-reminder")!.id;

  const gone = await call(deps, "POST", `flows/suggestions/${id}/dismiss`);
  assert.equal(gone?.status, 200);
  assert.deepEqual(await gone!.json(), { ok: true });
  assert.ok(dismissed.has(id));
  const again = await call(deps, "POST", `flows/suggestions/${id}/dismiss`);
  assert.equal(again?.status, 200, "twice is fine");

  const after = (await (await call(deps, "GET", "flows/suggestions"))!.json()) as { suggestions: FlowSuggestion[] };
  assert.deepEqual(after.suggestions.map((s) => s.id).filter((s) => s === id), []);
  assert.equal(after.suggestions.length, 1);
});

test("a flows port that can't answer offers nothing rather than a duplicate", async () => {
  const { deps } = fakes({ flows: { list: async () => Promise.reject(new Error("not wired")) } });
  const res = await call(deps, "GET", "flows/suggestions");
  assert.deepEqual(await res!.json(), { suggestions: [] });
});

test("an existing flow on the same habit hides its suggestion", async () => {
  const { deps } = fakes({
    flows: { list: async () => [{ trigger: { kind: "schedule", days: [2], time: "19:15" }, steps: [{ id: "n", title: null, kind: "notify", text: ["Bins"] }] }] },
  });
  const { suggestions } = (await (await call(deps, "GET", "flows/suggestions"))!.json()) as { suggestions: FlowSuggestion[] };
  assert.deepEqual(suggestions.map((s) => s.id), ["follow-delivery-reminder"]);
});

test("wrong methods, bad ids and other paths", async () => {
  const { deps, dismissed } = fakes();
  assert.equal((await call(deps, "POST", "flows/suggestions"))?.status, 405);
  assert.equal((await call(deps, "GET", "flows/suggestions/follow-delivery-reminder/dismiss"))?.status, 405);
  assert.equal((await call(deps, "POST", "flows/suggestions/Not%20an%20id/dismiss"))?.status, 400);
  assert.equal((await call(deps, "POST", "flows/suggestions/x/dismiss"))?.status, 400);
  assert.equal((await call(deps, "GET", "flows/suggestions/follow-delivery-reminder"))?.status, 404);
  assert.equal(await call(deps, "GET", "flows"), null, "the engine's routes aren't these");
  assert.equal(await call(deps, "GET", "flows/abc"), null);
  assert.equal(dismissed.size, 0);
});
