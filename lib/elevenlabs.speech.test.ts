import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsError, speak, useSpeechSocket, warmSpeech, type SpeechSocketEvents } from "./elevenlabs";

/** A stand-in for ElevenLabs' dialogue socket: records what's sent, lets the test play its side. */
function fakeEleven() {
  const sockets: Array<{ url: string; headers: Record<string, string>; sent: Array<Record<string, unknown>>; closed: boolean; on: SpeechSocketEvents }> = [];
  useSpeechSocket((url, headers, on) => {
    const rec = { url, headers, sent: [] as Array<Record<string, unknown>>, closed: false, on };
    sockets.push(rec);
    return { send: (t) => void rec.sent.push(JSON.parse(t) as Record<string, unknown>), close: () => void (rec.closed = true) };
  });
  return sockets;
}
const audio = (bytes: number[], final = false) => JSON.stringify({ audio: Buffer.from(bytes).toString("base64"), is_final: final });
async function read(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) out.push(...chunk);
  return out;
}

afterEach(() => useSpeechSocket(null));

test("speak sends the voice, the line and close_socket once the socket opens, and streams the audio", async () => {
  const sockets = fakeEleven();
  const p = speak("key-1", "voice0001", "Hello [there].");
  const s = sockets[0];
  assert.match(s.url, /text-to-dialogue\/stream-input\?model_id=eleven_v4_turbo&output_format=pcm_24000$/);
  assert.equal(s.headers["xi-api-key"], "key-1");
  assert.deepEqual(s.sent, [], "nothing before it's open");
  s.on.open();
  assert.deepEqual(s.sent, [{ voices: ["voice0001"] }, { inputs: [{ text: "Hello there .", voice_id: "voice0001" }] }, { close_socket: true }]);
  s.on.message(audio([1, 2]));
  const stream = await p;
  s.on.message(audio([3], true));
  assert.deepEqual(await read(stream), [1, 2, 3]);
  assert.equal(s.closed, true);
});

test("a warm socket registers the voice when it opens and sends the line only when there is one", async () => {
  const sockets = fakeEleven();
  const w = warmSpeech("key-1", "voice0001");
  sockets[0].on.open();
  assert.deepEqual(sockets[0].sent, [{ voices: ["voice0001"] }]);
  assert.equal(w.usable, true);
  const p = w.say("Ready when you are.");
  assert.equal(w.usable, false, "one line per socket");
  assert.deepEqual(sockets[0].sent.slice(1), [{ inputs: [{ text: "Ready when you are.", voice_id: "voice0001" }] }, { close_socket: true }]);
  sockets[0].on.message(audio([5], true));
  assert.deepEqual(await read(await p), [5]);
  await assert.rejects(w.say("again"), ElevenLabsError);
});

test("a line given before the socket has opened goes as soon as it does", async () => {
  const sockets = fakeEleven();
  const w = warmSpeech("k", "voice0001");
  const p = w.say("Early");
  assert.deepEqual(sockets[0].sent, []);
  sockets[0].on.open();
  assert.equal(sockets[0].sent.length, 3);
  sockets[0].on.message(audio([1], true));
  assert.deepEqual(await read(await p), [1]);
});

test("a warm socket ElevenLabs closes or refuses is no longer usable, and saying on it fails with the reason", async () => {
  const sockets = fakeEleven();
  const idle = warmSpeech("k", "voice0001");
  sockets[0].on.open();
  sockets[0].on.close();
  assert.equal(idle.usable, false);
  await assert.rejects(idle.say("hi"), (e: ElevenLabsError) => e.problem === "failed");

  const refused = warmSpeech("k", "voice0001");
  sockets[1].on.error(401);
  assert.equal(refused.usable, false);
  await assert.rejects(refused.say("hi"), (e: ElevenLabsError) => e.problem === "bad_key");

  const unused = warmSpeech("k", "voice0001");
  unused.close();
  assert.equal(sockets[2].closed, true);
  assert.equal(unused.usable, false);
});

test("an error message before any audio rejects; an abort hangs up", async () => {
  const sockets = fakeEleven();
  const p = speak("k", "voice0001", "Hi");
  sockets[0].on.open();
  sockets[0].on.message(JSON.stringify({ error: "quota_exceeded" }));
  await assert.rejects(p, (e: ElevenLabsError) => e.problem === "no_credits" && e.status === 402);

  const abort = new AbortController();
  const q = speak("k", "voice0001", "Hi", abort.signal);
  sockets[1].on.open();
  sockets[1].on.message(audio([1]));
  const stream = await q;
  abort.abort();
  assert.equal(sockets[1].closed, true);
  sockets[1].on.message(audio([2]));
  assert.deepEqual(await read(stream), [1], "frames after a hang-up are dropped");

  await assert.rejects(speak("k", "voice0001", "  "), /nothing to say/);
  assert.equal(sockets.length, 2, "no socket for an empty line");
});

test("a reused socket says line after line: new_turn and flush, each ending at ElevenLabs' end-of-turn message", async () => {
  const sockets = fakeEleven();
  const w = warmSpeech("k", "voice0001", { reuse: true });
  sockets[0].on.open();
  const first = w.say("One.");
  assert.deepEqual(sockets[0].sent, [{ voices: ["voice0001"] }, { inputs: [{ text: "One.", voice_id: "voice0001", new_turn: true }] }, { flush: true }]);
  assert.equal(w.usable, false, "busy while a line is being said");
  sockets[0].on.message(audio([1]));
  const a = await first;
  sockets[0].on.message(JSON.stringify({ is_final_audio_for_turn: true }));
  assert.deepEqual(await read(a), [1]);
  assert.equal(w.usable, true);
  assert.equal(w.endedBy, "turn");
  assert.equal(sockets[0].closed, false, "the socket stays open");

  const second = w.say("Two.");
  assert.deepEqual(sockets[0].sent.slice(3), [{ inputs: [{ text: "Two.", voice_id: "voice0001", new_turn: true }] }, { flush: true }], "the voice isn't sent again");
  sockets[0].on.message(audio([2]));
  sockets[0].on.message(JSON.stringify({ is_final_audio_for_turn: true }));
  assert.deepEqual(await read(await second), [2]);
  assert.equal(sockets.length, 1);
});

test("keep_alive goes only on an open, idle socket", async () => {
  const sockets = fakeEleven();
  const w = warmSpeech("k", "voice0001", { reuse: true });
  w.keepAlive();
  assert.deepEqual(sockets[0].sent, [], "not before it's open");
  sockets[0].on.open();
  w.keepAlive();
  assert.deepEqual(sockets[0].sent[1], { keep_alive: true });
  const p = w.say("Hi");
  w.keepAlive();
  assert.equal(sockets[0].sent.length, 4, "not while a line is being said");
  sockets[0].on.message(audio([1]));
  sockets[0].on.message(JSON.stringify({ is_final_audio_for_turn: true }));
  await p;
  w.close();
  w.keepAlive();
  assert.equal(sockets[0].sent.length, 4);
});

test("on a reused socket a pause in the audio ends the line if no end-of-turn message comes; stopping hangs up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = fakeEleven();
  const w = warmSpeech("k", "voice0001", { reuse: true });
  sockets[0].on.open();
  const p = w.say("Hi");
  sockets[0].on.message(audio([1]));
  const stream = await p;
  t.mock.timers.tick(2499);
  assert.equal(w.usable, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await read(stream), [1]);
  assert.equal(w.endedBy, "gap");
  assert.equal(w.usable, true);

  const abort = new AbortController();
  const q = w.say("Stop me", abort.signal);
  sockets[0].on.message(audio([2]));
  await q;
  abort.abort();
  assert.equal(sockets[0].closed, true, "the socket has no cancel, so stopping closes it");
  assert.equal(w.usable, false);
});
