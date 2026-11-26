// Run: npx tsx --test netlify/lib/connectors/lifelog-b-http.test.ts
// getJson reads at most MAX_JSON_BYTES of an answer, counted as it streams.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { getJson, LifeApiError, MAX_JSON_BYTES, type GetOptions } from "./lifelog-b-http";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const opts: GetOptions = {
  service: "reddit",
  hosts: ["api.example.com"],
  refused: (status) => new LifeApiError("reddit", status, "refused"),
  unreachable: "Couldn't reach it",
};

test("an answer under the cap is parsed as before", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  assert.deepEqual(await getJson("https://api.example.com/x", opts), { ok: true });
});

test("an endless answer is cut off at the cap, not buffered whole", async () => {
  let sent = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          sent += 1024 * 1024;
          c.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      }),
    )) as typeof fetch;
  await assert.rejects(getJson("https://api.example.com/x", opts), (e: unknown) => e instanceof LifeApiError && e.status === 413);
  assert.ok(sent <= MAX_JSON_BYTES + 2 * 1024 * 1024, `read ${sent} bytes`);
});

test("a declared length over the cap is refused before reading", async () => {
  globalThis.fetch = (async () => new Response("{}", { headers: { "content-length": String(MAX_JSON_BYTES + 1) } })) as typeof fetch;
  await assert.rejects(getJson("https://api.example.com/x", opts), /too large/);
});
