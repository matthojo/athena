/**
 * The app's side of the owner's ElevenLabs connection and of Talk
 * (netlify/lib/voice/routes.ts). The key goes up once, when it's added, and
 * never comes back: the server only ever says whether it's connected and
 * which voice Athena speaks in. Nothing here is cached on the device.
 */

import { ApiError, getToken, isSampleMode } from "./api";

export type VoiceProblem = "not_connected" | "bad_key" | "not_allowed" | "no_credits" | "busy" | "voice" | "unreachable" | "failed" | "setup" | "format";

export interface VoiceStatus {
  connected: boolean;
  status: "connected" | "key_rejected" | "not_connected";
  voice: { id: string; name: string } | null;
  connected_at: string | null;
  /** Dictation falls back to Gemini when ElevenLabs fails. */
  gemini_backup: boolean;
  setup: { encryption: boolean };
  models: { speech: string; listening: string };
  /** Only when asked for (?usage=1); null when the key can't read the account. */
  usage?: { tier: string; used: number; limit: number; resets_at: string | null } | null;
  usage_problem?: VoiceProblem;
}

export interface Voice {
  id: string;
  name: string;
  category: string;
  /** The owner's own (cloned, designed, saved) rather than one of ElevenLabs' stock voices. */
  mine: boolean;
  traits: string;
  preview_url: string | null;
}

/** An API failure that says what went wrong at ElevenLabs. */
export class VoiceApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly reason: VoiceProblem | null,
  ) {
    super(message, status);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    throw new VoiceApiError("Couldn't reach Athena. Check your connection.", 0, "unreachable");
  }
  if (res.ok) return res;
  let message = res.status === 429 ? "That's a lot of talking for one minute. Try again in a moment." : `${res.status} ${res.statusText}`;
  let reason: VoiceProblem | null = res.status === 429 ? "busy" : null;
  try {
    const body = (await res.json()) as { error?: string; reason?: VoiceProblem };
    if (body.error) message = body.error;
    if (body.reason) reason = body.reason;
  } catch {
    // not JSON (the platform's own rate-limit page)
  }
  throw new VoiceApiError(message, res.status, reason);
}

// ---------- the connection ----------

export async function fetchVoiceStatus(withUsage = false): Promise<VoiceStatus> {
  const res = await call(`/elevenlabs${withUsage ? "?usage=1" : ""}`);
  return (await res.json()) as VoiceStatus;
}

/** Check a key with ElevenLabs and store it (sealed, on the server). */
export async function connectElevenLabs(apiKey: string): Promise<VoiceStatus & { voices: Voice[] }> {
  const res = await call("/elevenlabs", { method: "PUT", body: JSON.stringify({ api_key: apiKey }) });
  return (await res.json()) as VoiceStatus & { voices: Voice[] };
}

export async function chooseVoice(voiceId: string): Promise<VoiceStatus> {
  const res = await call("/elevenlabs", { method: "PATCH", body: JSON.stringify({ voice_id: voiceId }) });
  return (await res.json()) as VoiceStatus;
}

/** Whether dictation tries Gemini (through Netlify) when ElevenLabs fails. */
export async function setGeminiBackup(on: boolean): Promise<VoiceStatus> {
  const res = await call("/elevenlabs", { method: "PATCH", body: JSON.stringify({ gemini_backup: on }) });
  return (await res.json()) as VoiceStatus;
}

export async function disconnectElevenLabs(): Promise<VoiceStatus> {
  const res = await call("/elevenlabs", { method: "DELETE" });
  return (await res.json()) as VoiceStatus;
}

export async function fetchVoices(): Promise<{ voices: Voice[]; selected: string | null }> {
  const res = await call("/elevenlabs/voices");
  return (await res.json()) as { voices: Voice[]; selected: string | null };
}

// ---------- Talk ----------

/** Where to stream the microphone for one turn: a socket URL carrying a single-use token. */
export async function talkListenUrl(signal?: AbortSignal): Promise<{ url: string; sampleRate: number }> {
  const res = await call("/talk/listen", { method: "POST", signal });
  const { url, sample_rate } = (await res.json()) as { url: string; sample_rate: number };
  return { url, sampleRate: sample_rate };
}

/** A single-use ticket (30 seconds) that opens the Talk session socket; a WebSocket can't carry the bearer token. */
export async function talkTicket(): Promise<string> {
  const res = await call("/talk/ticket", { method: "POST" });
  return ((await res.json()) as { ticket: string }).ticket;
}

/** Athena's reply as speech: a stream of 16-bit PCM and its sample rate. */
export async function talkSpeak(text: string, opts: { voiceId?: string; signal?: AbortSignal } = {}): Promise<{ body: ReadableStream<Uint8Array>; sampleRate: number }> {
  const res = await call("/talk/speak", { method: "POST", body: JSON.stringify({ text, voice_id: opts.voiceId }), signal: opts.signal });
  if (!res.body) throw new VoiceApiError("This browser can't play streamed speech.", 0, "failed");
  return { body: res.body, sampleRate: Number(res.headers.get("X-Sample-Rate")) || 24_000 };
}

/** Whether Talk can run here at all: a microphone, Web Audio and WebSockets (or sample mode, which fakes them). */
export function talkSupported(): boolean {
  if (isSampleMode()) return true;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  return !!Ctx && !!navigator.mediaDevices?.getUserMedia && typeof WebSocket === "function" && window.isSecureContext;
}
