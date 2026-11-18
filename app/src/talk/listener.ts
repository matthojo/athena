/**
 * One listening turn: the microphone's PCM streamed to ElevenLabs' realtime
 * transcription (Scribe v2 Realtime) over a WebSocket the page opens itself,
 * with the single-use token the server minted in the URL. ElevenLabs decides
 * the turn is over when the owner pauses (voice activity detection) and sends
 * the settled text, which is this turn's result. Live partial text arrives
 * as they speak.
 *
 * finishNow() is the owner tapping "done": it asks for the text so far
 * instead of waiting for the pause. Nothing is kept once the turn ends.
 */

import type { Mic } from "./mic";
import { MIC_RATE } from "./mic";

/** Why listening stopped without text, in terms the session can explain. */
export type ListenProblem = "bad_key" | "no_credits" | "busy" | "terms" | "network" | "failed";

export class ListenError extends Error {
  constructor(readonly problem: ListenProblem) {
    super(problem);
  }
}

export interface Listening {
  /** The owner's words for this turn ("" if they said nothing that counted). */
  result: Promise<string>;
  finishNow: () => void;
  cancel: () => void;
}

const ERRORS: Record<string, ListenProblem> = {
  auth_error: "bad_key",
  quota_exceeded: "no_credits",
  rate_limited: "busy",
  queue_overflow: "busy",
  resource_exhausted: "busy",
  commit_throttled: "busy",
  unaccepted_terms: "terms",
  session_time_limit_exceeded: "failed",
  insufficient_audio_activity: "failed",
};

function base64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** How long to wait for the settled text after "done" before using what was heard so far. */
const FINISH_GRACE_MS = 2500;

export function startListening(opts: { url: string; mic: Mic; onPartial: (text: string) => void }): Listening {
  let socket: WebSocket | null = null;
  let open = false;
  let settled = false;
  let partial = "";
  const queue: Int16Array[] = [];
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (text: string) => void;
  let reject!: (error: ListenError) => void;
  const result = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const send = (pcm: Int16Array, commit = false) => {
    socket?.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64(pcm), commit, sample_rate: MIC_RATE }));
  };

  function end(outcome: { text: string } | { error: ListenError }) {
    if (settled) return;
    settled = true;
    clearTimeout(finishTimer);
    opts.mic.onChunk(() => undefined);
    try {
      socket?.close();
    } catch {
      // already closing
    }
    if ("text" in outcome) resolve(outcome.text);
    else reject(outcome.error);
  }

  opts.mic.onChunk((pcm) => {
    if (settled) return;
    if (open) send(pcm);
    // Audio from before the socket opened (the first second or so) is kept and sent in order.
    else if (queue.length < 100) queue.push(pcm);
  });

  try {
    socket = new WebSocket(opts.url);
  } catch {
    end({ error: new ListenError("network") });
    return { result, finishNow: () => undefined, cancel: () => undefined };
  }

  socket.onopen = () => {
    open = true;
    for (const pcm of queue.splice(0)) send(pcm);
  };
  socket.onmessage = (e) => {
    let m: { message_type?: string; text?: string; error?: string };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const type = m.message_type ?? "";
    if (type === "partial_transcript") {
      partial = (m.text ?? "").trim();
      if (partial && !settled) opts.onPartial(partial);
    } else if (type === "committed_transcript") {
      const text = (m.text ?? "").trim();
      // An empty commit is a cough or a door: keep listening (unless "done" was tapped).
      if (text) end({ text });
      else if (finishTimer) end({ text: partial });
    } else if (type in ERRORS || type.endsWith("error")) {
      end({ error: new ListenError(ERRORS[type] ?? "failed") });
    }
  };
  // A dropped connection mid-sentence is a failure, never "done": acting on half an
  // instruction ("archive the reminders about the…") is worse than asking again.
  // Only once the owner has said they're done does what was heard count.
  const dropped = () => end(finishTimer ? { text: partial } : { error: new ListenError("network") });
  socket.onerror = dropped;
  socket.onclose = dropped;

  return {
    result,
    finishNow() {
      if (settled || finishTimer) return;
      if (!open) {
        end({ text: partial });
        return;
      }
      // Commit now with a breath of silence, and give the settled text a moment to come back.
      send(new Int16Array(MIC_RATE / 10), true);
      finishTimer = setTimeout(() => end({ text: partial }), FINISH_GRACE_MS);
    },
    cancel() {
      end({ text: "" });
    },
  };
}
