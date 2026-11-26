/**
 * One Talk session over one WebSocket (GET /api/talk/session, upgraded in
 * ../routes/talk.ts). The app sends small JSON messages; Athena's voice goes
 * back as binary frames of 16-bit PCM between a "start" and an "end".
 *
 *   app → server   { type: "warm" }                       thinking has started: make sure ElevenLabs is open
 *                  { type: "speak", id, text, voice_id? }  say this
 *                  { type: "stop" }                        barge-in: stop the current speech
 *   server → app   { type: "ready", sample_rate }
 *                  { type: "start", id, sample_rate, ms, warm, kept }, binary frames…, { type: "end", id }
 *                  { type: "error", id, error, reason, status }
 *
 * The session keeps one ElevenLabs dialogue socket open across turns: opened
 * with the session, a line per reply (lib/elevenlabs.ts warmSpeech, reuse),
 * `keep_alive` every 15 s while idle (ElevenLabs closes after 20 quiet
 * seconds, Netlify after 60). After 5 idle minutes it is closed and reopened
 * on demand: on "warm", or by the reply itself. A barge-in hangs it up (the
 * socket has no cancel) and opens the next at once.
 *
 * If a line on the kept socket fails before any sound, or only ends because
 * the audio stopped, the session goes back to what POST /api/talk/speak
 * does, a socket per line opened ahead, for the rest of the session. The key
 * stays here.
 */
import { ElevenLabsError, speak as speakOnce, SPEECH_SAMPLE_RATE, warmSpeech, type WarmSpeech } from "../../../lib/elevenlabs";
import { MAX_TEXT, VOICE_ID } from "../../lib/voice/routes";

/** What the session needs from a WebSocket: the server's own, or a stand-in in tests. */
export interface TalkSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close", listener: (event: { data?: unknown }) => void): void;
}

export interface TalkSessionDeps {
  key: string;
  voiceId: string | null;
  /** Counts one spoken reply against the talk limit; false when over it. */
  allow: () => boolean;
  /** ElevenLabs refused the key. */
  refused?: () => unknown;
  open?: typeof warmSpeech;
  /** One line on its own socket: the fallback when the kept socket fails. */
  speakOnce?: typeof speakOnce;
  now?: () => number;
}

/** How often an idle ElevenLabs socket is told to stay open (its inactivity timer is 20 s). */
export const KEEP_ALIVE_MS = 15_000;
/** An ElevenLabs socket nobody has spoken on for this long is closed; the next turn opens another. */
export const IDLE_MAX_MS = 5 * 60_000;

const open = new Set<TalkSocket>();

/** Close every Talk session with 1012 ("service restart"): the app reconnects straight away. Called at shutdown. */
export function closeTalkSessions(): void {
  for (const socket of [...open]) {
    try {
      socket.close(1012, "Server restarting");
    } catch {
      // already closing
    }
  }
}

export function attachTalkSession(socket: TalkSocket, deps: TalkSessionDeps): void {
  const now = deps.now ?? Date.now;
  const openSpeech = deps.open ?? warmSpeech;
  const fallback = deps.speakOnce ?? speakOnce;
  let held: { speech: WarmSpeech; voiceId: string; used: number; beat: ReturnType<typeof setInterval> } | null = null;
  let current: { id: string; abort: AbortController; speech?: WarmSpeech } | null = null;
  /** Set when the kept socket let a reply down: from then on, a socket per line. */
  let perLine = false;
  let closed = false;
  open.add(socket);

  const send = (data: string | Uint8Array) => {
    if (closed) return;
    try {
      socket.send(data);
    } catch {
      // the app has gone; its close event cleans up
    }
  };
  const tell = (message: Record<string, unknown>) => send(JSON.stringify(message));

  function drop() {
    if (!held) return;
    clearInterval(held.beat);
    held.speech.close();
    held = null;
  }

  /** Have a socket to ElevenLabs open for `voiceId` (the session's voice by default), unless one already is. */
  function hold(voiceId = deps.voiceId) {
    if (closed || !voiceId) return;
    if (held && held.voiceId === voiceId && (held.speech.usable || current?.speech === held.speech)) return;
    drop();
    const mine = (held = {
      speech: openSpeech(deps.key, voiceId, { reuse: !perLine }),
      voiceId,
      used: now(),
      beat: setInterval(() => {
        if (held !== mine) return clearInterval(mine.beat);
        if (now() - mine.used >= IDLE_MAX_MS) drop();
        else mine.speech.keepAlive();
      }, KEEP_ALIVE_MS),
    });
    mine.beat.unref?.();
  }

  /** The socket to say the next line on, and whether it was open already. */
  function take(voiceId: string): { speech: WarmSpeech; warm: boolean } {
    const warm = !!held && held.voiceId === voiceId && held.speech.usable;
    hold(voiceId);
    const mine = held!;
    mine.used = now();
    if (perLine) {
      // A per-line socket closes itself after its line; it is no longer the one held.
      clearInterval(mine.beat);
      held = null;
    }
    return { speech: mine.speech, warm };
  }

  function stop() {
    if (!current) return;
    current.abort.abort();
    current = null;
    // Stopping hung up the kept socket; have the next one ready.
    hold();
  }

  async function speak(id: string, text: string, voiceId: string) {
    stop();
    const mine: NonNullable<typeof current> = (current = { id, abort: new AbortController() });
    const live = () => current === mine && !closed;
    const began = now();
    const { speech, warm } = take(voiceId);
    mine.speech = speech;
    const kept = !perLine;
    try {
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await speech.say(text, mine.abort.signal);
      } catch (error) {
        const transient = error instanceof ElevenLabsError && (error.problem === "failed" || error.problem === "busy" || error.problem === "unreachable");
        if (!live() || !kept || !transient) throw error;
        console.warn("Athena voice: the kept ElevenLabs socket failed before any audio; using a socket per line for this session");
        perLine = true;
        drop();
        stream = await fallback(deps.key, voiceId, text, mine.abort.signal);
      }
      if (!live()) return void stream.cancel().catch(() => undefined);
      tell({ type: "start", id, sample_rate: SPEECH_SAMPLE_RATE, ms: now() - began, warm, kept: !perLine });
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (!live()) return void reader.cancel().catch(() => undefined);
        if (done) break;
        if (value?.length) send(value);
      }
      tell({ type: "end", id });
      if (!perLine && speech.endedBy === "gap") {
        // No end-of-turn message came: every reply would wait out the gap. Not worth it.
        console.warn("Athena voice: ElevenLabs sent no end-of-turn message; using a socket per line for this session");
        perLine = true;
        drop();
      }
      if (held?.speech === speech) held.used = now();
      current = null;
      hold();
    } catch (error) {
      if (!live()) return;
      if (!(error instanceof ElevenLabsError)) console.error("Athena voice: a Talk session couldn't speak:", error instanceof Error ? error.message : error);
      const e = error instanceof ElevenLabsError ? error : new ElevenLabsError("failed");
      if (e.problem === "bad_key") void Promise.resolve(deps.refused?.()).catch(() => undefined);
      tell({ type: "error", id, error: e.message, reason: e.problem, status: e.status });
    } finally {
      if (current === mine) current = null;
    }
  }

  socket.addEventListener("message", (event) => {
    if (closed) return;
    // The app sends small JSON text. A binary or oversized frame ends the session, before anything reads it.
    if (typeof event.data !== "string") return socket.close(1003, "Text messages only");
    if (event.data.length > MAX_TEXT * 4) return socket.close(1009, "Message too big");
    let m: { type?: unknown; id?: unknown; text?: unknown; voice_id?: unknown };
    try {
      m = JSON.parse(event.data) as typeof m;
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "stop") return stop();
    if (m.type === "warm") return hold();
    if (m.type !== "speak") return;
    const id = typeof m.id === "string" || typeof m.id === "number" ? String(m.id).slice(0, 40) : "";
    const text = typeof m.text === "string" ? m.text.trim().slice(0, MAX_TEXT) : "";
    if (!id) return;
    if (!text) return tell({ type: "error", id, error: "Missing 'text'", reason: "failed", status: 400 });
    if (!deps.allow()) return tell({ type: "error", id, error: "Too many requests", reason: "busy", status: 429 });
    const voiceId = typeof m.voice_id === "string" && VOICE_ID.test(m.voice_id) ? m.voice_id : deps.voiceId;
    if (!voiceId) return tell({ type: "error", id, error: "Pick a voice for Athena in Settings → Voice first.", reason: "voice", status: 422 });
    void speak(id, text, voiceId);
  });

  socket.addEventListener("close", () => {
    closed = true;
    open.delete(socket);
    current?.abort.abort();
    current = null;
    drop();
  });

  tell({ type: "ready", sample_rate: SPEECH_SAMPLE_RATE });
  hold();
}
