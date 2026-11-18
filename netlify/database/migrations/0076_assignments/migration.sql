-- Athena — Assignments, guests and Team chat (docs/team.md "Assignments";
-- the contract is lib/assignment-types.ts), and Word files a note is
-- downloaded as. Additive only. Safe to run twice. Mirrored at db/schema.sql.

-- One piece of work passed along a line of assistants. The title and brief
-- are sealed in `payload`. `checkpoint` is the default its stages start
-- from; `suggestions` = 'take' answers a stage's questions as suggested
-- without stopping. `note_id` is the work product; `thread_id` the Ask
-- conversation it came from.
CREATE TABLE IF NOT EXISTS team_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'waiting', 'done', 'stopped', 'failed')),
  checkpoint TEXT NOT NULL DEFAULT 'auto' CHECK (checkpoint IN ('auto', 'approve')),
  suggestions TEXT NOT NULL DEFAULT 'ask' CHECK (suggestions IN ('ask', 'take')),
  sent_back BOOLEAN NOT NULL DEFAULT false,
  note_id UUID REFERENCES notes (id) ON DELETE SET NULL,
  thread_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_assignments_open_idx ON team_assignments (status) WHERE status IN ('running', 'waiting');

-- A guest: an assistant made for one assignment. No triggers, not on the
-- Team page, not counted toward the 12, gone with its assignment. "Keep on
-- the team" clears this column. `role` is its key in the role library.
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES team_assignments (id) ON DELETE CASCADE;
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS role TEXT;
CREATE INDEX IF NOT EXISTS team_assistants_assignment_idx ON team_assistants (assignment_id) WHERE assignment_id IS NOT NULL;

-- One assistant's turn at an assignment. `words` seals its task, handoff,
-- questions and answers (StageWords). `waits_for` says what it waits on.
CREATE TABLE IF NOT EXISTS team_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES team_assignments (id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  assistant_id UUID NOT NULL REFERENCES team_assistants (id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL DEFAULT 'auto' CHECK (checkpoint IN ('auto', 'approve')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'waiting', 'done', 'skipped', 'failed')),
  waits_for TEXT CHECK (waits_for IN ('go', 'answer', 'approval')),
  run_id UUID REFERENCES team_runs (id) ON DELETE SET NULL,
  note_version UUID,
  sent_back_from SMALLINT,
  words TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (assignment_id, position)
);
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES team_stages (id) ON DELETE SET NULL;

-- Team chat: one channel for the whole team. A post points at its run,
-- stage or assignment and never copies a plan. `body` is sealed.
-- `assistant_id` null with kind 'said' is the owner; null otherwise is Ask.
CREATE TABLE IF NOT EXISTS team_posts (
  id BIGSERIAL PRIMARY KEY,
  assistant_id UUID REFERENCES team_assistants (id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES team_assignments (id) ON DELETE CASCADE,
  stage_id UUID REFERENCES team_stages (id) ON DELETE CASCADE,
  run_id UUID REFERENCES team_runs (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('lineup', 'update', 'handoff', 'question', 'plan', 'approval', 'done', 'failed', 'said', 'reply')),
  body TEXT NOT NULL,
  -- 'dismiss': a run that didn't finish, kept in the waiting strip until the owner dismisses it.
  waits_for TEXT CHECK (waits_for IN ('go', 'answer', 'approval', 'dismiss')),
  -- The conversation a `plan` or `reply` post's plan card lives in.
  thread_id UUID,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_posts_created_idx ON team_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS team_posts_assignment_idx ON team_posts (assignment_id, id) WHERE assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS team_posts_waiting_idx ON team_posts (id) WHERE waits_for IS NOT NULL AND settled_at IS NULL;

-- A note downloaded as Word is kept as a file (lib/files.ts).
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_type_check;
ALTER TABLE files ADD CONSTRAINT files_type_check CHECK (type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/markdown', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));

-- A file Athena made from a note (make_document), and the stage that made
-- it, so a made file is told from one the owner attached.
ALTER TABLE files ADD COLUMN IF NOT EXISTS made_from_note UUID REFERENCES notes (id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES team_stages (id) ON DELETE SET NULL;
