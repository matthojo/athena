-- Watch & read: what's known about a title beyond its name (lib/watch-meta.ts).
--
-- `meta`: one sealed JSON string, like `sync` (0029): the year, the running
-- time, genres, the playlists it's in, the owner's tags and the seasons it
-- suits. Sources fill it once per item (netlify/lib/watch-enrich.ts); tags
-- are the owner's. Null: nothing known yet.
ALTER TABLE reading_items ADD COLUMN IF NOT EXISTS meta JSONB;
