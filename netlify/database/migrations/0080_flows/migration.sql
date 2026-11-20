-- Athena — Flows (lib/flows.ts, lib/flow-run.ts; the contract is lib/flow-types.ts): a trigger and steps with
-- branches, beside Team. Additive only. Safe to run twice. Mirrored at db/schema.sql.

-- One flow. The owner's words (its name, the whole trigger with any words it matches, its steps) are sealed in
-- `payload`, as team_assistants does. What the jobs need to find due flows is plain: `trigger_kind` and
-- `schedule`, which holds only days, times, counts of minutes or days and the facets an event filter names
-- (never its `match` words). `assistant_id`: the Team assistant that runs it, or null for a plain flow.
CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'event', 'before', 'manual')),
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  assistant_id UUID REFERENCES team_assistants (id) ON DELETE SET NULL,
  handed_at TIMESTAMPTZ,
  money BOOLEAN NOT NULL DEFAULT false,
  paused BOOLEAN NOT NULL DEFAULT false,
  origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'ask', 'draft', 'suggestion', 'trigger', 'shared')),
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flows_active_idx ON flows (trigger_kind) WHERE NOT paused;
CREATE INDEX IF NOT EXISTS flows_assistant_idx ON flows (assistant_id) WHERE assistant_id IS NOT NULL;

-- One run of a flow. Sealed: `label` (what set it off), `summary`, `error`, and `state` (each step's line, the
-- values steps gave, where the run is, what it waits on and the cards it has to send). Plain, for the reminders
-- job: the status and what it waits for, when a Wait carries on (`resumes_at`), since when it waits for the
-- owner (`waiting_since`), the Ask plan or assignment it waits on (ids), the ids of the records it changed
-- (`made`, so a run never starts its own flow again), the team_events that started it and the trigger's slot.
-- `version` goes up with every write, so two answers at once can't both apply.
CREATE TABLE IF NOT EXISTS flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed', 'stopped')),
  waits_for TEXT CHECK (waits_for IN ('go', 'answer', 'time', 'assignment')),
  label TEXT,
  assistant_id UUID REFERENCES team_assistants (id) ON DELETE SET NULL,
  summary TEXT,
  error TEXT,
  state TEXT NOT NULL,
  dry BOOLEAN NOT NULL DEFAULT false,
  resumes_at TIMESTAMPTZ,
  waiting_since TIMESTAMPTZ,
  plan_id UUID REFERENCES ask_plans (id) ON DELETE SET NULL,
  assignment_id UUID REFERENCES team_assignments (id) ON DELETE SET NULL,
  notices_pending BOOLEAN NOT NULL DEFAULT false,
  made TEXT[] NOT NULL DEFAULT '{}',
  event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  slot TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flow_runs_flow_idx ON flow_runs (flow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS flow_runs_open_idx ON flow_runs (status) WHERE status IN ('queued', 'running', 'waiting');
CREATE INDEX IF NOT EXISTS flow_runs_resume_idx ON flow_runs (resumes_at) WHERE status = 'waiting' AND waits_for = 'time';
CREATE INDEX IF NOT EXISTS flow_runs_notices_idx ON flow_runs (id) WHERE notices_pending;
-- A trigger's slot starts a flow once, however many passes see it.
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_slot_idx ON flow_runs (flow_id, slot) WHERE slot IS NOT NULL;
