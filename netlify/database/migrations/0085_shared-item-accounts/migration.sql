-- Athena — items someone else shared (lib/shared-limits.ts, SECURITY.md §10). Additive only. Safe to run twice.
-- Mirrored at db/schema.sql.
--
-- `team_assistants.origin`: 'shared' for an assistant imported from a file or a link; NULL for one made here.
--   Plain: it says where the row came from, nothing about what it says.
-- `team_assistants.accounts`, `ask_skills.accounts`: the connected accounts (connectors.id) the owner ticked for an
--   imported item. An imported assistant's turns, and an imported skill while it's in use, open only these. Empty
--   to start. Ids only, like `allow`.
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS accounts TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ask_skills ADD COLUMN IF NOT EXISTS accounts TEXT[] NOT NULL DEFAULT '{}';

-- Assistants imported before this: their triggers became flows marked as imported (0083, origin 'shared').
UPDATE team_assistants SET origin = 'shared'
  WHERE origin IS NULL AND id IN (SELECT assistant_id FROM flows WHERE origin = 'shared' AND assistant_id IS NOT NULL);
