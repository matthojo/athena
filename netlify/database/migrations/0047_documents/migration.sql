-- Athena — note templates, and notes sent to Google Docs and Notion
-- (docs/notes/documents.md, SECURITY.md §9 "Documents Athena writes").
-- Mirrored at db/schema.sql. Safe to run twice.

-- The owner's templates: Markdown with {{fields}}. The six starters live in
-- code (lib/templates.ts); editing one saves a row with its key in `starter`.
-- Names and bodies are sealed under the data key (§11).
CREATE TABLE IF NOT EXISTS note_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  starter TEXT,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS note_templates_starter_idx ON note_templates (starter) WHERE starter IS NOT NULL AND archived_at IS NULL;

-- Every doc and page Athena made. This is the list of what it may change
-- later (fill again, trash, clear): never anything else in the account.
CREATE TABLE IF NOT EXISTS document_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google-docs', 'notion')),
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  -- 'doc' or 'page'; 'folder' for the Athena folder in Drive.
  kind TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc', 'page', 'folder')),
  external_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Undo: trashed in Drive, or cleared in Notion.
  undone_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS document_exports_external_idx ON document_exports (connector_id, external_id);
CREATE INDEX IF NOT EXISTS document_exports_note_idx ON document_exports (note_id, created_at DESC);

-- Notion: "Let Athena create pages" is on when a parent page is chosen.
-- The id is Notion's; the title is the owner's words, so it's sealed.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS write_parent_id TEXT;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS write_parent_title TEXT NOT NULL DEFAULT '';
