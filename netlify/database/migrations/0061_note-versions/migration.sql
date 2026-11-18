-- Athena — a note's earlier versions (lib/note-versions.ts; security review M12).
--
-- Whenever a note's title or body is replaced (by an MCP client, Ask's
-- assistant, a collection run, a saved action, a script, or the owner in the
-- app), updateNote (lib/db.ts) first copies what was there into this table,
-- so an overwrite can be put back from the note in the app. The owner's own
-- typing is grouped to one version per 10 minutes. The last 20 per note are
-- kept; the rest are dropped in the same statement.
--
-- `title` and `body` are sealed like the note's own (they are copied as
-- stored, and re-sealed with it on a key rotation: lib/encryption.ts).
-- `changed_by` is a short readable label of what made the change that
-- replaced this version ('owner', 'api', 'mcp', 'restore', ...), or null when
-- it didn't say.
-- Rows go with their note when it is deleted for good.
--
-- Additive only. Numbered after main's 0055. Mirrored at db/schema.sql.

CREATE TABLE IF NOT EXISTS note_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_versions_note_idx ON note_versions (note_id, created_at DESC);
