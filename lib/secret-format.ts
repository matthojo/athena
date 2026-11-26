/**
 * Where each credential sealed by lib/secret-box.ts belongs (its context), and
 * retiring the v1 format, which had none.
 *
 * Contexts: a connector's secrets are sealed for its id, provider and address;
 * the ElevenLabs key and the map and TMDB keys for their settings rows.
 *
 * Retiring v1: retireV1Secrets(), run by the encrypt-data scheduled function
 * every five minutes on production, seals every v1 value in `connectors` and
 * in those settings rows again as v2. When none is left it records the
 * `secret-format` setting, and from then on loadSecretFormat() has every
 * instance refuse v1 values: a connector holding one reads as signed out.
 * Without CONNECTOR_ENCRYPTION_KEY it does nothing and records nothing; a v1
 * value no key here opens stays v1 and keeps the pass from finishing, so the
 * function's log names it until the old key is put in
 * CONNECTOR_ENCRYPTION_KEY_PREVIOUS or the account is signed in to again.
 */
import { qRaw } from "./db";
import { currentKeyId, isV1, open, retireV1, seal, secretBoxConfigured, v1Retired } from "./secret-box";

// ---------- contexts ----------

/** A connector's secrets: the account, its kind and its address. */
export function connectorContext(c: { id: string; provider: string; url: string }): string {
  return `connector\n${c.id}\n${c.provider}\n${c.url}`;
}

export const VOICE_ROW = "elevenlabs";
export const VOICE_CONTEXT = `settings\n${VOICE_ROW}`;

export const ART_ROW = "maps-art";
export const artContext = (which: "tiles" | "tmdb"): string => `settings\n${ART_ROW}\n${which}`;

// ---------- retiring v1 ----------

/** The setting recorded once every v1 value has been sealed again. */
export const FORMAT_KEY = "secret-format";
/** How often an instance that still accepts v1 looks for the setting. */
const RECHECK_MS = 60_000;
let checkedAt = -Infinity;

/** Refuse v1 values once the pass has finished. Cheap: once refused, it stays so; otherwise it looks at most once a minute. */
export async function loadSecretFormat(now = Date.now()): Promise<void> {
  if (v1Retired() || now - checkedAt < RECHECK_MS) return;
  checkedAt = now;
  try {
    const [row] = await qRaw<{ value: { v1_retired_at?: unknown } | null }>(`SELECT value FROM settings WHERE key = $1`, [FORMAT_KEY]);
    if (typeof row?.value?.v1_retired_at === "string") retireV1();
  } catch {
    // Read again next time.
  }
}

/** For tests: forget what's been read. */
export function resetSecretFormat(): void {
  checkedAt = -Infinity;
  retireV1(false);
}

export interface FormatPass {
  state: "no_key" | "done" | "finished" | "pending";
  resealed: number;
  /** v1 values no key here opens. */
  unreadable: number;
}

/** Seal one v1 value again for `context`; false when no key here opens it. */
function v2(sealed: string, context: string): string | null {
  try {
    return seal(open(sealed), context);
  } catch {
    return null;
  }
}

/**
 * Seal every v1 credential again as v2, and once none is left record that v1
 * is retired. Safe to run any number of times and alongside other writes: a
 * value is only replaced while it's still the v1 value read.
 */
export async function retireV1Secrets(): Promise<FormatPass> {
  const out: FormatPass = { state: "pending", resealed: 0, unreadable: 0 };
  // Without the key nothing can be checked, so nothing is recorded.
  if (!secretBoxConfigured()) return { ...out, state: "no_key" };
  const [flag] = await qRaw<{ value: { v1_retired_at?: unknown } | null }>(`SELECT value FROM settings WHERE key = $1`, [FORMAT_KEY]);
  if (typeof flag?.value?.v1_retired_at === "string") {
    retireV1();
    return { ...out, state: "done" };
  }

  const rows = await qRaw<{ id: string; provider: string; url: string; credentials: string }>(
    `SELECT id, provider, url, credentials FROM connectors WHERE credentials LIKE 'v1.%'`,
  );
  for (const row of rows) {
    const next = v2(row.credentials, connectorContext(row));
    if (!next) {
      out.unreadable++;
      continue;
    }
    const done = await qRaw(`UPDATE connectors SET credentials = $2 WHERE id = $1 AND credentials = $3 RETURNING id`, [row.id, next, row.credentials]);
    out.resealed += done.length;
  }

  const settings = await qRaw<{ key: string; value: Record<string, unknown> | null }>(`SELECT key, value FROM settings WHERE key = ANY($1)`, [[VOICE_ROW, ART_ROW]]);
  for (const { key, value } of settings) {
    const slots: Array<{ path: string[]; context: string }> =
      key === VOICE_ROW ? [{ path: ["key"], context: VOICE_CONTEXT }] : [{ path: ["tiles", "key"], context: artContext("tiles") }, { path: ["tmdb", "key"], context: artContext("tmdb") }];
    for (const { path, context } of slots) {
      const sealed = path.reduce<unknown>((at, k) => (at && typeof at === "object" ? (at as Record<string, unknown>)[k] : undefined), value);
      if (typeof sealed !== "string" || !isV1(sealed)) continue;
      const next = v2(sealed, context);
      if (!next) {
        out.unreadable++;
        continue;
      }
      const done = await qRaw(`UPDATE settings SET value = jsonb_set(value, $2::text[], to_jsonb($3::text)) WHERE key = $1 AND value #>> $2::text[] = $4 RETURNING key`, [
        key,
        path,
        next,
        sealed,
      ]);
      out.resealed += done.length;
    }
  }

  // Counted again, so a v1 value written meanwhile, or one that changed under the pass, isn't missed.
  const [left] = await qRaw<{ n: number }>(
    `SELECT (SELECT count(*) FROM connectors WHERE credentials LIKE 'v1.%')
          + (SELECT count(*) FROM settings WHERE key = $1 AND value->>'key' LIKE 'v1.%')
          + (SELECT count(*) FROM settings WHERE key = $2 AND (value #>> '{tiles,key}' LIKE 'v1.%' OR value #>> '{tmdb,key}' LIKE 'v1.%'))
          AS n`,
    [VOICE_ROW, ART_ROW],
  );
  if (Number(left?.n ?? 1) > 0) return out;
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [FORMAT_KEY, JSON.stringify({ v1_retired_at: new Date().toISOString(), key_id: currentKeyId() })],
  );
  retireV1();
  return { ...out, state: "finished" };
}
