-- Athena — who wrote each of a note's earlier versions.
--
-- note_versions.changed_by says what replaced a version. `written_by` says
-- what wrote it: the changed_by of the version before it, copied when the
-- version is kept (updateNote, lib/db.ts). Null when nothing came before (a
-- note's first version, and every version kept before this migration).
--
-- updateNote keeps two allowances per note: the newest 20 versions the owner
-- wrote (written_by 'owner' or 'restore', or null), and the newest 30 anyone
-- else wrote. A change the owner didn't make only ever drops the oldest of
-- the second kind, so another program's edits can't push the owner's own
-- words out of a note's history.
--
-- Additive only. Numbered after 0093 (calendar sync). Mirrored at db/schema.sql.

ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS written_by TEXT;
