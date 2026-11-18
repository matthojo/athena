-- What a Team run says about itself (docs/team.md, "Server"): what set it
-- off (`label`, sealed: an event's title is someone else's words), what it's
-- doing right now while it works (`step`, sealed: it can name a person or a
-- note), and when it last said so (`step_at`, so a run that went silent is
-- failed sooner). `quiet` marks a run that found nothing to do: it's kept,
-- but it sends no "From <Name>" card. Numbered after 0070 (home).
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS step TEXT;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS step_at TIMESTAMPTZ;
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS quiet BOOLEAN NOT NULL DEFAULT false;
-- `retried`: a triggered run that failed before anything ran goes back in
-- the queue once, for the next pass (owner, 15 Nov: "Try once more, then
-- tell me"); a second failure is final and sends its card.
ALTER TABLE team_runs ADD COLUMN IF NOT EXISTS retried BOOLEAN NOT NULL DEFAULT false;
