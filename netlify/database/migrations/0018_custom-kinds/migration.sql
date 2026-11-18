-- Athena — custom kinds: the owner's own kinds of record ("Wines", "Plants",
-- "Board games"), each with its own fields, and the records kept of them.
--
-- A kind is made in the app's Settings (or by asking Athena in Ask). Its
-- fields are ordinary custom fields (0016) whose kind is 'custom:<kind id>',
-- and its records' values are custom_values with the same entity_kind, so the
-- field editor, the value rules and the MCP field tools work on them as they
-- are. Kinds and records are archived, never deleted by an agent: archiving a
-- kind hides it and every record of it everywhere except the Archived page,
-- where only the owner can delete permanently.
--
-- Names, singular names, titles and bodies are the owner's content, so
-- they're sealed under ATHENA_DATA_KEY like the rest (SECURITY.md §11).
-- Nothing here is compared, sorted or searched in SQL: names are matched and
-- records searched in the Function (lib/custom-kinds.ts). Ids, icons,
-- positions and dates stay readable.
--
-- Mirrored for reference at db/schema.sql.

CREATE TABLE custom_kinds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- As the Library shows it, plural: "Wines". Sealed.
  name TEXT NOT NULL,
  -- One record, for sentences and buttons: "wine" ("New wine"). Sealed.
  one TEXT NOT NULL,
  -- One of the app's line icons (lib/custom-field-rules.ts KIND_ICONS), readable.
  icon TEXT NOT NULL DEFAULT 'folder' CHECK (icon ~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'),
  -- Order in the Library and Settings, as the owner arranged it.
  position INT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_kinds_live_idx ON custom_kinds (position) WHERE archived_at IS NULL;

-- One record of a kind: a title, a Markdown body (athena:// links in it
-- become 'content' edges from source_type 'record', like a note's), and its
-- field values in custom_values. Permanently deleting a record deletes its
-- edges and values in the same statement (lib/db.ts deleteEntityForever).
CREATE TABLE custom_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind_id UUID NOT NULL REFERENCES custom_kinds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_records_kind_idx ON custom_records (kind_id) WHERE archived_at IS NULL;
CREATE INDEX custom_records_archived_idx ON custom_records (archived_at DESC) WHERE archived_at IS NOT NULL;

-- ---------- Graph: a custom record can link and be linked ----------
-- One link kind for every custom record, athena://record/<uuid>: record ids
-- are unique, so the kind needn't be in the link. Widened the same way as 0002.
ALTER TABLE edges DROP CONSTRAINT edges_source_type_check;
ALTER TABLE edges DROP CONSTRAINT edges_target_type_check;
ALTER TABLE edges ADD CONSTRAINT edges_source_type_check
  CHECK (source_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record'));
ALTER TABLE edges ADD CONSTRAINT edges_target_type_check
  CHECK (target_type IN ('note', 'person', 'project', 'place', 'organisation', 'event', 'record'));
