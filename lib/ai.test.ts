import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ANTHROPIC_API_KEY ??= "test";

test("rejectedTool names the tool a provider refused, and nothing else", async () => {
  const { rejectedTool } = await import("./ai");
  const refused = { status: 400, message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.69.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12"}}' };
  assert.equal(rejectedTool(refused), 69);
  assert.equal(rejectedTool({ status: 400, message: "tools.3.input_schema: Extra inputs are not permitted" }), 3);
  // Another 400, another status, or not an error at all.
  assert.equal(rejectedTool({ status: 400, message: "messages.2.content: invalid" }), null);
  assert.equal(rejectedTool({ status: 500, message: "tools.69.custom.input_schema: JSON schema is invalid" }), null);
  assert.equal(rejectedTool(new Error("tools.69.custom.input_schema")), null);
  assert.equal(rejectedTool(null), null);
});

test("a 403 with no body is the gateway turning the request away; one with a body is Claude's own", async () => {
  const { gatewayDenied } = await import("./ai");
  assert.equal(gatewayDenied({ status: 403, error: undefined }), true);
  assert.equal(gatewayDenied({ status: 403, error: { type: "error", error: { type: "permission_error" } } }), false);
  assert.equal(gatewayDenied({ status: 401, error: undefined }), false);
  assert.equal(gatewayDenied(null), false);
});

test("a request the gateway turns away is asked again, while the deadline allows", async () => {
  const { createMessage, streamMessage } = await import("./ai");
  const denied = Object.assign(new Error("403 status code (no body)"), { status: 403, error: undefined });
  // No credentials in the test, so the same stub is asked again.
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN, u: process.env.ANTHROPIC_BASE_URL };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  try {
    let calls = 0;
    const once = { messages: { create: async () => (++calls === 1 ? Promise.reject(denied) : { id: "ok" }) } };
    assert.deepEqual(await createMessage(once as never, {} as never, Date.now() + 60_000), { id: "ok" });
    assert.equal(calls, 2);
    calls = 0;
    const always = { messages: { create: async () => (calls++, Promise.reject(denied)) } };
    // Time for the first wait (1 s) and not the second (4 s more): asked twice, then the refusal stands.
    await assert.rejects(createMessage(always as never, {} as never, Date.now() + 3_000), (e) => e === denied);
    assert.equal(calls, 2);
    // No time left: not asked again.
    calls = 0;
    await assert.rejects(createMessage(always as never, {} as never, Date.now() + 100), (e) => e === denied);
    assert.equal(calls, 1);
    // Streamed: asked again when nothing had arrived.
    let streams = 0;
    const stream = {
      messages: {
        stream: () => {
          const n = ++streams;
          return {
            abort() {},
            async *[Symbol.asyncIterator]() {
              if (n === 1) throw denied;
              yield { type: "message_start" };
            },
            finalMessage: async () => ({ id: "streamed" }),
          };
        },
      },
    };
    assert.deepEqual(await streamMessage(stream as never, {} as never, Date.now() + 60_000, () => undefined), { id: "streamed" });
    assert.equal(streams, 2);
  } finally {
    if (saved.k !== undefined) process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    if (saved.u !== undefined) process.env.ANTHROPIC_BASE_URL = saved.u;
  }
});

test("a refusal that lasts most of a minute is waited out, and never past the deadline", async (t) => {
  const { createMessage, streamMessage } = await import("./ai");
  const denied = Object.assign(new Error("403 status code (no body)"), { status: 403, error: undefined });
  // No credentials in the test, so the same stub is asked again.
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN, u: process.env.ANTHROPIC_BASE_URL };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  /** Let the request reach its next wait, then move the clock on by a second, until it settles. */
  const settle = async <T>(p: Promise<T>): Promise<{ value?: T; error?: unknown; at: number }> => {
    let out: { value?: T; error?: unknown } | null = null;
    p.then(
      (value) => (out = { value }),
      (error) => (out = { error }),
    );
    for (let s = 0; s < 300 && !out; s++) {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      if (!out) t.mock.timers.tick(1_000);
    }
    assert.ok(out, "the request never settled");
    return { ...(out as { value?: T; error?: unknown }), at: Date.now() };
  };
  try {
    // Refused four times, accepted on the fifth: 1 + 4 + 10 + 20 = 35 s of waiting, each wait told to the caller.
    let calls = 0;
    const fifth = { messages: { create: async () => (++calls < 5 ? Promise.reject(denied) : { id: "ok" }) } };
    const told: Array<[number, number]> = [];
    let got = await settle(createMessage(fifth as never, {} as never, Date.now() + 240_000, (ms, attempt) => told.push([ms, attempt])));
    assert.deepEqual(got.value, { id: "ok" });
    assert.equal(calls, 5);
    assert.equal(got.at, 35_000);
    assert.deepEqual(told, [[1_000, 1], [4_000, 2], [10_000, 3], [20_000, 4]]);

    // Refused throughout: asked six times over 60 s, then the refusal stands.
    const always = { messages: { create: async () => (calls++, Promise.reject(denied)) } };
    calls = 0;
    let from = Date.now();
    got = await settle(createMessage(always as never, {} as never, from + 240_000));
    assert.equal(got.error, denied);
    assert.equal(calls, 6);
    assert.equal(got.at - from, 60_000);

    // 20 s to the deadline: the 1, 4 and 10 s waits fit, the 20 s one doesn't. It stops at 15 s, not past the deadline.
    calls = 0;
    from = Date.now();
    got = await settle(createMessage(always as never, {} as never, from + 20_000));
    assert.equal(got.error, denied);
    assert.equal(calls, 4);
    assert.equal(got.at - from, 15_000);

    // Streamed: the same waits while nothing has arrived, and the caller is told.
    let streams = 0;
    const stream = {
      messages: {
        stream: () => {
          const n = ++streams;
          return {
            abort() {},
            async *[Symbol.asyncIterator]() {
              if (n < 5) throw denied;
              yield { type: "message_start" };
            },
            finalMessage: async () => ({ id: "streamed" }),
          };
        },
      },
    };
    const waits: number[] = [];
    from = Date.now();
    const streamed = await settle(streamMessage(stream as never, {} as never, from + 240_000, () => undefined, (ms) => waits.push(ms)));
    assert.deepEqual(streamed.value, { id: "streamed" });
    assert.equal(streams, 5);
    assert.equal(streamed.at - from, 35_000);
    assert.deepEqual(waits, [1_000, 4_000, 10_000, 20_000]);
  } finally {
    t.mock.timers.reset();
    if (saved.k !== undefined) process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    if (saved.u !== undefined) process.env.ANTHROPIC_BASE_URL = saved.u;
  }
});

// ---------- what the log says about a refusal, and the changed-credential retry ----------

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A made-up JWT: the gateway's credential may be one, and its times belong in the log. */
const jwt = (claims: Record<string, unknown>, tail: string): string => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${tail}`;
const halves = (s: string): string[] => [s, s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];

/** Everything written to the console while `run` runs, and for a moment after (the "ok after 403" line is written late). */
async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { warn: console.warn, log: console.log, error: console.error };
  console.warn = console.log = console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const value = await run();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { value, lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** A stand-in gateway: a bare 403 unless the request carries a credential it accepts. Records what each request sent. */
async function gateway(accepts: (credential: string, n: number) => boolean) {
  const sent: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const credential = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "").replace(/^Bearer /, "");
      sent.push(credential);
      if (!accepts(credential, sent.length)) {
        // The refusal as production sends it, plus headers that must never reach the log.
        res.writeHead(403, {
          "x-nf-request-id": "01TESTREQUEST0000000000000",
          server: "Netlify",
          "set-cookie": `session=${credential}`,
          "x-echo": `seen ${credential.slice(0, Math.ceil(credential.length / 2))}`,
          "x-upstream-token": credential,
        });
        res.end();
        return;
      }
      const message = { id: "msg_ok", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!body.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
        return;
      }
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { sent, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

const facts = (lines: string[], prefix: string): Array<Record<string, unknown>> => lines.filter((l) => l.startsWith(prefix)).map((l) => JSON.parse(l.slice(prefix.length)) as Record<string, unknown>);

/** Run with the environment's Claude credential and gateway address set, and put back what was there. */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ATHENA_RUNTIME", ...Object.keys(vars)];
  const saved = new Map(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  for (const [n, v] of Object.entries(vars)) if (v !== undefined) process.env[n] = v;
  try {
    return await run();
  } finally {
    for (const [n, v] of saved) v === undefined ? delete process.env[n] : (process.env[n] = v);
  }
}

test("a refusal is logged with what is known, and never the credential or a part of it", async () => {
  const { Anthropic, createMessage, fingerprint } = await import("./ai");
  const now = Math.floor(Date.now() / 1000);
  const credential = jwt({ iat: now - 240, exp: now + 60, site_id: "a-site", sub: "someone" }, "c2lnbmF0dXJlLW9mLXRoZS10b2tlbg");
  const g = await gateway(() => false);
  try {
    const { lines } = await withEnv({ ANTHROPIC_API_KEY: credential, ANTHROPIC_BASE_URL: g.url, ATHENA_RUNTIME: "server" }, () =>
      logged(async () => {
        // No time for a wait: asked once, and the refusal stands.
        await assert.rejects(createMessage(new Anthropic({ maxRetries: 0 }), { model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, Date.now() + 100), (e) => (e as { status?: number }).status === 403);
      }),
    );
    assert.equal(g.sent.length, 1);
    const [line] = facts(lines, "Athena gateway 403 ");
    assert.ok(line, "no refusal line was logged");
    assert.equal(line.provider, "claude");
    assert.equal(line.runtime, "server");
    assert.equal(line.requestId, "01TESTREQUEST0000000000000");
    assert.equal(line.credential, fingerprint(credential));
    assert.match(String(line.credential), /^[0-9a-f]{8}$/);
    assert.equal(line.envCredential, line.credential);
    assert.equal(line.sameAsEnv, true);
    assert.equal(line.next, "stop");
    const times = line.jwt as Record<string, number>;
    assert.equal(times.iat, now - 240);
    assert.equal(times.exp, now + 60);
    assert.ok(Math.abs(times.issuedSecondsAgo - 240) <= 2 && Math.abs(times.expiresInSeconds - 60) <= 2);
    assert.deepEqual(Object.keys(times).sort(), ["exp", "expiresInSeconds", "iat", "issuedSecondsAgo"]);
    assert.equal(typeof line.upSeconds, "number");
    assert.equal(typeof line.envChanges, "number");
    assert.equal(line.refusals, 1);
    assert.deepEqual(line.addresses, ["127.0.0.1"]);
    // The response's headers, without the ones that carry a credential by name or by value.
    const headers = line.headers as Record<string, string>;
    assert.equal(headers.server, "Netlify");
    assert.equal(headers["x-nf-request-id"], "01TESTREQUEST0000000000000");
    assert.equal(headers["x-echo"], "[removed]");
    assert.ok(!("set-cookie" in headers) && !("x-upstream-token" in headers));
    // Nothing logged holds the credential, either half of it, or what its claims say.
    const all = lines.join("\n");
    for (const part of [...halves(credential), ...credential.split("."), "a-site", "someone"]) assert.ok(!all.includes(part), "part of the credential was logged");
  } finally {
    await g.close();
  }
});

test("a refused credential that the environment has since replaced is not waited on: the new one is tried at once", async () => {
  const { Anthropic, createMessage, streamMessage, fingerprint } = await import("./ai");
  const older = "older-credential-0123456789-abcdefghij";
  const newer = "newer-credential-9876543210-zyxwvutsrq";
  const g = await gateway((credential) => credential === newer);
  try {
    const waits: number[] = [];
    const { value, lines } = await withEnv({ ANTHROPIC_API_KEY: older, ANTHROPIC_BASE_URL: g.url }, () =>
      logged(async () => {
        const client = new Anthropic({ maxRetries: 0 });
        // The platform rewrites the credential in place while the process lives.
        process.env.ANTHROPIC_API_KEY = newer;
        const started = Date.now();
        const message = await createMessage(client, { model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, Date.now() + 60_000, (ms) => waits.push(ms));
        const took = Date.now() - started;
        // Streamed: the same, while nothing has arrived.
        const events: string[] = [];
        const stale = new Anthropic({ maxRetries: 0, apiKey: older });
        const streamed = await streamMessage(stale, { model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, Date.now() + 60_000, (e) => events.push(e.type), (ms) => waits.push(ms));
        return { message, took, streamed, events };
      }),
    );
    assert.equal(value.message.id, "msg_ok");
    assert.ok(value.took < 900, `asked again after ${value.took} ms, so it waited`);
    assert.deepEqual(g.sent.slice(0, 2), [older, newer]);
    // The streamed request was refused with the older credential and asked again with the newer one, too.
    assert.deepEqual(g.sent.slice(2, 4), [older, newer]);
    assert.equal(value.streamed.id, "msg_ok");
    assert.ok(value.events.includes("content_block_delta"));
    assert.deepEqual(waits, [], "the caller was told of a wait that didn't happen");
    const [first] = facts(lines, "Athena gateway 403 ");
    assert.equal(first.next, "retry-now");
    assert.equal(first.credential, fingerprint(older));
    assert.equal(first.envCredential, fingerprint(newer));
    assert.equal(first.sameAsEnv, false);
    assert.equal(first.jwt, null);
    // One line each says how the refusals ended: with another credential than the one refused.
    const oks = facts(lines, "Athena gateway ok after 403 ");
    assert.equal(oks.length, 2);
    assert.equal(oks[0].credential, fingerprint(newer));
    assert.equal(oks[0].sameAsRefused, false);
    assert.equal(oks[1].refusals, 1);
    const all = lines.join("\n");
    for (const part of [...halves(older), ...halves(newer)]) assert.ok(!all.includes(part), "part of a credential was logged");
  } finally {
    await g.close();
  }
});

test("a refusal of the credential the environment still holds is waited on as before", async () => {
  const { Anthropic, createMessage, fingerprint } = await import("./ai");
  const only = "the-only-credential-0123456789-abcdefgh";
  // Refused once with the credential the environment still holds, then accepted: the first wait (1 s), and the caller is told.
  const g = await gateway((_credential, n) => n > 1);
  try {
    const waits: Array<[number, number]> = [];
    const { value, lines } = await withEnv({ ANTHROPIC_API_KEY: only, ANTHROPIC_BASE_URL: g.url }, () =>
      logged(async () => {
        const started = Date.now();
        const message = await createMessage(new Anthropic({ maxRetries: 0 }), { model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, Date.now() + 60_000, (ms, attempt) => waits.push([ms, attempt]));
        return { message, took: Date.now() - started };
      }),
    );
    assert.equal(value.message.id, "msg_ok");
    assert.ok(value.took >= 950, `asked again after ${value.took} ms, without the wait`);
    assert.deepEqual(g.sent, [only, only]);
    assert.deepEqual(waits, [[1_000, 1]]);
    const [first] = facts(lines, "Athena gateway 403 ");
    assert.equal(first.next, "wait-1s");
    assert.equal(first.sameAsEnv, true);
    assert.equal(first.credential, fingerprint(only));
    const [ok] = facts(lines, "Athena gateway ok after 403 ");
    assert.equal(ok.sameAsRefused, true);
    assert.equal(ok.refusedForSeconds, 1);
    assert.ok(!lines.join("\n").includes(only.slice(0, 19)));
  } finally {
    await g.close();
  }
});
