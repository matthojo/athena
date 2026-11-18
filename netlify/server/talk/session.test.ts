import { test } from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsError, type WarmSpeech } from "../../../lib/elevenlabs";
import { attachTalkSession, closeTalkSessions, IDLE_MAX_MS, KEEP_ALIVE_MS, type TalkSessionDeps, type TalkSocket } from "./session";
import { issueTicket, redeemTicket, TICKET_TTL_MS } from "./ticket";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The app's side of the socket: what the server sent, and a way to send to it. */
function fakeSocket() {
  const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = { message: [], close: [] };
  const sent: Array<string | Uint8Array> = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket: TalkSocket = {
    send: (d) => void sent.push(d),
    close: (code, reason) => {
      closes.push([code, reason]);
      listeners.close.forEach((l) => l({}));
    },
    addEventListener: (type, l) => void listeners[type].push(l),
  };
  return {
    socket,
    sent,
    closes,
    say: (m: unknown) => listeners.message.forEach((l) => l({ data: typeof m === "string" ? m : JSON.stringify(m) })),
    json: () => sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>),
    audio: () => sent.filter((s): s is Uint8Array => typeof s !== "string"),
  };
}

/** A stand-in for ElevenLabs: each opened socket records what it's asked and plays what the test feeds it. */
function fakeSpeech() {
  type Rec = { voiceId: string; reuse: boolean; texts: string[]; closed: boolean; dead: boolean; aborted: boolean; beats: number; push: (b: number[]) => void; end: (by?: "turn" | "gap") => void; fail: (e: ElevenLabsError) => void };
  const opened: Rec[] = [];
  const open: NonNullable<TalkSessionDeps["open"]> = (_key, voiceId, opts) => {
    let turn: { controller: ReadableStreamDefaultController<Uint8Array>; stream: ReadableStream<Uint8Array>; resolve: (s: ReadableStream<Uint8Array>) => void; reject: (e: unknown) => void; started: boolean } | null = null;
    let endedBy: "turn" | "gap" | null = null;
    const rec: Rec = {
      voiceId,
      reuse: !!opts?.reuse,
      texts: [],
      closed: false,
      dead: false,
      aborted: false,
      beats: 0,
      push(b) {
        turn!.controller.enqueue(new Uint8Array(b));
        if (!turn!.started) turn!.resolve(turn!.stream);
        turn!.started = true;
      },
      end(by = "turn") {
        endedBy = by;
        turn?.controller.close();
        turn = null;
        if (!rec.reuse) rec.dead = true;
      },
      fail(e) {
        rec.dead = true;
        turn?.reject(e);
        turn = null;
      },
    };
    opened.push(rec);
    const speech: WarmSpeech = {
      get usable() {
        return !rec.dead && !rec.closed && !turn;
      },
      get endedBy() {
        return endedBy;
      },
      say(text, signal) {
        rec.texts.push(text);
        signal?.addEventListener("abort", () => {
          rec.aborted = true;
          rec.dead = true;
        });
        return new Promise((resolve, reject) => {
          let controller!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
          turn = { controller, stream, resolve, reject, started: false };
        });
      },
      keepAlive: () => void rec.beats++,
      close: () => void (rec.closed = true),
    };
    return speech;
  };
  return { opened, open };
}

function session(over: Partial<TalkSessionDeps> = {}) {
  const s = fakeSocket();
  const el = fakeSpeech();
  attachTalkSession(s.socket, { key: "k", voiceId: "voice0001", allow: () => true, open: el.open, ...over });
  return { ...s, el };
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};

test("a ticket works once, from the IP it was issued to, for 30 seconds", () => {
  const t = 5_000_000;
  const a = issueTicket("1.1.1.1", t);
  assert.equal(redeemTicket(a, "1.1.1.1", t + 1000), true);
  assert.equal(redeemTicket(a, "1.1.1.1", t + 1001), false, "single use");
  assert.equal(redeemTicket(issueTicket("1.1.1.1", t), "2.2.2.2", t), false, "another IP");
  assert.equal(redeemTicket(issueTicket("1.1.1.1", t), "1.1.1.1", t + TICKET_TTL_MS), false, "expired");
  const b = issueTicket("1.1.1.1", t);
  assert.equal(redeemTicket(b, "2.2.2.2", t), false);
  assert.equal(redeemTicket(b, "1.1.1.1", t), false, "a wrong attempt spends it");
  assert.equal(redeemTicket(null, "1.1.1.1", t), false);
  assert.equal(redeemTicket("made-up", "1.1.1.1", t), false);
  assert.notEqual(issueTicket("1.1.1.1", t), issueTicket("1.1.1.1", t));
});

test("the session opens ElevenLabs once and says reply after reply on that one socket", async () => {
  const s = session();
  assert.deepEqual(s.json(), [{ type: "ready", sample_rate: 24_000 }]);
  assert.equal(s.el.opened.length, 1, "opened with the session, before there are words");
  assert.equal(s.el.opened[0].reuse, true);
  s.say({ type: "warm" });
  s.say({ type: "speak", id: 1, text: " Hello there. " });
  s.el.opened[0].push([1, 2]);
  s.el.opened[0].push([3, 4]);
  s.el.opened[0].end();
  await settle();
  const [, start, end] = s.json();
  assert.deepEqual([start.type, start.id, start.warm, start.kept], ["start", "1", true, true]);
  assert.deepEqual(end, { type: "end", id: "1" });
  assert.deepEqual(s.audio().map((a) => [...a]), [[1, 2], [3, 4]]);
  assert.equal(typeof s.sent[2], "object", "audio goes between start and end");

  s.say({ type: "warm" });
  s.say({ type: "speak", id: 2, text: "And again." });
  s.el.opened[0].push([5]);
  s.el.opened[0].end();
  await settle();
  assert.equal(s.el.opened.length, 1, "no second socket");
  assert.deepEqual(s.el.opened[0].texts, ["Hello there.", "And again."]);
  assert.deepEqual(s.json().slice(3).map((m) => [m.type, m.id]), [["start", "2"], ["end", "2"]]);
});

test("an idle socket is kept alive every 15 s, closed after 5 idle minutes, and reopened on demand", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  const s = session({ now: () => now });
  const step = (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  step(KEEP_ALIVE_MS);
  step(KEEP_ALIVE_MS);
  assert.equal(s.el.opened[0].beats, 2);
  for (let i = 0; i < 18; i++) step(KEEP_ALIVE_MS);
  assert.equal(now, IDLE_MAX_MS);
  assert.equal(s.el.opened[0].closed, true, "closed once nobody has spoken for 5 minutes");
  const beats = s.el.opened[0].beats;
  step(KEEP_ALIVE_MS * 4);
  assert.equal(s.el.opened[0].beats, beats, "and nothing is sent or reopened while Talk sits idle");
  assert.equal(s.el.opened.length, 1);
  s.say({ type: "warm" });
  assert.equal(s.el.opened.length, 2, "warm reopens it");
  s.say({ type: "speak", id: 1, text: "Back" });
  assert.deepEqual(s.el.opened[1].texts, ["Back"]);
  s.el.opened[1].push([1]);
  await settle();
  assert.equal(s.json()[1].warm, true);

  const cold = session({ now: () => now });
  cold.el.opened[0].dead = true; // ElevenLabs closed it
  cold.say({ type: "speak", id: 1, text: "Cold" });
  assert.equal(cold.el.opened.length, 2, "a reply with no socket waiting opens its own");
  cold.el.opened[1].push([1]);
  await settle();
  assert.equal(cold.json()[1].warm, false);
});

test("a reply in another voice gets a socket for that voice", () => {
  const s = session();
  s.say({ type: "speak", id: 3, text: "Other", voice_id: "voice0002" });
  assert.equal(s.el.opened[0].closed, true);
  assert.equal(s.el.opened[1].voiceId, "voice0002");
  assert.deepEqual(s.el.opened[1].texts, ["Other"]);
});

test("stop is barge-in: ElevenLabs is hung up, nothing more is sent for that reply, and a new socket is ready", async () => {
  const s = session();
  s.say({ type: "speak", id: 1, text: "A long reply" });
  s.el.opened[0].push([1]);
  await settle();
  s.say({ type: "stop" });
  assert.equal(s.el.opened[0].aborted, true);
  assert.equal(s.el.opened.length, 2, "the next socket is opened at once");
  s.el.opened[0].push([2]);
  await settle();
  assert.deepEqual(s.json().map((m) => m.type), ["ready", "start"]);
  assert.equal(s.audio().length, 1);
  s.say({ type: "speak", id: 2, text: "Next" });
  assert.deepEqual(s.el.opened[1].texts, ["Next"]);
  assert.equal(s.el.opened.length, 2);
});

test("a new reply replaces the one in progress", async () => {
  const s = session();
  s.say({ type: "speak", id: 1, text: "First" });
  s.el.opened[0].push([1]);
  await settle();
  s.say({ type: "speak", id: 2, text: "Second" });
  assert.equal(s.el.opened[0].aborted, true);
  s.el.opened[1].push([7]);
  s.el.opened[1].end();
  await settle();
  assert.deepEqual(s.json().slice(1).map((m) => [m.type, m.id]), [["start", "1"], ["start", "2"], ["end", "2"]]);
});

test("if the kept socket fails before any sound, the reply is said the old way and the session stays on a socket per line", async () => {
  const once: string[] = [];
  const s = session({
    speakOnce: async (_k, _v, text) => {
      once.push(text);
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([4]));
          c.close();
        },
      });
    },
  });
  s.say({ type: "speak", id: 1, text: "Hi" });
  s.el.opened[0].fail(new ElevenLabsError("failed"));
  await settle();
  assert.deepEqual(once, ["Hi"]);
  assert.deepEqual(s.json().slice(1).map((m) => [m.type, m.id, m.kept]), [["start", "1", false], ["end", "1", undefined]]);
  assert.deepEqual(s.audio().map((a) => [...a]), [[4]]);
  assert.equal(s.el.opened.length, 2, "a socket is opened ahead for the next line");
  assert.equal(s.el.opened[1].reuse, false);
  s.say({ type: "speak", id: 2, text: "Two" });
  s.el.opened[1].push([5]);
  s.el.opened[1].end();
  await settle();
  assert.equal(s.el.opened.length, 3, "and another after it, one line each");
  assert.equal(s.el.opened[2].reuse, false);
});

test("a reply that only ended because the audio stopped moves the session to a socket per line", async () => {
  const s = session();
  s.say({ type: "speak", id: 1, text: "Hi" });
  s.el.opened[0].push([1]);
  s.el.opened[0].end("gap");
  await settle();
  assert.equal(s.json()[2].type, "end");
  assert.equal(s.el.opened[0].closed, true);
  assert.equal(s.el.opened[1].reuse, false);
});

test("ElevenLabs' refusal reaches the app in its own words, a refused key is noted, and it isn't retried", async () => {
  let refused = 0;
  let retried = 0;
  const s = session({ refused: () => refused++, speakOnce: async () => (retried++, new ReadableStream<Uint8Array>()) });
  s.say({ type: "speak", id: 1, text: "Hi" });
  s.el.opened[0].fail(new ElevenLabsError("bad_key"));
  await settle();
  const err = s.json()[1];
  assert.deepEqual([err.type, err.reason, err.status], ["error", "bad_key", 424]);
  assert.equal(refused, 1);
  assert.equal(retried, 0);
});

test("each reply counts against the talk limit; no voice, no text and nonsense are refused without calling ElevenLabs", () => {
  let left = 1;
  const s = session({ allow: () => left-- > 0 });
  s.say({ type: "speak", id: 1, text: "ok" });
  s.say({ type: "speak", id: 2, text: "over" });
  assert.deepEqual(s.el.opened[0].texts, ["ok"]);
  assert.deepEqual(s.json()[1], { type: "error", id: "2", error: "Too many requests", reason: "busy", status: 429 });

  const none = session({ voiceId: null });
  none.say({ type: "warm" });
  none.say({ type: "speak", id: 1, text: "hi" });
  none.say({ type: "speak", id: 2, text: "   " });
  none.say("not json");
  none.say({ type: "speak", text: "no id" });
  none.say({ type: "launch" });
  assert.equal(none.el.opened.length, 0);
  assert.deepEqual(none.json().slice(1).map((m) => [m.id, m.reason, m.status]), [["1", "voice", 422], ["2", "failed", 400]]);
});

test("closing the socket hangs up ElevenLabs, and shutdown closes every session with 1012", async () => {
  const a = session();
  const b = session();
  b.say({ type: "speak", id: 1, text: "Mid-sentence" });
  b.el.opened[0].push([1]);
  await settle();
  closeTalkSessions();
  assert.deepEqual(a.closes, [[1012, "Server restarting"]]);
  assert.deepEqual(b.closes, [[1012, "Server restarting"]]);
  assert.equal(a.el.opened[0].closed, true, "the socket that was waiting is closed");
  assert.equal(b.el.opened[0].aborted, true, "the speech in progress is stopped");
  assert.equal(b.el.opened.length, 1, "and nothing is reopened for a session that's gone");
  const sentBefore = b.sent.length;
  b.el.opened[0].push([2]);
  await settle();
  assert.equal(b.sent.length, sentBefore);
  closeTalkSessions();
  assert.equal(a.closes.length, 1, "a closed session isn't closed twice");
});
