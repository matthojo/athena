// Run: npx tsx --test app/src/db/sample-music.test.ts
// Sample playlists read like real ones: no track twice in one playlist, and the track count matches what's listed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { samplePlaylist, samplePlaylists } from "./sample-music";

test("every sample playlist of the owner's own lists each track once", async () => {
  const v = await samplePlaylists();
  assert.equal(v.playlists.length, 9);
  for (const s of v.playlists) {
    const p = (await samplePlaylist(s.id))!;
    if (!p.items) continue;
    const names = p.items.map((t) => t.track);
    assert.equal(new Set(names).size, names.length, `${p.name} repeats a track`);
    assert.equal(names.length, Math.min(p.tracks, 100));
  }
});
