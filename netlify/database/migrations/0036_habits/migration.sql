-- Athena — the owner's own habits (lib/own-habits.ts, lib/habit-rules.ts;
-- SECURITY.md §11). Mirrored at db/schema.sql.
--
-- A habit made in Athena, beside the ones Habitify, Todoist, Loop, Daylio and
-- Bearable send. Ticks aren't stored here: each is a `habit` day entry with
-- source 'athena' (count 1 done, 0 not yet; a target's "3 of 8 glasses" in
-- its note), so streaks, the year grid, Patterns and the evening nudge read
-- them like any other habit.
--
-- name and unit are sealed like note text (ENCRYPTED in lib/encryption.ts),
-- so names are matched and kept unique in the Function, never in SQL. The
-- schedule, target, icon, order and dates stay readable.
-- days: weekdays it's due as a bitmask, Monday = 1 … Sunday = 64.
-- per_week: N times a week on any days, instead of fixed weekdays.

CREATE TABLE IF NOT EXISTS habits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  days SMALLINT NOT NULL DEFAULT 127 CHECK (days BETWEEN 0 AND 127),
  per_week SMALLINT CHECK (per_week IS NULL OR per_week BETWEEN 1 AND 7),
  target INT CHECK (target IS NULL OR target BETWEEN 2 AND 1000),
  unit TEXT,
  icon TEXT NOT NULL DEFAULT 'check' CHECK (icon ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  position INT NOT NULL DEFAULT 0,
  starts_on DATE NOT NULL DEFAULT CURRENT_DATE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT habits_due_check CHECK (per_week IS NOT NULL OR days > 0)
);
CREATE INDEX IF NOT EXISTS habits_live_idx ON habits (position) WHERE archived_at IS NULL;
