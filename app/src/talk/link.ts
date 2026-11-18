/**
 * The app's end of the Talk session socket (netlify/server/talk/session.ts):
 * one WebSocket for a whole Talk session, opened with a single-use ticket
 * (a WebSocket can't carry the bearer token). Athena's voice arrives on it as
 * binary PCM frames, a barge-in is a "stop" message, and warm() tells the
 * server thinking has started, so its ElevenLabs socket is open in time.
 *
 * It is an accelerator, never a requirement: speak() rejects with LinkDown
 * whenever the socket isn't open (or goes before the first sound) and the
 * session falls back to POST /api/talk/speak for that reply. A socket the
 * server closes with 1012 (it's restarting) is reopened straight away, any
 * other after a second; three failed connections in a row and it stops trying.
 */
import { talkTicket, VoiceApiError, type VoiceProblem } from "../db/voice-api";

/** The socket can't take this reply; use /api/talk/speak. */
export class LinkDown extends Error {}

export interface Spoken {
  body: ReadableStream<Uint8Array>;
  sampleRate: number;
}

export interface TalkLink {
  warm(): void;
  speak(text: string, signal?: AbortSignal): Promise<Spoken>;
  close(): void;
}

/** The server gives up on ElevenLabs' first audio at 12 s; a little longer than that and the socket is treated as stuck. */
const START_TIMEOUT_MS = 14_000;
const MAX_FAILURES = 3;

interface Turn {
  id: string;
  started: boolean;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  resolve: (s: Spoken) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  body: ReadableStream<Uint8Array>;
}

export function openTalkLink(): TalkLink {
  let ws: WebSocket | null = null;
  let connecting = false;
  let ended = false;
  let failures = 0;
  let seq = 0;
  let turn: Turn | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const say = (message: Record<string, unknown>) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  /** The reply in progress is over: reject it if nothing has played, else end its audio where it is. */
  function settle(error?: unknown) {
    const t = turn;
    if (!t) return;
    turn = null;
    clearTimeout(t.timer);
    if (!t.started) return t.reject(error ?? new LinkDown());
    try {
      t.controller?.close();
    } catch {
      // the player already cancelled it
    }
  }

  async function connect() {
    if (ended || connecting || ws || failures >= MAX_FAILURES) return;
    connecting = true;
    let sock: WebSocket;
    try {
      const ticket = await talkTicket();
      if (ended) return;
      sock = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/talk/session?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      connecting = false;
      failures++;
      return;
    }
    sock.binaryType = "arraybuffer";
    let ready = false;
    sock.onmessage = (event) => {
      if (typeof event.data !== "string") {
        if (ws === sock && turn?.started) {
          try {
            turn.controller?.enqueue(new Uint8Array(event.data as ArrayBuffer));
          } catch {
            // cancelled
          }
        }
        return;
      }
      let m: { type?: string; id?: string; sample_rate?: number; error?: string; reason?: VoiceProblem; status?: number };
      try {
        m = JSON.parse(event.data) as typeof m;
      } catch {
        return;
      }
      if (m.type === "ready") {
        if (ended) return sock.close();
        ready = true;
        connecting = false;
        failures = 0;
        ws = sock;
        return;
      }
      // Anything about a reply that was stopped or replaced is old news.
      if (!turn || m.id !== turn.id) return;
      if (m.type === "start") {
        turn.started = true;
        clearTimeout(turn.timer);
        turn.resolve({ body: turn.body, sampleRate: m.sample_rate || 24_000 });
      } else if (m.type === "end") settle();
      else if (m.type === "error") settle(new VoiceApiError(m.error || "ElevenLabs couldn't do that right now. Try again in a moment.", m.status ?? 502, m.reason ?? "failed"));
    };
    sock.onclose = (event) => {
      if (!ready) {
        connecting = false;
        failures++;
      }
      if (ws === sock) {
        ws = null;
        settle();
      }
      if (ended) return;
      clearTimeout(retry);
      retry = setTimeout(() => void connect(), event.code === 1012 ? 0 : 1000);
    };
  }

  void connect();

  return {
    warm() {
      if (ws) say({ type: "warm" });
      else void connect();
    },
    speak(text, signal) {
      if (ws?.readyState !== WebSocket.OPEN || signal?.aborted) {
        void connect();
        return Promise.reject(new LinkDown());
      }
      settle();
      const id = String(++seq);
      const stop = () => {
        if (turn?.id !== id) return;
        say({ type: "stop" });
        settle(new DOMException("Stopped", "AbortError"));
      };
      return new Promise<Spoken>((resolve, reject) => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
          cancel: stop,
        });
        const timer = setTimeout(() => {
          if (turn?.id !== id) return;
          say({ type: "stop" });
          settle();
        }, START_TIMEOUT_MS);
        turn = { id, started: false, controller, resolve, reject, timer, body };
        signal?.addEventListener("abort", stop, { once: true });
        say({ type: "speak", id, text });
      });
    },
    close() {
      ended = true;
      clearTimeout(retry);
      settle();
      ws?.close(1000);
      ws = null;
    },
  };
}
