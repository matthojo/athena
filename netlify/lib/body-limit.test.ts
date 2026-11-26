// Run: npx tsx --test netlify/lib/body-limit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyUpTo, textUpTo } from "./body-limit";

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

test("bodyUpTo: a response's bytes under the limit; null over it, by header or by count", async () => {
  assert.deepEqual(await bodyUpTo(new Response("hello"), 10), Buffer.from("hello"));
  assert.deepEqual(await bodyUpTo(new Response(null, { status: 204 }), 10), Buffer.alloc(0));
  const declared = new Response("x".repeat(10), { headers: { "content-length": "5000" } });
  assert.equal(await bodyUpTo(declared, 100), null);
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64).fill(120));
    },
  });
  assert.equal(await bodyUpTo(new Response(endless), 1000), null);
  assert.ok(pulled < 100, `read ${pulled} chunks before stopping`);
});
