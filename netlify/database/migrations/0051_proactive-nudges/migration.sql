-- Athena — nudges Athena starts (lib/proactive/, SECURITY.md §8 "Nudges Athena
-- starts"). Mirrored at db/schema.sql. Safe to run twice.

-- One row per nudge made: meeting prep, after a meeting, awaiting reply, leave
-- by, the day plan, the weekly plan and drift. `key` is the dedupe key (ids
-- and times only, e.g. prep:<event id>:<start>); a key is never nudged twice.
-- Everything a person could read (title, body, the evidence, the suggested
-- reply, names, subjects) is in `payload`, sealed under the data key.
CREATE TABLE IF NOT EXISTS nudges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  -- The owner's day it was made on: the daily cap counts these.
  local_day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  pushed_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  -- Dismissed from its card: an awaiting-reply thread dismissed counts as closed.
  dismissed_at TIMESTAMPTZ,
  -- Which of its actions were applied (indexes), so a card shows them done.
  applied JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS nudges_day_idx ON nudges (local_day);
CREATE INDEX IF NOT EXISTS nudges_live_idx ON nudges (expires_at) WHERE dismissed_at IS NULL;

-- "Fewer like this": a rule muted until a time. No content.
CREATE TABLE IF NOT EXISTS nudge_mutes (
  rule TEXT PRIMARY KEY,
  muted_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
