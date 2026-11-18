// Run: npx tsx --test netlify/lib/connectors/swarm-direct.test.ts
// Swarm over Foursquare's v2 API, with fetch stubbed (reply shapes as api.foursquare.com documents them; venues and times made up).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_CATEGORIES, CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { exchangeSwarmCode, openSwarm, PAGE, swarmAdapter, swarmAuthorizationUrl } from "./swarm-direct";

type Reply = { status?: number; body: unknown };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];
const realSave = lifeTokenStore.save;
let saved: ConnectorSecrets[] = [];

beforeEach(() => {
  calls = [];
  routes = [];
  saved = [];
  lifeRetryWaits.ms = [1, 1];
  lifeTokenStore.save = async (_id, mutate) => {
    const s: ConnectorSecrets = { tokens: { access_token: "old", refresh_token: "r1" } };
    mutate(s);
    saved.push(s);
  };
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lifeTokenStore.save = realSave;
});

const connector = { id: "c1", name: "Swarm", provider: "swarm", auth_type: "oauth", url: "https://api.foursquare.com/v2", scope: "" } as Connector;
const secrets = (): ConnectorSecrets => ({ tokens: { access_token: "a1", obtained_at: Date.now() }, ownClient: { client_id: "FSQID", client_secret: "cs" } });
const SELF = { meta: { code: 200 }, response: { user: { id: "1" } } };
const self = (url: URL) => (url.pathname === "/v2/users/self" ? { body: SELF } : undefined);

/** n check-ins, newest first, an hour apart from `from` backwards. */
function checkins(n: number, from = Date.parse("2026-11-06T20:00:00Z"), offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ck${offset + i}`,
    createdAt: Math.floor((from - (offset + i) * 3_600_000) / 1000),
    type: "checkin",
    venue: { id: `v${(offset + i) % 7}`, name: ` Venue ${(offset + i) % 7} `, location: { lat: 51.5 + i / 1e4, lng: -0.12, city: "London" }, categories: [{ name: "Coffee Shop", primary: true }] },
  }));
}

test("preset: Swarm sits in Places and travel, reads only, says it's encrypted, and is reached directly", () => {
  assert.ok(CONNECTOR_CATEGORIES.some((c) => c.id === "travel" && c.label === "Places and travel"));
  const p = CONNECTOR_PRESETS.find((x) => x.id === "swarm")!;
  assert.equal(p.category, "travel");
  assert.equal(p.needsOwnClient, true);
  assert.deepEqual(p.readTools, ["checkins"]);
  assert.match(p.help, /encrypted/);
  for (const t of swarmAdapter.tools(connector)) assert.equal(classifyTool("swarm", t.name, t.annotations), "read");
  assert.equal(directFor(connector), swarmAdapter);
  assert.equal(directApi(connector), true);
});

test("checkins: pages of 250 by offset, newest first, until a short page; the token goes in the query", async () => {
  const all = checkins(PAGE * 2 + 10);
  routes = [
    self,
    (url) => {
      if (url.pathname !== "/v2/users/self/checkins") return undefined;
      const off = Number(url.searchParams.get("offset"));
      return { body: { meta: { code: 200 }, response: { checkins: { count: all.length, items: all.slice(off, off + PAGE) } } } };
    },
  ];
  const acct = await openSwarm(connector, secrets(), "Europe/London");
  const r = await acct.call("checkins", {});
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.items.length, 510);
  assert.equal(out.next_cursor, undefined);
  const pages = calls.filter((c) => c.url.pathname.endsWith("/checkins"));
  assert.deepEqual(pages.map((c) => c.url.searchParams.get("offset")), ["0", "250", "500"]);
  for (const c of calls) {
    assert.equal(c.url.searchParams.get("oauth_token"), "a1");
    assert.match(c.url.searchParams.get("v") ?? "", /^\d{8}$/);
  }
  assert.deepEqual(out.items[0], { id: "ck0", at: "2026-11-06T20:00:00.000Z", date: "2026-11-06", time: "20:00", venue: "Venue 0", venue_id: "v0", category: "Coffee Shop", lat: 51.5, lng: -0.12, town: "London" });
});

test("checkins: four pages a call, then a cursor that carries on where it stopped", async () => {
  const all = checkins(PAGE * 5);
  routes = [
    self,
    (url) => {
      if (!url.pathname.endsWith("/checkins")) return undefined;
      const off = Number(url.searchParams.get("offset"));
      return { body: { response: { checkins: { items: all.slice(off, off + PAGE) } } } };
    },
  ];
  const acct = await openSwarm(connector, secrets(), "Europe/London");
  const first = JSON.parse((await acct.call("checkins", {})).text);
  assert.equal(first.items.length, 1000);
  assert.ok(first.next_cursor);
  const rest = JSON.parse((await acct.call("checkins", { cursor: first.next_cursor })).text);
  assert.equal(rest.items.length, 250);
  assert.equal(rest.items[0].id, "ck1000");
  assert.equal(rest.next_cursor, undefined);
});

test("checkins: a window becomes after/beforeTimestamp, and items outside it are dropped", async () => {
  routes = [self, (url) => (url.pathname.endsWith("/checkins") ? { body: { response: { checkins: { items: checkins(30) } } } } : undefined)];
  const acct = await openSwarm(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("checkins", { date: "2026-11-06" })).text);
  const q = calls.find((c) => c.url.pathname.endsWith("/checkins"))!.url.searchParams;
  assert.equal(q.get("afterTimestamp"), String(Date.parse("2026-11-06T00:00:00Z") / 1000));
  assert.equal(q.get("beforeTimestamp"), String(Date.parse("2026-11-07T00:00:00Z") / 1000));
  assert.ok(out.items.every((i: { date: string }) => i.date === "2026-11-06"));
  assert.equal(out.items.length, 21, "20:00 back to 00:00");
});

test("a refused token: sign in again (the account shows needs_auth); rate limits are retried, then reported", async () => {
  routes = [(url) => (url.pathname === "/v2/users/self" ? { status: 401, body: { meta: { code: 401, errorType: "invalid_auth" } } } : undefined)];
  await assert.rejects(openSwarm(connector, secrets(), "Europe/London"), (e: unknown) => {
    assert.deepEqual(directFailure(e), { status: "needs_auth", detail: "Swarm didn't accept the sign-in. Sign in again" });
    return swarmAdapter.accountProblem(e);
  });
  routes = [(url) => (url.pathname === "/v2/users/self" ? { status: 403, body: { meta: { code: 403, errorType: "rate_limit_exceeded" } } } : undefined)];
  await assert.rejects(openSwarm(connector, secrets(), "Europe/London"), (e: unknown) => directFailure(e)?.status === "error");
});

test("refresh: an expired token with a refresh token is renewed once and saved back; a 401 renews and retries", async () => {
  let tokenCalls = 0;
  routes = [
    (url) => {
      if (url.host !== "foursquare.com" || url.pathname !== "/oauth2/access_token") return undefined;
      tokenCalls++;
      assert.equal(url.searchParams.get("grant_type"), "refresh_token");
      assert.equal(url.searchParams.get("refresh_token"), "r1");
      assert.equal(url.searchParams.get("client_id"), "FSQID");
      return { body: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } };
    },
    (url) => (url.pathname === "/v2/users/self" ? (url.searchParams.get("oauth_token") === "a2" ? { body: SELF } : { status: 401, body: { meta: { errorType: "invalid_auth" } } }) : undefined),
  ];
  const expired: ConnectorSecrets = { tokens: { access_token: "old", refresh_token: "r1", expires_in: 3600, obtained_at: Date.now() - 2 * 3_600_000 }, ownClient: { client_id: "FSQID", client_secret: "cs" } };
  await openSwarm(connector, expired, "Europe/London");
  assert.equal(tokenCalls, 1);
  assert.equal((saved[0].tokens as { access_token: string; refresh_token: string }).access_token, "a2");
  assert.equal((saved[0].tokens as { refresh_token: string }).refresh_token, "r2");

  // Not yet expired, but refused: renewed and tried again.
  tokenCalls = 0;
  saved = [];
  await openSwarm(connector, { tokens: { access_token: "stale", refresh_token: "r1", obtained_at: Date.now() }, ownClient: { client_id: "FSQID" } }, "Europe/London");
  assert.equal(tokenCalls, 1);
  assert.equal(saved.length, 1);
});

test("sign-in: Foursquare's consent page, and the code swapped for a token that doesn't expire", async () => {
  const u = new URL(swarmAuthorizationUrl({ clientId: "FSQID", redirectUri: "https://athena.test/api/connectors/oauth/callback", state: "s1" }));
  assert.equal(u.origin + u.pathname, "https://foursquare.com/oauth2/authenticate");
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: "FSQID", response_type: "code", redirect_uri: "https://athena.test/api/connectors/oauth/callback", state: "s1" });
  routes = [(url) => (url.pathname === "/oauth2/access_token" ? { body: { access_token: "tok" } } : undefined)];
  const t = await exchangeSwarmCode({ code: "c0de", redirectUri: "https://athena.test/cb", client: { client_id: "FSQID", client_secret: "cs" } });
  assert.equal(t.access_token, "tok");
  assert.equal(t.refresh_token, undefined);
  const q = calls[0].url.searchParams;
  assert.deepEqual([q.get("grant_type"), q.get("code"), q.get("redirect_uri"), q.get("client_secret")], ["authorization_code", "c0de", "https://athena.test/cb", "cs"]);
  routes = [(url) => (url.pathname === "/oauth2/access_token" ? { status: 400, body: { error: "invalid_client" } } : undefined)];
  await assert.rejects(exchangeSwarmCode({ code: "x", redirectUri: "r", client: { client_id: "bad" } }), /Sign in again|refused/);
});
