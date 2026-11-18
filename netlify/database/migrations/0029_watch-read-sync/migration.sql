-- Athena — films, shows and books from Letterboxd, Trakt and Goodreads land
-- in Watch & read (lib/watch-read-sync.ts).
--
-- `sync`: what the sources know about the item, one sealed JSON string
-- (SECURITY.md §11): the keys it's matched by (each source's id, and its
-- title and year), and the status and rating a source last wrote. When the
-- item's status or rating no longer matches what a source wrote, you changed
-- it, and sources leave it alone from then on. Null for items you added and
-- no source has seen.
--
-- Additive only. Numbered after 0027 (0028 and 0029 are other branches').
-- Mirrored at db/schema.sql.

ALTER TABLE reading_items ADD COLUMN sync JSONB;
