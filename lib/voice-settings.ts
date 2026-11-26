/**
 * The owner's ElevenLabs connection, kept in one `settings` row (key
 * `elevenlabs`) rather than a table of its own: there's only ever one, and
 * nothing in it needs querying.
 *
 *   { key: "<sealed>", voice: { id, name } | null, status, connected_at, checked_at, gemini_backup? }
 *
 * gemini_backup (missing = on): when ElevenLabs can't transcribe a dictation,
 * try Gemini through Netlify AI Gateway instead. Off keeps audio off Google.
 *
 * The API key is sealed with AES-256-GCM under CONNECTOR_ENCRYPTION_KEY
 * (lib/secret-box.ts, the same as connector sign-ins) and only ever opened
 * inside a Function to call ElevenLabs. Nothing here returns it to the API:
 * voiceStatus() is what the app sees. See docs: security/outside-services.
 */

import { qRaw } from "./db";
import { needsReseal, open, seal, secretBoxConfigured } from "./secret-box";
import { loadSecretFormat, VOICE_CONTEXT, VOICE_ROW } from "./secret-format";

export type VoiceConnectionStatus = "connected" | "key_rejected";

interface Stored {
  key: string;
  voice: { id: string; name: string } | null;
  status: VoiceConnectionStatus;
  connected_at: string;
  checked_at: string | null;
  gemini_backup?: boolean;
}

/** What the app is told: never the key. */
export interface VoiceStatus {
  connected: boolean;
  status: VoiceConnectionStatus | "not_connected";
  voice: { id: string; name: string } | null;
  connected_at: string | null;
  /** Dictation falls back to Gemini when ElevenLabs fails. */
  gemini_backup: boolean;
  /** Whether this server can store a key at all (CONNECTOR_ENCRYPTION_KEY is set). */
  setup: { encryption: boolean };
}

const ROW = VOICE_ROW;
/** What the key is sealed for (lib/secret-box.ts, lib/secret-format.ts). */
const SEALED_FOR = VOICE_CONTEXT;

async function load(): Promise<Stored | null> {
  const [row] = await qRaw<{ value: Stored }>(`SELECT value FROM settings WHERE key = $1`, [ROW]);
  const v = row?.value;
  return v && typeof v.key === "string" && v.key ? v : null;
}

async function store(value: Stored): Promise<void> {
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ROW, JSON.stringify(value)],
  );
}

export async function voiceStatus(): Promise<VoiceStatus> {
  const s = await load();
  return {
    connected: !!s,
    status: s?.status ?? "not_connected",
    voice: s?.voice ?? null,
    connected_at: s?.connected_at ?? null,
    gemini_backup: s?.gemini_backup !== false,
    setup: { encryption: secretBoxConfigured() },
  };
}

/** Store a key that ElevenLabs has just accepted, with the voice to start with. Replaces any earlier key. */
export async function saveVoiceKey(apiKey: string, voice: { id: string; name: string } | null): Promise<void> {
  const now = new Date().toISOString();
  // A new key keeps the owner's Gemini backup choice.
  const backup = (await load())?.gemini_backup;
  await store({ key: seal(apiKey, SEALED_FOR), voice, status: "connected", connected_at: now, checked_at: now, ...(backup === false ? { gemini_backup: false } : {}) });
}

export async function setVoice(voice: { id: string; name: string }): Promise<void> {
  const s = await load();
  if (!s) return;
  await store({ ...s, voice });
}

export async function setGeminiBackup(on: boolean): Promise<void> {
  const s = await load();
  if (!s) return;
  await store({ ...s, gemini_backup: on });
}

/** ElevenLabs refused the key (revoked, or rotated): say so in Settings → Voice until it's replaced. */
export async function setVoiceKeyStatus(status: VoiceConnectionStatus): Promise<void> {
  const s = await load();
  if (!s || s.status === status) return;
  await store({ ...s, status, checked_at: new Date().toISOString() });
}

/** Forget the key (and the voice). ElevenLabs keeps the key itself; delete it there to revoke it. */
export async function removeVoiceConnection(): Promise<void> {
  await qRaw(`DELETE FROM settings WHERE key = $1`, [ROW]);
}

/**
 * The key and voice, opened for one call to ElevenLabs; null when there's no
 * connection or the key can't be opened (CONNECTOR_ENCRYPTION_KEY missing or
 * changed since it was saved).
 */
export async function voiceCredentials(): Promise<{
  key: string;
  voice: { id: string; name: string } | null;
  status: VoiceConnectionStatus;
  geminiBackup: boolean;
} | null> {
  await loadSecretFormat();
  const s = await load();
  if (!s) return null;
  try {
    const key = open(s.key, SEALED_FOR);
    // Sealed in the older format or under a previous key: seal again, unless it was replaced meanwhile.
    if (needsReseal(s.key) && secretBoxConfigured()) {
      await qRaw(`UPDATE settings SET value = jsonb_set(value, '{key}', to_jsonb($2::text)) WHERE key = $1 AND value->>'key' = $3`, [ROW, seal(key, SEALED_FOR), s.key]).catch(() => undefined);
    }
    return { key, voice: s.voice, status: s.status, geminiBackup: s.gemini_backup !== false };
  } catch {
    console.error("Athena voice: the stored ElevenLabs key can't be opened with the current CONNECTOR_ENCRYPTION_KEY");
    return null;
  }
}
