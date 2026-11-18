-- Pictures Ask made (lib/images.ts): Undo archives one, like everything else (owner, 17 Nov 2026; SECURITY.md §7).
-- The conversation's link to the file is archived: it leaves the conversation and waits on the Archived page,
-- where it's restored (archived_at cleared) or deleted for good. An archived link still keeps the file.
ALTER TABLE thread_files ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS thread_files_archived_idx ON thread_files (archived_at) WHERE archived_at IS NOT NULL;
