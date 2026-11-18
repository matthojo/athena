-- Athena — artwork for Days and Watch & read (lib/art.ts, SECURITY.md §13 "Artwork and maps").
--
-- Posters, book covers, album art and game headers, fetched once by the
-- server from an allowlist of hosts, resized to two WebP sizes and sealed
-- into Netlify Blobs (store "athena-art"). Never people's photos.
--
-- art: one row per image. id is a blind index of the original bytes, so the
-- same cover from two addresses is stored once. w and h are the large
-- size's pixels; tone is its average colour, for the placeholder shown
-- while it loads. kid is the data key that sealed the bytes.
--
-- art_sources: where art came from, keyed by a blind index of the source
-- (an image address, an ISBN, a title looked up on TMDB). art_id is null
-- when nothing was found, so a miss isn't asked again for a fortnight.
-- No address, title or ISBN is stored readable. Mirrored at db/schema.sql.

CREATE TABLE IF NOT EXISTS art (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  w INTEGER NOT NULL CHECK (w > 0),
  h INTEGER NOT NULL CHECK (h > 0),
  tone TEXT CHECK (tone ~ '^#[0-9a-f]{6}$'),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  kid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS art_sources (
  source_hash TEXT PRIMARY KEY,
  art_id TEXT REFERENCES art(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS art_sources_art_id ON art_sources (art_id);
