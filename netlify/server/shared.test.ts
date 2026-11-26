import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANON_LIMIT, countRequest, dailyCap, ipBucket, limitKey, pruneCounts, rateLimit, requireAuth, warm } from "./shared";

test("addresses: IPv4 as it is, IPv6 by its /64", () => {
  assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("::ffff:203.0.113.7"), "203.0.113.7", "IPv4 written as IPv6");
  assert.equal(ipBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8:1:2::1"), "2001:db8:1:2::/64", "the same /64, written short");
  assert.equal(ipBucket("2001:0DB8:0001:0002:0:0:0:9"), "2001:db8:1:2::/64", "case and leading zeros");
  assert.equal(ipBucket("[2001:db8::1]"), "2001:db8:0:0::/64");
  assert.equal(ipBucket("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.notEqual(ipBucket("2001:db8:1:3::1"), ipBucket("2001:db8:1:2::1"), "another /64");
});

test("a request is counted under its credential in an area, or its address (one bucket for every area) without one", () => {
  assert.equal(limitKey("assistant", { id: "master" }, "203.0.113.7"), "assistant:master");
  assert.equal(limitKey("talk", { id: "key:abc" }, "203.0.113.7"), "talk:key:abc");
  assert.equal(limitKey("assistant", null, "2001:db8:1:2::9"), "anon:2001:db8:1:2::/64");
  assert.equal(limitKey("talk", null, "2001:db8:1:2::9"), limitKey("assistant", null, "2001:db8:1:2::5"));
});

test("countRequest: the master token is counted as itself wherever it comes from; no token by address", async () => {
  process.env.MCP_BEARER_TOKEN = "count-token-count-token-count-token";
  const signed = new Request("https://x.test/api/assistant", { headers: { Authorization: "Bearer count-token-count-token-count-token" } });
  for (let i = 0; i < 5; i++) {
    const { who, limited } = await countRequest(signed, "count-test", 5, `198.51.100.${i}`);
    assert.equal(who?.id, "master");
    assert.equal(limited, null);
  }
  assert.equal((await countRequest(signed, "count-test", 5, "198.51.100.99")).limited?.status, 429, "a new address doesn't reset a credential's count");
  const anon = new Request("https://x.test/api/assistant", { headers: { Authorization: "Bearer wrong" } });
  const first = await countRequest(anon, "count-test", 5, "198.51.100.200");
  assert.equal(first.who, null);
  assert.equal(first.limited, null, "the credential's spent count isn't the address's");
  for (let i = 1; i < ANON_LIMIT; i++) await countRequest(anon, "count-test", 5, "198.51.100.200");
  assert.equal((await countRequest(anon, "count-test", 5, "198.51.100.200")).limited?.status, 429);
  delete process.env.MCP_BEARER_TOKEN;
});

test("a daily cap allows `limit` a UTC day per key, and starts again the next day", () => {
  const day = Date.parse("2026-11-26T10:00:00Z");
  for (let i = 0; i < 3; i++) assert.equal(dailyCap("cap:test", 3, day + i), true);
  assert.equal(dailyCap("cap:test", 3, day + 10), false);
  assert.equal(dailyCap("cap:other", 3, day + 10), true, "another key has its own");
  assert.equal(dailyCap("cap:test", 3, Date.parse("2026-11-27T00:00:01Z")), true);
});

test("pruning drops finished windows and past days, and nothing still counting", () => {
  const t = 5_000_000;
  rateLimit("prune:a", 5, t);
  dailyCap("prune:d", 5, t);
  const held = pruneCounts(t + 1);
  assert.ok(held >= 2);
  assert.ok(pruneCounts(t + 60_000) < held, "the finished window is gone");
  assert.equal(rateLimit("prune:a", 1, t + 60_001), null, "and a new one starts");
});

test("the rate limiter allows `limit` a minute per key, then answers 429 until the window ends", () => {
  const t = 1_000_000;
  for (let i = 0; i < 20; i++) assert.equal(rateLimit("assistant:1.2.3.4", 20, t + i), null);
  const refused = rateLimit("assistant:1.2.3.4", 20, t + 30_000);
  assert.equal(refused?.status, 429);
  assert.equal(refused?.headers.get("Retry-After"), "30");
  assert.equal(rateLimit("assistant:5.6.7.8", 20, t + 30_000), null, "another IP has its own count");
  assert.equal(rateLimit("talk:1.2.3.4", 30, t + 30_000), null, "another area has its own count");
  assert.equal(rateLimit("assistant:1.2.3.4", 20, t + 60_000), null, "a new window starts after a minute");
});

test("warm creates once per key and retries after a rejected promise", async () => {
  let made = 0;
  const a = warm("test:a", () => ({ n: ++made }));
  assert.equal(warm("test:a", () => ({ n: ++made })), a);
  assert.equal(made, 1);
  const failed = warm("test:b", () => Promise.reject(new Error("no")));
  await assert.rejects(failed);
  assert.equal(await warm("test:b", async () => "ok"), "ok");
});

test("no token is refused", async () => {
  delete process.env.MCP_BEARER_TOKEN;
  const res = await requireAuth(new Request("https://x.test/api/live/ping"));
  assert.equal(res?.status, 401);
});

test("the server claims only Ask, Talk, the live channel and Team chat's channel, and api.ts excludes each of those paths", () => {
  const paths = ["/api/assistant", "/api/assistant/*", "/api/talk/*", "/api/live/*", "/api/team/chat"];
  const server = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  assert.ok(server.includes(`path: ${JSON.stringify(paths).replaceAll(",", ", ")}`));
  const api = readFileSync(join(import.meta.dirname, "..", "functions", "api.ts"), "utf8");
  const excluded = api.slice(api.lastIndexOf("excludedPath"));
  for (const p of paths) assert.ok(excluded.includes(`"${p}"`), `api.ts must exclude ${p}`);
});
