-- Athena — folders for notes.
--
-- A note is in one folder or none (notes.folder_id); tags stay for anything
-- that cuts across folders. A folder can sit inside another, three deep at
-- most (lib/note-folder-rules.ts holds that rule and the rest). A folder's
-- name is sealed under the data key like a note's tags, so two folders with
-- the same name in the same place are kept apart by lib/note-folders.ts,
-- not by an index.
--
-- Deleting a folder moves its notes and folders to its own parent first
-- (lib/note-folders.ts deleteFolder); the foreign keys only catch a row
-- removed some other way: notes fall out of it, folders move to the top.
--
-- Additive only. Numbered after 0095 (note version writers). Mirrored at db/schema.sql.

CREATE TABLE IF NOT EXISTS note_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES note_folders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_folders_parent_idx ON note_folders (parent_id);

ALTER TABLE notes ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES note_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS notes_folder_idx ON notes (folder_id) WHERE folder_id IS NOT NULL;
