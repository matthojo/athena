// Run: npx tsx --test netlify/lib/ask-routes.test.ts
// /api/routines is closed: every method and path answers 410 and points at /api/team.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAskRoutes, ROUTINES_GONE } from "./ask-routes";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const deps = { undo: async () => {} };

test("every /api/routines call is 410 Gone, pointing at /api/team, and nothing is read or written", async () => {
  let bodyRead = false;
  const body = async () => {
    bodyRead = true;
    return { prompt: "What slipped this week?", days: [5], time: "16:00" };
  };
  const id = "00000000-0000-4000-8000-000000000001";
  for (const [method, path] of [["POST", "routines"], ["GET", "routines"], ["PUT", `routines/${id}`], ["DELETE", `routines/${id}`], ["PATCH", "routines/x/y"]]) {
    const url = new URL(`https://athena.test/api/${path}`);
    const res = await handleAskRoutes(new Request(url, { method }), url, ["api", ...path.split("/")], body, json, deps);
    assert.ok(res, `${method} /api/${path} is handled`);
    assert.equal(res.status, 410, `${method} /api/${path}`);
    assert.deepEqual(await res.json(), { error: "Routines are assistants now. Use /api/team.", use: "/api/team" });
  }
  assert.equal(bodyRead, false);
  assert.equal(ROUTINES_GONE.use, "/api/team");
});
