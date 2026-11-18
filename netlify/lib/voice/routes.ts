/**
 * REST routes for the owner's ElevenLabs connection and for Talk, mounted by
 * netlify/functions/api.ts behind the same bearer token as the rest of /api/*.
 *
 *   GET    /api/elevenlabs           status (never the key); ?usage=1 adds the plan's credits
 *   PUT    /api/elevenlabs           { api_key } check it with ElevenLabs, then store it sealed
 *   PATCH  /api/elevenlabs           { voice_id } the voice Athena speaks in; { gemini_backup } on or off
 *   DELETE /api/elevenlabs           forget the key
 *   GET    /api/elevenlabs/voices    the voices the account can use
 *   POST   /api/talk/listen          → { url } a Scribe Realtime socket with a single-use token
 *   POST   /api/talk/speak           { text, voice_id? } → streamed 16-bit PCM (X-Sample-Rate)
 *
 * A Talk session speaks over one WebSocket instead (POST /api/talk/ticket, then
 * GET /api/talk/session; netlify/server/talk/session.ts); /api/talk/speak is
 * what the app falls back to when that socket isn't open.
 *
 * /api/talk/* enters through the Netlify Server (netlify/server/routes/talk.ts),
 * which rate-limits it in code:
 * every call spends the owner's ElevenLabs credits. The rest is
 * configuration, called a few times a session.
 *
 * transcribeDictation() is how /api/voice/transcribe picks a provider:
 * ElevenLabs when it's connected, Gemini through AI Gateway otherwise (and if
 * ElevenLabs fails, so dictation keeps working, unless the Gemini backup is off).
 */
import { AthenaInputError } from "../../../lib/db";
import {
  defaultVoice,
  ElevenLabsError,
  fetchUsage,
  LISTEN_SAMPLE_RATE,
  listenUrl,
  listVoices,
  MODEL_LABELS,
  singleUseToken,
  speak,
  SPEECH_SAMPLE_RATE,
  transcribeRecording,
} from "../../../lib/elevenlabs";
import { removeVoiceConnection, saveVoiceKey, setGeminiBackup, setVoice, setVoiceKeyStatus, voiceCredentials, voiceStatus } from "../../../lib/voice-settings";
import { secretBoxConfigured } from "../../../lib/secret-box";
import { transcribe as transcribeWithGemini, VoiceError } from "../../../lib/voice";

type Json = (data: unknown, status?: number) => Response;

export const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;
/** A reply is one or two sentences; this is generous and stops a pasted essay. */
export const MAX_TEXT = 2000;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object") return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AthenaInputError("Invalid JSON body");
}

function failure(json: Json, error: unknown): Response {
  if (error instanceof ElevenLabsError) return json({ error: error.message, reason: error.problem }, error.status);
  throw error;
}

export const NOT_CONNECTED = { error: "Connect ElevenLabs in Settings → Voice to use Talk.", reason: "not_connected" } as const;
const notConnected = (json: Json) => json(NOT_CONNECTED, 503);

/** A key ElevenLabs refuses is marked, so Connectors can say so until it's replaced. */
async function noteRefusal(error: unknown) {
  if (error instanceof ElevenLabsError && error.problem === "bad_key") await setVoiceKeyStatus("key_rejected");
}

async function status(withUsage: boolean) {
  const base = await voiceStatus();
  const out: Record<string, unknown> = { ...base, models: MODEL_LABELS };
  if (withUsage && base.connected) {
    const creds = await voiceCredentials();
    if (creds) {
      try {
        out.usage = await fetchUsage(creds.key);
        if (base.status === "key_rejected") {
          // It works again (a hiccup, or ElevenLabs restored it).
          await setVoiceKeyStatus("connected");
          out.status = "connected";
        }
      } catch (error) {
        await noteRefusal(error);
        if (error instanceof ElevenLabsError && error.problem === "bad_key") out.status = "key_rejected";
        out.usage = null;
        out.usage_problem = error instanceof ElevenLabsError ? error.problem : "failed";
      }
    }
  }
  return out;
}

// ---------- /api/elevenlabs ----------

export async function handleElevenLabsRoutes(req: Request, url: URL, segments: string[], json: Json): Promise<Response | null> {
  const [, , sub] = segments;
  if (sub === "voices" && segments.length === 3) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const creds = await voiceCredentials();
    if (!creds) return notConnected(json);
    try {
      const voices = await listVoices(creds.key);
      return json({ voices, selected: creds.voice?.id ?? null });
    } catch (error) {
      await noteRefusal(error);
      return failure(json, error);
    }
  }
  if (segments.length !== 2) return null;

  if (req.method === "GET") return json(await status(url.searchParams.get("usage") === "1"));

  if (req.method === "PUT") {
    if (!secretBoxConfigured()) return json({ error: "Set CONNECTOR_ENCRYPTION_KEY on the server before adding a key (see the README).", reason: "setup" }, 503);
    const b = await body(req);
    const key = typeof b.api_key === "string" ? b.api_key.trim() : "";
    if (!key || key.length < 20 || key.length > 200 || /\s/.test(key)) {
      return json({ error: "That doesn't look like an ElevenLabs API key. Copy the whole key from ElevenLabs and paste it again.", reason: "format" }, 400);
    }
    try {
      // The key has to list voices (to pick one) and start a Talk session; both are free to check.
      const voices = await listVoices(key);
      await singleUseToken(key, "realtime_scribe");
      const keep = (await voiceStatus()).voice;
      const voice = (keep && voices.find((v) => v.id === keep.id)) || defaultVoice(voices);
      await saveVoiceKey(key, voice ? { id: voice.id, name: voice.name } : null);
      return json({ ...(await status(true)), voices });
    } catch (error) {
      if (error instanceof ElevenLabsError && error.problem === "bad_key") {
        return json({ error: "ElevenLabs didn't accept that key. Check you copied all of it, or make a new one.", reason: "bad_key" }, 424);
      }
      return failure(json, error);
    }
  }

  if (req.method === "PATCH") {
    const b = await body(req);
    if (typeof b.gemini_backup === "boolean" && b.voice_id === undefined) {
      if (!(await voiceCredentials())) return notConnected(json);
      await setGeminiBackup(b.gemini_backup);
      return json(await status(false));
    }
    const id = typeof b.voice_id === "string" ? b.voice_id.trim() : "";
    if (!VOICE_ID.test(id)) throw new AthenaInputError("Pick a voice from the list");
    const creds = await voiceCredentials();
    if (!creds) return notConnected(json);
    try {
      const voice = (await listVoices(creds.key)).find((v) => v.id === id);
      if (!voice) throw new AthenaInputError("That voice isn't in your ElevenLabs account any more", 404);
      await setVoice({ id: voice.id, name: voice.name });
      return json(await status(false));
    } catch (error) {
      await noteRefusal(error);
      return failure(json, error);
    }
  }

  if (req.method === "DELETE") {
    await removeVoiceConnection();
    return json(await status(false));
  }
  return json({ error: "Method not allowed" }, 405);
}

// ---------- /api/talk ----------

export async function handleTalkRoutes(req: Request, segments: string[], json: Json, headers: Record<string, string>): Promise<Response | null> {
  const [, , action] = segments;
  if (segments.length !== 3 || (action !== "listen" && action !== "speak")) return null;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const creds = await voiceCredentials();
  if (!creds) return notConnected(json);

  if (action === "listen") {
    try {
      const token = await singleUseToken(creds.key, "realtime_scribe");
      if (creds.status === "key_rejected") await setVoiceKeyStatus("connected");
      return json({ url: listenUrl(token), sample_rate: LISTEN_SAMPLE_RATE });
    } catch (error) {
      await noteRefusal(error);
      return failure(json, error);
    }
  }

  const b = await body(req);
  const text = typeof b.text === "string" ? b.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) throw new AthenaInputError("Missing 'text'");
  const override = typeof b.voice_id === "string" && VOICE_ID.test(b.voice_id) ? b.voice_id : null;
  const voiceId = override ?? creds.voice?.id;
  if (!voiceId) return json({ error: "Pick a voice for Athena in Settings → Voice first.", reason: "voice" }, 422);
  try {
    const stream = await speak(creds.key, voiceId, text, req.signal);
    return new Response(stream, {
      status: 200,
      headers: { ...headers, "Content-Type": "audio/pcm", "X-Sample-Rate": String(SPEECH_SAMPLE_RATE), "Cache-Control": "no-store" },
    });
  } catch (error) {
    await noteRefusal(error);
    return failure(json, error);
  }
}

// ---------- dictation ----------

/**
 * One recording to text: ElevenLabs Scribe v2 with the owner's key when it's
 * connected, otherwise (or if ElevenLabs can't right now) Gemini through AI
 * Gateway, as before.
 */
export async function transcribeDictation(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const creds = await voiceCredentials().catch(() => null);
  if (creds) {
    // Tried even when last marked rejected: a one-off refusal shouldn't move dictation off ElevenLabs for good.
    try {
      const text = await transcribeRecording(creds.key, audio, mimeType);
      if (creds.status === "key_rejected") await setVoiceKeyStatus("connected").catch(() => undefined);
      return text;
    } catch (error) {
      await noteRefusal(error).catch(() => undefined);
      if (!(error instanceof ElevenLabsError)) throw error;
      // With the backup off, the audio stays with ElevenLabs: say so rather than send it to Gemini.
      if (!creds.geminiBackup) throw new VoiceError("ElevenLabs couldn't write that down just now. Try again in a moment.", 502);
      console.warn(`Athena voice: ElevenLabs couldn't transcribe (${error.problem}); using Gemini instead`);
    }
  }
  return transcribeWithGemini(audio, mimeType);
}
