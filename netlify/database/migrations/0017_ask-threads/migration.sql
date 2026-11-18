-- Athena — Ask keeps every conversation.
--
-- One row per thread. The PWA makes the id itself (a UUID), so a thread
-- started offline already has its final id when it syncs. `title` is the
-- owner's own name for it ('' = named from its first message, in the app).
-- `messages` is the whole conversation as one JSON array: what the owner
-- said, the assistant's replies (text, choices, changes) with the turns
-- that were sent, and search answers stored as references only (the
-- question, its keywords and the ids and kinds of what matched), never as
-- copies of note text. The app loads those items as they are now.
--
-- Encrypted at rest (SECURITY.md §11): `title` holds "enc:v1:…" text once
-- the key is set and `messages` holds one sealed JSON string (like
-- suggestions.payload). Nothing here is searched in SQL.
--
-- `updated_at` is the device's time of the last change, so the newest
-- write wins when two devices edit the same thread. `synced_at` is the
-- server's time of the last write, which pulls read from ("what changed
-- since my last sync"), so a device clock that's off can't hide a change.
-- Archiving a conversation sets `archived_at` (it syncs like any other
-- change, newest wins); the Archived page restores it or deletes it for
-- good, which removes the row, and devices drop it on their next sync.
-- App only: not in MCP.
--
-- Mirrored for reference at db/schema.sql.

CREATE TABLE ask_threads (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ask_threads_synced_idx ON ask_threads (synced_at);
