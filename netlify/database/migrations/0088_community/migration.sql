-- Athena — Community (lib/catalogue-types.ts, lib/community-config.ts). Additive only. Safe to run twice.
-- Mirrored at db/schema.sql.
--
-- An assistant, skill or flow added from the Community catalogue remembers which listing it came from, so Athena
-- can say when there's a newer version or the item was taken down. NULL for anything made here or added from a
-- file or a link. Plain: the catalogue's public id (16 characters), the SHA-256 of the files as added
-- ("sha256-" and 64 hex digits), and the author's version string. None of it is the owner's words.
--
-- The owner's switch, "Check the Community catalogue", is the plain settings row `community` ({ on: boolean });
-- missing means off, so it needs no change here.
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS catalogue_id TEXT;
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS catalogue_hash TEXT;
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS catalogue_version TEXT;
ALTER TABLE ask_skills ADD COLUMN IF NOT EXISTS catalogue_id TEXT;
ALTER TABLE ask_skills ADD COLUMN IF NOT EXISTS catalogue_hash TEXT;
ALTER TABLE ask_skills ADD COLUMN IF NOT EXISTS catalogue_version TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS catalogue_id TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS catalogue_hash TEXT;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS catalogue_version TEXT;
