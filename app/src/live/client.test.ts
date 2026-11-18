// The live channel's client: reading the stream, when it connects, and how it comes back.
// Run: npx tsx --test app/src/live/client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, createLiveClient, sseReader } from "./client";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A server the test drives: each fetch is one stream it can write to, end or refuse. */
function fakeServer() {
  const calls: Array<{ auth: string | null; push: (text: string) => void; end: () => void; aborted: () => boolean }> = [];
  const replies: Array<Response | Error> = [];
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const canned = replies.shift();
    if (canned instanceof Error) throw canned;
    if (canned) return canned;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const signal = init!.signal!;
    signal.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {}
    });
    const enc = new TextEncoder();
    calls.push({
      auth: new Headers(init!.headers).get("Authorization"),
      push: (text) => controller.enqueue(enc.encode(text)),
      end: () => controller.close(),
      aborted: () => signal.aborted,
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, replies };
}

function setup(over: { quietMs?: number } = {}) {
  const server = fakeServer();
  const world = { visible: true, online: true, token: "ath_k_test" as string | null };
  const changes: Array<[string, string[]]> = [];
  const client = createLiveClient({
    fetch: server.fetch,
    token: () => world.token,
    visible: () => world.visible,
    online: () => world.online,
    onChange: (kind, ids) => changes.push([kind, ids]),
    random: () => 0, // the shortest wait: half the base
    ...over,
  });
  return { server, world, changes, client };
}

test("sseReader: events split across pieces, comments dropped, CRLF and several data lines", () => {
  const sse = sseReader();
  assert.deepEqual(sse.feed(": hb\n\nevent: cha"), []);
  assert.deepEqual(sse.feed('nge\ndata: {"kind":"note"}\n\nevent: ready\r\ndata: a\r\ndata: b\r\n\r\ndata: x'), [
    { event: "change", data: '{"kind":"note"}' },
    { event: "ready", data: "a\nb" },
  ]);
  assert.deepEqual(sse.feed("\n\n"), [{ event: "message", data: "x" }]);
});

test("backoffMs doubles from a second to a minute, with jitter", () => {
  assert.deepEqual([0, 1, 2, 6, 30].map((n) => backoffMs(n, 1)), [1000, 2000, 4000, 60_000, 60_000]);
  assert.equal(backoffMs(0, 0), 500);
});

test("connects with the token only when visible, online and signed in; closes when hidden", async () => {
  const { server, world, client } = setup();
  world.visible = false;
  client.sync();
  world.visible = true;
  world.online = false;
  client.sync();
  world.online = true;
  world.token = null;
  client.sync();
  assert.equal(server.calls.length, 0);

  world.token = "ath_k_test";
  client.sync();
  client.sync();
  await tick();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].auth, "Bearer ath_k_test");
  assert.equal(client.connected, true);

  world.visible = false;
  client.sync();
  assert.equal(client.connected, false);
  assert.equal(server.calls[0].aborted(), true);
  await tick(20);
  assert.equal(server.calls.length, 1); // no retry while hidden

  world.visible = true;
  client.sync();
  await tick();
  assert.equal(server.calls.length, 2);
  client.stop();
});

test("change events reach onChange; a reconnect reports only the kinds whose mark moved while away", async () => {
  const { server, world, changes, client } = setup();
  client.sync();
  await tick();
  server.calls[0].push(frame("ready", { marks: { note: "a", nudge: "n" } }));
  server.calls[0].push(": hb\n\n" + frame("change", { kind: "note", ids: ["n1"], mark: "b" }));
  await tick();
  assert.deepEqual(changes, [["note", ["n1"]]]);

  world.visible = false;
  client.sync();
  world.visible = true;
  client.sync();
  await tick();
  server.calls[1].push(frame("ready", { marks: { note: "b", nudge: "n2", run: "r" } }));
  server.calls[1].push("data: not json\n\n");
  await tick();
  assert.deepEqual(changes.slice(1), [["nudge", []]]);
  client.stop();
});

test("a stream that ends is retried after the backoff; a refused token is not, until something changes", async () => {
  const { server, client } = setup();
  server.replies.push(new TypeError("network"));
  client.sync();
  await tick(520); // first retry: 500 ms with the jitter at its lowest
  assert.equal(server.calls.length, 1);
  server.calls[0].push(frame("ready", { marks: {} }));
  await tick();
  server.calls[0].end(); // the server shut down
  await tick(520);
  assert.equal(server.calls.length, 2);

  server.replies.push(new Response('{"error":"Unauthorized"}', { status: 401 }));
  server.calls[1].end();
  await tick(520);
  assert.equal(client.connected, false);
  await tick(600);
  assert.equal(server.calls.length, 2);
  client.sync(); // coming back to the app tries once more
  await tick();
  assert.equal(server.calls.length, 3);
  client.stop();
});

test("a busy server's Retry-After is honoured, and a silent stream is dropped", async () => {
  const { server, client } = setup({ quietMs: 30 });
  server.replies.push(new Response("{}", { status: 503, headers: { "Retry-After": "1" } }));
  client.sync();
  await tick(600);
  assert.equal(server.calls.length, 0);
  await tick(500);
  assert.equal(server.calls.length, 1);
  await tick(60); // nothing heard for longer than quietMs
  assert.equal(server.calls[0].aborted(), true);
  client.stop();
});
