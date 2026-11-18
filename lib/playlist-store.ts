/**
 * Where playlists live (lib/playlists.ts): one `settings` row, key
 * 'music_playlists', whose value is { sealed: <every source's playlists,
 * sealed with the data key> }, like the car (lib/car-store.ts). No
 * migration. Listed in SEALED_SETTINGS so a key rotation reseals it.
 */
import { qRaw } from "./db";
import { dataKeyConfigured, openStrict, sealText } from "./data-box";
import type { PlaylistSource, SourcePlaylists } from "./playlists";

export const PLAYLISTS_KEY = "music_playlists";

export async function loadPlaylists(): Promise<SourcePlaylists[]> {
  const [row] = await qRaw<{ value: { sealed?: string } }>(`SELECT value FROM settings WHERE key = $1`, [PLAYLISTS_KEY]);
  if (!row?.value?.sealed) return [];
  try {
    const all = JSON.parse(openStrict(row.value.sealed)) as SourcePlaylists[];
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

/** Replace one source's playlists, leaving the others. */
export async function savePlaylists(next: SourcePlaylists): Promise<void> {
  if (!dataKeyConfigured()) return;
  const all = (await loadPlaylists()).filter((s) => s.source !== next.source);
  all.push(next);
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PLAYLISTS_KEY, JSON.stringify({ sealed: sealText(JSON.stringify(all)) })],
  );
}

/** Mark a source as needing a fresh sign-in, keeping what was read before. */
export async function markPlaylistsNeedSignIn(source: PlaylistSource, now: Date): Promise<void> {
  const prev = (await loadPlaylists()).find((s) => s.source === source);
  await savePlaylists({ source, updated: prev?.updated ?? now.toISOString(), needs_sign_in: true, playlists: prev?.playlists ?? [] });
}
