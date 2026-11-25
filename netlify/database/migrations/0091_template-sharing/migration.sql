-- Athena — note templates shared and added from a file or from Community (lib/template-share.ts,
-- lib/templates-db.ts). Additive only. Safe to run twice. Mirrored at db/schema.sql.
--
-- An added template is a note_templates row like the owner's own, marked as someone else's: origin 'shared', with
-- the author's one-line summary (sealed, like the name and body), their GitHub name and version as the file gave
-- them, and catalogue_* naming the Community listing it came from, as for assistants, skills, flows and check-in
-- sets (0089, 0090); NULL for a file or a link. changed_at: when the owner changed it after adding it, so an Update
-- goes beside their copy and never over it. NULL for the owner's own templates and Athena's starters.
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS catalogue_id TEXT;
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS catalogue_hash TEXT;
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS catalogue_version TEXT;
ALTER TABLE note_templates ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS note_templates_catalogue_idx ON note_templates (catalogue_id) WHERE catalogue_id IS NOT NULL;
