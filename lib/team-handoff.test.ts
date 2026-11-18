/**
 * Handing a run to the background function. On 16 Nov 2026 every run failed with "The run couldn't start": the
 * function's default address sat outside /api/, so the login gate answered each hand-off with a 303 to /login, and
 * the followed redirect's 200 read as "handed off".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handOffTeamRun, TEAM_RUN_PATH } from "./team-run";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the run function lives under /api/, where the login gate lets a bearer call through", () => {
  assert.ok(TEAM_RUN_PATH.startsWith("/api/"));
  assert.ok(read("../netlify/functions/team-run.ts").includes(`path: "${TEAM_RUN_PATH}"`), "team-run.ts is served at TEAM_RUN_PATH");
  const api = read("../netlify/functions/api.ts");
  assert.ok(api.slice(api.lastIndexOf("excludedPath")).includes(`"${TEAM_RUN_PATH}"`), "api.ts must leave the path to team-run.ts");
  assert.match(read("../netlify/edge-functions/site-auth.ts"), /pathname\.startsWith\("\/api\/"\)/);
});

test("only the background function's 202 counts as handed off", async () => {
  process.env.MCP_BEARER_TOKEN ||= "test-token";
  const answering = (status: number, seen?: RequestInit[]) =>
    (async (_url: URL, init: RequestInit) => {
      seen?.push(init);
      return new Response(null, { status, headers: status === 303 ? { Location: "/login" } : {} });
    }) as unknown as typeof fetch;
  const seen: RequestInit[] = [];
  await handOffTeamRun("https://athena.test", "r1", answering(202, seen));
  assert.equal(seen[0].redirect, "manual", "a redirect is never followed");
  await assert.rejects(handOffTeamRun("https://athena.test", "r1", answering(303)), /answered 303/);
  await assert.rejects(handOffTeamRun("https://athena.test", "r1", answering(200)), /answered 200/, "a page's 200 isn't the function");
});
