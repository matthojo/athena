-- Athena — files: photos, screenshots, PDFs and Markdown/text the owner adds
-- in Ask or to a note.
--
-- The bytes live in Netlify Blobs (store "athena-files", key = the file's
-- id, plus "<id>-thumb" for an image's small preview), sealed under
-- ATHENA_DATA_KEY before they're written (lib/data-box.ts sealBytes;
-- SECURITY.md §11). There are no public URLs: the app reads them through
-- the authenticated /api/files routes. This table says what each file is.
--
-- `name` is the owner's file name ("receipt.pdf"), sealed like other text.
-- `type` (one of a fixed list, checked here), `size`, the image's size in
-- pixels and a PDF's page count stay readable: lists and limits use them,
-- and they say nothing about what's in it. `key_id` is the data key the
-- bytes are sealed under, so a key rotation can re-seal them.
--
-- `summary` is a short description Claude writes the first time it reads
-- the file; follow-ups send it instead of the file. `extracted_text` is a
-- PDF's or text file's words, for reading it again cheaply. Both are sealed
-- like `name`, and both are NULL until that first read.
--
-- A file is kept while something uses it: a note (note_files, removed with
-- the note) or an Ask conversation (thread_files; conversations keep file
-- ids, never bytes). Ask links a file to its conversation as it uploads,
-- possibly before the conversation is first saved, so thread_files has no
-- foreign key. When the last link goes, lib/files.ts deletes the file and
-- its bytes. Archiving a note or a conversation keeps every link.
--
-- Mirrored for reference at db/schema.sql.

CREATE TABLE files (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/markdown', 'text/plain')),
  size INT NOT NULL CHECK (size > 0),
  width INT,
  height INT,
  pages INT,
  has_thumb BOOLEAN NOT NULL DEFAULT false,
  key_id TEXT NOT NULL,
  summary TEXT,
  extracted_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE note_files (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, file_id)
);
CREATE INDEX note_files_file_idx ON note_files (file_id);

CREATE TABLE thread_files (
  thread_id UUID NOT NULL,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, file_id)
);
CREATE INDEX thread_files_file_idx ON thread_files (file_id);
