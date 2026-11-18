-- Athena — the reading list becomes "Watch & read": films, TV shows, music
-- (an album or a song) and games join articles, books, podcasts, videos,
-- papers and other.
--
-- Only the kind CHECK widens. The table keeps its name (reading_items) and
-- the statuses keep their stored values (queued / reading / done); the app
-- words them for the kind ("To watch", "Listening", "Played"). Every
-- existing row passes the wider check, so nothing is rewritten.
--
-- The CHECK in 0005 was declared inline, so Postgres named it
-- <table>_<column>_check (the same pattern 0002 used to widen edges).
-- Mirrored for reference at db/schema.sql.
ALTER TABLE reading_items DROP CONSTRAINT reading_items_kind_check;
ALTER TABLE reading_items ADD CONSTRAINT reading_items_kind_check
  CHECK (kind IN ('article', 'book', 'podcast', 'video', 'paper', 'other', 'film', 'tv', 'music', 'game'));
