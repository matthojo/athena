// Ask's reply streams token by token, on the real path: the real api.ts handler, the real
// lib/answer.ts and lib/assistant.ts, a real Postgres, and the real Anthropic SDK talking to a
// scripted stand-in for the Messages API over HTTP (server-sent events, a few characters a time).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/ask-stream.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const url = process.env.ATHENA_TEST_DB_URL;
const skip = !url && "set ATHENA_TEST_DB_URL";

/** One scripted model turn: the blocks it writes, in order. */
type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };
type Script = (body: { stream?: boolean; messages: unknown[] }) => Block[];

let server: Server;
let script: Script = () => [];
/** Whether the stand-in saw its last stream cut off before it finished writing. */
let cutOff = false;
let calls = 0;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const pieces = (s: string, n = 6) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) ?? [];

before(async () => {
  if (!url) return;
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      calls++;
      const body = JSON.parse(raw);
      const blocks = script(body);
      const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message(blocks, stop)));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let finished = false;
      res.on("close", () => (cutOff = !finished));
      const write = async (s: string) => {
        if (res.destroyed) throw new Error("closed");
        res.write(s);
        await new Promise((r) => setTimeout(r, 15));
      };
      try {
        await write(sse("message_start", { type: "message_start", message: { ...message([], null), content: [] } }));
        for (const [index, b] of blocks.entries()) {
          if (b.type === "text") {
            await write(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
            for (const p of pieces(b.text)) await write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: p } }));
          } else {
            await write(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}_${calls}`, name: b.name, input: {} } }));
            for (const p of pieces(JSON.stringify(b.input), 8)) await write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } }));
          }
          await write(sse("content_block_stop", { type: "content_block_stop", index }));
        }
        await write(sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }));
        await write(sse("message_stop", { type: "message_stop" }));
        finished = true;
        res.end();
      } catch {
        // the reader went away
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test";
  const g = globalThis as { Netlify?: unknown };
  g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
  const { q } = await import("../../lib/db");
  await q(`DELETE FROM notes WHERE title = 'Pricing call with Elena'`);
});

after(async () => {
  if (!url) return;
  server?.close();
  const { q } = await import("../../lib/db");
  await q(`DELETE FROM notes WHERE title = 'Pricing call with Elena'`);
  const { closePool } = (await import("../../lib/db")) as { closePool?: () => Promise<void> };
  await closePool?.();
});

function message(blocks: Block[], stop: string | null) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: blocks.map((b, i) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: `toolu_${i}_${calls}`, name: b.name, input: b.input })),
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** POST to the real handler with Accept: application/x-ndjson; every event with when it arrived. */
async function stream(path: string, body: unknown, opts: { abortAfterText?: number } = {}) {
  const api = (await import("../functions/api")).default;
  const stop = new AbortController();
  const res = await api(
    new Request(`https://athena.test/api${path}`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      signal: stop.signal,
    }),
    {} as never,
  );
  assert.match(res.headers.get("content-type") ?? "", /ndjson/);
  const events: Array<{ at: number; e: { type: string; delta?: string; reset?: boolean; reply?: Record<string, unknown> } }> = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const t0 = Date.now();
  let buf = "";
  let texts = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const e = JSON.parse(line);
      events.push({ at: Date.now() - t0, e });
      if (e.type === "text" && opts.abortAfterText && ++texts >= opts.abortAfterText) {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}

test("a written answer streams its words, then the reply with resolved citations and chips", { skip }, async () => {
  const { createNote } = await import("../../lib/db");
  const note = await createNote({ title: "Pricing call with Elena", body: "Elena said pricing should stay at £40 a seat until the renewal in March." });
  const text = "Elena wants to keep pricing at £40 a seat until the March renewal [1].";
  script = (body) => {
    const sent = JSON.stringify(body.messages);
    assert.ok(sent.includes(`note:${note.id}`), "the first search found the note");
    return [{ type: "tool_use", name: "answer", input: { text, found: true, sources: [{ ref: `note:${note.id}`, title: "Pricing call with Elena", date: "" }], next: ["When is the renewal?", "What did Priya say?"] } }];
  };
  const events = await stream("/assistant", { question: "What did Elena say about pricing?" });
  const textEvents = events.filter((x) => x.e.type === "text");
  const done = events.find((x) => x.e.type === "done")!;
  // Many small pieces, arriving over time, all before the reply.
  assert.ok(textEvents.length >= 5, `only ${textEvents.length} text events`);
  assert.ok(textEvents[textEvents.length - 1].at - textEvents[0].at > 50, "the words arrived over time, not in one piece");
  assert.ok(textEvents.every((x) => x.at <= done.at));
  assert.equal(textEvents.map((x) => x.e.delta ?? "").join(""), text);
  // The citation resolves only in the finished reply.
  const reply = done.e.reply as { text: string; sources: Array<{ n: number; id: string; kind: string }>; next: string[]; found: boolean };
  assert.equal(reply.found, true);
  assert.equal(reply.text, text);
  assert.deepEqual(reply.sources.map((s) => [s.n, s.kind, s.id]), [[1, "note", note.id]]);
  assert.deepEqual(reply.next, ["When is the renewal?", "What did Priya say?"]);
});

test("one route: a look-up before the reply shows as a step, and only the reply's own words stream", { skip }, async () => {
  let turn = 0;
  const text = "You have nothing open about the dentist.";
  script = () =>
    turn++ === 0
      ? [{ type: "text", text: "Let me check your to-dos." }, { type: "tool_use", name: "find_todos", input: { query: "dentist" } }]
      : [{ type: "tool_use", name: "answer", input: { text, found: true, general: false, from_today: false, sources: [], next: ["Remind me to book it", "What's due this week?"], ask: { question: "", options: [], more: [] } } }];
  // The same route takes the older { messages } shape too.
  const events = await stream("/assistant", { messages: [{ role: "user", text: "Have I booked the dentist?" }] });
  const steps = events.filter((x) => x.e.type === "step").map((x) => String((x.e as { text?: unknown }).text));
  assert.ok(steps.includes("Checking your to-dos"), steps.join(" | "));
  // Words before a tool call are the model thinking aloud, not the reply: they never go out.
  const shown = events.filter((x) => x.e.type === "text").map((x) => x.e.delta ?? "").join("");
  assert.equal(shown, text);
  const reply = events.find((x) => x.e.type === "done")!.e.reply as { text: string; next: string[]; changes: unknown[]; choices: unknown[] };
  assert.equal(reply.text, text);
  assert.deepEqual(reply.next, ["Remind me to book it", "What's due this week?"]);
  // An older caller reads these as lists, so they're always there for it.
  assert.deepEqual([reply.changes, reply.choices], [[], []]);
});

test("the routes that chose between two back ends are gone", { skip }, async () => {
  const api = (await import("../functions/api")).default;
  for (const path of ["/api/assistant/route", "/api/assistant/answer"]) {
    const res = await api(new Request(`https://athena.test${path}`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ text: "add milk", question: "add milk" }) }), {} as never);
    assert.equal(res.status, 404, path);
  }
});

test("Stop: when the app goes away mid-answer, the model's stream is cut off too", { skip }, async () => {
  cutOff = false;
  const long = "This answer goes on for a while so there's time to stop it part-way through the writing. ".repeat(4);
  script = () => [{ type: "tool_use", name: "answer", input: { text: long, found: false, sources: [], next: [] } }];
  const events = await stream("/assistant", { question: "Tell me about the long thing" }, { abortAfterText: 3 });
  assert.equal(events.filter((x) => x.e.type === "text").length, 3);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(cutOff, true, "the stand-in model saw its stream closed early");
});

test("without the ndjson header the reply is plain JSON, chips included", { skip }, async () => {
  script = () => [{ type: "text", text: "Done.\n<next>Undo that</next>" }];
  const api = (await import("../functions/api")).default;
  const res = await api(
    new Request("https://athena.test/api/assistant", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", text: "ok" }] }) }),
    {} as never,
  );
  assert.match(res.headers.get("content-type") ?? "", /json/);
  const reply = (await res.json()) as { text: string; next: string[] };
  assert.equal(reply.text, "Done.");
  assert.deepEqual(reply.next, ["Undo that"]);
});
