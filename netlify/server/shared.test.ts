import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rateLimit, requireAuth, warm } from "./shared";

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
