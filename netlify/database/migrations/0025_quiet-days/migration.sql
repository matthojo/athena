-- Athena — collections can skip a run when nothing's new (the precheck's
-- "anything new?" glance), or always run. On by default, as before.
-- Additive. Mirrored for reference at db/schema.sql.

ALTER TABLE collections ADD COLUMN skip_quiet BOOLEAN NOT NULL DEFAULT true;
