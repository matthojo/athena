-- Athena — Team: named assistants, each with its own job, triggers, memory
-- and character (docs/team.md; lib/team.ts, lib/team-types.ts). Additive
-- only. Safe to run twice. Mirrored at db/schema.sql. May be renumbered at merge.

-- An assistant. Its words (name, job, instructions, personality, avatar) are
-- sealed in `payload`, and what it remembers (a summary of at most 2,000
-- characters and up to 30 facts) in `memory`, both like ask_routines.payload.
-- `allow` names the assistant tools it may run without asking; anything else
-- becomes a plan that waits for Go. `routine_id` is the routine it came from.
-- At most 12 (lib/team.ts).
CREATE TABLE IF NOT EXISTS team_assistants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  allow TEXT[] NOT NULL DEFAULT '{}',
  paused BOOLEAN NOT NULL DEFAULT false,
  routine_id UUID,
  memory TEXT,
  memory_updated_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_assistants_routine_idx ON team_assistants (routine_id) WHERE routine_id IS NOT NULL;

-- When an assistant runs: on weekdays at a time in the owner's zone
-- (`schedule`, like a routine), or when something arrives in Athena
-- (`event`, an EventFilter in `event`). Plain, so the reminders job can read
-- it. `last_slot` is the schedule slot it last ran for: one run per slot.
CREATE TABLE IF NOT EXISTS team_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES team_assistants (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'event')),
  days SMALLINT[],
  at_time TEXT,
  event JSONB,
  paused BOOLEAN NOT NULL DEFAULT false,
  last_slot TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_triggers_assistant_idx ON team_triggers (assistant_id);
CREATE INDEX IF NOT EXISTS team_triggers_kind_idx ON team_triggers (kind) WHERE NOT paused;

-- Something arrived in Athena that an event trigger may want: a collected
-- item, a saved link or gift idea, a tagged note. `facets` holds only what a
-- filter matches on (no secrets, no body text). The reminders job matches
-- unprocessed rows to triggers; rows are kept for 7 days.
CREATE TABLE IF NOT EXISTS team_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('collected', 'saved', 'note')),
  ref_id TEXT,
  ref_kind TEXT,
  facets JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_events_pending_idx ON team_events (created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS team_events_created_idx ON team_events (created_at);

-- One run of an assistant, from a trigger, an event or Run now. What it did,
-- in words, is sealed in `summary`; the conversation it kept is `thread_id`.
CREATE TABLE IF NOT EXISTS team_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES team_assistants (id) ON DELETE CASCADE,
  trigger_id UUID REFERENCES team_triggers (id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES team_events (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  thread_id UUID,
  summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_runs_assistant_idx ON team_runs (assistant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS team_runs_open_idx ON team_runs (status) WHERE status IN ('queued', 'running');

-- A conversation that belongs to an assistant. Ask's own list hides these
-- unless it's filtered to that assistant.
ALTER TABLE ask_threads ADD COLUMN IF NOT EXISTS assistant_id UUID;
CREATE INDEX IF NOT EXISTS ask_threads_assistant_idx ON ask_threads (assistant_id) WHERE assistant_id IS NOT NULL;
