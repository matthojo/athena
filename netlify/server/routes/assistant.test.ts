import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@netlify/server";
import { onServer } from "../../../lib/ai";
import { runHost } from "../assistant/host";
import { handleAssistant } from "./assistant";

const ID = "33333333-3333-4333-8333-333333333333";
const ctx = (waited: Array<Promise<unknown>> = []) => ({ ip: `10.0.0.${Math.floor(Math.random() * 250)}`, waitUntil: (p: Promise<unknown>) => void waited.push(p) }) as unknown as Context;
const lines = async (res: Response) => (await res.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

test("on the server, Ask's time caps are the longer ones", () => {
  assert.equal(onServer(), true);
});

test("a streamed reply without a run id is left to stepStream, as before", () => {
  assert.equal(runHost.current!(new Request("https://x.test/api/assistant", { method: "POST" }), async () => ({}), {}), null);
  assert.equal(runHost.current!(new Request("https://x.test/api/assistant", { method: "POST", headers: { "X-Ask-Run": "not-a-uuid" } }), async () => ({}), {}), null);
});

test("a named run streams NDJSON, says its id, and the same request again follows it without running twice", async () => {
  let ran = 0;
  const work = async () => (ran++, { text: "Done.", changes: [], choices: [] });
  const post = () => new Request("https://x.test/api/assistant", { method: "POST", headers: { "X-Ask-Run": ID } });
  const first = await runHost.current!(post(), work, { Vary: "Origin" })!;
  assert.match(first.headers.get("content-type") ?? "", /ndjson/);
  assert.equal(first.headers.get("x-ask-run"), ID);
  assert.equal(first.headers.get("vary"), "Origin");
  assert.equal((await lines(first)).at(-1).type, "done");
  const again = await runHost.current!(post(), work, {})!;
  assert.deepEqual((await lines(again)).at(-1).reply, { text: "Done.", changes: [], choices: [] });
  assert.equal(ran, 1);
});

test("following, stopping and warming all need the token", async () => {
  delete process.env.MCP_BEARER_TOKEN;
  for (const [method, path] of [["GET", `/api/assistant/runs/${ID}`], ["DELETE", `/api/assistant/runs/${ID}`], ["POST", "/api/assistant/warm"]] as const) {
    const res = await handleAssistant(new Request(`https://x.test${path}`, { method }), ctx());
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("with the token: a known run is followed by its id alone, an unknown one is 404, Stop and warm answer at once", async () => {
  process.env.MCP_BEARER_TOKEN = "t".repeat(40);
  const auth = { Authorization: `Bearer ${"t".repeat(40)}` };
  const known = await handleAssistant(new Request(`https://x.test/api/assistant/runs/${ID}`, { headers: auth }), ctx());
  assert.equal(known.status, 200);
  assert.equal((await lines(known)).at(-1).type, "done");
  const unknown = await handleAssistant(new Request("https://x.test/api/assistant/runs/44444444-4444-4444-8444-444444444444", { headers: auth }), ctx());
  assert.equal(unknown.status, 404);
  const stopped = await handleAssistant(new Request(`https://x.test/api/assistant/runs/${ID}`, { method: "DELETE", headers: auth }), ctx());
  assert.deepEqual(await stopped.json(), { ok: true, stopped: false });
  const waited: Array<Promise<unknown>> = [];
  const warmed = await handleAssistant(new Request("https://x.test/api/assistant/warm", { method: "POST", headers: auth }), ctx(waited));
  assert.deepEqual(await warmed.json(), { ok: true, runs: true });
  assert.equal(waited.length, 1, "the warming itself runs after the response");
  await waited[0];
  delete process.env.MCP_BEARER_TOKEN;
});
