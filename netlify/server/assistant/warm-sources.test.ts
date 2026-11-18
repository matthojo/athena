import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connector } from "../../../lib/connectors";
import { answerSourcesWith } from "../../lib/connectors/answer-sources";
import { ConnectorNeedsSignIn, type OpenConnector } from "../../lib/connectors/mcp-client";
import { MAX_AGE_MS, warmSources } from "./warm-sources";

const row = (over: Partial<Connector> = {}): Connector =>
  ({ id: "c1", name: "Gmail", provider: "gmail", account_label: "", status: "connected", allowed_tools: ["search_threads"], use_in_ask: true, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...over }) as Connector;

/** A fake account: counts how often it's opened, listed and closed; each connection can be made to fail. */
function fake() {
  const state = { opens: 0, lists: 0, closes: 0, calls: [] as number[], broken: new Set<number>(), t: 1_000_000 };
  const w = warmSources({
    now: () => state.t,
    open: async () => {
      const n = ++state.opens;
      return { connector: row(), n, close: async () => void state.closes++ } as unknown as OpenConnector;
    },
    tools: async () => {
      state.lists++;
      return [{ name: "search_threads", description: "Search mail", inputSchema: {} }];
    },
    call: async (open) => {
      const n = (open as unknown as { n: number }).n;
      state.calls.push(n);
      if (state.broken.has(n)) throw new Error("fetch failed: other side closed");
      return { text: `from connection ${n}`, isError: false };
    },
  });
  let rows = [row()];
  const port = answerSourcesWith({ list: async () => rows, ...w.source });
  return { state, w, port, setRows: (r: Connector[]) => (rows = r) };
}

test("an account opened for one answer is reused by the next: no second handshake or listing", async () => {
  const { state, w, port } = fake();
  const first = await port.open({ timeoutMs: 1000 });
  await first.accounts[0].call("search_threads", {}, 1000);
  await first.close();
  assert.equal(state.closes, 0, "the answer ending doesn't close a kept account");
  const second = await port.open({ timeoutMs: 1000 });
  assert.equal((await second.accounts[0].call("search_threads", {}, 1000)).text, "from connection 1");
  assert.deepEqual([state.opens, state.lists], [1, 1]);
  assert.equal(w.stats.reused, 1);
  await w.close();
  assert.equal(state.closes, 1);
});

test("a kept account that's gone stale (idle close, expired session or token) is reopened and asked again, not surfaced", async () => {
  const { state, w, port } = fake();
  await (await port.open({ timeoutMs: 1000 })).close();
  // More than 60 quiet seconds later the platform has closed connection 1.
  state.broken.add(1);
  const next = await port.open({ timeoutMs: 1000 });
  const r = await next.accounts[0].call("search_threads", {}, 1000);
  assert.equal(r.text, "from connection 2");
  assert.deepEqual(state.calls, [1, 2]);
  assert.equal(w.stats.reopened, 1);
  // The answer's later lookups use the new connection straight away.
  await next.accounts[0].call("search_threads", {}, 1000);
  assert.deepEqual(state.calls, [1, 2, 2]);
});

test("a failure on an account opened for this answer isn't retried: it's that lookup's own failure, as before", async () => {
  const { state, port } = fake();
  state.broken.add(1);
  const opened = await port.open({ timeoutMs: 1000 });
  await assert.rejects(opened.accounts[0].call("search_threads", {}, 1000), /fetch failed/);
  assert.equal(state.opens, 1);
});

test("an account whose row changed (new sign-in, refreshed token, allowlist) or that's old is opened afresh", async () => {
  const { state, port, setRows } = fake();
  await port.open({ timeoutMs: 1000 });
  setRows([row({ updated_at: "2026-11-11T09:00:00Z" })]);
  await port.open({ timeoutMs: 1000 });
  assert.deepEqual([state.opens, state.closes], [2, 1]);
  state.t += MAX_AGE_MS;
  await port.open({ timeoutMs: 1000 });
  assert.deepEqual([state.opens, state.lists, state.closes], [3, 3, 2]);
});

test("an account that needs signing in is still skipped and named, and tried again next time", async () => {
  let opens = 0;
  const w = warmSources({
    open: async () => {
      opens++;
      throw new ConnectorNeedsSignIn("Gmail");
    },
  });
  const port = answerSourcesWith({ list: async () => [row()], ...w.source });
  assert.deepEqual((await port.open({ timeoutMs: 1000 })).skipped, ["Gmail (needs signing in)"]);
  await port.open({ timeoutMs: 1000 });
  assert.equal(opens, 2);
});
