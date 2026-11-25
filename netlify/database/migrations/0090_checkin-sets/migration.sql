-- Athena — sets of check-in questions added from a file or from Community (lib/checkin-share.ts,
-- lib/checkin-sets.ts). Additive only. Safe to run twice. Mirrored at db/schema.sql.
--
-- One row per set added. Its questions live with the owner's own, in the plain settings row 'checkins', each naming
-- the set's id in `set`, so a set can be switched off (`paused`: its questions aren't asked) or removed whole.
-- Plain, like the check-in settings: the set's name and summary are its author's words, never the owner's answers,
-- which stay sealed in `checkins`. catalogue_* name the Community listing it came from, as for assistants, skills
-- and flows (0089); NULL for a file or a link.
CREATE TABLE IF NOT EXISTS checkin_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  author TEXT,
  version TEXT,
  paused BOOLEAN NOT NULL DEFAULT false,
  catalogue_id TEXT,
  catalogue_hash TEXT,
  catalogue_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkin_sets_catalogue_idx ON checkin_sets (catalogue_id) WHERE catalogue_id IS NOT NULL;
