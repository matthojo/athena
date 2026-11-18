-- Athena — goal progress log (lib/memory.ts upsertGoal, lib/week-review.ts;
-- docs/notes/week-review-build.md). Mirrored at db/schema.sql.
--
-- A goal keeps one progress number, so a week or month in review couldn't
-- say which goals moved on. Every write that changes a goal's progress
-- (the app, Ask, MCP, the API) adds a row here with the new value. The
-- review reads the last value before the period and the last within it.
--
-- Progress is a plain number, like goals.progress: nothing here is sealed.
-- Rows go with their goal when it's deleted for good.

CREATE TABLE IF NOT EXISTS goal_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  progress INT NOT NULL CHECK (progress BETWEEN 0 AND 100),
  -- 'seed': the value a goal had when the log began (this migration);
  -- 'change': a write that changed it, or a new goal's starting value.
  source TEXT NOT NULL DEFAULT 'change' CHECK (source IN ('seed', 'change')),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_progress_goal_at_idx ON goal_progress (goal_id, at DESC);

-- Seed each goal's current value once, so next week has a baseline.
INSERT INTO goal_progress (goal_id, progress, source)
SELECT g.id, g.progress, 'seed' FROM goals g
 WHERE NOT EXISTS (SELECT 1 FROM goal_progress p WHERE p.goal_id = g.id);
