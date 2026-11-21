// Flows' trigger claims on real Postgres (migration 0081): a fire is claimed once and can be given back; flows
// mark events seen with their own column, so Team's claim and theirs don't take events from each other; old fires go.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/flow-triggers-db.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties team_events and flow_trigger_fires first.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE flow_trigger_fires`);
  await qRaw(`TRUNCATE team_events CASCADE`);
});

test("a fire is claimed once, and can be given back", { skip }, async () => {
  const { dbFlowClaims } = await import("./flow-triggers-db");
  const at = new Date("2026-11-20T16:00:00Z");
  assert.equal(await dbFlowClaims.fire("flow-1", "schedule:2026-11-20T16:00:00.000Z", at), true);
  assert.equal(await dbFlowClaims.fire("flow-1", "schedule:2026-11-20T16:00:00.000Z", at), false);
  assert.equal(await dbFlowClaims.fire("flow-2", "schedule:2026-11-20T16:00:00.000Z", at), true);
  await dbFlowClaims.release("flow-1", "schedule:2026-11-20T16:00:00.000Z");
  assert.equal(await dbFlowClaims.fire("flow-1", "schedule:2026-11-20T16:00:00.000Z", at), true);
});

test("flows and Team each see every event, apart; flows mark theirs seen when done", { skip }, async () => {
  const { emitTeamEvent } = await import("./team-events");
  const { claimEvents } = await import("./team-triggers");
  const { dbFlowClaims } = await import("./flow-triggers-db");
  const a = await emitTeamEvent("note", null, "note", { title: "Lentil soup", tags: ["recipe"] });
  const b = await emitTeamEvent("collected", null, "note", { title: "Fix the login page", kind: "issue" });
  assert.deepEqual((await claimEvents()).map((e) => e.id), [a, b]);
  assert.equal((await dbFlowClaims.event(a!))?.facets.title, "Lentil soup");
  // Reading doesn't mark: a plain flow may leave some for the next pass.
  assert.deepEqual((await dbFlowClaims.pending(10)).map((e) => e.id), [a, b]);
  await dbFlowClaims.seen([a!]);
  assert.equal(await dbFlowClaims.event(a!), null);
  assert.deepEqual((await dbFlowClaims.pending(10)).map((e) => e.id), [b]);
  await dbFlowClaims.seen([b!]);
  assert.deepEqual(await dbFlowClaims.pending(10), []);
});

test("fires older than a week go", { skip }, async () => {
  const { dbFlowClaims } = await import("./flow-triggers-db");
  await dbFlowClaims.fire("flow-1", "old", new Date("2026-11-01T09:00:00Z"));
  await dbFlowClaims.fire("flow-1", "new", new Date("2026-11-19T09:00:00Z"));
  assert.equal(await dbFlowClaims.prune!(new Date("2026-11-20T09:00:00Z")), 1);
  assert.equal(await dbFlowClaims.fire("flow-1", "new", new Date("2026-11-19T09:00:00Z")), false);
});
