-- Athena — a to-do's details (lib/todo-details.ts). Additive only. Safe to run twice.
-- Mirrored at db/schema.sql.
--
-- `steps`: the to-do's checklist, one sealed JSON value ([{ id, text, done }]), written whole on every change.
-- `links`: web pages and things in Athena it points at, one sealed JSON value ([{ id, url, title }]).
--   The athena:// ones also become content edges from the to-do (lib/db.ts syncContentLinks).
-- `priority`: 0 none, 1 low, 2 medium, 3 high. Plain: it says nothing about what the to-do is.
-- The description is the existing `notes` column, now written as Markdown.
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS steps JSONB;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS links JSONB;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_priority_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_priority_check CHECK (priority BETWEEN 0 AND 3);
