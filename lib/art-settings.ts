/**
 * Settings → Maps and artwork: the owner's map tile key (MapTiler or Stadia
 * Maps) and an optional TMDB key, in one `settings` row (key `maps-art`).
 *
 *   { tiles?: { provider, key: <sealed>, status, added_at, checked_at },
 *     tmdb?:  { key: <sealed>, status, added_at, checked_at } }
 *
 * Keys are sealed with AES-256-GCM under CONNECTOR_ENCRYPTION_KEY
 * (lib/secret-box.ts), like connector sign-ins and the ElevenLabs key, and
 * only opened inside a Function to fetch tiles or look up a poster. Nothing
 * here returns a key to the API: mapsArtStatus() is what the app sees.
 * docs: security/outside-services.
 */
import { qRaw } from "./db";
import { needsReseal, open, seal, secretBoxConfigured } from "./secret-box";

export type TileProvider = "maptiler" | "stadia";
export const TILE_PROVIDERS: readonly TileProvider[] = ["maptiler", "stadia"];
export type KeyStatus = "working" | "rejected";

interface StoredKey {
  key: string;
  status: KeyStatus;
  added_at: string;
  checked_at: string;
}

interface Stored {
  tiles?: StoredKey & { provider: TileProvider };
  tmdb?: StoredKey;
}

/** What the app is told: never a key. */
export interface MapsArtStatus {
  tiles: { provider: TileProvider; status: KeyStatus; added_at: string } | null;
  tmdb: { status: KeyStatus; added_at: string } | null;
  /** Whether this server can keep a key at all (CONNECTOR_ENCRYPTION_KEY is set). */
  setup: { encryption: boolean };
}

const ROW = "maps-art";
/** What each key is sealed for (lib/secret-box.ts). */
const sealedFor = (which: "tiles" | "tmdb") => `settings\nmaps-art\n${which}`;

async function load(): Promise<Stored> {
  const [row] = await qRaw<{ value: Stored }>(`SELECT value FROM settings WHERE key = $1`, [ROW]);
  return row?.value && typeof row.value === "object" ? row.value : {};
}

async function store(value: Stored): Promise<void> {
  if (!value.tiles && !value.tmdb) {
    await qRaw(`DELETE FROM settings WHERE key = $1`, [ROW]);
    return;
  }
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ROW, JSON.stringify(value)],
  );
}

export async function mapsArtStatus(): Promise<MapsArtStatus> {
  const s = await load();
  return {
    tiles: s.tiles ? { provider: s.tiles.provider, status: s.tiles.status, added_at: s.tiles.added_at } : null,
    tmdb: s.tmdb ? { status: s.tmdb.status, added_at: s.tmdb.added_at } : null,
    setup: { encryption: secretBoxConfigured() },
  };
}

/** Keep a tile key the provider has just accepted. Replaces any earlier one. */
export async function saveTileKey(provider: TileProvider, key: string): Promise<void> {
  const s = await load();
  const now = new Date().toISOString();
  await store({ ...s, tiles: { provider, key: seal(key, sealedFor("tiles")), status: "working", added_at: now, checked_at: now } });
}

/** Keep a TMDB key TMDB has just accepted. */
export async function saveTmdbKey(key: string): Promise<void> {
  const s = await load();
  const now = new Date().toISOString();
  await store({ ...s, tmdb: { key: seal(key, sealedFor("tmdb")), status: "working", added_at: now, checked_at: now } });
}

export async function removeKey(which: "tiles" | "tmdb"): Promise<void> {
  const s = await load();
  delete s[which];
  await store(s);
}

/** The provider refused a kept key (revoked, or the free plan ran out): Settings says so until it's replaced. */
export async function setKeyStatus(which: "tiles" | "tmdb", status: KeyStatus): Promise<void> {
  const s = await load();
  const k = s[which];
  if (!k || k.status === status) return;
  k.status = status;
  k.checked_at = new Date().toISOString();
  await store(s);
}

async function opened(which: "tiles" | "tmdb", k: StoredKey | undefined): Promise<string | null> {
  if (!k) return null;
  try {
    const key = open(k.key, sealedFor(which));
    // Sealed in the older format or under a previous key: seal again, unless it was replaced meanwhile.
    if (needsReseal(k.key)) {
      await qRaw(
        `UPDATE settings SET value = jsonb_set(value, ARRAY[$2, 'key'], to_jsonb($3::text)) WHERE key = $1 AND value->$2->>'key' = $4`,
        [ROW, which, seal(key, sealedFor(which)), k.key],
      ).catch(() => undefined);
    }
    return key;
  } catch {
    console.error("Athena maps and artwork: a kept key can't be opened with the current CONNECTOR_ENCRYPTION_KEY");
    return null;
  }
}

/** The tile key, opened for one render. Null without one. */
export async function tileCredentials(): Promise<{ provider: TileProvider; key: string; status: KeyStatus } | null> {
  const s = await load();
  const key = await opened("tiles", s.tiles);
  return key && s.tiles ? { provider: s.tiles.provider, key, status: s.tiles.status } : null;
}

/** The TMDB key, opened for one lookup. Null without one, or once TMDB has refused it. */
export async function tmdbKey(): Promise<string | null> {
  const s = await load();
  return s.tmdb?.status === "working" ? opened("tmdb", s.tmdb) : null;
}

/** The TMDB key whatever its status, for Settings' test button. */
export async function tmdbKeyForTest(): Promise<string | null> {
  return opened("tmdb", (await load()).tmdb);
}
