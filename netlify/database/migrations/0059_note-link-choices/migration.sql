-- Athena — the owner's Card and Mention choices in notes Athena wrote
-- (security review M6, owner's answer 10 Nov 2026; lib/note-link-choices.ts).
-- In a note the owner didn't write, a web link is a plain link and is never
-- previewed, unless the owner chose otherwise for that address in the app's
-- editor. Those choices live here, never in the note's Markdown, so nothing
-- that writes a note's body (a model, a collection, MCP) can make one.
-- One row per note; `payload` is the list of { url, mode }, sealed under the
-- data key. Additive only. Safe to run twice. Mirrored at db/schema.sql.
CREATE TABLE IF NOT EXISTS note_link_choices (
  note_id UUID PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
