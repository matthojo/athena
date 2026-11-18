// Run: npx tsx --test netlify/lib/body-limit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { textUpTo } from "./body-limit";

const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request("https://athena.example/api/places/timeline", { method: "POST", body, headers });

test("reads a body under the limit", async () => {
  assert.equal(await textUpTo(post('{"a":"é"}'), 100), '{"a":"é"}');
});

test("refuses from Content-Length before reading", async () => {
  const req = post("x".repeat(10), { "content-length": "5000" });
  assert.equal(await textUpTo(req, 100), null);
  assert.equal(req.bodyUsed, false);
});

test("stops a body without a length once it passes the limit", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      if (pulled > 1000) return c.close();
      c.enqueue(new Uint8Array(64).fill(120));
    },
  });
  const req = new Request("https://athena.example/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.equal(await textUpTo(req, 1000), null);
  assert.ok(pulled < 100, `read ${pulled} chunks before stopping`);
});
