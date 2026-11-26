import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@netlify/server";
import { handleTeamChat } from "./team-chat";
import { rateLimit } from "../shared";

const ctx = (ip: string) => ({ ip }) as Context;
const TOKEN = "team-chat-token-team-chat-token-0001";
const chat = (method: string, token?: string) => new Request("https://x.test/api/team/chat", { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

test("what's typed in Team chat shares Ask's 20 a minute per credential; reading the channel isn't counted", async () => {
  process.env.MCP_BEARER_TOKEN = TOKEN;
  // Signed in: counted against the master token, from whichever address. The dispatcher answers each (no database here).
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await handleTeamChat(chat("POST", TOKEN), ctx(`9.9.8.${i}`))).status;
  assert.equal(last, 429);
  assert.notEqual((await handleTeamChat(chat("GET", TOKEN), ctx("9.9.8.1"))).status, 429, "a read still goes through");
  // The same count as Ask's own (netlify/server/routes/assistant.ts).
  assert.equal(rateLimit("assistant:master", 20)?.status, 429);
  delete process.env.MCP_BEARER_TOKEN;
});

test("without a credential, POSTs count against the address's own bucket, not anyone's credential", async () => {
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await handleTeamChat(chat("POST"), ctx("9.9.7.1"))).status;
  assert.equal(last, 429, "30 a minute from one address");
  assert.equal((await handleTeamChat(chat("POST"), ctx("9.9.7.2"))).status, 401, "another address has its own");
});
