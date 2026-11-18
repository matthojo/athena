-- Each Team assistant's own models (docs/ai-models.md): { think?, image? },
-- each a { provider, model } from Netlify AI Gateway's list. Empty: the same
-- as Ask. Model names aren't sensitive, so it's plain, like `allow` and `web`.
-- The owner's own choices are the `settings` row `ai_models`. Safe to run twice.
ALTER TABLE team_assistants ADD COLUMN IF NOT EXISTS models JSONB NOT NULL DEFAULT '{}';
-- The model a Team run thought with, whether the chosen one failed so the
-- default ran instead, and the one that failed (TeamRun.model, fell_back,
-- tried). Plain, like status.
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS model JSONB;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS fell_back BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS tried JSONB;
