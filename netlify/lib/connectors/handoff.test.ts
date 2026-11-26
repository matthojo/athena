// Run: npx tsx --test netlify/lib/connectors/handoff.test.ts
// Collection runs and history loads are handed to background functions: only their 202 (204 under netlify dev)
// counts, and a redirect is never followed, so the login page's 200 can't read as "handed off".
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { backfillTrigger, BACKFILL_PATH } from "./backfill";
import { handedOff, RUN_PATH, triggerRuns } from "./trigger";

const g = globalThis as { Netlify?: unknown; fetch: typeof fetch };
const realFetch = g.fetch;
const realNetlify = g.Netlify;
g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test-token" : undefined) } };
afterEach(() => {
  g.fetch = realFetch;
});
process.on("exit", () => void (g.Netlify = realNetlify));

const ORIGIN = "https://athena.example.com";

function answer(status: number, headers: Record<string, string> = {}) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    return new Response(null, { status, headers });
  }) as typeof fetch;
  return { seen, impl };
}

test("only 202, or 204 under netlify dev, is a hand-off", () => {
  assert.equal(handedOff(202), true);
  assert.equal(handedOff(204), true);
  for (const s of [200, 201, 301, 302, 303, 307, 401, 404, 500]) assert.equal(handedOff(s), false, String(s));
});

test("a collection run goes to the site's own collect-run, redirects not followed", async () => {
  const { seen, impl } = answer(202);
  await triggerRuns(ORIGIN, ["run-1"], impl);
  assert.equal(seen[0].url, `${ORIGIN}${RUN_PATH}`);
  assert.equal(seen[0].init.redirect, "manual");
  assert.equal(new Headers(seen[0].init.headers).get("authorization"), "Bearer test-token");
  assert.ok(seen[0].init.signal);
});

test("a history load goes to the site's own backfill-run; a redirect or a 200 isn't a hand-off", async () => {
  const ok = answer(204);
  g.fetch = ok.impl;
  await backfillTrigger.send(ORIGIN, ["account-1"]);
  assert.equal(ok.seen[0].url, `${ORIGIN}${BACKFILL_PATH}`);
  assert.equal(ok.seen[0].init.redirect, "manual");
  g.fetch = answer(302, { location: "/login" }).impl;
  await assert.rejects(backfillTrigger.send(ORIGIN, ["account-1"]), /answered 302/);
  g.fetch = answer(200).impl;
  await assert.rejects(backfillTrigger.send(ORIGIN, ["account-1"]), /answered 200/);
});
