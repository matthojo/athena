-- Athena — plays per hour on a Days entry (lib/day-hours.ts; Music's heatmap).
--
-- A listened entry folds a day's plays of one album into one row with a
-- count. `hours` keeps when those plays happened: a JSON array of 24 counts,
-- the owner's local hours 0-23, written by the Last.fm and ListenBrainz
-- history loads and the Life log run when the source gives play times.
-- Null when unknown (older rows, sources without times, saves). Sealed like
-- the entry's other text (lib/encryption.ts), so it's TEXT, not JSONB.
--
-- Additive only. Numbered after main's 0061. Mirrored at db/schema.sql.

ALTER TABLE day_entries ADD COLUMN IF NOT EXISTS hours TEXT;
