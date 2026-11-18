import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@netlify/server";
import { handleTeamChat } from "./team-chat";
import { rateLimit } from "../shared";

const ctx = (ip: string) => ({ ip }) as Context;
const chat = (method: string) => new Request("https://x.test/api/team/chat", { method });

test("what's typed in Team chat shares Ask's 20 a minute; reading the channel isn't counted", async () => {
  // No bearer token: each call is turned away by the dispatcher (401), after the count.
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await handleTeamChat(chat("POST"), ctx("9.9.8.1"))).status;
  assert.equal(last, 429);
  assert.notEqual((await handleTeamChat(chat("GET"), ctx("9.9.8.1"))).status, 429, "a read still goes through");
  // The same count as Ask's own (netlify/server/routes/assistant.ts).
  assert.equal(rateLimit("assistant:9.9.8.1", 20)?.status, 429);
  for (let i = 0; i < 20; i++) rateLimit("assistant:9.9.8.2", 20);
  assert.equal((await handleTeamChat(chat("POST"), ctx("9.9.8.2"))).status, 429);
});
