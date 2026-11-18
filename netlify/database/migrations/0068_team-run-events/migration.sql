-- A run fired by events gets every event that matched its assistant in one
-- pass (docs/team.md): their team_events ids, oldest first, as a JSON array.
-- event_id stays the first of them.
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS event_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
