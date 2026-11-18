/**
 * ElevenLabs, with the owner's own API key: the voice Athena talks in, and
 * the ears for Talk and dictation. This is the only file that knows
 * ElevenLabs' URLs, models and wire formats.
 *
 * - Speaking: Eleven v4 Turbo (`eleven_v4_turbo`), ElevenLabs' low-latency
 *   v4 model. It's only offered on the Text to Dialogue WebSocket, which a
 *   Netlify Function can open as a client but a browser can't be given the
 *   key for, so speak() runs here and the app receives the audio as a
 *   streamed HTTP response (raw 16-bit PCM at 24 kHz).
 * - Listening in Talk: Scribe v2 Realtime over a WebSocket the app opens
 *   itself, authorised by a single-use token minted here (15 minutes, one
 *   connection). The key never leaves the server.
 * - Dictation: Scribe v2 (batch), called from here with the recording.
 *
 * Every call takes the key as an argument; storing it is lib/voice-settings.ts.
 * Nothing here logs a key, a token, audio or text: failures log the status only.
 */

import WebSocket from "ws";

export const ELEVEN_API = "https://api.elevenlabs.io";
export const ELEVEN_WSS = "wss://api.elevenlabs.io";

/** The model Athena speaks with (models page, November 2026: "~100ms", built for conversation). */
export const SPEECH_MODEL = "eleven_v4_turbo";
export const LISTEN_MODEL = "scribe_v2_realtime";
export const DICTATION_MODEL = "scribe_v2";
/** The plain names the app shows in the connection's details. */
export const MODEL_LABELS = { speech: "Eleven v4 Turbo", listening: "Scribe v2 Realtime" } as const;

/** Speech comes back as 16-bit little-endian mono PCM at this rate (`pcm_24000`). */
export const SPEECH_SAMPLE_RATE = 24_000;
/** The app streams the microphone at this rate (`pcm_16000`, ElevenLabs' recommended input). */
export const LISTEN_SAMPLE_RATE = 16_000;
/** A pause this long ends a turn in Talk. Long enough for a breath mid-sentence. */
export const TURN_SILENCE_SECS = 1.2;
/** About a minute of speech; replies are one or two sentences, so this only stops a runaway. */
export const MAX_SPEECH_CHARS = 900;

const TIMEOUT_MS = 15_000;
const FIRST_AUDIO_MS = 12_000;
const SPEECH_TOTAL_MS = 45_000;

/** What went wrong, in terms the app can explain. */
export type ElevenProblem = "bad_key" | "not_allowed" | "no_credits" | "busy" | "voice" | "unreachable" | "failed";

const MESSAGES: Record<ElevenProblem, string> = {
  bad_key: "ElevenLabs didn't accept the API key. Replace it in Settings → Voice.",
  not_allowed: "Your ElevenLabs key isn't allowed to do this. In ElevenLabs, give the key access to Text to Speech, Speech to Text and Voices, or make one without restrictions.",
  no_credits: "Your ElevenLabs account has run out of credits for this month.",
  busy: "ElevenLabs is busy right now. Try again in a moment.",
  voice: "That voice can't be used with Eleven v4 Turbo. Pick another voice in Settings → Voice.",
  unreachable: "Couldn't reach ElevenLabs. Check your connection and try again.",
  failed: "ElevenLabs couldn't do that right now. Try again in a moment.",
};

/** The HTTP status Athena's API answers with for each problem (never 401: the app reads that as its own sign-in). */
const STATUS: Record<ElevenProblem, number> = {
  bad_key: 424,
  not_allowed: 424,
  no_credits: 402,
  busy: 429,
  voice: 422,
  unreachable: 504,
  failed: 502,
};

export class ElevenLabsError extends Error {
  readonly status: number;
  constructor(
    readonly problem: ElevenProblem,
    message = MESSAGES[problem],
  ) {
    super(message);
    this.name = "ElevenLabsError";
    this.status = STATUS[problem];
  }
}

/**
 * ElevenLabs' error body is `{ detail: { type, code, message, status } }`
 * (`status` is the legacy name for `code`); older endpoints answer 401 for
 * an exhausted quota or a key without the right permission.
 */
export function classify(status: number, body: unknown): ElevenProblem {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const d = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  const code = String(d.code ?? d.status ?? "").toLowerCase();
  if (code.includes("quota") || code.includes("credit") || status === 402) return "no_credits";
  if (code.includes("voice")) return "voice";
  if (code.includes("permission") || code === "forbidden" || code.includes("not_available") || code.includes("subscription_required") || code.includes("access_denied")) return "not_allowed";
  if (status === 401) return "bad_key";
  if (status === 403) return "not_allowed";
  if (status === 429 || status === 503) return "busy";
  return "failed";
}

async function call(path: string, key: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("xi-api-key", key);
  let res: Response;
  try {
    res = await fetch(`${ELEVEN_API}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ElevenLabsError("unreachable");
  }
  if (res.ok) return res;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const problem = classify(res.status, body);
  // The path and status only: the body can echo what was sent.
  console.error(`Athena voice: ElevenLabs ${path.split("?")[0]} answered ${res.status} (${problem})`);
  throw new ElevenLabsError(problem);
}

// ---------- the account ----------

export interface ElevenUsage {
  tier: string;
  /** Credits used and allowed this period (ElevenLabs counts a character of speech as a credit). */
  used: number;
  limit: number;
  resets_at: string | null;
}

/** The account's plan and how much of it is used, or null when the key can't read it (a restricted key). */
export async function fetchUsage(key: string): Promise<ElevenUsage | null> {
  try {
    const res = await call("/v1/user/subscription", key);
    const s = (await res.json()) as { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number | null };
    return {
      tier: String(s.tier ?? ""),
      used: Number(s.character_count ?? 0),
      limit: Number(s.character_limit ?? 0),
      resets_at: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
    };
  } catch (error) {
    if (error instanceof ElevenLabsError && error.problem === "not_allowed") return null;
    throw error;
  }
}

export interface ElevenVoice {
  id: string;
  name: string;
  /** "premade" voices are ElevenLabs'; the rest are the owner's (cloned, designed, saved from the library). */
  category: string;
  mine: boolean;
  /** A few words from its labels: "British · Warm · Narration". */
  traits: string;
  /** ElevenLabs' own short sample, played from their CDN. */
  preview_url: string | null;
}

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();

export function toVoice(v: { voice_id?: string; name?: string; category?: string; labels?: Record<string, string> | null; preview_url?: string | null }): ElevenVoice | null {
  if (!v.voice_id || !/^[A-Za-z0-9]{8,64}$/.test(v.voice_id)) return null;
  const l = v.labels ?? {};
  const traits = [l.accent, l.descriptive ?? l.description, l.use_case ?? l.use_case_label]
    .filter((x): x is string => typeof x === "string" && !!x.trim())
    .map(titleCase)
    .slice(0, 3)
    .join(" · ");
  const preview = typeof v.preview_url === "string" && /^https:\/\//.test(v.preview_url) ? v.preview_url : null;
  const category = v.category ?? "premade";
  return { id: v.voice_id, name: (v.name ?? "Unnamed voice").trim().slice(0, 80), category, mine: category !== "premade", traits, preview_url: preview };
}

/** The voices this account can use: its own first, then ElevenLabs' own, each by name. */
export async function listVoices(key: string): Promise<ElevenVoice[]> {
  const voices: ElevenVoice[] = [];
  let next: string | null = null;
  // Two pages of 100 is far more than one person has; it stops a loop, nothing more.
  for (let page = 0; page < 2; page++) {
    const qs = new URLSearchParams({ page_size: "100", include_total_count: "false" });
    if (next) qs.set("next_page_token", next);
    const res = await call(`/v2/voices?${qs}`, key);
    const json = (await res.json()) as { voices?: unknown[]; has_more?: boolean; next_page_token?: string | null };
    for (const v of json.voices ?? []) {
      const voice = toVoice(v as Parameters<typeof toVoice>[0]);
      if (voice && !voices.some((x) => x.id === voice.id)) voices.push(voice);
    }
    next = json.has_more ? (json.next_page_token ?? null) : null;
    if (!next) break;
  }
  return voices.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
}

/** A calm default for a new connection: one of ElevenLabs' British voices if the account has them, else the first. */
export function defaultVoice(voices: ElevenVoice[]): ElevenVoice | null {
  for (const name of ["Alice", "George", "Lily", "Sarah"]) {
    const v = voices.find((x) => !x.mine && x.name.split(/\s|-/)[0].toLowerCase() === name.toLowerCase());
    if (v) return v;
  }
  return voices.find((x) => !x.mine) ?? voices[0] ?? null;
}

// ---------- listening (Talk) ----------

export type TokenType = "realtime_scribe" | "tts_websocket";

/** A single-use token: good for one connection, for 15 minutes. Minting one is free. */
export async function singleUseToken(key: string, type: TokenType): Promise<string> {
  const res = await call(`/v1/single-use-token/${type}`, key, { method: "POST" });
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new ElevenLabsError("failed");
  return token;
}

/**
 * Where the app streams the microphone during Talk: Scribe v2 Realtime with
 * the token, 16 kHz PCM in, and voice activity detection to end a turn when
 * the owner stops speaking. Background chatter is filtered out; fillers
 * ("um", false starts) are left out of the text the assistant reads.
 */
export function listenUrl(token: string): string {
  const qs = new URLSearchParams({
    model_id: LISTEN_MODEL,
    token,
    audio_format: `pcm_${LISTEN_SAMPLE_RATE}`,
    commit_strategy: "vad",
    vad_silence_threshold_secs: String(TURN_SILENCE_SECS),
    min_speech_duration_ms: "120",
    min_silence_duration_ms: "120",
    filter_background_audio: "true",
    no_verbatim: "true",
  });
  return `${ELEVEN_WSS}/v1/speech-to-text/realtime?${qs}`;
}

// ---------- dictation ----------

/** Transcribe one recording with Scribe v2. Resolves to "" when there was no speech. */
export async function transcribeRecording(key: string, audio: ArrayBuffer, mimeType: string): Promise<string> {
  const form = new FormData();
  form.set("model_id", DICTATION_MODEL);
  form.set("tag_audio_events", "false");
  const ext = mimeType.split("/")[1]?.replace(/^x-/, "") || "webm";
  form.set("file", new Blob([audio], { type: mimeType }), `recording.${ext}`);
  // Short enough that the Gemini fallback still fits inside the function's time limit.
  const res = await call("/v1/speech-to-text", key, { method: "POST", body: form }, 20_000);
  const json = (await res.json()) as { text?: string; transcripts?: Array<{ text?: string }> };
  const text = json.text ?? (json.transcripts ?? []).map((t) => t.text ?? "").join(" ");
  return text.replace(/\s+/g, " ").trim();
}

// ---------- speaking ----------

/**
 * Text as it should be spoken: markdown links as their label, no square
 * brackets (Eleven v4 reads "[whispering]" as a direction, not words), no
 * control characters, and no more than MAX_SPEECH_CHARS, cut at a sentence.
 */
export function speakableText(text: string): string {
  let t = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[[\]{}<>]/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > MAX_SPEECH_CHARS) {
    const cut = t.slice(0, MAX_SPEECH_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
  }
  return t;
}

/** The few socket operations speak() needs, so tests can stand in for ElevenLabs. */
export interface SpeechSocket {
  send(text: string): void;
  close(): void;
}

export interface SpeechSocketEvents {
  open(): void;
  message(text: string): void;
  /** The connection failed; `status` when the server refused the upgrade with an HTTP status. */
  error(status?: number): void;
  close(): void;
}

export type OpenSpeechSocket = (url: string, headers: Record<string, string>, on: SpeechSocketEvents) => SpeechSocket;

/** The real socket (the `ws` package, so the key can ride in the handshake header). */
export const wsSpeechSocket: OpenSpeechSocket = (url, headers, on) => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: TIMEOUT_MS });
  let failed = false;
  ws.on("open", () => on.open());
  ws.on("message", (data) => on.message(data.toString()));
  ws.on("unexpected-response", (_req, res) => {
    failed = true;
    on.error(res.statusCode);
    res.resume();
    ws.terminate();
  });
  ws.on("error", () => {
    if (failed) return;
    failed = true;
    on.error();
  });
  ws.on("close", () => on.close());
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
};

let openSocket: OpenSpeechSocket = wsSpeechSocket;

/** Tests swap in a fake ElevenLabs; null restores the real one. */
export function useSpeechSocket(open: OpenSpeechSocket | null): void {
  openSocket = open ?? wsSpeechSocket;
}

/** What the dialogue socket sends: audio chunks, the end, or an error. */
interface DialogueMessage {
  audio?: string | null;
  is_final?: boolean;
  isFinal?: boolean;
  is_final_audio_for_turn?: boolean;
  error?: string;
  message?: string;
  code?: number;
}

function socketProblem(m: DialogueMessage): ElevenProblem {
  const e = `${m.error ?? ""} ${m.message ?? ""}`.toLowerCase();
  if (/quota|credit/.test(e)) return "no_credits";
  if (/voice/.test(e)) return "voice";
  if (/permission|not allowed|forbidden/.test(e)) return "not_allowed";
  if (/auth|api key|api_key|unauthori[sz]ed|token/.test(e)) return "bad_key";
  if (/rate|busy|concurren|capacity/.test(e)) return "busy";
  return "failed";
}

/** A dialogue socket opened ahead of the words, so the handshake isn't part of the wait for the first sound. */
export interface WarmSpeech {
  /** True while it can take a line: open or opening, not failed or closed, and not in the middle of one. */
  readonly usable: boolean;
  /** How the last line on a reused socket ended: ElevenLabs' end-of-turn message, or a pause in the audio. */
  readonly endedBy: "turn" | "gap" | null;
  /** Speak one line on it. Resolves like speak(). */
  say(text: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** Reset ElevenLabs' 20 s inactivity timer on an idle socket. Spends nothing. */
  keepAlive(): void;
  /** Hang up (unused, or mid-speech). */
  close(): void;
}

/** On a reused socket, audio stopping this long ends the line if ElevenLabs' end-of-turn message hasn't. */
const TURN_GAP_MS = 2500;

/**
 * Open the dialogue socket and register the voice now; say() sends a line
 * later. Nothing is spent until a line is sent.
 *
 * With `reuse` the socket stays open for line after line (a Talk session):
 * each line goes as `inputs` with `new_turn`, then `flush`, and ends at
 * `is_final_audio_for_turn`; `keep_alive` holds an idle one open. Stopping a
 * line means hanging up: the socket has no cancel. Without `reuse` it says
 * one line and asks ElevenLabs to close (`close_socket`), the sequence
 * speak() has always used. (Message names: ElevenLabs' SDK types,
 * TextToDialogueWebsocketClientMessage, @elevenlabs/elevenlabs-js 2.77.)
 */
export function warmSpeech(key: string, voiceId: string, opts: { reuse?: boolean } = {}): WarmSpeech {
  const reuse = !!opts.reuse;
  const qs = new URLSearchParams({ model_id: SPEECH_MODEL, output_format: `pcm_${SPEECH_SAMPLE_RATE}` });
  let finished = false;
  let opened = false;
  let greeted = false;
  let failure: ElevenLabsError | null = null;
  let endedBy: "turn" | "gap" | null = null;
  /** Set once openSocket returns; a stand-in can report events before that. */
  let socket: SpeechSocket | null = null;
  /** The line being said. */
  let turn: {
    line: string;
    sent: boolean;
    started: boolean;
    controller: ReadableStreamDefaultController<Uint8Array> | null;
    stream: ReadableStream<Uint8Array>;
    resolve: (s: ReadableStream<Uint8Array>) => void;
    reject: (e: ElevenLabsError) => void;
    signal?: AbortSignal;
    timers: ReturnType<typeof setTimeout>[];
    gap?: ReturnType<typeof setTimeout>;
  } | null = null;

  /** The line is over: its audio stream closes (or, with nothing played, its promise rejects). */
  function endTurn(error?: ElevenLabsError) {
    const t = turn;
    if (!t) return;
    turn = null;
    t.timers.forEach(clearTimeout);
    clearTimeout(t.gap);
    t.signal?.removeEventListener("abort", onAbort);
    if (!t.started) return t.reject(error ?? new ElevenLabsError("failed"));
    try {
      // Mid-speech, a failure just ends the audio early: the app plays what arrived.
      if (error) console.error(`Athena voice: speech ended early (${error.problem})`);
      t.controller?.close();
    } catch {
      // already closed (the app hung up)
    }
  }

  function finish(error?: ElevenLabsError) {
    if (finished) return;
    finished = true;
    failure = error ?? new ElevenLabsError("failed");
    socket?.close();
    endTurn(error);
  }
  const onAbort = () => finish(new ElevenLabsError("failed", "Stopped"));

  /** Send what's due: the voice once the socket is open, then the line once there is one, and ask for it all now. */
  function pump() {
    if (finished || !socket || !opened) return;
    if (!greeted) {
      greeted = true;
      socket.send(JSON.stringify({ voices: [voiceId] }));
    }
    if (turn && !turn.sent) {
      turn.sent = true;
      socket.send(JSON.stringify({ inputs: [reuse ? { text: turn.line, voice_id: voiceId, new_turn: true } : { text: turn.line, voice_id: voiceId }] }));
      socket.send(JSON.stringify(reuse ? { flush: true } : { close_socket: true }));
    }
  }

  socket = openSocket(`${ELEVEN_WSS}/v1/text-to-dialogue/stream-input?${qs}`, { "xi-api-key": key }, {
    open() {
      opened = true;
      pump();
    },
    message(raw) {
      // Frames still buffered after a hang-up or a timeout are dropped, never enqueued on a closed stream.
      if (finished) return;
      let m: DialogueMessage;
      try {
        m = JSON.parse(raw) as DialogueMessage;
      } catch {
        return;
      }
      if (m.error) {
        const problem = socketProblem(m);
        console.error(`Athena voice: ElevenLabs speech socket error (${problem})`);
        finish(new ElevenLabsError(problem));
        return;
      }
      const t = turn;
      if (m.audio && t) {
        const bytes = new Uint8Array(Buffer.from(m.audio, "base64"));
        if (bytes.length) {
          try {
            t.controller?.enqueue(bytes);
          } catch {
            finish();
            return;
          }
          if (!t.started) {
            t.started = true;
            t.resolve(t.stream);
          }
          if (reuse) {
            clearTimeout(t.gap);
            t.gap = setTimeout(() => {
              if (turn !== t) return;
              endedBy = "gap";
              endTurn();
            }, TURN_GAP_MS);
          }
        }
      }
      if (m.is_final || m.isFinal) return finish();
      if (m.is_final_audio_for_turn && reuse && turn?.started) {
        endedBy = "turn";
        endTurn();
      }
    },
    error(status) {
      if (status) console.error(`Athena voice: ElevenLabs speech socket refused (${status})`);
      finish(new ElevenLabsError(status ? classify(status, null) : "unreachable"));
    },
    close() {
      finish(turn?.started ? undefined : new ElevenLabsError("failed"));
    },
  });
  if (finished) socket.close();
  pump();

  return {
    get usable() {
      return !finished && !turn;
    },
    get endedBy() {
      return endedBy;
    },
    say(text, signal) {
      const line = speakableText(text);
      if (!line || turn) {
        if (!turn) finish();
        return Promise.reject(new ElevenLabsError("failed", line ? undefined : "There's nothing to say."));
      }
      if (finished) return Promise.reject(failure ?? new ElevenLabsError("failed"));
      return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
          // The reader walked away mid-line: the only way to stop ElevenLabs is to hang up.
          cancel() {
            finish();
          },
        });
        const mine = (turn = { line, sent: false, started: false, controller, stream, resolve, reject, signal, timers: [] as ReturnType<typeof setTimeout>[] });
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort);
        mine.timers.push(setTimeout(() => turn === mine && !mine.started && finish(new ElevenLabsError("busy", "ElevenLabs took too long to start speaking. Try again.")), FIRST_AUDIO_MS));
        mine.timers.push(setTimeout(() => turn === mine && (reuse ? endTurn() : finish()), SPEECH_TOTAL_MS));
        pump();
      });
    },
    keepAlive() {
      if (!finished && opened && greeted && !turn) socket?.send(JSON.stringify({ keep_alive: true }));
    },
    close: () => finish(new ElevenLabsError("failed", "Stopped")),
  };
}

/**
 * Speak `text` in a voice with Eleven v4 Turbo. Resolves once the first audio
 * has arrived (so a refused key or voice is a proper error, not an empty
 * stream) with the rest still streaming in. `signal` (the app hanging up, a
 * barge-in) closes the socket.
 */
export async function speak(key: string, voiceId: string, text: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  if (!speakableText(text)) throw new ElevenLabsError("failed", "There's nothing to say.");
  return warmSpeech(key, voiceId).say(text, signal);
}
