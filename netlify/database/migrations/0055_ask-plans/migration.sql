-- Athena — Ask plans before it acts, runs routines, and keeps one log of what
-- it changed (lib/ask-plans.ts, lib/routines.ts, lib/ask-activity.ts;
-- SECURITY.md §8 "Plans, routines and the activity log"). Additive only.
-- Safe to run twice. Mirrored at db/schema.sql. May be renumbered at merge.

-- A plan: two or more changes Ask worked out and wrote nothing for yet. The
-- owner ticks the steps and taps Go; a routine's plan is only ever proposed.
-- The steps (each tool call and its label) and what Go did are in `payload`,
-- sealed under the data key. `source` is ask or routine; ids only otherwise.
CREATE TABLE IF NOT EXISTS ask_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'ask',
  thread_id UUID,
  routine_id UUID,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set once by Go: a plan runs at most once.
  ran_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ask_plans_created_idx ON ask_plans (created_at DESC);

-- A routine: a recurring Ask question ("Every Friday at 4pm: what slipped
-- this week?"). Its words are sealed in `payload`; when it runs (weekdays,
-- a time of day in the owner's zone) is plain, so the scheduler can read it.
-- `last_slot` is the slot it last ran for: one run per routine per slot.
CREATE TABLE IF NOT EXISTS ask_routines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload TEXT NOT NULL,
  days SMALLINT[] NOT NULL,
  at_time TEXT NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT false,
  last_slot TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_thread_id UUID,
  -- The last run's nudge, sealed, until it goes out (it waits for quiet hours to end).
  pending TEXT,
  -- The last run's nudge went out (or was held for good): nothing left to deliver.
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What Ask did: one row per change Ask made, from a reply, a plan's Go, a
-- routine's plan or a nudge's card. The receipt (what it is, what happened,
-- Open and the Undo op) is in `payload`, sealed. `state` is done, undone or
-- undo_failed; `source` is ask, plan, routine or nudge.
CREATE TABLE IF NOT EXISTS ask_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  thread_id UUID,
  plan_id UUID,
  routine_id UUID,
  nudge_id UUID,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'done',
  state_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ask_activity_created_idx ON ask_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS ask_activity_plan_idx ON ask_activity (plan_id) WHERE plan_id IS NOT NULL;
