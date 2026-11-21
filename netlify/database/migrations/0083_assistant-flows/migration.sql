-- Team assistants' triggers become flows the assistant runs (lib/team-flows.ts). Additive only. Safe to run twice.
-- Mirrored at db/schema.sql.
--
-- The move itself is code (the flows' words are sealed, so it needs the data key): the reminders job moves every
-- trigger in one transaction and marks it done in settings (`team.triggers_moved`). These columns are what it
-- needs, and they're all plain ids and times:
--
-- `flows.trigger_id`: the team_triggers row a flow was made from, unique, so a trigger becomes one flow however
-- often the move runs. No foreign key: the trigger row is kept (old runs still name it) and a flow outlives it.
ALTER TABLE flows ADD COLUMN IF NOT EXISTS trigger_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS flows_trigger_idx ON flows (trigger_id) WHERE trigger_id IS NOT NULL;

-- `team_triggers.moved_at`: when the trigger became a flow. A moved trigger never fires again; the flow does.
ALTER TABLE team_triggers ADD COLUMN IF NOT EXISTS moved_at TIMESTAMPTZ;

-- `team_runs.flow_run_id`, `flow_id`: a run of an assistant's flow, kept as the assistant's run too, so Team, Home
-- and the "From <Name>" card read it as they read every run. One team run per flow run.
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS flow_run_id UUID;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS flow_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS team_runs_flow_run_idx ON team_runs (flow_run_id) WHERE flow_run_id IS NOT NULL;
