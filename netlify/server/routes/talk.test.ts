import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@netlify/server";
import { handleTalk } from "./talk";

const ctx = (ip: string) => ({ ip }) as Context;

test("a ticket needs the bearer token, and only by POST", async () => {
  process.env.MCP_BEARER_TOKEN = "test-token-test-token-test-token";
  const none = await handleTalk(new Request("https://x.test/api/talk/ticket", { method: "POST" }), ctx("9.9.9.1"));
  assert.equal(none.status, 401);
  const get = await handleTalk(new Request("https://x.test/api/talk/ticket"), ctx("9.9.9.1"));
  assert.equal(get.status, 405);
  const ok = await handleTalk(new Request("https://x.test/api/talk/ticket", { method: "POST", headers: { Authorization: "Bearer test-token-test-token-test-token" } }), ctx("9.9.9.1"));
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { ticket: string; expires_in: number };
  assert.match(body.ticket, /^[\w-]{40,}$/);
  assert.equal(body.expires_in, 30);
  delete process.env.MCP_BEARER_TOKEN;
});

test("the session path refuses a plain request, and an upgrade without a good ticket", async () => {
  const plain = await handleTalk(new Request("https://x.test/api/talk/session?ticket=x"), ctx("9.9.9.2"));
  assert.equal(plain.status, 426);
  const upgrade = { headers: { Upgrade: "websocket", Connection: "Upgrade" } };
  const noTicket = await handleTalk(new Request("https://x.test/api/talk/session", upgrade), ctx("9.9.9.2"));
  assert.equal(noTicket.status, 401);
  const madeUp = await handleTalk(new Request("https://x.test/api/talk/session?ticket=made-up", upgrade), ctx("9.9.9.2"));
  assert.equal(madeUp.status, 401);
});

test("ticket and upgrade requests count against the 30 a minute talk limit", async () => {
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await handleTalk(new Request("https://x.test/api/talk/session"), ctx("9.9.9.3"))).status;
  assert.equal(last, 429);
  const ticket = await handleTalk(new Request("https://x.test/api/talk/ticket", { method: "POST" }), ctx("9.9.9.3"));
  assert.equal(ticket.status, 429);
});
